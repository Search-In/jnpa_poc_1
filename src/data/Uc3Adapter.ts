/**
 * Uc3Adapter — the corpus-backed `DataAdapter` (selected when `VITE_UC3_ENABLED`
 * and `VITE_DATA_MODE=mock`; there is no `uc3` data-mode value).
 *
 * Implements the full 13-method adapter contract against the UC-3 gateway's marine
 * APIs, so every operational screen (map, KPI wall, 5-day Gantt, DUKC, port craft,
 * reports) renders REAL ingested JNPA data — berthing reports, PCS messages, pilot
 * cards, tide panels — instead of MockAdapter's fixtures. This is checklist item
 * D1/D2: the fixture vocabulary is replaced by corpus-derived data through the
 * existing `DataAdapter` seam, so no screen changes its data access.
 *
 * POSITION SYNTHESIS. The corpus has no AIS: vessel STATE is real (from the
 * operational ledger — spec UI-020) while POSITION is synthesised deterministically
 * from port geometry (berth slots, anchorage rings, the channel centreline) so the
 * map can show it. Every such vessel carries `SOURCE: 'derived'` — real identity,
 * real state, indicative position — and must never be badged live.
 *
 * TIME MODEL. The corpus is historical (May–Jul 2026). All reads omit `at` so the
 * backend anchors to the latest ACTUAL in the data (the dense berthing-report era);
 * `VITE_UC3_AS_OF` pins a different instant for rehearsing a specific day. The
 * SimAdapter wrapper still overlays what-if levers on top, unchanged.
 *
 * HONESTY RULES carried through this adapter:
 *   - KPI cards keep the backend's definition/basis/baseline-source strings
 *     (spec UI-041) and surface measurability notes instead of fabricated values.
 *   - Berths carry OCCUPANCY working|idle (spec UI-022) and DIMENSIONS_ASSUMED.
 *   - Plan entries carry KIND confirmed|indicative + PROVENANCE (spec UI-028).
 */

import type {
  ArrivalsDeparturesBlock,
  Berth,
  BerthingPlanEntry,
  KpiSnapshot,
  PortCraftUnit,
  PredictionPoint,
  ShippingLine,
  TideStationsReading,
  Vessel,
  WeatherReading,
} from '@/types/domain';
import type { KpiBundle, KpiValue, TrendPoint } from '@/types/kpi';
import type {
  ConnectionListener,
  DataAdapter,
  TimeWindow,
  Unsubscribe,
  VesselListener,
  WhatIfResult,
  WhatIfScenario,
} from './types';
import { KPI_ANATOMY } from '@/config/kpiAnatomy';
import { KPI_TARGETS } from '@/config/targets';
import { env } from './config';
import { computeWhatIf } from './MockAdapter';
import { fetchShippingLines } from './uc3/shippingLines';
import { fetchBerthingReportsPage } from './uc3/berthing';
import { fetchMarineKpis as fetchOpsMarineKpis } from './uc3/marineKpis';
import { fetchPortCraft } from './uc3/portCraft';
import {
  fetchKpiBaselines,
  fetchMarineArrDep,
  fetchMarineBerths,
  fetchMarineKpis,
  fetchMarinePlan,
  fetchMarineVesselStates,
  fetchTides,
  toBerthingPlanEntries,
  type MarineBerthState,
  type MarineBerthsResult,
  type MarineKpiBaseline,
  type MarineKpisResult,
  type MarineVesselState,
  type TideReadingRow,
} from './uc3/marineDashboard';
import { fetchOpenMeteoWeather, parseLonLat } from './weather';
import { fetchTideStations } from './tide';
import {
  ANCHORAGES,
  PILOT_STATION,
  TERMINAL_QUAYS,
  channelCentreline,
  offsetMeters,
} from '@/map/portGeometry';

const H = 3_600_000;
const POLL_MS = 15_000;
const CACHE_MS = 30_000;

/** Backend terminal code → frontend quay-geometry key. NSDT/liquid berths have no
 * quay geometry in the twin scene, so their berths stay off the map layer. */
const TERMINAL_TO_QUAY: Record<string, string> = {
  APMT: 'GTI', // Gateway Terminals India IS the APM Terminals Mumbai quay
  NSICT: 'NSICT',
  NSIGT: 'NSIGT',
  BMCT: 'BMCT',
  NSFT: 'JNPCT', // NSFT operates the former JNPCT quay (CB01–CB03)
  JNPCT: 'JNPCT',
};

const BERTH_DEPTH_M = 60;

/** Deterministic 0..1 hash of a string — stable jitter for synthesised positions. */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

function centroid(ring: number[][]): [number, number] {
  let lng = 0;
  let lat = 0;
  for (const p of ring) {
    lng += p[0];
    lat += p[1];
  }
  return [lng / ring.length, lat / ring.length];
}

/** Point along a polyline at fraction t (0 = first vertex, 1 = last). */
function alongLine(line: [number, number][], t: number): [number, number] {
  if (line.length === 0) return [72.93, 18.94];
  const f = Math.min(Math.max(t, 0), 1) * (line.length - 1);
  const i = Math.min(Math.floor(f), line.length - 2);
  const frac = f - i;
  const [ax, ay] = line[i];
  const [bx, by] = line[i + 1];
  return [ax + (bx - ax) * frac, ay + (by - ay) * frac];
}

function bearing(a: [number, number], b: [number, number]): number {
  const deg = (Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export type BerthGeomMap = Map<string, { geom: number[][]; centre: [number, number] }>;

/**
 * Pure position synthesis for corpus vessel-states (UC1-011).
 * Real identity + ledger state; lat/lon from port geometry — never AIS.
 * Always returns `SOURCE: 'derived'` so the map/feed can badge honesty.
 */
export function synthesiseDerivedVessel(
  s: MarineVesselState,
  berthGeom: BerthGeomMap,
  asOf: number,
): Vessel | null {
  const id = s.imoNo || s.viaNo || s.vesselName;
  if (!id) return null;
  const centre = channelCentreline();
  const jitter = hash01(id);
  let pos: [number, number];
  let sog = 0;
  let nav: Vessel['NAV_STATUS'];
  let cog = 0;

  const berth = s.berthCode
    ? berthGeom.get(s.berthCode.toUpperCase().replace(/[\s-]/g, '')) ?? berthGeom.get(s.berthCode)
    : undefined;

  switch (s.state) {
    case 'alongside': {
      nav = 'moored';
      const quay = TERMINAL_TO_QUAY[s.terminal] ? TERMINAL_QUAYS[TERMINAL_TO_QUAY[s.terminal]] : undefined;
      pos = berth?.centre ?? (quay
        ? offsetMeters(quay.mid, quay.along, (jitter - 0.5) * quay.lengthM * 0.8)
        : alongLine(centre, 0.95));
      break;
    }
    case 'under_pilotage': {
      nav = 'berthing';
      sog = 6;
      const target = berth?.centre ?? alongLine(centre, 0.9);
      const t = 0.35 + jitter * 0.4;
      pos = [
        PILOT_STATION.lng + (target[0] - PILOT_STATION.lng) * t,
        PILOT_STATION.lat + (target[1] - PILOT_STATION.lat) * t,
      ];
      cog = bearing([PILOT_STATION.lng, PILOT_STATION.lat], target);
      break;
    }
    case 'at_anchorage': {
      nav = 'anchored';
      const ring = ANCHORAGES[jitter > 0.5 ? 0 : 1].ring;
      const c = centroid(ring);
      pos = [c[0] + (jitter - 0.5) * 0.012, c[1] + (hash01(id + 'y') - 0.5) * 0.008];
      break;
    }
    case 'inbound':
    case 'expected': {
      nav = 'approaching';
      sog = 10;
      const eta = s.etb || s.eta;
      const hoursOut = eta > asOf ? Math.min((eta - asOf) / H, 24) : 24;
      // ≤1 h out ≈ the pilot ground (t≈0.55 of the centreline); 24 h out ≈ seaward end.
      const t = Math.max(0.02, 0.55 - (hoursOut / 24) * 0.53);
      pos = alongLine(centre, t);
      const ahead = alongLine(centre, Math.min(t + 0.05, 1));
      cog = bearing(pos, ahead);
      break;
    }
    case 'departed': {
      const atd = s.atd || 0;
      if (!atd || asOf - atd > 12 * H) return null; // long gone — off the picture
      nav = 'underway';
      sog = 12;
      const hoursGone = (asOf - atd) / H;
      const t = Math.max(0.02, 0.5 - (hoursGone / 12) * 0.48);
      pos = alongLine(centre, t);
      const out = alongLine(centre, Math.max(t - 0.05, 0));
      cog = bearing(pos, out);
      break;
    }
    default:
      return null;
  }

  return {
    MMSI: s.imoNo ? `IMO:${s.imoNo}` : `VIA:${s.viaNo || id}`,
    VESSEL_NAME: s.vesselName || `IMO ${s.imoNo}`,
    VESSEL_TYPE: 'Container Ship',
    NAV_STATUS: nav,
    SOG: sog,
    COG: cog,
    HEADING: cog,
    LAT: pos[1],
    LON: pos[0],
    ETA: s.etb || s.eta || null,
    BERTH_ID: s.berthCode || null,
    TIMESTAMP: asOf,
    SOURCE: 'derived',
  };
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

export class Uc3Adapter implements DataAdapter {
  readonly mode = 'live' as const;

  /** Demo pin for the anchor instant (epoch ms); 0 = let the backend anchor. */
  private readonly asOf: number;

  private cache = new Map<string, Cached<unknown>>();

  constructor() {
    const pinned = (import.meta.env.VITE_UC3_AS_OF as string | undefined) ?? '';
    const parsed = pinned ? Date.parse(pinned) : NaN;
    this.asOf = Number.isFinite(parsed) ? parsed : 0;
  }

  private at(): number | undefined {
    return this.asOf > 0 ? this.asOf : undefined;
  }

  private cached<T>(slot: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(slot);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(slot, { at: Date.now(), value });
    // A failed load must not poison the cache window.
    value.catch(() => {
      if (this.cache.get(slot)?.value === value) this.cache.delete(slot);
    });
    return value;
  }

  private loadBerths(): Promise<MarineBerthsResult> {
    return this.cached('berths', () => fetchMarineBerths(this.at()));
  }

  private loadKpis(): Promise<MarineKpisResult> {
    return this.cached('kpis', () => fetchMarineKpis(this.at()));
  }

  private loadStates(): Promise<MarineVesselState[]> {
    return this.cached('states', async () => (await fetchMarineVesselStates(this.at())).items);
  }

  private loadTides(): Promise<TideReadingRow[]> {
    return this.cached('tides', async () => (await fetchTides()).items);
  }

  /** Published-baseline register (jnport.gov.in ▸ Reports), tolerated as empty. */
  private loadBaselines(): Promise<Map<string, MarineKpiBaseline>> {
    return this.cached('baselines', () =>
      fetchKpiBaselines().catch(() => new Map<string, MarineKpiBaseline>()));
  }

  // ---------------------------------------------------------------- berths
  /** Slot geometry per terminal, computed from how many berths that quay carries. */
  private berthGeometry(states: MarineBerthState[]): Map<string, { geom: number[][]; centre: [number, number] }> {
    const byQuay = new Map<string, MarineBerthState[]>();
    for (const b of states) {
      const quay = TERMINAL_TO_QUAY[b.terminal];
      if (!quay || !TERMINAL_QUAYS[quay]) continue;
      const list = byQuay.get(quay) ?? [];
      list.push(b);
      byQuay.set(quay, list);
    }
    const out = new Map<string, { geom: number[][]; centre: [number, number] }>();
    for (const [quay, list] of byQuay) {
      const q = TERMINAL_QUAYS[quay];
      list.sort((a, b) => a.code.localeCompare(b.code));
      const slots = list.length;
      const cellLen = q.lengthM / slots;
      list.forEach((b, i) => {
        const centreAlong = -q.lengthM / 2 + cellLen * (i + 0.5);
        const boxLen = Math.min(b.lengthM ?? cellLen, cellLen * 0.92);
        const midW = offsetMeters(q.mid, q.along, centreAlong);
        const wA = offsetMeters(midW, q.along, -boxLen / 2);
        const wB = offsetMeters(midW, q.along, +boxLen / 2);
        const lB = offsetMeters(wB, q.landward, BERTH_DEPTH_M);
        const lA = offsetMeters(wA, q.landward, BERTH_DEPTH_M);
        out.set(b.code, { geom: [wA, wB, lB, lA, wA], centre: midW });
      });
    }
    return out;
  }

  async getBerths(): Promise<Berth[]> {
    const res = await this.loadBerths();
    const geom = this.berthGeometry(res.items);
    return res.items
      .filter((b) => geom.has(b.code))
      .map((b) => ({
        BERTH_ID: b.code,
        BERTH_NAME: `${b.terminalName || b.terminal} ${b.code}`,
        TERMINAL: TERMINAL_TO_QUAY[b.terminal] ?? b.terminal,
        LENGTH_M: b.lengthM ?? 0,
        DRAFT_M: b.designDepthM ?? 0,
        STATUS: b.state === 'free' ? 'available' : 'occupied',
        GEOM: geom.get(b.code)!.geom,
        OCCUPANCY: b.state === 'occupied-working' ? 'working'
          : b.state === 'occupied-idle' ? 'idle' : undefined,
        VESSEL_NAME: b.vesselName || null,
        OCCUPIED_SINCE: b.alongsideSince || null,
        DIMENSIONS_ASSUMED: b.dimensionsAssumed,
      }));
  }

  // ---------------------------------------------------------------- vessels
  subscribeVessels(onBatch: VesselListener, onState?: ConnectionListener): Unsubscribe {
    let alive = true;
    onState?.('connecting');
    const tick = async () => {
      try {
        const [states, berths] = await Promise.all([this.loadStates(), this.loadBerths()]);
        if (!alive) return;
        const geom = this.berthGeometry(berths.items);
        const asOf = this.asOf || berths.asOf || Date.now();
        const vessels = states
          .map((s) => synthesiseDerivedVessel(s, geom, asOf))
          .filter((v): v is Vessel => v !== null);
        onState?.('connected');
        onBatch(vessels);
      } catch {
        if (alive) onState?.('error');
      }
    };
    void tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      onState?.('closed');
    };
  }

  // ---------------------------------------------------------------- plan
  async getBerthPlan(window?: TimeWindow): Promise<BerthingPlanEntry[]> {
    const hours = window?.lastHours
      ?? (window?.from && window?.to ? (window.to - window.from) / H : 120);
    const days = Math.max(1, Math.min(Math.ceil(hours / 24), 14));
    const res = await fetchMarinePlan(this.at(), days);
    return toBerthingPlanEntries(res);
  }

  // ---------------------------------------------------------------- KPIs
  /**
   * Build one UI-041 card. `value === null` is unmeasurable (dash + note) —
   * never coerce to a fabricated zero.
   */
  private kpiValue(
    key: keyof KpiBundle,
    value: number | null,
    trend: TrendPoint[],
    meta?: Partial<KpiValue>,
  ): KpiValue {
    const t = KPI_TARGETS[key];
    const a = KPI_ANATOMY[key];
    const sampleN = meta?.sampleN ?? 0;
    const note =
      meta?.note ||
      (value === null || sampleN === 0
        ? `not measurable — n=0 for ${a.name}`
        : undefined);
    const unmeasurable = value === null || (sampleN === 0 && !!note);
    const v =
      !unmeasurable && value !== null && Number.isFinite(value)
        ? Number(value.toFixed(2))
        : 0;
    const deltaPct =
      unmeasurable || t.target === 0 ? 0 : ((v - t.target) / t.target) * 100;
    const pub = a.publishedBaseline;
    const baselineValue = meta?.baselineValue ?? pub?.value;
    const baselinePeriod = meta?.baselinePeriod ?? pub?.period;
    const vsBaselinePct =
      meta?.vsBaselinePct ??
      (baselineValue && !unmeasurable && baselineValue !== 0
        ? Number((((v - baselineValue) / baselineValue) * 100).toFixed(1))
        : undefined);

    return {
      key,
      label: t.label,
      value: v,
      unit: t.unit,
      target: t.target,
      deltaPct: Number.isFinite(deltaPct) ? Number(deltaPct.toFixed(1)) : 0,
      trend: unmeasurable ? [] : trend,
      definition: meta?.definition ?? a.definition,
      basis: meta?.basis ?? a.basis,
      baselineSource: meta?.baselineSource || a.baselineSource,
      note,
      sampleN: unmeasurable ? 0 : sampleN,
      baselineValue,
      baselinePeriod,
      vsBaselinePct: unmeasurable ? undefined : vsBaselinePct,
      provenance: meta?.provenance ?? 'LIVE-CORPUS',
      p50: meta?.p50,
      p90: meta?.p90,
      breakdown: meta?.breakdown,
    };
  }

  async getKPIs(): Promise<KpiBundle> {
    const [kpis, berths, states, predictions, baselines, opsKpis] = await Promise.all([
      this.loadKpis(),
      this.loadBerths(),
      this.loadStates(),
      this.getPrediction().catch(() => [] as PredictionPoint[]),
      this.loadBaselines(),
      fetchOpsMarineKpis().catch(() => null),
    ]);
    const occBaseline = baselines.get('BERTH_OCC') ?? null;
    const tatBaseline = baselines.get('AVG_TAT') ?? null;
    const byKey = new Map(kpis.kpis.map((k) => [k.key, k]));
    const trend = (key: string): TrendPoint[] =>
      (byKey.get(key)?.series ?? []).map((p) => ({ ts: p.ts, value: p.value }));
    const fromApi = (key: string): Partial<KpiValue> => {
      const k = byKey.get(key);
      if (!k) return {};
      return {
        definition: k.definition || undefined,
        basis: k.basis || undefined,
        baselineSource: k.baselineSource || undefined,
        note: k.note || undefined,
        sampleN: k.n,
        baselineValue: k.baseline?.value ?? undefined,
        baselinePeriod: k.baseline?.period || undefined,
        vsBaselinePct: k.vsBaselinePct ?? undefined,
        p50: k.median,
        provenance: 'LIVE-CORPUS',
      };
    };

    // Prediction accuracy as a percentage: share of arrivals within ±4 h of the
    // declared ETA (the MAE in hours rides along in the note — spec UI-044 wants
    // an interval statement, not a bare point).
    const withBoth = predictions.filter((p) => p.actualAta !== null);
    const within4h = withBoth.filter(
      (p) => Math.abs((p.actualAta as number) - p.predictedEta) <= 4 * H).length;
    const accuracyPct = withBoth.length ? (within4h / withBoth.length) * 100 : null;
    const mae = byKey.get('FORECAST_ACC');

    const occupiedPct = berths.items.length
      ? (berths.occupied / berths.items.length) * 100
      : null;
    const anchored = states.filter((s) => s.state === 'at_anchorage').length;
    const approaching = states.filter(
      (s) => s.state === 'inbound' || s.state === 'expected').length;

    // Port Craft Optimization — mean of pilot + craft utilisation from the
    // projection KPI board (/marine/state/kpis), not a fabricated register %.
    const craftFleetN = opsKpis
      ? opsKpis.pilot.known + opsKpis.craft.fleetTotal
      : 0;
    const craftUtil =
      opsKpis && craftFleetN > 0
        ? (opsKpis.pilot.utilisationPct + opsKpis.craft.utilisationPct) / 2
        : null;

    const avgTatRaw = byKey.get('AVG_TAT');
    const avgTatMeta = fromApi('AVG_TAT');
    if (tatBaseline?.value != null && avgTatMeta.baselineValue == null) {
      avgTatMeta.baselineValue = tatBaseline.value;
      avgTatMeta.baselinePeriod = tatBaseline.period || undefined;
      avgTatMeta.baselineSource =
        `jnport.gov.in Operating Performance Profile ${tatBaseline.value} h ` +
        `pilot-to-pilot ${tatBaseline.period || ''} — ${tatBaseline.source}`.trim();
    }

    return {
      jitPct: this.kpiValue(
        'jitPct',
        byKey.get('JIT_PCT')?.value ?? null,
        trend('JIT_PCT'),
        fromApi('JIT_PCT'),
      ),
      preBerthingDelay: this.kpiValue(
        'preBerthingDelay',
        byKey.get('PRE_BERTH_DELAY')?.value ?? null,
        trend('PRE_BERTH_DELAY'),
        fromApi('PRE_BERTH_DELAY'),
      ),
      preSailingDelay: this.kpiValue(
        'preSailingDelay',
        byKey.get('PRE_SAIL_DELAY')?.value ?? null,
        trend('PRE_SAIL_DELAY'),
        fromApi('PRE_SAIL_DELAY'),
      ),
      avgTat: this.kpiValue(
        'avgTat',
        avgTatRaw?.value ?? null,
        trend('AVG_TAT'),
        avgTatMeta,
      ),
      portCraftOptimization: this.kpiValue('portCraftOptimization', craftUtil, [], {
        sampleN: craftFleetN,
        note:
          craftFleetN === 0
            ? 'not measurable — pilot/craft fleet empty at /marine/state/kpis'
            : undefined,
        basis: 'Marine Projection pilot + craft utilisation at the anchor instant',
        provenance: 'LIVE-CORPUS',
      }),
      forecastAccuracy: this.kpiValue('forecastAccuracy', accuracyPct, [], {
        ...fromApi('FORECAST_ACC'),
        note:
          withBoth.length === 0
            ? 'not measurable — no predicted-vs-actual ETA pairs in window'
            : mae?.value != null
              ? `ETA mean absolute error ${mae.value} h over n=${mae.n}`
              : undefined,
        sampleN: withBoth.length,
        provenance: 'LIVE-CORPUS',
      }),
      berthOccupancy: this.kpiValue('berthOccupancy', occupiedPct, [], {
        sampleN: berths.items.length,
        note:
          berths.items.length === 0 ? 'not measurable — berth register empty' : undefined,
        baselineValue: occBaseline?.value ?? undefined,
        baselinePeriod: occBaseline?.period || undefined,
        baselineSource: occBaseline?.value != null
          ? `JNPA published baseline ${occBaseline.value}% (${occBaseline.period}) — ${occBaseline.source}`
          : undefined,
        vsBaselinePct:
          occBaseline?.value && occupiedPct != null
            ? Number((((occupiedPct - occBaseline.value) / occBaseline.value) * 100).toFixed(1))
            : undefined,
        provenance: 'LIVE-CORPUS',
      }),
      anchored: this.kpiValue('anchored', anchored + approaching, [], {
        sampleN: states.length || anchored + approaching,
        breakdown: `${anchored} anchored · ${approaching} approaching`,
        note:
          states.length === 0 && anchored + approaching === 0
            ? 'not measurable — no ledger-derived vessel states at anchor'
            : undefined,
        provenance: 'LIVE-CORPUS',
      }),
    };
  }

  // ---------------------------------------------------------------- series / history
  private async snapshotsFromSeries(): Promise<KpiSnapshot[]> {
    const kpis = await this.loadKpis();
    const byKey = new Map(kpis.kpis.map((k) => [k.key, k]));
    const days = new Map<number, KpiSnapshot>();
    const put = (key: string, field: keyof KpiSnapshot) => {
      for (const p of byKey.get(key)?.series ?? []) {
        const row = days.get(p.ts) ?? {
          TS: p.ts, PRE_BERTH_DELAY: 0, PRE_SAIL_DELAY: 0, AVG_TAT: 0,
          JIT_PCT: 0, FORECAST_ACC: 0, BERTH_OCC: 0, ANCHORED: 0, APPROACHING: 0,
        };
        (row[field] as number) = p.value;
        days.set(p.ts, row);
      }
    };
    put('PRE_BERTH_DELAY', 'PRE_BERTH_DELAY');
    put('PRE_SAIL_DELAY', 'PRE_SAIL_DELAY');
    put('AVG_TAT', 'AVG_TAT');
    put('JIT_PCT', 'JIT_PCT');
    return [...days.values()].sort((a, b) => a.TS - b.TS);
  }

  async getDelaySeries(kind: 'preBerthing' | 'preSailing', window?: TimeWindow): Promise<KpiSnapshot[]> {
    void kind;
    return this.applyWindow(await this.snapshotsFromSeries(), window);
  }

  async getKpiHistory(window?: TimeWindow): Promise<KpiSnapshot[]> {
    return this.applyWindow(await this.snapshotsFromSeries(), window);
  }

  private applyWindow(rows: KpiSnapshot[], window?: TimeWindow): KpiSnapshot[] {
    if (!window || (!window.from && !window.lastHours)) return rows;
    const to = window.to ?? rows[rows.length - 1]?.TS ?? Date.now();
    const from = window.from ?? to - (window.lastHours ?? 24) * H;
    const hit = rows.filter((r) => r.TS >= from && r.TS <= to);
    // A short sim window can miss every daily point; the trend is still the story.
    return hit.length > 0 ? hit : rows;
  }

  // ---------------------------------------------------------------- arrivals / departures
  async getArrivalsDepartures(window?: TimeWindow): Promise<ArrivalsDeparturesBlock[]> {
    const hours = window?.lastHours
      ?? (window?.from && window?.to ? Math.ceil((window.to - window.from) / H) : 48);
    const res = await fetchMarineArrDep(this.at(), Math.min(Math.max(hours, 4), 336));
    const fmt = new Intl.DateTimeFormat('en-IN', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
    });
    return res.blocks.map((b) => ({
      blockStart: b.bucketStart,
      label: `${fmt.format(new Date(b.bucketStart))}–${fmt.format(
        new Date(b.bucketStart + res.bucketHours * H))}`,
      arrivals: b.arrivals,
      departures: b.departures,
    }));
  }

  // ---------------------------------------------------------------- predictions
  async getPrediction(window?: TimeWindow): Promise<PredictionPoint[]> {
    void window;
    const page = await fetchBerthingReportsPage({}, 200, 0);
    return page.items
      .filter((r) => r.eta > 0)
      .map((r) => ({
        MMSI: r.imoNumber ? `IMO:${r.imoNumber}` : `VIA:${r.voyageNumber}`,
        VESSEL_NAME: r.vesselName,
        predictedEta: r.eta,
        actualAta: r.ata > 0 ? r.ata : null,
      }));
  }

  // ---------------------------------------------------------------- port craft
  async getPortCraft(): Promise<PortCraftUnit[]> {
    const [register, states] = await Promise.all([fetchPortCraft(), this.loadStates()]);
    // Real fleet register + ledger-derived deployment: each vessel under pilotage
    // right now engages one pilot launch and two tugs (standard JNPA container
    // move). Assignment is deterministic (hash of the movement onto the fleet),
    // and every derived row is distinguishable by its real register identity.
    const moves = states.filter((s) => s.state === 'under_pilotage');
    const tugs = register.filter((c) => /tug/i.test(c.craftType));
    const launches = register.filter((c) => /launch/i.test(c.craftType));
    const assigned = new Map<string, MarineVesselState>();
    moves.forEach((m, i) => {
      const t1 = tugs[(i * 2) % Math.max(tugs.length, 1)];
      const t2 = tugs[(i * 2 + 1) % Math.max(tugs.length, 1)];
      const pl = launches[i % Math.max(launches.length, 1)];
      for (const c of [t1, t2, pl]) if (c) assigned.set(c.name, m);
    });
    return register.map((c) => {
      const job = assigned.get(c.name);
      const type: PortCraftUnit['TYPE'] = /tug/i.test(c.craftType)
        ? 'tug' : /launch/i.test(c.craftType) ? 'pilot' : 'mooring';
      return {
        CRAFT_ID: c.name,
        TYPE: type,
        STATUS: job ? 'deployed' : 'idle',
        ASSIGNED_MMSI: job ? (job.imoNo ? `IMO:${job.imoNo}` : `VIA:${job.viaNo}`) : null,
        DEPLOYED_AT: job?.pilotBoardedAt || null,
        RESPONSE_MIN: null, // no measured response times in the register — never invent
      };
    });
  }

  // ---------------------------------------------------------------- weather & tide
  async getWeather(): Promise<WeatherReading> {
    const { lat, lon } = parseLonLat(env.liveRegion.center);
    const reading = await fetchOpenMeteoWeather(lat, lon);
    // Tide height from the REAL berthing-report tide panels at the anchor instant
    // (chart datum), replacing the interim model value when corpus data covers it.
    try {
      const tides = await this.loadTides();
      const anchor = this.asOf || (await this.loadBerths()).asOf;
      const nearest = nearestTide(tides, anchor);
      if (nearest) return { ...reading, tideM: nearest.heightM };
    } catch {
      /* keep the interim source */
    }
    return reading;
  }

  async getTideStations(): Promise<TideStationsReading> {
    const base = await fetchTideStations(Date.now());
    try {
      const [tides, berths] = await Promise.all([this.loadTides(), this.loadBerths()]);
      const anchor = this.asOf || berths.asOf;
      const nearest = nearestTide(tides, anchor);
      const next = nearestTide(tides, anchor + 30 * 60_000);
      if (!nearest) return base;
      const trend: 'rising' | 'falling' | 'slack' = !next
        ? 'slack'
        : next.heightM > nearest.heightM + 0.02 ? 'rising'
        : next.heightM < nearest.heightM - 0.02 ? 'falling' : 'slack';
      // The berthing-report tide table is port-wide (one harbour datum), so every
      // station shows the same corpus height; wind/wave stay per-station (Open-Meteo).
      return {
        TS: anchor,
        stations: base.stations.map((s) => ({
          ...s,
          tideM: nearest.heightM,
          tideTrend: trend,
          // The corpus tide table supplied a real height, so tideM is no longer
          // an unreported measurement even if Open-Meteo withheld one.
          missing: s.missing?.filter((k) => k !== 'tideM'),
          TS: anchor,
        })),
      };
    } catch {
      return base;
    }
  }

  // ---------------------------------------------------------------- misc
  getShippingLines(): Promise<ShippingLine[]> {
    return fetchShippingLines();
  }

  async runWhatIf(scenario: WhatIfScenario): Promise<WhatIfResult> {
    const bundle = await this.getKPIs();
    return computeWhatIf(scenario, bundle.jitPct.value, bundle.avgTat.value,
      this.asOf || Date.now());
  }
}

/** Nearest tide reading to `ts` within ±8 h, else null. Pure. */
export function nearestTide(tides: TideReadingRow[], ts: number): TideReadingRow | null {
  let best: TideReadingRow | null = null;
  let bestD = 8 * H;
  for (const t of tides) {
    const d = Math.abs(t.tideTs - ts);
    if (d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}
