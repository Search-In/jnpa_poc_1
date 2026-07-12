/**
 * Assembles the 8-card `KpiBundle` from raw domain data + persisted snapshots.
 * Keeps the per-formula maths in `formulas.ts`; this file only orchestrates and
 * attaches targets/trends so the UI gets ready-to-render `KpiValue` objects.
 */

import type { BerthingPlanEntry, KpiSnapshot, PredictionPoint, Vessel } from '@/types/domain';
import type { KpiBundle, KpiKey, KpiValue, TrendPoint } from '@/types/kpi';
import { KPI_TARGETS } from '@/config/targets';
import { deltaPct, round } from './helpers';
import {
  avgPreBerthingDelay,
  avgPreSailingDelay,
  avgVesselTAT,
  berthOccupancyPct,
  forecastAccuracyPct,
  justInTimePct,
  type BerthingEvent,
  type EtaPrediction,
  type JitArrival,
  type PortCall,
  type SailingEvent,
  type BerthInterval,
} from './formulas';

/** All inputs `buildKpiBundle` needs. Pass an explicit `now` for determinism. */
export interface KpiInputs {
  now: number;
  vessels: Vessel[];
  plan: BerthingPlanEntry[];
  predictions: PredictionPoint[];
  berthCount: number;
  /** Persisted snapshots used to build trend sparklines per KPI. */
  snapshots: KpiSnapshot[];
  /** Window for berth-occupancy + general "rolling" calcs (hours). */
  windowHours?: number;
}

function trendOf(snapshots: KpiSnapshot[], pick: (s: KpiSnapshot) => number): TrendPoint[] {
  return snapshots.map((s) => ({ ts: s.TS, value: round(pick(s), 2) }));
}

function makeKpi(key: KpiKey, value: number, trend: TrendPoint[]): KpiValue {
  const t = KPI_TARGETS[key];
  const v = round(value, t.unit === '' ? 0 : 1);
  return {
    key,
    label: t.label,
    value: v,
    unit: t.unit,
    target: t.target,
    deltaPct: deltaPct(v, t.target),
    trend,
  };
}

/** Map completed berthing-plan entries into the formula input shapes. */
function toBerthingEvents(plan: BerthingPlanEntry[]): BerthingEvent[] {
  return plan
    .filter((p) => p.ACTUAL_START !== null)
    .map((p) => ({ ata: p.PLANNED_START, atb: p.ACTUAL_START as number }));
}

function toSailingEvents(plan: BerthingPlanEntry[]): SailingEvent[] {
  return plan
    .filter((p) => p.ACTUAL_END !== null)
    .map((p) => ({ cargoComplete: p.PLANNED_END, atd: p.ACTUAL_END as number }));
}

function toPortCalls(plan: BerthingPlanEntry[]): PortCall[] {
  return plan
    .filter((p) => p.ACTUAL_START !== null)
    .map((p) => ({ ata: p.ACTUAL_START as number, atd: p.ACTUAL_END }));
}

function toJitArrivals(plan: BerthingPlanEntry[]): JitArrival[] {
  return plan
    .filter((p) => p.ACTUAL_START !== null)
    .map((p) => ({ ata: p.ACTUAL_START as number, recommendedSlot: p.PLANNED_START }));
}

function toEtaPredictions(predictions: PredictionPoint[], now: number): EtaPrediction[] {
  // Reference = "now − 12h" stand-in for when the prediction was anchored;
  // the live adapter supplies a real detection time. Held constant for tests.
  const reference = now - 12 * 3_600_000;
  return predictions.map((p) => ({
    reference,
    predictedEta: p.predictedEta,
    actualAta: p.actualAta,
  }));
}

function toBerthIntervals(plan: BerthingPlanEntry[]): BerthInterval[] {
  return plan
    .filter((p) => p.ACTUAL_START !== null)
    .map((p) => ({ start: p.ACTUAL_START as number, end: p.ACTUAL_END }));
}

/**
 * Re-value a KPI card from a freshly-computed number, and reconcile its trend so
 * the sparkline agrees with the headline. The persisted snapshot series is an
 * independent synthetic baseline whose level need not match the formula-computed
 * value; left alone, the gauge could read 0% while the line hovers at 74%, and
 * the line would never react to What-if. We keep the historical SHAPE but retarget
 * it: the newest point lands exactly on the live value, and older points ease
 * toward it (recent points move most), so the tail visibly slips/recovers with
 * the levers while the deep history stays anchored to its baseline.
 */
function revalue(card: KpiValue, value: number): KpiValue {
  const t = KPI_TARGETS[card.key as KpiKey];
  const v = round(value, t.unit === '' ? 0 : 1);
  const n = card.trend.length;
  const trend =
    n === 0
      ? card.trend
      : card.trend.map((p, i) => {
          // weight 0 at the oldest point → 1 at the newest (linear ease-in).
          const w = n === 1 ? 1 : i / (n - 1);
          const blended = p.value * (1 - w) + v * w;
          return { ts: p.ts, value: round(blended, t.unit === '' ? 0 : 1) };
        });
  return { ...card, value: v, deltaPct: deltaPct(v, t.target), trend };
}

/**
 * Recompute the four plan-derived headline cards (pre-berthing delay, avg TAT,
 * JIT, berth occupancy) from an overlaid plan, keeping every other card and all
 * trends/targets from `base`. Lets `SimAdapter` fold lever-driven arrival slip
 * onto the plan and have the SAME formulas re-value the headline KPIs — one
 * causal source shared with the gantt. Pass the same window used to build `base`.
 */
export function recomputePlanKpis(
  base: KpiBundle,
  plan: BerthingPlanEntry[],
  now: number,
  berthCount: number,
  windowHours = 24,
): KpiBundle {
  const windowEnd = now;
  const windowStart = now - windowHours * 3_600_000;
  return {
    ...base,
    preBerthingDelay: revalue(base.preBerthingDelay, avgPreBerthingDelay(toBerthingEvents(plan))),
    preSailingDelay: revalue(base.preSailingDelay, avgPreSailingDelay(toSailingEvents(plan))),
    avgTat: revalue(base.avgTat, avgVesselTAT(toPortCalls(plan))),
    jitPct: revalue(base.jitPct, justInTimePct(toJitArrivals(plan))),
    berthOccupancy: revalue(
      base.berthOccupancy,
      berthOccupancyPct(toBerthIntervals(plan), berthCount, windowStart, windowEnd),
    ),
  };
}

export function buildKpiBundle(input: KpiInputs): KpiBundle {
  const windowHours = input.windowHours ?? 24;
  const windowEnd = input.now;
  const windowStart = input.now - windowHours * 3_600_000;

  const anchored = input.vessels.filter((v) => v.NAV_STATUS === 'anchored').length;
  const approaching = input.vessels.filter((v) => v.NAV_STATUS === 'approaching').length;

  return {
    preBerthingDelay: makeKpi(
      'preBerthingDelay',
      avgPreBerthingDelay(toBerthingEvents(input.plan)),
      trendOf(input.snapshots, (s) => s.PRE_BERTH_DELAY)
    ),
    preSailingDelay: makeKpi(
      'preSailingDelay',
      avgPreSailingDelay(toSailingEvents(input.plan)),
      trendOf(input.snapshots, (s) => s.PRE_SAIL_DELAY)
    ),
    avgTat: makeKpi(
      'avgTat',
      avgVesselTAT(toPortCalls(input.plan)),
      trendOf(input.snapshots, (s) => s.AVG_TAT)
    ),
    jitPct: makeKpi(
      'jitPct',
      justInTimePct(toJitArrivals(input.plan)),
      trendOf(input.snapshots, (s) => s.JIT_PCT)
    ),
    forecastAccuracy: makeKpi(
      'forecastAccuracy',
      forecastAccuracyPct(toEtaPredictions(input.predictions, input.now)),
      trendOf(input.snapshots, (s) => s.FORECAST_ACC)
    ),
    berthOccupancy: makeKpi(
      'berthOccupancy',
      berthOccupancyPct(toBerthIntervals(input.plan), input.berthCount, windowStart, windowEnd),
      trendOf(input.snapshots, (s) => s.BERTH_OCC)
    ),
    anchored: makeKpi('anchored', anchored, trendOf(input.snapshots, (s) => s.ANCHORED)),
    approaching: makeKpi(
      'approaching',
      approaching,
      trendOf(input.snapshots, (s) => s.APPROACHING)
    ),
  };
}
