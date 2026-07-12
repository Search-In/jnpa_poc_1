/**
 * Regression tests for the JIT-always-0% bug and lever-driven KPI reactivity.
 *
 * Two guarantees:
 *  1. The base fixture yields a live, realistic JIT (not the old flat 0%, not a
 *     trivial 100%) with NO What-if running — arrival actuals straddle the JIT
 *     tolerance window.
 *  2. What-if levers (weather, pilots down, berths out, extra arrivals) slip the
 *     plan actuals through applyPlanLevers, so the SAME formulas recompute a
 *     LOWER JIT and HIGHER pre-berthing delay — the honest single-source model.
 */
import { describe, it, expect } from 'vitest';
import { buildKpiBundle, recomputePlanKpis } from '@/kpi';
import { makeBerthingPlan, makeKpiSnapshots, makePredictions, makeVessels, BERTHS } from '@/data/mock/fixtures';
import { applyPlanLevers } from './applySim';
import { NEUTRAL_LEVERS, type SimLevers } from './simStore';

const T0 = 1_700_000_000_000;

function baseBundle(now = T0) {
  return buildKpiBundle({
    now,
    vessels: makeVessels(now, 0),
    plan: makeBerthingPlan(now),
    predictions: makePredictions(now),
    berthCount: BERTHS.length,
    snapshots: makeKpiSnapshots(now),
    windowHours: 24,
  });
}

describe('JIT baseline (no What-if)', () => {
  it('is a live, non-trivial value — not the old flat 0% or a trivial 100%', () => {
    const jit = baseBundle().jitPct.value;
    expect(jit).toBeGreaterThan(20);
    expect(jit).toBeLessThan(100);
  });

  it('recomputePlanKpis with the unaltered plan reproduces the baseline JIT', () => {
    const base = baseBundle();
    const same = recomputePlanKpis(base, makeBerthingPlan(T0), T0, BERTHS.length);
    expect(same.jitPct.value).toBe(base.jitPct.value);
  });
});

describe('What-if levers move JIT and delays via slipped actuals', () => {
  const stress: SimLevers = {
    ...NEUTRAL_LEVERS,
    weatherSeverity: 0.85,
    pilotsDown: 2,
  };

  it('neutral levers are an identity on the plan (honest baseline preserved)', () => {
    const plan = makeBerthingPlan(T0);
    expect(applyPlanLevers(plan, NEUTRAL_LEVERS)).toEqual(plan);
  });

  it('stress levers slip arrivals later, lowering JIT and raising pre-berthing delay', () => {
    const base = baseBundle();
    const slipped = applyPlanLevers(makeBerthingPlan(T0), stress);
    const worse = recomputePlanKpis(base, slipped, T0, BERTHS.length);

    expect(worse.jitPct.value).toBeLessThan(base.jitPct.value);
    expect(worse.preBerthingDelay.value).toBeGreaterThan(base.preBerthingDelay.value);
  });

  it('never touches entries without an actual arrival', () => {
    const plan = makeBerthingPlan(T0);
    const slipped = applyPlanLevers(plan, stress);
    plan.forEach((p, i) => {
      if (p.ACTUAL_START === null) expect(slipped[i].ACTUAL_START).toBeNull();
    });
  });
});
