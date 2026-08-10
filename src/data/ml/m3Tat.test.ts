import { describe, expect, it } from 'vitest';
import { DEMO_TAT_INPUT, M3_PREDICT_PATH } from './m3Tat';

describe('M3 client contract', () => {
  it('targets the documented endpoint suffix', () => {
    expect(M3_PREDICT_PATH).toBe('/uc1/m3/predict');
  });
});

describe('DEMO_TAT_INPUT', () => {
  it('pins the evaluator curl: 4,000 TEU at 15.0 m on the learned engine', () => {
    // The card prints these two numbers next to the result, and the UC1-068
    // decision is that the screen and the terminal must agree. Changing them
    // silently breaks that equivalence.
    expect(DEMO_TAT_INPUT.parcel_teu).toBe(4000);
    expect(DEMO_TAT_INPUT.draft_m).toBe(15.0);
    expect(DEMO_TAT_INPUT.engine).toBe('lightgbm');
  });

  it('stays inside the service field bounds', () => {
    const i = DEMO_TAT_INPUT;
    expect(i.parcel_teu).toBeGreaterThanOrEqual(0);
    expect(i.parcel_teu).toBeLessThanOrEqual(30000);
    expect(i.draft_m).toBeGreaterThan(0);
    expect(i.draft_m).toBeLessThanOrEqual(25);
  });

  it('submits no outcome field — the leakage firewall', () => {
    // The request schema is itself part of the firewall: every field must be
    // knowable at the ETB decision, so nothing may name a realised outcome.
    const banned = /(^|_)(tat|actual|atd|outcome|duration)($|_)/i;
    for (const key of Object.keys(DEMO_TAT_INPUT)) {
      expect(banned.test(key), `${key} looks like an outcome`).toBe(false);
    }
  });
});
