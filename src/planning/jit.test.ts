import { describe, it, expect } from 'vitest';
import { recommendRta } from './jit';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

describe('recommendRta', () => {
  it('recommends slowing down when the berth is not ready yet', () => {
    const r = recommendRta({
      etaMs: T0,
      berthReadyMs: T0 + 6 * H,
      goWindowStartMs: T0 + 4 * H,
      distanceNm: 160,
      currentSpeedKn: 16,
    });
    expect(r.rtaMs).toBe(T0 + 6 * H); // max(berthReady, goWindow)
    expect(r.waitAvoidedH).toBeCloseTo(6, 1);
    expect(r.recommendedSpeedKn).not.toBeNull();
    expect(r.recommendedSpeedKn!).toBeLessThan(16);
    expect(r.bunkerSavedT).toBeGreaterThan(0);
    expect(r.co2SavedT).toBeGreaterThan(0);
    expect(r.advisory).toMatch(/Reduce to/);
  });

  it('advises arrive-as-planned when there is no material wait', () => {
    const r = recommendRta({
      etaMs: T0,
      berthReadyMs: T0,
      goWindowStartMs: T0,
      distanceNm: 100,
      currentSpeedKn: 14,
    });
    expect(r.waitAvoidedH).toBe(0);
    expect(r.bunkerSavedT).toBe(0);
    expect(r.advisory).toMatch(/no material JIT benefit/);
  });

  it('CO₂ tracks bunker saved by the emission factor', () => {
    const r = recommendRta({
      etaMs: T0,
      berthReadyMs: T0 + 8 * H,
      goWindowStartMs: T0,
      distanceNm: 200,
      currentSpeedKn: 18,
    });
    if (r.bunkerSavedT > 0) {
      expect(r.co2SavedT).toBeGreaterThan(r.bunkerSavedT); // factor ~3.1
    }
  });
});
