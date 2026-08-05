/**
 * UC-1 model-service connector — the AIS feed → eight-model prediction path.
 *
 * Structured like the UC-3 connectors (seaChannels.ts, liveVessels.ts): endpoint
 * constants, a typed *wire* shape kept separate from the domain type, exported
 * PURE mappers, and the I/O functions last — so every mapping is unit-testable
 * with no network and no fetch stub.
 *
 * Three facts about this integration are worth knowing before reading the code:
 *
 *  • **The whole feed is sent, not one vessel.** M4 (berth occupancy), M5 (berth
 *    plan) and M7 (craft roster) are FLEET models: their answers are properties
 *    of the arrival set. Asking for one hull would produce a berth plan for a
 *    port with one ship in it. So the panel scores the feed once and reads each
 *    vessel out of the same document.
 *
 *  • **The service does the translating, not this module.** An AIS position
 *    report carries no draught, no cargo and no ATA; the estimates that fill
 *    those gaps live in `ml/src/pipeline/uc1_webapp_adapter.py`, versioned, with
 *    a ledger per vessel. This module deliberately does NOT estimate anything —
 *    a second estimator in the frontend is exactly how two screens end up
 *    showing different under-keel clearances for the same hull.
 *
 *  • **The request is capped.** The service scores at most `max_fleet` vessels
 *    per call. `selectFleet` decides which ones travel — the focal vessel first,
 *    then operational priority — and the caller reports how many were left out
 *    rather than letting the count silently shrink.
 */

import type { NavStatus, Vessel } from '@/types/domain';
import { mlHttp } from './client';
import type {
  PredictionContext,
  PredictionResponse,
  VesselPrediction,
} from './types';

/** Endpoint suffixes, relative to `env.ml.apiBase` (so '/ml-api' is NOT repeated). */
export const PREDICTIONS_PATH = '/uc1/webapp/predictions';
export const MAPPING_PATH = '/uc1/webapp/mapping';
// ML_HEALTH_PATH lives in client.ts — its liveness probe needs it, and one
// definition beats two that can drift apart.

/**
 * One AIS row as the service reads it.
 *
 * UPPER_SNAKE because that is what the domain `Vessel` already carries and what
 * the adapter's readers expect; the adapter is tolerant of case and of
 * snake_case, but sending the canonical form keeps the wire log readable.
 */
export interface AisRequestRow {
  MMSI: string;
  VESSEL_NAME: string;
  VESSEL_TYPE: string;
  NAV_STATUS: NavStatus;
  SOG: number;
  COG: number;
  HEADING: number;
  LAT: number;
  LON: number;
  ETA: number | null;
  BERTH_ID: string | null;
  TIMESTAMP: number;
  SOURCE: string;
}

/** Operational priority — the same order the vessel table sorts by. */
const PRIORITY: Record<NavStatus, number> = {
  approaching: 0,
  berthing: 1,
  anchored: 2,
  underway: 3,
  moored: 4,
};

/**
 * Map one live vessel onto the request row. Pure.
 *
 * A projection, not a translation: only the fields the models can actually use
 * are sent. Everything absent stays absent — the service names its substitution
 * in the ledger, which is worth more than a plausible number invented here.
 */
export function toRequestRow(v: Vessel): AisRequestRow {
  return {
    MMSI: v.MMSI,
    VESSEL_NAME: v.VESSEL_NAME,
    VESSEL_TYPE: v.VESSEL_TYPE,
    NAV_STATUS: v.NAV_STATUS,
    SOG: v.SOG,
    COG: v.COG,
    HEADING: v.HEADING,
    LAT: v.LAT,
    LON: v.LON,
    ETA: v.ETA,
    BERTH_ID: v.BERTH_ID,
    TIMESTAMP: v.TIMESTAMP,
    SOURCE: v.SOURCE ?? 'mock',
  };
}

/**
 * Choose which vessels travel when the feed is larger than the service's cap.
 *
 * The focal vessel is always first — the operator asked about her, and a panel
 * that answered "she was not in the sample" would be useless. The rest follow
 * operational priority (approaching before moored), because an inbound hull is
 * the one a berth plan has to place. Pure and stable: equal keys keep feed
 * order, so the same feed always produces the same request.
 */
export function selectFleet(vessels: Vessel[], focusMmsi: string, cap: number): Vessel[] {
  if (cap <= 0) return [];
  const focus = vessels.filter((v) => v.MMSI === focusMmsi);
  const rest = vessels
    .filter((v) => v.MMSI !== focusMmsi)
    .map((v, i) => ({ v, i }))
    .sort((a, b) => PRIORITY[a.v.NAV_STATUS] - PRIORITY[b.v.NAV_STATUS] || a.i - b.i)
    .map(({ v }) => v);
  return [...focus, ...rest].slice(0, cap);
}

/**
 * Build the optional port-context block from what the dashboard already knows.
 *
 * Only genuinely-held values are included. Omitting a field makes the service
 * apply its own documented fallback (the synthetic harmonic tide curve, the
 * anchorage queue derived from occupancy) and REPORT it in `data_quality` —
 * strictly better than passing a placeholder the operator would read as
 * measured. Pure.
 */
export function buildContext(input: {
  berthOccupancyPct?: number | null;
  windKn?: number | null;
  tideM?: number | null;
  rainMmHr?: number | null;
  weather?: string | null;
}): PredictionContext {
  const ctx: PredictionContext = {};
  if (Number.isFinite(input.berthOccupancyPct)) {
    ctx.berth_occupancy_pct = Number(input.berthOccupancyPct);
  }
  if (Number.isFinite(input.windKn)) ctx.wind_kn = Number(input.windKn);
  if (Number.isFinite(input.tideM)) ctx.tide_m = Number(input.tideM);
  if (Number.isFinite(input.rainMmHr)) ctx.rain_mm_hr = Number(input.rainMmHr);
  if (input.weather) ctx.weather = input.weather;
  return ctx;
}

/**
 * Index a response by MMSI so a table row can find its own vessel. Pure.
 *
 * Falls back to the vessel NAME when a row carried no MMSI (the mock fleet
 * always has one; a hand-built payload may not), because a prediction that
 * cannot be found is the same as no prediction at all.
 */
export function indexByMmsi(res: PredictionResponse): Map<string, VesselPrediction> {
  const out = new Map<string, VesselPrediction>();
  for (const vessel of res.dashboard?.vessels ?? []) {
    if (vessel.mmsi) out.set(vessel.mmsi, vessel);
    else if (vessel.vessel) out.set(vessel.vessel, vessel);
  }
  return out;
}

/**
 * True when any model in the run failed. The panel shows this rather than
 * quietly rendering seven blocks where eight were asked for.
 */
export function failedModels(res: PredictionResponse): string[] {
  return (res.dashboard?.run?.models_failed ?? []).map(
    (f) => `${f.model}${f.error ? ` — ${f.error}` : ''}`,
  );
}

/** Score a fleet. Throws (with an operator-readable message) on any failure. */
export async function fetchFleetPredictions(
  vessels: Vessel[],
  context: PredictionContext = {},
): Promise<PredictionResponse> {
  if (vessels.length === 0) throw new Error('[ML] no vessels in the feed to score');
  return mlHttp<PredictionResponse>(PREDICTIONS_PATH, {
    method: 'POST',
    body: JSON.stringify({ vessels: vessels.map(toRequestRow), context, models: [] }),
  });
}

/**
 * The catalogue of constants the service may substitute for a field AIS never
 * sends. Rendered in the panel's "what this rests on" section.
 */
export async function fetchMappingCatalogue(): Promise<Record<string, unknown>> {
  return mlHttp<Record<string, unknown>>(MAPPING_PATH);
}
