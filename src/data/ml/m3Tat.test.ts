import { describe, expect, it } from 'vitest';
import { DEMO_TAT_INPUT, M3_PREDICT_PATH, toM3Result, type M3PredictWire } from './m3Tat';

const WIRE: M3PredictWire = {
  call_id: 'C-DEMO-1',
  vessel_id: 'V-DEMO-1',
  engine: 'lightgbm',
  p10_hours: 28.4,
  p50_hours: 36.2,
  p90_hours: 47.9,
  band_width_hours: 19.5,
  sigma_hours: 7.6,
  stressor_count: 3,
  stressors_active: ['severe_weather', 'pilots_down', 'deep_draft_tight'],
  quantile_crossing_corrected: false,
  clamped_at_min: false,
  model_version: 'm3-coef-2.1.0',
  breakdown: {
    base_hours: 18,
    contributions: [
      { factor: 'parcel_teu', contribution_h: 8.0, share_pct: 40, direction: 'increase' },
      { factor: 'severe_weather_flag', contribution_h: 3.5, direction: 'increase' },
      { factor: 'pilots_down', contribution_h: 1.2, direction: 'increase' },
      { factor: 'dredge_restore', contribution_h: -2.4, direction: 'decrease' },
      { factor: 'tugs_down', contribution_h: 0, direction: 'neutral' },
    ],
  },
  engine_trace: [],
  artifact_sha256: 'abcdef0123456789',
  holdout_mae_hours: 4.12,
};

describe('DEMO_TAT_INPUT', () => {
  it('targets the documented endpoint suffix', () => {
    expect(M3_PREDICT_PATH).toBe('/uc1/m3/predict');
  });

  it('pins the evaluator curl: 4,000 TEU at 15.0 m on the learned engine', () => {
    // The panel prints these two numbers next to the result, and the UC1-068
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
    expect(i.weather_severity).toBeGreaterThanOrEqual(0);
    expect(i.weather_severity).toBeLessThanOrEqual(3);
    expect(i.severe_weather_flag === 0 || i.severe_weather_flag === 1).toBe(true);
    expect(i.incident_severity).toBeLessThanOrEqual(3);
    expect(i.berth_window_extension_h).toBeLessThanOrEqual(48);
    expect(i.net_channel_depth_delta_m).toBeGreaterThanOrEqual(-5);
  });

  it('submits no outcome field — the leakage firewall', () => {
    const banned = /(^|_)(tat|actual|atd|atb_actual|outcome|duration)($|_)/i;
    for (const key of Object.keys(DEMO_TAT_INPUT)) {
      expect(banned.test(key), `${key} looks like an outcome`).toBe(false);
    }
  });
});

describe('toM3Result', () => {
  it('carries the band, sigma and provenance through', () => {
    const r = toM3Result(WIRE);
    expect(r.p10_hours).toBe(28.4);
    expect(r.p50_hours).toBe(36.2);
    expect(r.p90_hours).toBe(47.9);
    expect(r.sigma_hours).toBe(7.6);
    expect(r.bandWidthHours).toBe(19.5);
    expect(r.engine).toBe('lightgbm');
    expect(r.model_version).toBe('m3-coef-2.1.0');
    expect(r.holdout_mae_hours).toBe(4.12);
    expect(r.artifact_sha256).toBe('abcdef0123456789');
    expect(r.stressorsActive).toHaveLength(3);
  });

  it('ranks only the factors that ADD time, largest first', () => {
    // The panel renders this list with a "+" prefix, so a negative would print
    // as "+-2.4 h"; neutral rows are noise in a "top drivers" list.
    const r = toM3Result(WIRE);
    expect(r.contributions).toEqual([
      { factor: 'parcel_teu', hours: 8.0 },
      { factor: 'severe_weather_flag', hours: 3.5 },
      { factor: 'pilots_down', hours: 1.2 },
    ]);
  });

  it('falls back to p90 − p10 when the service omits the band width', () => {
    const rest: M3PredictWire = { ...WIRE };
    delete (rest as Partial<M3PredictWire>).band_width_hours;
    expect(toM3Result(rest).bandWidthHours).toBeCloseTo(19.5, 6);
  });

  it('reports a missing artifact as null rather than NaN or undefined', () => {
    const rest: M3PredictWire = { ...WIRE };
    delete rest.artifact_sha256;
    delete rest.holdout_mae_hours;
    const r = toM3Result(rest);
    expect(r.artifact_sha256).toBeNull();
    expect(r.holdout_mae_hours).toBeNull();
  });

  it('surfaces an artifact fallback warning when the service sends one', () => {
    const r = toM3Result({
      ...WIRE,
      artifact_mode: 'synthetic-refit',
      artifact_warning: 'no packaged artifact; refitted in-process',
    });
    expect(r.artifactMode).toBe('synthetic-refit');
    expect(r.artifactWarning).toMatch(/refitted/);
  });

  it('survives a response with no breakdown at all', () => {
    const r = toM3Result({ ...WIRE, breakdown: {} });
    expect(r.contributions).toEqual([]);
    expect(r.p50_hours).toBe(36.2);
  });
});
