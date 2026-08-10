/**
 * UC1-M5 connector — conflict-free berth allocation with an explainable objective.
 *
 * Wraps `POST /uc1/m5/optimise` on the Gen-2 model service
 * (`ml/src/uc1_models/uc1_m5_berth_optimiser.py`). Same posture as the other ML
 * connectors: endpoint constant, wire shapes separate from domain shapes,
 * exported PURE builders/mappers, the single I/O function last.
 *
 * The service validates its payload strictly (FastAPI/pydantic `Field` bounds),
 * and real JNPA data does NOT fit those bounds unmodified — so the request
 * builder clamps rather than letting the panel take a puzzling 422:
 *
 *  • **Berth length is capped at 600 m.** `BerthModel.length_m` is `le=600`, but
 *    BMCT-1/BMCT-2 are 1000 m and GTI-1 is 712 m in the fixtures. Clamping is
 *    safe for this optimiser: it places at most one vessel per berth per window
 *    and the largest permitted LOA is 500 m, so the removed headroom cannot
 *    change a feasibility decision.
 *  • **LOA, draft and service hours are clamped** to their declared ranges, and
 *    a zero-length call is floored to half an hour (`service_hours` is `gt=0`).
 *  • **The fleet is capped** at `env.ml.maxFleet`, and the caller is told how
 *    many were left out via `omitted` rather than letting the count silently
 *    shrink.
 */

import type { Berth } from '@/types/domain';
import type { BerthRequest } from '@/planning/optimiser';
import { env } from '../config';
import { mlHttp } from './client';

/** Endpoint suffix, relative to `env.ml.apiBase` (so '/ml-api' is NOT repeated). */
export const M5_OPTIMISE_PATH = '/uc1/m5/optimise';

/** `auto` lets the service pick CP-SAT when OR-Tools is present, else greedy. */
export type M5Algorithm = 'auto' | 'greedy' | 'cpsat';

const H_MS = 3_600_000;

/** Service `Field` bounds — mirrored here so the clamps have one source. */
const LIMITS = {
  berthLengthM: 600,
  berthMaxDraftM: 25,
  loaM: 500,
  draftM: 25,
  serviceHoursMin: 0.5,
  serviceHoursMax: 240,
} as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// --- wire shapes ------------------------------------------------------------

export interface M5BerthRequestWire {
  request_id: string;
  vessel_id: string;
  vessel_name: string;
  loa_m: number;
  draft_m: number;
  requested_berth_id: string;
  requested_start_utc: string;
  service_hours: number;
  priority: number;
}

export interface M5BerthWire {
  berth_id: string;
  terminal: string;
  length_m: number;
  max_draft_m: number;
  out_of_service: boolean;
}

export interface M5OptimiseRequestWire {
  requests: M5BerthRequestWire[];
  berths: M5BerthWire[];
  algorithm: M5Algorithm;
}

export interface M5AssignmentWire {
  request_id: string;
  vessel_id: string;
  vessel_name: string;
  berth_id: string;
  start_utc: string;
  end_utc: string;
  wait_hours: number;
  is_berth_shift: boolean;
  tide_window_id?: string | null;
  tide_miss: boolean;
  feasible: boolean;
  infeasible_reason?: string | null;
  marginal_cost: number;
  rationale?: string | null;
}

export interface M5PlanWire {
  plan_id: string;
  algorithm: string;
  generated_at_utc: string;
  assignments: M5AssignmentWire[];
  unassigned_request_ids: string[];
  cost: {
    wait_hours_total: number;
    wait_cost: number;
    tide_misses: number;
    tide_cost: number;
    berth_shifts: number;
    shift_cost: number;
    total_cost: number;
    [k: string]: unknown;
  };
  solve_ms: number;
  tide_policy: string;
  explanation: string[];
  breakdown?: Record<string, unknown>;
}

// --- domain shapes ----------------------------------------------------------

export interface M5Assignment {
  planId: string;
  mmsi: string;
  vesselName: string;
  berthId: string;
  startMs: number;
  endMs: number;
  waitH: number;
  isBerthShift: boolean;
  tideMiss: boolean;
  feasible: boolean;
  rationale: string | null;
}

export interface M5OptimiseResult {
  planId: string;
  algorithm: string;
  /** The objective value — lower is better. */
  cost: number;
  /** What drove the objective, in the panel's vocabulary. */
  breakdown: {
    waitH: number;
    tideMisses: number;
    shifts: number;
  };
  assignments: M5Assignment[];
  /** Requests the optimiser could not place. */
  unplaced: number;
  unplacedIds: string[];
  solveMs: number;
  tidePolicy: string;
  explanation: string[];
  /** Requests dropped before sending because the fleet cap was hit. */
  omitted: number;
}

// --- pure builders / mappers ------------------------------------------------

/**
 * Domain → wire. Pure, and total: clamps every bounded field so a valid JNPA
 * plan can never produce a 422.
 *
 * A request with no berth preference is sent with an empty `requested_berth_id`.
 * The service compares the assigned berth against that string to count "berth
 * shifts", so such a request is counted as shifted wherever it lands — callers
 * that care about the shift metric should always supply a preference.
 */
export function toOptimiseRequest(
  requests: BerthRequest[],
  berths: Berth[],
  algorithm: M5Algorithm = 'auto',
  maxFleet: number = env.ml.maxFleet
): { body: M5OptimiseRequestWire; omitted: number } {
  const capped = requests.slice(0, Math.max(1, maxFleet));
  return {
    omitted: Math.max(0, requests.length - capped.length),
    body: {
      algorithm,
      requests: capped.map((r, i) => ({
        request_id: r.planId,
        vessel_id: r.mmsi,
        vessel_name: r.vesselName,
        loa_m: clamp(r.loaM, 1, LIMITS.loaM),
        draft_m: clamp(r.draftM, 0.1, LIMITS.draftM),
        requested_berth_id: r.requestedBerthId ?? '',
        requested_start_utc: new Date(r.requestedStartMs).toISOString(),
        service_hours: clamp(
          r.durationMs / H_MS,
          LIMITS.serviceHoursMin,
          LIMITS.serviceHoursMax
        ),
        // The plan is already in priority order; 1..9 with lower = more urgent.
        priority: clamp(i + 1, 1, 9),
      })),
      berths: berths.map((b) => ({
        berth_id: b.BERTH_ID,
        terminal: b.TERMINAL,
        length_m: clamp(b.LENGTH_M, 1, LIMITS.berthLengthM),
        max_draft_m: clamp(b.DRAFT_M, 0.1, LIMITS.berthMaxDraftM),
        out_of_service: b.STATUS === 'maintenance',
      })),
    },
  };
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : 0;
};

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** Wire → domain. Pure. */
export function toM5Result(wire: M5PlanWire, omitted = 0): M5OptimiseResult {
  const unplacedIds = Array.isArray(wire.unassigned_request_ids)
    ? wire.unassigned_request_ids.map(String)
    : [];
  return {
    planId: wire.plan_id ?? '',
    algorithm: wire.algorithm ?? 'unknown',
    // Already rounded to 4 dp by the service; 2 dp is what the panel prints.
    cost: Number(num(wire.cost?.total_cost).toFixed(2)),
    breakdown: {
      waitH: Number(num(wire.cost?.wait_hours_total).toFixed(2)),
      tideMisses: num(wire.cost?.tide_misses),
      shifts: num(wire.cost?.berth_shifts),
    },
    assignments: (Array.isArray(wire.assignments) ? wire.assignments : []).map((a) => ({
      planId: a.request_id,
      mmsi: a.vessel_id,
      vesselName: a.vessel_name,
      berthId: a.berth_id,
      startMs: ms(a.start_utc),
      endMs: ms(a.end_utc),
      waitH: num(a.wait_hours),
      isBerthShift: Boolean(a.is_berth_shift),
      tideMiss: Boolean(a.tide_miss),
      feasible: a.feasible !== false,
      rationale: a.rationale ?? null,
    })),
    unplaced: unplacedIds.length,
    unplacedIds,
    solveMs: num(wire.solve_ms),
    tidePolicy: wire.tide_policy ?? 'soft',
    explanation: Array.isArray(wire.explanation) ? wire.explanation.map(String) : [],
    omitted,
  };
}

// --- I/O --------------------------------------------------------------------

/**
 * Ask the service for a conflict-free berth plan.
 *
 * @throws when the model service is disabled, unreachable, slow or answers
 *         non-2xx (see `client.ts` — the message is already operator-readable).
 */
export async function optimiseM5(
  requests: BerthRequest[],
  berths: Berth[],
  algorithm: M5Algorithm = 'auto'
): Promise<M5OptimiseResult> {
  const { body, omitted } = toOptimiseRequest(requests, berths, algorithm);
  const wire = await mlHttp<M5PlanWire>(M5_OPTIMISE_PATH, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return toM5Result(wire, omitted);
}
