/**
 * LiveOverlayAdapter — composites REAL live AIS vessels ON TOP of a base adapter.
 *
 * Selected by `VITE_DATA_MODE=hybrid`. It wraps a base `DataAdapter` (normally
 * MockAdapter, so the JNPA map is always populated) and, in parallel, opens
 * TWO live sources concurrently:
 *   • aisstream.io WebSocket (global free AIS; sparse over Indian waters), and
 *   • the AISHub public station feed (map.json for station 2387 — real JNPA /
 *     Nhava Sheva hulls; see aishub.ts).
 * Each emitted vessel batch is the UNION of:
 *   • the base fleet   (SOURCE='mock' — the deterministic JNPA simulation), and
 *   • all live fixes   (SOURCE='live' — real vessels from either source),
 * merged by MMSI. Keys never collide: mock MMSIs are synthetic, AISStream uses
 * numeric MMSIs, and AISHub keys are prefixed 'AISHUB-'. A live fix wins over a
 * mock one on collision.
 *
 * HONESTY NOTE: free aisstream.io has thin coverage over Indian waters, so its
 * JNPA bbox may return few/zero vessels — AISHub fills that gap with real JNPA
 * traffic. Both live sources are badged 'live' downstream so simulated traffic
 * is never shown as real. (AISHub's public feed anonymises MMSI and coarsens
 * speed; names, types, and positions are genuine — noted in aishub.ts.)
 *
 * Every non-vessel method delegates 1:1 to the base adapter, so KPIs, berths,
 * plan, weather, and what-if behave exactly as in the base mode.
 */

import type {
  ArrivalsDeparturesBlock,
  Berth,
  BerthingPlanEntry,
  KpiSnapshot,
  PortCraftUnit,
  PredictionPoint,
  Vessel,
  WeatherReading,
} from '@/types/domain';
import type { KpiBundle } from '@/types/kpi';
import type {
  ConnectionListener,
  ConnectionState,
  DataAdapter,
  TimeWindow,
  Unsubscribe,
  VesselListener,
  WhatIfResult,
  WhatIfScenario,
} from './types';
import { env } from './config';
import { openAisStream } from './aisstream';
import { openAisHubFeed, type AisHubMapResponse } from './aishub';
import aisHubSample from './mock/aishub.sample.json';
import { validateVessel, TrackQuality, type DqReason } from './quality';

/**
 * Coalesce cache flushes: a burst of AIS frames triggers at most one merged
 * emit per this interval, not one per message (backpressure without UI freeze).
 * Matches ArcGISAdapter's VESSEL_FLUSH_MS.
 */
const VESSEL_FLUSH_MS = 250;

export class LiveOverlayAdapter implements DataAdapter {
  /**
   * Reports the BASE mode. The overlay is additive, not a distinct mode — the
   * header/UI treat this as the base experience with real vessels layered in.
   */
  readonly mode: 'mock' | 'live';

  private readonly base: DataAdapter;

  /** Latest base (mock) fleet, keyed by MMSI, refreshed on every base tick. */
  private baseByMmsi = new Map<string, Vessel>();
  /** Latest live AIS fix per MMSI (the real overlay). */
  private liveByMmsi = new Map<string, Vessel>();
  /** Data-quality track guard (teleport / regression / dedup / staleness). */
  private trackQuality = new TrackQuality();
  /** Rolling count of quarantined live frames by reason, for the DQ surface. */
  private quarantineCounts = new Map<string, number>();

  constructor(base: DataAdapter) {
    this.base = base;
    this.mode = base.mode;
  }

  private now(): number {
    return Date.now();
  }

  /** Count of REAL live vessels currently held (0 is honest, not an error). */
  getLiveVesselCount(): number {
    return this.liveByMmsi.size;
  }

  /** Quarantine tally snapshot (reason code → count) for the live overlay. */
  getQuarantineCounts(): Record<string, number> {
    return Object.fromEntries(this.quarantineCounts);
  }

  private recordQuarantine(reasons: DqReason[]): void {
    for (const r of reasons) {
      this.quarantineCounts.set(r.code, (this.quarantineCounts.get(r.code) ?? 0) + 1);
    }
  }

  /** mock ∪ live, live winning on MMSI collision. */
  private mergedBatch(): Vessel[] {
    const merged = new Map<string, Vessel>(this.baseByMmsi);
    for (const [mmsi, v] of this.liveByMmsi) merged.set(mmsi, v);
    return [...merged.values()];
  }

  subscribeVessels(onBatch: VesselListener, onState?: ConnectionListener): Unsubscribe {
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleFlush = () => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        onBatch(this.mergedBatch());
      }, VESSEL_FLUSH_MS);
    };

    // 1) Base fleet — refresh the mock map on every tick, then re-emit the union.
    //    Base connection state is intentionally NOT forwarded: the status dot
    //    should reflect the LIVE sources (below), which are the real feeds.
    const unsubBase = this.base.subscribeVessels((batch) => {
      this.baseByMmsi = new Map(batch.map((v) => [v.MMSI, v]));
      scheduleFlush();
    });

    // Both live sources run concurrently; either connecting reports 'connected'.
    // We latch a single 'connected' so a later source failure doesn't downgrade
    // the dot while the other source is still delivering real vessels.
    let anyConnected = false;
    const markConnected = () => {
      if (anyConnected) return;
      anyConnected = true;
      onState?.('connected');
    };
    const hasAisStream = Boolean(env.aisStreamToken);
    const hasAisHub = env.aisHub.enabled;
    onState?.(hasAisStream || hasAisHub ? 'connecting' : 'connected');
    if (!hasAisStream && !hasAisHub) markConnected(); // base-only hybrid

    const unsubLive: Array<() => void> = [];

    // 2a) AISStream — global free AIS WebSocket (sparse over Indian waters).
    if (hasAisStream) {
      // Ship name + type arrive in separate ShipStaticData frames, in any order
      // relative to positions — remember them per MMSI and merge both ways.
      const staticByMmsi = new Map<string, { name: string; type: string }>();
      const forwardState: ConnectionListener = (s: ConnectionState) => {
        if (s === 'connected') markConnected();
      };
      unsubLive.push(
        openAisStream({
          token: env.aisStreamToken,
          bbox: env.liveRegion.bbox,
          onState: forwardState,
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
            v.SOURCE = 'live';
            const s = staticByMmsi.get(v.MMSI);
            if (s) {
              v.VESSEL_TYPE = s.type;
              v.VESSEL_NAME = s.name || v.VESSEL_NAME;
            }
            this.liveByMmsi.set(v.MMSI, v);
            scheduleFlush();
          },
          onStatic: (s) => {
            staticByMmsi.set(s.MMSI, { name: s.VESSEL_NAME, type: s.VESSEL_TYPE });
            const existing = this.liveByMmsi.get(s.MMSI);
            if (existing) {
              existing.VESSEL_TYPE = s.VESSEL_TYPE;
              existing.VESSEL_NAME = s.VESSEL_NAME || existing.VESSEL_NAME;
              this.liveByMmsi.set(s.MMSI, existing);
              scheduleFlush();
            }
          },
        })
      );
    }

    // 2b) AISHub — public station feed with REAL JNPA/Nhava Sheva hulls. Polls
    //     map.json (via the dev proxy) every 60s; the vessels it emits already
    //     carry SOURCE='live' and 'AISHUB-'-prefixed keys, so they merge in
    //     without colliding with AISStream's numeric MMSIs.
    if (hasAisHub) {
      unsubLive.push(
        openAisHubFeed({
          station: env.aisHub.station,
          proxyBase: env.aisHub.proxyBase,
          sample: env.aisHub.useSampleFallback ? (aisHubSample as AisHubMapResponse) : undefined,
          onState: (s: ConnectionState) => {
            if (s === 'connected') markConnected();
          },
          onVessels: (vessels) => {
            const now = this.now();
            for (const raw of vessels) {
              // Same DQ gate as AISStream, but against the STATION's coverage box
              // (wider than the tight AISStream JNPA box) so legitimate Mumbai-
              // approaches hulls aren't dropped as OUT_OF_AOI.
              const checked = validateVessel(raw, env.aisHub.aoiBbox);
              if (checked.reasons.length) this.recordQuarantine(checked.reasons);
              if (!checked.vessel) continue;
              const vetted = this.trackQuality.vet(checked.vessel, 'aishub', now);
              if (vetted.reasons.length) this.recordQuarantine(vetted.reasons);
              if (!vetted.vessel) continue;
              vetted.vessel.SOURCE = 'live';
              this.liveByMmsi.set(vetted.vessel.MMSI, vetted.vessel);
            }
            scheduleFlush();
          },
        })
      );
    }

    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      unsubBase();
      for (const u of unsubLive) u();
    };
  }

  // ── Everything else delegates 1:1 to the base adapter ──────────────────────
  getBerths(): Promise<Berth[]> {
    return this.base.getBerths();
  }
  getBerthPlan(window?: TimeWindow): Promise<BerthingPlanEntry[]> {
    return this.base.getBerthPlan(window);
  }
  getKPIs(): Promise<KpiBundle> {
    return this.base.getKPIs();
  }
  getArrivalsDepartures(window?: TimeWindow): Promise<ArrivalsDeparturesBlock[]> {
    return this.base.getArrivalsDepartures(window);
  }
  getDelaySeries(
    kind: 'preBerthing' | 'preSailing',
    window?: TimeWindow
  ): Promise<KpiSnapshot[]> {
    return this.base.getDelaySeries(kind, window);
  }
  getPrediction(window?: TimeWindow): Promise<PredictionPoint[]> {
    return this.base.getPrediction(window);
  }
  getPortCraft(): Promise<PortCraftUnit[]> {
    return this.base.getPortCraft();
  }
  getWeather(): Promise<WeatherReading> {
    return this.base.getWeather();
  }
  getKpiHistory(window?: TimeWindow): Promise<KpiSnapshot[]> {
    return this.base.getKpiHistory(window);
  }
  runWhatIf(scenario: WhatIfScenario): Promise<WhatIfResult> {
    return this.base.runWhatIf(scenario);
  }
}
