import { describe, it, expect } from 'vitest';
import {
  DEMO_TAT_INPUT,
  contributionsFromBreakdown,
  mapM3PredictResponse,
} from './m3Tat';

describe('m3Tat', () => {
  it('keeps the UC1-068 rehearsal pin at 4000 TEU / 15.0 m / lightgbm', () => {
    expect(DEMO_TAT_INPUT.parcel_teu).toBe(4000);
    expect(DEMO_TAT_INPUT.draft_m).toBe(15.0);
    expect(DEMO_TAT_INPUT.engine).toBe('lightgbm');
  });

  it('maps P10/P50/P90 and artifact provenance from the wire payload', () => {
    const mapped = mapM3PredictResponse({
      p10_hours: 38.1,
      p50_hours: 42.5,
      p90_hours: 49.2,
      sigma_hours: 3.4,
      engine: 'lightgbm',
      model_version: 'm3-additive-v1.2.0',
      artifact_sha256: '27038b98ef02ffba6206bfdedaa0cc7498678307a0fb21ea586263cdb3ceb4c7',
      holdout_mae_hours: 2.489586189526652,
      artifact_mode: 'TRAINED_ARTIFACT',
      breakdown: {
        contributions: [
          { factor: 'parcel_teu', contribution_h: 16 },
          { factor: 'queue', contribution_h: 4 },
          { factor: 'noise', contribution_h: 0 },
        ],
      },
    });
    expect(mapped.p50_hours).toBe(42.5);
    expect(mapped.artifact_sha256?.startsWith('27038b98')).toBe(true);
    expect(mapped.holdout_mae_hours).toBeCloseTo(2.49, 2);
    expect(mapped.contributions.map((c) => c.factor)).toEqual(['parcel_teu', 'queue']);
  });

  it('ignores empty contribution lists', () => {
    expect(contributionsFromBreakdown(null)).toEqual([]);
    expect(contributionsFromBreakdown({})).toEqual([]);
  });
});
