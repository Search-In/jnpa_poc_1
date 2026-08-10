/**
 * Assembles the 8-card `KpiBundle` from raw domain data + persisted snapshots.
 * Keeps the per-formula maths in `formulas.ts`; this file only orchestrates and
 * attaches targets/trends/UI-041 anatomy so the UI gets ready-to-render cards.
 */

import type { BerthingPlanEntry, KpiSnapshot, PredictionPoint, Vessel } from '@/types/domain';
import type { KpiBundle, KpiKey, KpiValue, TrendPoint } from '@/types/kpi';
import { KPI_ANATOMY, type KpiProvenance } from '@/config/kpiAnatomy';
import { KPI_TARGETS } from '@/config/targets';
import { deltaPct, hoursBetween, percentile, round } from './helpers';
import {
  avgPreBerthingDelay,
  avgPreSailingDelay,
  avgVesselTAT,
  berthOccupancyPct,
  craftPerformance,
  forecastAccuracyPct,
  justInTimePct,
  type BerthingEvent,
  type CraftJob,
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
  /** Port-craft jobs for the Port Craft Optimization card. */
  craftJobs?: CraftJob[];
  /** Provenance chip for every card in this bundle (SIM demo vs LIVE-CORPUS). */
  provenance?: KpiProvenance;
}

function trendOf(snapshots: KpiSnapshot[], pick: (s: KpiSnapshot) => number): TrendPoint[] {
  return snapshots.map((s) => ({ ts: s.TS, value: round(pick(s), 2) }));
}

function anatomyMeta(
  key: KpiKey,
  sampleN: number,
  extras?: Partial<KpiValue> & { unmeasurableNote?: string },
): Partial<KpiValue> {
  const a = KPI_ANATOMY[key];
  const unmeasurable = sampleN === 0;
  const pub = a.publishedBaseline;
  const vsBaselinePct =
    !unmeasurable &&
    pub &&
    extras?.value !== undefined &&
    Number.isFinite(extras.value) &&
    pub.value !== 0
      ? deltaPct(extras.value as number, pub.value)
      : extras?.vsBaselinePct;

  return {
    definition: a.definition,
    basis: a.basis,
    baselineSource: a.baselineSource,
    sampleN,
    baselineValue: pub?.value,
    baselinePeriod: pub?.period,
    vsBaselinePct,
    note: unmeasurable
      ? (extras?.unmeasurableNote ?? `not measurable — n=0 for ${a.name}`)
      : extras?.note,
    p50: extras?.p50,
    p90: extras?.p90,
    breakdown: extras?.breakdown,
    provenance: extras?.provenance,
  };
}

function makeKpi(
  key: KpiKey,
  value: number,
  trend: TrendPoint[],
  sampleN: number,
  provenance: KpiProvenance,
  extras?: Partial<KpiValue> & { unmeasurableNote?: string },
): KpiValue {
  const t = KPI_TARGETS[key];
  const unmeasurable = sampleN === 0;
  const v = unmeasurable ? 0 : round(value, t.unit === '' || t.unit === 'vessels' ? 0 : 1);
  const meta = anatomyMeta(key, sampleN, { ...extras, value: v, provenance });
  return {
    key,
    label: t.label,
    value: v,
    unit: t.unit,
    target: t.target,
    deltaPct: unmeasurable ? 0 : deltaPct(v, t.target),
    trend: unmeasurable ? [] : trend,
    ...meta,
    provenance,
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
  const v = round(value, t.unit === '' || t.unit === 'vessels' ? 0 : 1);
  const n = card.trend.length;
  const trend =
    n === 0
      ? card.trend
      : card.trend.map((p, i) => {
          // weight 0 at the oldest point → 1 at the newest (linear ease-in).
          const w = n === 1 ? 1 : i / (n - 1);
          const blended = p.value * (1 - w) + v * w;
          return { ts: p.ts, value: round(blended, t.unit === '' || t.unit === 'vessels' ? 0 : 1) };
        });
  return { ...card, value: v, deltaPct: deltaPct(v, t.target), trend, sampleN: card.sampleN || 1, note: undefined };
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
  const provenance = input.provenance ?? 'SIM';

  const berthingEvents = toBerthingEvents(input.plan);
  const sailingEvents = toSailingEvents(input.plan);
  const portCalls = toPortCalls(input.plan);
  const completedCalls = portCalls.filter((c): c is { ata: number; atd: number } => c.atd !== null);
  const tatHours = completedCalls.map((c) => hoursBetween(c.ata, c.atd));
  const jitArrivals = toJitArrivals(input.plan);
  const etaPreds = toEtaPredictions(input.predictions, input.now);
  const etaWithActual = etaPreds.filter((p) => p.actualAta !== null);

  const anchoredN = input.vessels.filter((v) => v.NAV_STATUS === 'anchored').length;
  const approachingN = input.vessels.filter((v) => v.NAV_STATUS === 'approaching').length;

  const craftJobs = input.craftJobs ?? [];
  const craftStats = craftPerformance(craftJobs);
  const craftUtil =
    craftStats.length === 0
      ? 0
      : craftStats.reduce((s, c) => s + c.utilisationPct, 0) / craftStats.length;
  const craftN = craftJobs.length;

  const delaySamples = berthingEvents.map((e) =>
    Math.max(0, hoursBetween(e.ata + 1.5 * 3_600_000, e.atb)),
  );
  const sailSamples = sailingEvents.map((e) =>
    Math.max(0, hoursBetween(e.cargoComplete + 2 * 3_600_000, e.atd)),
  );

  return {
    jitPct: makeKpi(
      'jitPct',
      justInTimePct(jitArrivals),
      trendOf(input.snapshots, (s) => s.JIT_PCT),
      jitArrivals.length,
      provenance,
      { unmeasurableNote: 'not measurable — no berthing-plan arrivals with ATA in window' },
    ),
    preBerthingDelay: makeKpi(
      'preBerthingDelay',
      avgPreBerthingDelay(berthingEvents),
      trendOf(input.snapshots, (s) => s.PRE_BERTH_DELAY),
      berthingEvents.length,
      provenance,
      {
        p50: berthingEvents.length ? round(percentile(delaySamples, 50), 1) : null,
        p90: berthingEvents.length ? round(percentile(delaySamples, 90), 1) : null,
        unmeasurableNote: 'not measurable — no calls with ATA/ATB pairing in window',
      },
    ),
    preSailingDelay: makeKpi(
      'preSailingDelay',
      avgPreSailingDelay(sailingEvents),
      trendOf(input.snapshots, (s) => s.PRE_SAIL_DELAY),
      sailingEvents.length,
      provenance,
      {
        p50: sailingEvents.length ? round(percentile(sailSamples, 50), 1) : null,
        p90: sailingEvents.length ? round(percentile(sailSamples, 90), 1) : null,
        unmeasurableNote: 'not measurable — no calls with cargo-complete/ATD pairing',
      },
    ),
    avgTat: makeKpi(
      'avgTat',
      avgVesselTAT(portCalls),
      trendOf(input.snapshots, (s) => s.AVG_TAT),
      completedCalls.length,
      provenance,
      {
        p50: completedCalls.length ? round(percentile(tatHours, 50), 1) : null,
        p90: completedCalls.length ? round(percentile(tatHours, 90), 1) : null,
        unmeasurableNote: 'not measurable — no completed calls with both ATA and ATD',
      },
    ),
    portCraftOptimization: makeKpi(
      'portCraftOptimization',
      craftUtil,
      [],
      craftN,
      provenance,
      {
        unmeasurableNote: 'not measurable — port-craft register empty at anchor',
      },
    ),
    forecastAccuracy: makeKpi(
      'forecastAccuracy',
      forecastAccuracyPct(etaPreds),
      trendOf(input.snapshots, (s) => s.FORECAST_ACC),
      etaWithActual.length,
      provenance,
      {
        unmeasurableNote: 'not measurable — no predicted-vs-actual ETA pairs in window',
      },
    ),
    berthOccupancy: makeKpi(
      'berthOccupancy',
      berthOccupancyPct(toBerthIntervals(input.plan), input.berthCount, windowStart, windowEnd),
      trendOf(input.snapshots, (s) => s.BERTH_OCC),
      input.berthCount,
      provenance,
      {
        unmeasurableNote: 'not measurable — berth register empty',
      },
    ),
    anchored: makeKpi(
      'anchored',
      anchoredN + approachingN,
      trendOf(input.snapshots, (s) => s.ANCHORED + s.APPROACHING),
      input.vessels.length,
      provenance,
      {
        breakdown: `${anchoredN} anchored · ${approachingN} approaching`,
        unmeasurableNote: 'not measurable — no vessels in the live set',
      },
    ),
  };
}
