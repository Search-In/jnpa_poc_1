/**
 * The KPI sparkline must agree with the headline value and react to What-if.
 * `recomputePlanKpis` retargets each plan-derived card's trend so its newest
 * point equals the live computed value (no gauge-vs-line mismatch) while the
 * historical shape is preserved, and the tail slips when a lever worsens the KPI.
 */
import { describe, it, expect } from 'vitest';
import { buildKpiBundle, recomputePlanKpis } from '@/kpi';
import { makeBerthingPlan, makeKpiSnapshots, makePredictions, makeVessels, BERTHS } from '@/data/mock/fixtures';
import { applyPlanLevers } from '@/sim/applySim';
import { NEUTRAL_LEVERS } from '@/sim/simStore';

const T0 = 1_700_000_000_000;

function base() {
  return buildKpiBundle({
    now: T0,
    vessels: makeVessels(T0, 0),
    plan: makeBerthingPlan(T0),
    predictions: makePredictions(T0),
    berthCount: BERTHS.length,
    snapshots: makeKpiSnapshots(T0),
    windowHours: 24,
  });
}

const last = (t: { value: number }[]) => t[t.length - 1].value;

describe('sparkline trend reconciles to the live value', () => {
  it('newest trend point equals the headline value at rest (no gauge/line mismatch)', () => {
    const b = base();
    const neutral = recomputePlanKpis(b, applyPlanLevers(makeBerthingPlan(T0), NEUTRAL_LEVERS), T0, BERTHS.length);
    for (const key of ['jitPct', 'preBerthingDelay', 'avgTat', 'berthOccupancy'] as const) {
      expect(last(neutral[key].trend), `${key} trend endpoint`).toBe(neutral[key].value);
    }
  });

  it('keeps the oldest historical point (shape preserved, not flattened)', () => {
    const b = base();
    const neutral = recomputePlanKpis(b, makeBerthingPlan(T0), T0, BERTHS.length);
    // Oldest point unchanged from the base synthetic history.
    expect(neutral.jitPct.trend[0].value).toBe(b.jitPct.trend[0].value);
  });

  it('trend tail slips when a lever worsens JIT', () => {
    const b = base();
    const neutral = recomputePlanKpis(b, applyPlanLevers(makeBerthingPlan(T0), NEUTRAL_LEVERS), T0, BERTHS.length);
    const stressed = recomputePlanKpis(
      b,
      applyPlanLevers(makeBerthingPlan(T0), { ...NEUTRAL_LEVERS, pilotsDown: 2 }),
      T0,
      BERTHS.length,
    );
    expect(last(stressed.jitPct.trend)).toBeLessThan(last(neutral.jitPct.trend));
    expect(last(stressed.jitPct.trend)).toBe(stressed.jitPct.value);
  });
});
