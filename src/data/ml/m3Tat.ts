/**
 * UC-1 Gen-2 · M3 — vessel turnaround-time (TAT) forecast.
 *
 * A thin, typed client over the model service's `POST /uc1/m3/predict`
 * (ml/src/uc1_models/uc1_m3_tat_predict.py). The Python pack returns a
 * P10/P50/P90 band plus a per-factor additive explanation; this module maps that
 * wire shape onto the small view model <TatPredictionCard> renders and does
 * NOTHING else — the computation lives in the service on :8100, never in the
 * browser (UC1-068 decision (a)). All transport, timeout and error wording is
 * handled by `mlHttp` (src/data/ml/client.ts), same as the Predictions surface.
 */

import { mlHttp } from './client';

/** The learned engines the service can score with. `additive` is the transparent
 *  surrogate; `lightgbm` matches the submitted artifact used in the demo. */
export type M3Engine = 'auto' | 'lightgbm' | 'sklearn_gbr' | 'sklearn_rf' | 'additive';

/**
 * Pre-berthing feature vector — mirrors the service's `TATPredictRequest`. Every
 * field is knowable at the ETB decision (the leakage firewall); there is
 * deliberately no way to submit an outcome. Only `parcel_teu` / `draft_m` /
 * `engine` are commonly set; every other field is optional and falls back to the
 * service's own field default when omitted.
 */
export interface M3PredictInput {
  parcel_teu: number;
  draft_m: number;
  engine?: M3Engine;
  call_id?: string;
  vessel_id?: string;
  vessel_name?: string;
  terminal?: string;
  berth_id?: string;
  terminal_max_draft_m?: number;
  weather_severity?: number;
  severe_weather_flag?: number;
  rain_mm_hr?: number;
  wind_kn?: number;
  net_channel_depth_delta_m?: number;
  pilots_down?: number;
  tugs_down?: number;
  anchorage_queue_count?: number;
  extra_arrivals_24h?: number;
  incident_severity?: number;
  berth_window_extension_h?: number;
  calls_prev_24h?: number;
}

/** One factor's additive contribution, flattened for the UI. */
export interface M3Contribution {
  factor: string;
  hours: number;
}

/** View model consumed by <TatPredictionCard>. */
export interface M3PredictResult {
  p10_hours: number;
  p50_hours: number;
  p90_hours: number;
  sigma_hours: number;
  engine: string;
  model_version?: string;
  /** Holdout MAE from the artifact's provenance, when the service ships it. */
  holdout_mae_hours?: number | null;
  /** SHA-256 of the loaded model artifact, when the service ships it. */
  artifact_sha256?: string;
  /** Per-factor additive attribution, largest absolute driver first. */
  contributions: M3Contribution[];
}

/**
 * The evaluator's canonical demo case: 4,000 TEU, 15.0 m draft, LightGBM — the
 * same inputs as the reference `curl POST /uc1/m3/predict`, so the P50 on screen
 * matches the terminal.
 */
export const DEMO_TAT_INPUT: M3PredictInput = {
  parcel_teu: 4000,
  draft_m: 15.0,
  engine: 'lightgbm',
};

/** Suffix relative to `env.ml.apiBase` (default '/ml-api'). */
export const M3_PREDICT_PATH = '/uc1/m3/predict';

/** The subset of the `POST /uc1/m3/predict` response this module reads. */
export interface M3Wire {
  p10_hours: number;
  p50_hours: number;
  p90_hours: number;
  sigma_hours: number;
  engine: string;
  model_version?: string;
  holdout_mae_hours?: number | null;
  artifact_sha256?: string;
  breakdown?: {
    contributions?: Array<{ factor: string; contribution_h: number }>;
  };
}

/**
 * Score one call. Throws (via `mlHttp`) when the service is disabled,
 * unreachable, slow or answers non-2xx — the card renders those with
 * `friendlyError`.
 */
export async function predictM3Tat(input: M3PredictInput): Promise<M3PredictResult> {
  const wire = await mlHttp<M3Wire>(M3_PREDICT_PATH, {
    method: 'POST',
    body: JSON.stringify(input),
  });

  const contributions: M3Contribution[] = (wire.breakdown?.contributions ?? [])
    .map((c) => ({ factor: c.factor, hours: c.contribution_h }))
    // The card shows the top few; order by the size of the effect, not its sign.
    .sort((a, b) => Math.abs(b.hours) - Math.abs(a.hours));

  return {
    p10_hours: wire.p10_hours,
    p50_hours: wire.p50_hours,
    p90_hours: wire.p90_hours,
    sigma_hours: wire.sigma_hours,
    engine: wire.engine,
    model_version: wire.model_version,
    holdout_mae_hours: wire.holdout_mae_hours,
    artifact_sha256: wire.artifact_sha256,
    contributions,
  };
}
