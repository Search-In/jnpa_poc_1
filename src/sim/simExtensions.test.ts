/**
 * Tests for the UC-1 ADDITIVE sim extensions (rain, oil spill, marine accident,
 * extended berth window, dredging) — including regression guards proving the
 * baseline (neutral levers) behaviour is byte-identical to before.
 */
import { describe, it, expect } from 'vitest';
import { NEUTRAL_LEVERS, type SimLevers } from './simStore';
import {
  weatherAt,
  controllingDepthM,
  netChannelDepthDeltaM,
  pilotageSuspended,
  incidentSuspendsMovements,
  channelSegmentsClosed,
} from './derive';
import { applyPlanLevers } from './applySim';
import { makeBerthingPlan } from '@/data/mock/fixtures';
import type { WeatherReading } from '@/types/domain';

const L = (patch: Partial<SimLevers>): SimLevers => ({ ...NEUTRAL_LEVERS, ...patch });
const T0 = 1_700_000_000_000;

describe('regression — neutral levers are identical to the baseline', () => {
  it('weatherAt with neutral levers: no rain, unchanged visibility', () => {
    const w = weatherAt(0, NEUTRAL_LEVERS);
    expect(w.rainMmHr).toBe(0);
    expect(w.visibilityNm).toBe(8.0); // 8 − 0·sev − 0·rain
  });

  it('controllingDepthM / netChannelDepthDeltaM neutral', () => {
    expect(netChannelDepthDeltaM(NEUTRAL_LEVERS)).toBe(0);
    // controllingDepthM neutral == base only (delta 0)
    expect(controllingDepthM(NEUTRAL_LEVERS)).toBe(controllingDepthM(L({})));
  });

  it('applyPlanLevers with neutral levers returns the plan unchanged', () => {
    const plan = makeBerthingPlan(T0);
    expect(applyPlanLevers(plan, NEUTRAL_LEVERS)).toEqual(plan);
  });

  it('incident helpers are inert at baseline', () => {
    expect(incidentSuspendsMovements(NEUTRAL_LEVERS)).toBe(false);
    expect(channelSegmentsClosed(NEUTRAL_LEVERS)).toEqual([]);
  });
});

describe('rain (weather enhancement)', () => {
  it('reports rain intensity and cuts visibility (existing fields intact)', () => {
    const w = weatherAt(0, L({ rainMmHr: 40 }));
    expect(w.rainMmHr).toBe(40);
    // 8 − min(6, 40·0.35) = 8 − 6 = 2.0
    expect(w.visibilityNm).toBe(2.0);
    // wind/wave unchanged from the calm baseline (no severity set)
    expect(w.windKt).toBe(weatherAt(0, NEUTRAL_LEVERS).windKt);
    expect(w.seaStateM).toBe(weatherAt(0, NEUTRAL_LEVERS).seaStateM);
  });

  it('pilotage suspends below the ~1 nm visibility minimum', () => {
    const lowVis: WeatherReading = { TS: 0, windKt: 12, windDir: 225, seaStateM: 1.0, visibilityNm: 0.5, tideM: 2.6 };
    const goodVis: WeatherReading = { ...lowVis, visibilityNm: 8 };
    expect(pilotageSuspended(lowVis)).toBe(true);
    expect(pilotageSuspended(goodVis)).toBe(false);
  });
});

describe('oil spill + marine accident (incidents)', () => {
  it('suspend movements at/above 0.3 severity', () => {
    expect(incidentSuspendsMovements(L({ oilSpill: 0.5 }))).toBe(true);
    expect(incidentSuspendsMovements(L({ accident: 0.6 }))).toBe(true);
    expect(incidentSuspendsMovements(L({ oilSpill: 0.2 }))).toBe(false);
  });

  it('oil spill closes fairway segments progressively', () => {
    expect(channelSegmentsClosed(L({ oilSpill: 0.4 }))).toEqual(['CH-INNER']);
    expect(channelSegmentsClosed(L({ oilSpill: 0.7 }))).toEqual(['CH-INNER', 'CH-TURN']);
    expect(channelSegmentsClosed(L({ oilSpill: 0.9 }))).toEqual(['CH-INNER', 'CH-TURN', 'CH-QUAY']);
  });

  it('an incident pushes berthing actuals later (plan slip)', () => {
    const plan = makeBerthingPlan(T0);
    const i = plan.findIndex((p) => p.ACTUAL_START !== null);
    const slipped = applyPlanLevers(plan, L({ oilSpill: 0.5 }));
    expect(slipped[i].ACTUAL_START!).toBeGreaterThan(plan[i].ACTUAL_START!);
  });
});

describe('extended berth window → TAT grows (not just shifts)', () => {
  it('lengthens the alongside interval by the extension hours', () => {
    const plan = makeBerthingPlan(T0);
    const i = plan.findIndex((p) => p.ACTUAL_START !== null && p.ACTUAL_END !== null);
    const ext = applyPlanLevers(plan, L({ berthWindowExtendH: 6 }));
    // ACTUAL_START unchanged, ACTUAL_END +6h → (END−START) grows by 6h.
    expect(ext[i].ACTUAL_START).toBe(plan[i].ACTUAL_START);
    const beforeTat = plan[i].ACTUAL_END! - plan[i].ACTUAL_START!;
    const afterTat = ext[i].ACTUAL_END! - ext[i].ACTUAL_START!;
    expect(afterTat - beforeTat).toBeCloseTo(6 * 3_600_000, -3);
  });
});

describe('dredging offsets siltation (end-to-end depth)', () => {
  it('restore metres add back onto the controlling depth', () => {
    const silt = controllingDepthM(L({ channelDepthDeltaM: -0.5 }));
    const dredged = controllingDepthM(L({ channelDepthDeltaM: -0.5, dredgeRestoreM: 0.4 }));
    expect(netChannelDepthDeltaM(L({ channelDepthDeltaM: -0.5, dredgeRestoreM: 0.4 }))).toBeCloseTo(-0.1, 5);
    expect(dredged).toBeGreaterThan(silt);
    expect(Number((dredged - silt).toFixed(2))).toBe(0.4);
  });

  it('dredging reduces the siltation-driven plan slip', () => {
    const plan = makeBerthingPlan(T0);
    const i = plan.findIndex((p) => p.ACTUAL_START !== null);
    const siltOnly = applyPlanLevers(plan, L({ channelDepthDeltaM: -0.5 }));
    const dredged = applyPlanLevers(plan, L({ channelDepthDeltaM: -0.5, dredgeRestoreM: 0.4 }));
    const siltSlip = siltOnly[i].ACTUAL_START! - plan[i].ACTUAL_START!;
    const dredgedSlip = dredged[i].ACTUAL_START! - plan[i].ACTUAL_START!;
    expect(dredgedSlip).toBeLessThan(siltSlip);
  });
});
