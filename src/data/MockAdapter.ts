/**
 * MockAdapter — fully offline implementation of `DataAdapter`.
 *
 * Runs the entire UI + KPI engine with zero credentials so the dashboard demos
 * immediately (`VITE_DATA_MODE=mock`). It ticks a fake AIS stream on an
 * interval and serves all queries from the deterministic JNPA fixtures.
 */

import type {
  ArrivalsDeparturesBlock,
  Berth,
  BerthingPlanEntry,
  KpiSnapshot,
  PortCraftUnit,
  PredictionPoint,
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
import {
  BERTHS,
  makeBerthingPlan,
  makeKpiSnapshots,
  makePortCraft,
  makePredictions,
  makeVessels,
  makeWeather,
} from './mock/fixtures';

const H = 3_600_000;
const STREAM_INTERVAL_MS = 3000;

function resolveWindow(window: TimeWindow | undefined, now: number): { from: number; to: number } {
  const to = window?.to ?? now;
  const from = window?.from ?? to - (window?.lastHours ?? 24) * H;
  return { from, to };
}

export class MockAdapter implements DataAdapter {
  readonly mode = 'mock' as const;

  private tick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private vesselListeners = new Set<VesselListener>();
  private stateListeners = new Set<ConnectionListener>();

  /** Read the clock lazily so tests can stub it; app uses the real clock. */
  private now(): number {
    return Date.now();
  }

  subscribeVessels(onBatch: VesselListener, onState?: ConnectionListener): Unsubscribe {
    this.vesselListeners.add(onBatch);
    if (onState) this.stateListeners.add(onState);

    // Emit initial state + first batch synchronously so the UI paints at once.
    onState?.('connecting');
    queueMicrotask(() => {
      onState?.('connected');
      onBatch(makeVessels(this.now(), this.tick));
    });

    if (!this.timer) this.startStream();

    return () => {
      this.vesselListeners.delete(onBatch);
      if (onState) this.stateListeners.delete(onState);
      if (this.vesselListeners.size === 0) this.stopStream();
    };
  }

  private startStream(): void {
    this.timer = setInterval(() => {
      this.tick += 1;
      const batch = makeVessels(this.now(), this.tick);
      for (const l of this.vesselListeners) l(batch);
    }, STREAM_INTERVAL_MS);
  }

  private stopStream(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const l of this.stateListeners) l('closed');
  }

  async getBerths(): Promise<Berth[]> {
    return BERTHS;
  }

  async getBerthPlan(window?: TimeWindow): Promise<BerthingPlanEntry[]> {
    const now = this.now();
    const { from, to } = resolveWindow(window, now);
    return makeBerthingPlan(now).filter(
      (p) => p.PLANNED_END >= from && p.PLANNED_START <= to
    );
  }

  async getKPIs(): Promise<KpiBundle> {
    const now = this.now();
    return buildKpiBundle({
      now,
      vessels: makeVessels(now, this.tick),
      plan: makeBerthingPlan(now),
      predictions: makePredictions(now),
      berthCount: BERTHS.length,
      snapshots: makeKpiSnapshots(now),
      windowHours: 24,
    });
  }

  async getArrivalsDepartures(window?: TimeWindow): Promise<ArrivalsDeparturesBlock[]> {
    const now = this.now();
    const { from, to } = resolveWindow(window, now);
    return bucketArrivalsDepartures(makeBerthingPlan(now), from, to);
  }

  async getDelaySeries(
    _kind: 'preBerthing' | 'preSailing',
    window?: TimeWindow
  ): Promise<KpiSnapshot[]> {
    // The snapshot carries both delay fields; the widget picks the one it needs.
    return this.getKpiHistory(window);
  }

  async getPrediction(window?: TimeWindow): Promise<PredictionPoint[]> {
    const now = this.now();
    const { from, to } = resolveWindow(window, now);
    return makePredictions(now).filter((p) => p.predictedEta >= from && p.predictedEta <= to);
  }

  async getPortCraft(): Promise<PortCraftUnit[]> {
    return makePortCraft(this.now());
  }

  async getWeather(): Promise<WeatherReading> {
    return makeWeather(this.now(), this.tick);
  }

  async getKpiHistory(window?: TimeWindow): Promise<KpiSnapshot[]> {
    const now = this.now();
    const { from, to } = resolveWindow(window, now);
    return makeKpiSnapshots(now).filter((s) => s.TS >= from && s.TS <= to);
  }

  async runWhatIf(scenario: WhatIfScenario): Promise<WhatIfResult> {
    const now = this.now();
    const bundle = await this.getKPIs();
    return computeWhatIf(scenario, bundle.jitPct.value, bundle.avgTat.value, now);
  }
}

// ── Pure helpers (exported for unit testing) ─────────────────────────────────

/** Bucket plan arrivals (ACTUAL_START) and departures (ACTUAL_END) into 4h blocks. */
export function bucketArrivalsDepartures(
  plan: BerthingPlanEntry[],
  from: number,
  to: number
): ArrivalsDeparturesBlock[] {
  const BLOCK = 4 * H;
  const blocks: ArrivalsDeparturesBlock[] = [];
  for (let t = from; t < to; t += BLOCK) {
    const blockEnd = t + BLOCK;
    const arrivals = plan.filter(
      (p) => p.ACTUAL_START !== null && p.ACTUAL_START >= t && p.ACTUAL_START < blockEnd
    ).length;
    const departures = plan.filter(
      (p) => p.ACTUAL_END !== null && p.ACTUAL_END >= t && p.ACTUAL_END < blockEnd
    ).length;
    blocks.push({
      blockStart: t,
      label: blockLabel(t),
      arrivals,
      departures,
    });
  }
  return blocks;
}

function blockLabel(ts: number): string {
  // IST = UTC+5:30. Label by IST hour to match the operator's clock.
  const istHour = Math.floor(((ts + 5.5 * H) % (24 * H)) / H);
  const end = (istHour + 4) % 24;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(istHour)}:00–${pad(end)}:00`;
}

/**
 * What-If stub: recompute JIT% and avg TAT under a hypothetical delay / berth
 * shift / weather penalty. Deliberately simple — a transparent linear model the
 * live adapter can later replace with a real recompute over the feature data.
 */
export function computeWhatIf(
  scenario: WhatIfScenario,
  jitBefore: number,
  tatBefore: number,
  _now: number
): WhatIfResult {
  const delay = scenario.delayHours ?? 0;
  const severity = scenario.weatherSeverity ?? 0;
  const notes: string[] = [];

  // Each hour of injected delay nudges one arrival out of the JIT window and
  // adds to dwell; weather severity scales both effects.
  const penaltyFactor = 1 + severity;
  const jitDrop = Math.min(jitBefore, delay * 5 * penaltyFactor);
  const tatRise = delay * penaltyFactor;

  if (scenario.delayVesselMmsi && delay > 0) {
    notes.push(`Delaying ${scenario.delayVesselMmsi} by ${delay}h`);
  }
  if (scenario.shiftToBerthId) {
    notes.push(`Shift to berth ${scenario.shiftToBerthId} (no TAT penalty assumed)`);
  }
  if (severity > 0) {
    notes.push(`Weather severity ${Math.round(severity * 100)}% applied`);
  }

  return {
    jitPctBefore: jitBefore,
    jitPctAfter: Math.max(0, Number((jitBefore - jitDrop).toFixed(1))),
    avgTatBefore: tatBefore,
    avgTatAfter: Number((tatBefore + tatRise).toFixed(1)),
    note: notes.length ? notes.join('; ') : 'No scenario inputs — baseline unchanged',
  };
}
