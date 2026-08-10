/**
 * UC1-M3 connector — forward turnaround forecast with a P10/P50/P90 band.
 *
 * Wraps `POST /uc1/m3/predict` on the Gen-2 model service
 * (`ml/src/uc1_models/uc1_m3_tat_predict.py`). Structured like the other ML/UC-3
 * connectors: endpoint constant, a typed *wire* shape kept separate from the
 * domain type, an exported PURE mapper, and the one I/O function last — so the
 * mapping is unit-testable with no network.
 *
 * Two things worth knowing:
 *
 *  • **This module estimates nothing.** The band, the sigma and the per-factor
 *    explanation all come from the service's fitted artifact. A second estimator
 *    in the browser is exactly how two screens end up quoting different TATs for
 *    the same call — so the request carries features and the response is mapped,
 *    never recomputed.
 *
 *  • **The request schema is the leakage firewall.** Every field is knowable at
 *    the ETB decision; there is deliberately no way to submit an outcome. Keep it
 *    that way when extending `M3TatInput`.
 */

import { mlHttp } from './client';

/** Endpoint suffix, relative to `env.ml.apiBase` (so '/ml-api' is NOT repeated). */
export const M3_PREDICT_PATH = '/uc1/m3/predict';

/** Which engine the service should score with. `auto` walks the fallback chain. */
export type M3Engine = 'auto' | 'lightgbm' | 'sklearn_gbr' | 'sklearn_rf' | 'additive';

/**
 * A pre-berthing feature vector — mirrors the service's `TATPredictRequest`.
 * Field names are snake_case because they go on the wire verbatim.
 */
export interface M3TatInput {
  call_id: string;
  vessel_id: string;
  vessel_name: string;
  terminal: string;
  berth_id: string;
  parcel_teu: number;
  draft_m: number;
  terminal_max_draft_m: number;
  /** 0–3. */
  weather_severity: number;
  /** 0 or 1. */
  severe_weather_flag: number;
  rain_mm_hr: number;
  wind_kn: number;
  /** Negative = siltation loss. */
  net_channel_depth_delta_m: number;
  pilots_down: number;
  tugs_down: number;
  anchorage_queue_count: number;
  extra_arrivals_24h: number;
  /** 0–3. */
  incident_severity: number;
  berth_window_extension_h: number;
  calls_prev_24h: number;
  engine: M3Engine;
}

/**
 * The demo pin (UC1-068 decision (a)): the dashboard must print the same P50 an
 * evaluator gets from the documented curl. Changing these numbers breaks that
 * equivalence, so treat them as a fixture, not a default.
 */
export const DEMO_TAT_INPUT: M3TatInput = {
  call_id: 'C-DEMO-1',
  vessel_id: 'V-DEMO-1',
  vessel_name: 'MSC VALERIA',
  terminal: 'BMCT',
  berth_id: 'BMCT-01',
  parcel_teu: 4000,
  draft_m: 15.0,
  terminal_max_draft_m: 16.5,
  weather_severity: 2,
  severe_weather_flag: 1,
  rain_mm_hr: 8.0,
  wind_kn: 26.0,
  net_channel_depth_delta_m: -0.3,
  pilots_down: 1,
  tugs_down: 0,
  anchorage_queue_count: 6,
  extra_arrivals_24h: 2,
  incident_severity: 0,
  berth_window_extension_h: 4.0,
  calls_prev_24h: 11,
  engine: 'lightgbm',
};

/** One row of the service's additive explanation. */
export interface M3ContributionWire {
  factor: string;
  input?: number;
  coefficient?: string;
  contribution_h: number;
  share_pct?: number;
  direction?: 'increase' | 'decrease' | 'neutral';
}

/** The service's response to `/uc1/m3/predict`, as it arrives. */
export interface M3PredictWire {
  call_id: string;
  vessel_id: string;
  engine: string;
  p10_hours: number;
  p50_hours: number;
  p90_hours: number;
  band_width_hours: number;
  sigma_hours: number;
  stressor_count: number;
  stressors_active: string[];
  quantile_crossing_corrected: boolean;
  clamped_at_min: boolean;
  model_version: string;
  breakdown: {
    contributions?: M3ContributionWire[];
    base_hours?: number;
    [k: string]: unknown;
  };
  engine_trace?: unknown[];
  // Added by the service's `_predict_with_provenance` when an artifact is loaded.
  artifact_sha256?: string;
  holdout_mae_hours?: number;
  artifact_mode?: string;
  artifact_warning?: string;
}

/** A factor that pushed the forecast up, in hours. */
export interface TatContribution {
  factor: string;
  hours: number;
}

/** The prediction as the panel consumes it. */
export interface M3PredictResult {
  p10_hours: number;
  p50_hours: number;
  p90_hours: number;
  sigma_hours: number;
  bandWidthHours: number;
  engine: string;
  model_version: string | null;
  /** Holdout mean absolute error of the loaded artifact, hours. */
  holdout_mae_hours: number | null;
  artifact_sha256: string | null;
  /** Named stressors the service found active for this call. */
  stressorsActive: string[];
  /** Ranked drivers, largest first — the "top drivers" list. */
  contributions: TatContribution[];
  /** Set when the service fell back or warned about the artifact it used. */
  artifactMode: string | null;
  artifactWarning: string | null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Wire → domain. Pure.
 *
 * Only factors that ADD time are kept, ranked largest-first: the panel renders
 * this list as "Top drivers" with a `+` prefix, so a negative contribution would
 * print as "+-0.4 h". Factors that reduce the forecast are still present in the
 * service's full breakdown for anyone auditing the number.
 */
export function toM3Result(wire: M3PredictWire): M3PredictResult {
  const rows = Array.isArray(wire.breakdown?.contributions) ? wire.breakdown.contributions : [];
  const contributions = rows
    .map((c) => ({ factor: String(c.factor), hours: num(c.contribution_h) }))
    .filter((c) => c.hours > 0)
    .sort((a, b) => b.hours - a.hours);

  return {
    p10_hours: num(wire.p10_hours),
    p50_hours: num(wire.p50_hours),
    p90_hours: num(wire.p90_hours),
    sigma_hours: num(wire.sigma_hours),
    bandWidthHours: num(wire.band_width_hours, num(wire.p90_hours) - num(wire.p10_hours)),
    engine: wire.engine || 'unknown',
    model_version: wire.model_version || null,
    holdout_mae_hours: typeof wire.holdout_mae_hours === 'number' ? wire.holdout_mae_hours : null,
    artifact_sha256: wire.artifact_sha256 || null,
    stressorsActive: Array.isArray(wire.stressors_active) ? wire.stressors_active.map(String) : [],
    contributions,
    artifactMode: wire.artifact_mode || null,
    artifactWarning: wire.artifact_warning || null,
  };
}

/**
 * Score one pre-berthing feature vector.
 *
 * @throws when the model service is disabled, unreachable, slow or answers non-2xx
 *         (see `client.ts` — the message is already operator-readable).
 */
export async function predictM3Tat(input: M3TatInput): Promise<M3PredictResult> {
  const wire = await mlHttp<M3PredictWire>(M3_PREDICT_PATH, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return toM3Result(wire);
}
