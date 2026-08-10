/**
 * UC1-M3 TAT — Gen-2 LightGBM service (`POST /uc1/m3/predict`).
 *
 * UC1-068: the Analytics TAT card must show the SAME P50 the evaluator gets from
 * curl against the submitted pack. Demo pin: 4,000 TEU / draft 15.0 m /
 * engine=lightgbm → LightGBM v1.2.0 (SHA-256 27038b98…).
 */

import { mlHttp } from './client';

export const M3_PREDICT_PATH = '/uc1/m3/predict';

/** Ticket / WS2 rehearsal inputs — keep in sync with the curl crib. */
export const DEMO_TAT_INPUT = {
  parcel_teu: 4000,
  draft_m: 15.0,
  terminal_max_draft_m: 16.5,
  engine: 'lightgbm' as const,
  call_id: 'C-DEMO-UC1-068',
  vessel_name: 'DEMO 4000 TEU',
  terminal: 'BMCT',
  berth_id: 'BMCT-01',
};

export interface M3PredictRequest {
  parcel_teu: number;
  draft_m: number;
  terminal_max_draft_m?: number;
  engine?: 'auto' | 'lightgbm' | 'sklearn_gbr' | 'sklearn_rf' | 'additive';
  call_id?: string;
  vessel_name?: string;
  terminal?: string;
  berth_id?: string;
  weather_severity?: number;
  severe_weather_flag?: number;
  rain_mm_hr?: number;
  wind_kn?: number;
  anchorage_queue_count?: number;
  pilots_down?: number;
  tugs_down?: number;
}

export interface M3Contribution {
  factor: string;
  hours: number;
}

export interface M3PredictResult {
  p10_hours: number;
  p50_hours: number;
  p90_hours: number;
  sigma_hours: number;
  engine: string;
  model_version: string;
  artifact_sha256: string | null;
  holdout_mae_hours: number | null;
  artifact_mode: string | null;
  contributions: M3Contribution[];
}

/** Pull top drivers from the service breakdown. Pure. */
export function contributionsFromBreakdown(breakdown: unknown): M3Contribution[] {
  if (!breakdown || typeof breakdown !== 'object') return [];
  const b = breakdown as Record<string, unknown>;
  const raw =
    (Array.isArray(b.contributions) && b.contributions) ||
    (Array.isArray(b.top_drivers) && b.top_drivers) ||
    (Array.isArray(b.factors) && b.factors) ||
    [];
  const out: M3Contribution[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const factor = String(r.factor ?? r.name ?? r.feature ?? '');
    const hours = Number(r.hours ?? r.contribution_h ?? r.value ?? NaN);
    if (!factor || !Number.isFinite(hours) || hours <= 0) continue;
    out.push({ factor, hours });
  }
  return out.sort((a, b) => b.hours - a.hours);
}

/** Map wire JSON → domain. Pure. */
export function mapM3PredictResponse(raw: Record<string, unknown>): M3PredictResult {
  const p50 = Number(raw.p50_hours);
  if (!Number.isFinite(p50)) {
    throw new Error('[ML] /uc1/m3/predict — response missing p50_hours');
  }
  return {
    p10_hours: Number(raw.p10_hours),
    p50_hours: p50,
    p90_hours: Number(raw.p90_hours),
    sigma_hours: Number(raw.sigma_hours ?? 0),
    engine: String(raw.engine ?? ''),
    model_version: String(raw.model_version ?? ''),
    artifact_sha256:
      typeof raw.artifact_sha256 === 'string' && raw.artifact_sha256
        ? raw.artifact_sha256
        : null,
    holdout_mae_hours:
      typeof raw.holdout_mae_hours === 'number' && Number.isFinite(raw.holdout_mae_hours)
        ? raw.holdout_mae_hours
        : null,
    artifact_mode: typeof raw.artifact_mode === 'string' ? raw.artifact_mode : null,
    contributions: contributionsFromBreakdown(raw.breakdown),
  };
}

/** Score one call on the Gen-2 M3 service. */
export async function predictM3Tat(
  input: M3PredictRequest = DEMO_TAT_INPUT,
): Promise<M3PredictResult> {
  const body = {
    ...DEMO_TAT_INPUT,
    ...input,
    engine: input.engine ?? 'lightgbm',
  };
  const raw = await mlHttp<Record<string, unknown>>(M3_PREDICT_PATH, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return mapM3PredictResponse(raw);
}
