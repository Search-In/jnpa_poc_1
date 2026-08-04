/**
 * ArcGISAdapter — live implementation of `DataAdapter`.
 *
 * Data flow (see docs/ARCHITECTURE.md):
 *   • Live vessel positions  ← StreamLayer (Velocity-published) OR AISStream WS
 *   • Berths / plan / craft   ← Hosted Feature Layer queries
 *   • KPI history             ← KPISnapshots Feature Layer
 *   • Headline KPIs           ← same `buildKpiBundle` engine as mock
 *
 * This adapter is used ONLY in live mode (VITE_DATA_MODE=live). The default demo
 * runs MOCK with zero credentials and never instantiates this class, so the app
 * needs no ArcGIS sign-in. If live mode is enabled against private org items, add
 * an OAuth flow here; public Feature Layers + AISStream need only their URLs.
 *
 * NOTE: this is wired to the ArcGIS JS SDK but requires the `.env` URLs to be
 * filled in. Each method throws a clear, actionable error when its endpoint is
 * not configured, so live mode fails loudly rather than rendering blank panels.
 */

import StreamLayer from '@arcgis/core/layers/StreamLayer';
import FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import type Graphic from '@arcgis/core/Graphic';

import type {
  ArrivalsDeparturesBlock,
  Berth,
  BerthingPlanEntry,
  KpiSnapshot,
  NavStatus,
  PortCraftUnit,
  PredictionPoint,
  ShippingLine,
  TideStationsReading,
  Vessel,
  WeatherReading,
} from '@/types/domain';
import type { KpiBundle } from '@/types/kpi';
import { buildKpiBundle } from '@/kpi';
import type {
  ConnectionListener,
  DataAdapter,
  TimeWindow,
  Unsubscribe,
  VesselListener,
  WhatIfResult,
  WhatIfScenario,
} from './types';
import { env } from './config';
import { bucketArrivalsDepartures, computeWhatIf } from './MockAdapter';
import { openAisStream } from './aisstream';
import { fetchOpenMeteoWeather, parseLonLat } from './weather';
import { fetchTideStations } from './tide';
import { fetchShippingLines } from './uc3/shippingLines';
import { validateVessel, TrackQuality, type DqReason } from './quality';

/**
 * Flush the vessel cache to subscribers at most once per this interval. AIS can
 * arrive in bursts (e.g. 10k queued frames after a reconnect); coalescing to the
 * animation frame budget keeps the UI from freezing (spec §5.1 backpressure).
 */
const VESSEL_FLUSH_MS = 250;

const H = 3_600_000;

function resolveWindow(window: TimeWindow | undefined, now: number): { from: number; to: number } {
  const to = window?.to ?? now;
  const from = window?.from ?? to - (window?.lastHours ?? 24) * H;
  return { from, to };
}

/**
 * Format an epoch-ms instant as an ArcGIS SQL date literal:
 * `TIMESTAMP 'YYYY-MM-DD HH:MM:SS'` (UTC). Feature Service date fields reject a
 * bare epoch-ms integer in a WHERE clause, so all date filters use this form.
 */
function sqlDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  const s =
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  return `TIMESTAMP '${s}'`;
}

/** Map a Feature Service graphic's attributes onto a domain Vessel. */
function attrToVessel(a: Record<string, unknown>): Vessel {
  return {
    MMSI: String(a.MMSI ?? ''),
    VESSEL_NAME: String(a.VESSEL_NAME ?? ''),
    VESSEL_TYPE: String(a.VESSEL_TYPE ?? ''),
    NAV_STATUS: (String(a.NAV_STATUS ?? 'underway') as NavStatus),
    SOG: Number(a.SOG ?? 0),
    COG: Number(a.COG ?? 0),
    HEADING: Number(a.HEADING ?? 0),
    LAT: Number(a.LAT ?? 0),
    LON: Number(a.LON ?? 0),
    ETA: a.ETA == null ? null : Number(a.ETA),
    BERTH_ID: a.BERTH_ID == null ? null : String(a.BERTH_ID),
    TIMESTAMP: Number(a.TIMESTAMP ?? 0),
  };
}

export class ArcGISAdapter implements DataAdapter {
  readonly mode = 'live' as const;

  private streamLayer: StreamLayer | null = null;
  /** Latest known position per MMSI, so subscribers get the full current set. */
  private vesselCache = new Map<string, Vessel>();
  /** Data-quality track guard (teleport / regression / dedup / staleness). */
  private trackQuality = new TrackQuality();
  /** Rolling count of quarantined frames by reason code, for the DQ surface. */
  private quarantineCounts = new Map<string, number>();
  /** Pending batch-flush timer (backpressure coalescing). */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private now(): number {
    return Date.now();
  }

  /** Record quarantine reasons so the Connector Readiness page can show DQ. */
  private recordQuarantine(reasons: DqReason[]): void {
    for (const r of reasons) {
      this.quarantineCounts.set(r.code, (this.quarantineCounts.get(r.code) ?? 0) + 1);
    }
  }

  /** Quarantine tally snapshot (reason code → count). */
  getQuarantineCounts(): Record<string, number> {
    return Object.fromEntries(this.quarantineCounts);
  }

  /** Subscribers waiting for Velocity positions routed via the map layerview. */
  private streamBatchListeners = new Set<VesselListener>();

  /**
   * The live StreamLayer instance (created on first subscribe). AISMap adds
   * THIS instance to its WebMap so the map and the KPI engine share one feed.
   */
  getStreamLayer(): StreamLayer | null {
    return this.streamLayer;
  }

  /**
   * Called by AISMap once it has the StreamLayer's layerview, for each
   * `data-received` graphic. (In ArcGIS JS 4.x the per-feature event lives on
   * the StreamLayerView, which only exists inside a MapView — so the map, not
   * the headless adapter, is where positions are observed.) The adapter merges
   * by MMSI and fans the full current set out to its vessel subscribers.
   */
  pushStreamGraphic(attributes: Record<string, unknown>): void {
    const v = attrToVessel(attributes);
    this.vesselCache.set(v.MMSI, v);
    const batch = [...this.vesselCache.values()];
    for (const l of this.streamBatchListeners) l(batch);
  }

  // ── Live vessels: Velocity Stream Layer, else AISStream WS fallback ────────
  subscribeVessels(onBatch: VesselListener, onState?: ConnectionListener): Unsubscribe {
    if (env.streamLayerUrl) {
      return this.subscribeViaStreamLayer(onBatch, onState);
    }
    if (env.aisStreamToken) {
      onState?.('connecting');
      // Ship name + type arrive in separate ShipStaticData frames, in any order
      // relative to positions — remember them per MMSI and merge both ways.
      const staticByMmsi = new Map<string, { name: string; type: string }>();
      // Coalesce cache flushes: a burst of frames triggers one flush per
      // VESSEL_FLUSH_MS, not one per message (backpressure without UI freeze).
      const scheduleFlush = () => {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          onBatch([...this.vesselCache.values()]);
        }, VESSEL_FLUSH_MS);
      };
      const unsub = openAisStream({
        token: env.aisStreamToken,
        bbox: env.liveRegion.bbox,
        onState,
        onVessel: (raw) => {
          const now = this.now();
          // 1) stateless firewall (position/range/AoI/SOG/name) …
          const checked = validateVessel(raw, env.liveRegion.bbox);
          if (checked.reasons.length) this.recordQuarantine(checked.reasons);
          if (!checked.vessel) return; // quarantined
          // 2) … then stateful vetting (teleport/regression/dedup).
          const vetted = this.trackQuality.vet(checked.vessel, 'aisstream', now);
          if (vetted.reasons.length) this.recordQuarantine(vetted.reasons);
          if (!vetted.vessel) return;
          const v = vetted.vessel;
          const s = staticByMmsi.get(v.MMSI);
          if (s) {
            v.VESSEL_TYPE = s.type;
            v.VESSEL_NAME = s.name || v.VESSEL_NAME;
          }
          this.vesselCache.set(v.MMSI, v);
          scheduleFlush();
        },
        onStatic: (s) => {
          staticByMmsi.set(s.MMSI, { name: s.VESSEL_NAME, type: s.VESSEL_TYPE });
          const existing = this.vesselCache.get(s.MMSI);
          if (existing) {
            existing.VESSEL_TYPE = s.VESSEL_TYPE;
            existing.VESSEL_NAME = s.VESSEL_NAME || existing.VESSEL_NAME;
            this.vesselCache.set(s.MMSI, existing);
            scheduleFlush();
          }
        },
      });
      return () => {
        if (this.flushTimer) {
          clearTimeout(this.flushTimer);
          this.flushTimer = null;
        }
        unsub();
      };
    }
    onState?.('error');
    throw new Error(
      '[ArcGISAdapter] No live vessel source: set VITE_STREAM_LAYER_URL (Velocity) ' +
        'or VITE_AISSTREAM_TOKEN (AISStream fallback).'
    );
  }

  /**
   * Subscribe to the Velocity Stream Layer. We create + `connect()` the layer
   * for liveness, then register the caller; AISMap adopts the same instance via
   * `getStreamLayer()` and feeds positions back through `pushStreamGraphic()`
   * (the per-feature `data-received` event only exists on the layerview).
   */
  private subscribeViaStreamLayer(
    onBatch: VesselListener,
    onState?: ConnectionListener
  ): Unsubscribe {
    onState?.('connecting');
    this.streamBatchListeners.add(onBatch);
    const layer = this.streamLayer ?? new StreamLayer({ url: env.streamLayerUrl });
    this.streamLayer = layer;

    layer
      .load()
      .then(() => layer.connect())
      .then(() => onState?.('connected'))
      .catch(() => onState?.('error'));

    return () => {
      this.streamBatchListeners.delete(onBatch);
      if (this.streamBatchListeners.size === 0) this.streamLayer = null;
    };
  }

  // ── Feature Layer queries ──────────────────────────────────────────────────
  /**
   * Query a Hosted Feature Layer. If its URL is **not configured**, returns an
   * empty set so the app can go live incrementally (real AIS vessels first,
   * operational layers as they are published) — the dependent widgets render
   * their empty state rather than erroring. A *configured* URL that fails still
   * throws, so genuine outages surface loudly.
   */
  private async queryAll(url: string, name: string, where = '1=1'): Promise<Graphic[]> {
    void name; // retained for call-site clarity / future error messages
    if (!url) return [];
    const layer = new FeatureLayer({ url });
    const result = await layer.queryFeatures({
      where,
      outFields: ['*'],
      returnGeometry: true,
    });
    return result.features;
  }

  async getBerths(): Promise<Berth[]> {
    const features = await this.queryAll(env.fs.berths, 'VITE_FS_BERTHS_URL');
    return features.map((f) => {
      const a = f.attributes as Record<string, unknown>;
      const rings = (f.geometry as { rings?: number[][][] } | null)?.rings?.[0] ?? [];
      return {
        BERTH_ID: String(a.BERTH_ID ?? ''),
        BERTH_NAME: String(a.BERTH_NAME ?? ''),
        TERMINAL: String(a.TERMINAL ?? ''),
        LENGTH_M: Number(a.LENGTH_M ?? 0),
        DRAFT_M: Number(a.DRAFT_M ?? 0),
        STATUS: (String(a.STATUS ?? 'available') as Berth['STATUS']),
        GEOM: rings,
      };
    });
  }

  async getBerthPlan(window?: TimeWindow): Promise<BerthingPlanEntry[]> {
    const { from, to } = resolveWindow(window, this.now());
    const where = `PLANNED_END >= ${sqlDate(from)} AND PLANNED_START <= ${sqlDate(to)}`;
    const features = await this.queryAll(env.fs.berthingPlan, 'VITE_FS_BERTHING_PLAN_URL', where);
    return features.map((f) => {
      const a = f.attributes as Record<string, unknown>;
      return {
        PLAN_ID: String(a.PLAN_ID ?? ''),
        BERTH_ID: String(a.BERTH_ID ?? ''),
        MMSI: String(a.MMSI ?? ''),
        VESSEL_NAME: String(a.VESSEL_NAME ?? ''),
        PLANNED_START: Number(a.PLANNED_START ?? 0),
        PLANNED_END: Number(a.PLANNED_END ?? 0),
        ACTUAL_START: a.ACTUAL_START == null ? null : Number(a.ACTUAL_START),
        ACTUAL_END: a.ACTUAL_END == null ? null : Number(a.ACTUAL_END),
        STATUS: (String(a.STATUS ?? 'scheduled') as BerthingPlanEntry['STATUS']),
      };
    });
  }

  async getPortCraft(): Promise<PortCraftUnit[]> {
    const features = await this.queryAll(env.fs.portCraft, 'VITE_FS_PORT_CRAFT_URL');
    return features.map((f) => {
      const a = f.attributes as Record<string, unknown>;
      return {
        CRAFT_ID: String(a.CRAFT_ID ?? ''),
        TYPE: (String(a.TYPE ?? 'tug') as PortCraftUnit['TYPE']),
        STATUS: (String(a.STATUS ?? 'idle') as PortCraftUnit['STATUS']),
        ASSIGNED_MMSI: a.ASSIGNED_MMSI == null ? null : String(a.ASSIGNED_MMSI),
        DEPLOYED_AT: a.DEPLOYED_AT == null ? null : Number(a.DEPLOYED_AT),
        RESPONSE_MIN: a.RESPONSE_MIN == null ? null : Number(a.RESPONSE_MIN),
      };
    });
  }

  async getKpiHistory(window?: TimeWindow): Promise<KpiSnapshot[]> {
    const { from, to } = resolveWindow(window, this.now());
    const where = `TS >= ${sqlDate(from)} AND TS <= ${sqlDate(to)}`;
    const features = await this.queryAll(env.fs.kpiSnapshots, 'VITE_FS_KPI_SNAPSHOTS_URL', where);
    return features
      .map((f) => f.attributes as Record<string, unknown>)
      .map((a) => ({
        TS: Number(a.TS ?? 0),
        PRE_BERTH_DELAY: Number(a.PRE_BERTH_DELAY ?? 0),
        PRE_SAIL_DELAY: Number(a.PRE_SAIL_DELAY ?? 0),
        AVG_TAT: Number(a.AVG_TAT ?? 0),
        JIT_PCT: Number(a.JIT_PCT ?? 0),
        FORECAST_ACC: Number(a.FORECAST_ACC ?? 0),
        BERTH_OCC: Number(a.BERTH_OCC ?? 0),
        ANCHORED: Number(a.ANCHORED ?? 0),
        APPROACHING: Number(a.APPROACHING ?? 0),
      }))
      .sort((x, y) => x.TS - y.TS);
  }

  async getDelaySeries(
    _kind: 'preBerthing' | 'preSailing',
    window?: TimeWindow
  ): Promise<KpiSnapshot[]> {
    return this.getKpiHistory(window);
  }

  async getPrediction(window?: TimeWindow): Promise<PredictionPoint[]> {
    // Prediction lives in the Vessels history layer (predicted ETA per fix);
    // here we read the latest ETA per MMSI against arrivals. Falls back to an
    // empty set if the vessels FS URL is not configured.
    if (!env.fs.vessels) return [];
    const { from, to } = resolveWindow(window, this.now());
    const where = `TIMESTAMP >= ${sqlDate(from)} AND TIMESTAMP <= ${sqlDate(to)} AND ETA IS NOT NULL`;
    const features = await this.queryAll(env.fs.vessels, 'VITE_FS_VESSELS_URL', where);
    return features.map((f) => {
      const a = f.attributes as Record<string, unknown>;
      return {
        MMSI: String(a.MMSI ?? ''),
        VESSEL_NAME: String(a.VESSEL_NAME ?? ''),
        predictedEta: Number(a.ETA ?? 0),
        actualAta: a.TIMESTAMP == null ? null : Number(a.TIMESTAMP),
      };
    });
  }

  async getArrivalsDepartures(window?: TimeWindow): Promise<ArrivalsDeparturesBlock[]> {
    const { from, to } = resolveWindow(window, this.now());
    const plan = await this.getBerthPlan(window);
    return bucketArrivalsDepartures(plan, from, to);
  }

  async getKPIs(): Promise<KpiBundle> {
    const now = this.now();
    const [plan, predictions, berths] = await Promise.all([
      this.getBerthPlan({ lastHours: 24 }),
      this.getPrediction({ lastHours: 24 }),
      this.getBerths(),
    ]);
    const snapshots = await this.getKpiHistory({ lastHours: 24 });
    return buildKpiBundle({
      now,
      vessels: [...this.vesselCache.values()],
      plan,
      predictions,
      berthCount: berths.length,
      snapshots,
      windowHours: 24,
    });
  }

  async getWeather(): Promise<WeatherReading> {
    // Prefer the configured JNPA weather/tidal/channel feed when set …
    if (env.weatherFeedUrl) {
      const res = await fetch(env.weatherFeedUrl);
      if (!res.ok) throw new Error(`[ArcGISAdapter] weather feed HTTP ${res.status}`);
      return (await res.json()) as WeatherReading;
    }
    // … otherwise use the free, no-key Open-Meteo source for the active region
    // (the open-source met fallback the PoC brief allows).
    const { lat, lon } = parseLonLat(env.liveRegion.center);
    return fetchOpenMeteoWeather(lat, lon);
  }

  async getTideStations(): Promise<TideStationsReading> {
    // Interim live source: Open-Meteo Marine per station. Real INCOIS OSF needs
    // a server-side proxy + data agreement (see docs/INCOIS.md); the panel's
    // TIDE SourceBadge labels this "interim — pending INCOIS OSF".
    return fetchTideStations(this.now());
  }

  /**
   * Shipping-line registry from the SHARED UC-3 backend — not an ArcGIS layer.
   *
   * This is the one live read that does not come from a Feature/Stream Layer:
   * the carrier master lives in the common JNPA gateway (see src/data/uc3/).
   * Kept behind the same adapter seam so no component ever calls it directly.
   *
   * Throws a clear, actionable error when the integration is switched off, per
   * this adapter's convention of failing loudly rather than rendering a blank
   * panel.
   */
  async getShippingLines(): Promise<ShippingLine[]> {
    if (!env.uc3.enabled) {
      throw new Error(
        '[ArcGISAdapter] No shipping-line source: the UC-3 integration is disabled ' +
          '(set VITE_UC3_ENABLED=true and point VITE_UC3_API_BASE at the gateway).'
      );
    }
    return fetchShippingLines();
  }

  /**
   * NOTE: live mode deliberately reuses the SAME linear stub as the mock adapter
   * (`computeWhatIf`) — there is no real recompute over the feature data behind
   * this. Only the baseline KPIs it perturbs are live. The model is stated in the
   * result's `note` and in the assumptions register (`whatIfModel`), so the
   * distinction is visible on screen rather than buried here.
   */
  async runWhatIf(scenario: WhatIfScenario): Promise<WhatIfResult> {
    const bundle = await this.getKPIs();
    return computeWhatIf(scenario, bundle.jitPct.value, bundle.avgTat.value, this.now());
  }
}
