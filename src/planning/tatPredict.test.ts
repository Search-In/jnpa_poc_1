/**
 * Tests for the additive TAT feature-model predictor (`tatPredict`). Confirms the
 * structural baseline, monotonic stressor response, the uncertainty band, and the
 * lever→feature bridge (including dredging offsetting siltation).
 */
import { describe, it, expect } from 'vitest';
import { predictTat, tatFeaturesFromLevers, TAT_MODEL, type TatFeatures } from './tatPredict';
import { NEUTRAL_LEVERS, type SimLevers } from '@/sim/simStore';

const L = (patch: Partial<SimLevers>): SimLevers => ({ ...NEUTRAL_LEVERS, ...patch });

const baseFeatures: TatFeatures = {
  parcelTeu: 2355,
  terminalMaxDraftM: 15,
  weatherSeverity: 0,
  rainMmHr: 0,
  netDepthDeltaM: 0,
  pilotsDown: 0,
  tugsDown: 0,
  extraArrivals: 0,
  incidentSeverity: 0,
  berthWindowExtendH: 0,
};

describe('predictTat', () => {
  it('structural baseline: only base + cargo + size, tight band', () => {
    const p = predictTat(baseFeatures);
    const cargo = 2355 * TAT_MODEL.perTeuH;
    const size = (15 - TAT_MODEL.draftRefM) * TAT_MODEL.perDraftMOverH;
    const expected = Number((TAT_MODEL.baseH + cargo + size).toFixed(1));
    expect(p.hoursP50).toBeCloseTo(expected, 1);
    expect(p.sigmaH).toBe(2); // no stressors → ±2 h
    expect(p.contributions).toHaveLength(11);
    expect(p.hoursP10).toBeLessThan(p.hoursP50);
    expect(p.hoursP90).toBeGreaterThan(p.hoursP50);
  });

  it('stressors raise the estimate AND widen the band (monotonic in weather)', () => {
    const calm = predictTat(baseFeatures);
    const rough = predictTat({ ...baseFeatures, weatherSeverity: 0.8 });
    expect(rough.hoursP50).toBeGreaterThan(calm.hoursP50);
    expect(rough.sigmaH).toBeGreaterThan(calm.sigmaH);
  });

  it('incident + depth loss + extended window all add hours', () => {
    const stressed = predictTat({
      ...baseFeatures,
      incidentSeverity: 0.7,
      netDepthDeltaM: -0.5,
      berthWindowExtendH: 6,
    });
    const byFactor = Object.fromEntries(stressed.contributions.map((c) => [c.factor, c.hours]));
    expect(byFactor['Marine incident']).toBeCloseTo(0.7 * TAT_MODEL.incidentH, 1);
    expect(byFactor['Channel depth loss']).toBeCloseTo(0.5 * TAT_MODEL.depthLossPerMH, 1);
    expect(byFactor['Extended berth window']).toBeCloseTo(6 * TAT_MODEL.extendWindowH, 1);
  });

  it('rain contribution is capped', () => {
    const p = predictTat({ ...baseFeatures, rainMmHr: 1000 });
    const rain = p.contributions.find((c) => c.factor === 'Rain')!.hours;
    expect(rain).toBe(TAT_MODEL.rainCapH);
  });
});

describe('tatFeaturesFromLevers', () => {
  const ctx = { parcelTeu: 2355, terminalMaxDraftM: 16.5 };

  it('neutral levers → zero stressor features', () => {
    const f = tatFeaturesFromLevers(NEUTRAL_LEVERS, ctx);
    expect(f.weatherSeverity).toBe(0);
    expect(f.rainMmHr).toBe(0);
    expect(f.netDepthDeltaM).toBe(0);
    expect(f.incidentSeverity).toBe(0);
    expect(f.berthWindowExtendH).toBe(0);
  });

  it('maps new levers (incident = max of spill/accident; dredge offsets siltation)', () => {
    const f = tatFeaturesFromLevers(L({ oilSpill: 0.7, accident: 0.3, channelDepthDeltaM: -0.5, dredgeRestoreM: 0.4, rainMmHr: 12 }), ctx);
    expect(f.incidentSeverity).toBe(0.7);
    expect(f.rainMmHr).toBe(12);
    expect(f.netDepthDeltaM).toBeCloseTo(-0.1, 5);
  });
});
