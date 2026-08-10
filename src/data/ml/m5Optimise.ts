/**
 * UC-1 Gen-2 · M5 — dynamic berth-plan optimiser.
 *
 * A thin, typed client over the model service's `POST /uc1/m5/optimise`
 * (ml/src/uc1_models/uc1_m5_berth_optimiser.py). The Python pack solves a
 * conflict-free berth allocation (CP-SAT when ortools is installed, else a greedy
 * heuristic) and returns the plan with an explainable objective breakdown. This
 * module translates <AnalyticsPanel>'s domain types into the service's request
 * shape and maps the response onto the small view model the panel renders — the
 * optimisation itself runs in the service on :8100, never in the browser. All
 * transport, timeout and error wording is handled by `mlHttp`.
 */

import { mlHttp } from './client';
import type { BerthRequest } from '@/planning/optimiser';
import type { Berth } from '@/types/domain';

const H = 3_600_000;

/** Solver choice. `auto` = CP-SAT when available, otherwise greedy. */
export type M5Algorithm = 'auto' | 'greedy' | 'cpsat';

/** One placement in the proposed plan, flattened for the UI. */
export interface M5Assignment {
  requestId: string;
  vesselName: string;
  berthId: string;
  startMs: number;
  endMs: number;
  waitH: number;
  tideMiss: boolean;
  shifted: boolean;
}

/** View model consumed by <AnalyticsPanel>'s optimiser section. */
export interface M5OptimiseResult {
  algorithm: string;
  /** The objective value (lower is better). */
  cost: number;
  breakdown: { waitH: number; tideMisses: number; shifts: number };
  assignments: M5Assignment[];
  /** Count of requests the solver could not place. */
  unplaced: number;
  solveMs: number;
}

/** Suffix relative to `env.ml.apiBase` (default '/ml-api'). */
export const M5_OPTIMISE_PATH = '/uc1/m5/optimise';

/** The `POST /uc1/m5/optimise` request body — mirrors the service's `OptimiseRequest`. */
interface M5RequestWire {
  request_id: string;
  vessel_id: string;
  vessel_name: string;
  loa_m: number;
  draft_m: number;
  requested_berth_id: string;
  requested_start_utc: string;
  service_hours: number;
}

interface M5BerthWire {
  berth_id: string;
  terminal: string;
  length_m: number;
  max_draft_m: number;
  out_of_service: boolean;
}

/** The subset of the plan response (`BerthPlan.as_dict()`) this module reads. */
interface M5PlanWire {
  algorithm: string;
  solve_ms: number;
  unassigned_request_ids?: string[];
  cost: {
    total_cost: number;
    wait_hours_total: number;
    tide_misses: number;
    berth_shifts: number;
  };
  assignments: Array<{
    request_id: string;
    vessel_name: string;
    berth_id: string;
    start_utc: string;
    end_utc: string;
    wait_hours: number;
    tide_miss: boolean;
    is_berth_shift: boolean;
  }>;
}

function toRequestWire(r: BerthRequest): M5RequestWire {
  return {
    request_id: r.planId,
    vessel_id: r.mmsi,
    vessel_name: r.vesselName,
    loa_m: r.loaM,
    draft_m: r.draftM,
    // Preference only; the service treats an empty string as "no preference".
    requested_berth_id: r.requestedBerthId ?? '',
    requested_start_utc: new Date(r.requestedStartMs).toISOString(),
    service_hours: r.durationMs / H,
  };
}

function toBerthWire(b: Berth): M5BerthWire {
  return {
    berth_id: b.BERTH_ID,
    terminal: b.TERMINAL,
    length_m: b.LENGTH_M,
    max_draft_m: b.DRAFT_M,
    out_of_service: b.STATUS === 'maintenance',
  };
}

function epochMs(iso: string): number {
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Propose a conflict-free berth plan. Throws (via `mlHttp`) when the service is
 * disabled, unreachable, slow or answers non-2xx — the panel renders those with
 * `friendlyError`.
 */
export async function optimiseM5(
  requests: BerthRequest[],
  berths: Berth[],
  algorithm: M5Algorithm = 'auto',
): Promise<M5OptimiseResult> {
  const plan = await mlHttp<M5PlanWire>(M5_OPTIMISE_PATH, {
    method: 'POST',
    body: JSON.stringify({
      requests: requests.map(toRequestWire),
      berths: berths.map(toBerthWire),
      algorithm,
      tide_policy: 'soft',
    }),
  });

  return {
    algorithm: plan.algorithm,
    cost: plan.cost.total_cost,
    breakdown: {
      waitH: plan.cost.wait_hours_total,
      tideMisses: plan.cost.tide_misses,
      shifts: plan.cost.berth_shifts,
    },
    assignments: (plan.assignments ?? []).map((a) => ({
      requestId: a.request_id,
      vesselName: a.vessel_name,
      berthId: a.berth_id,
      startMs: epochMs(a.start_utc),
      endMs: epochMs(a.end_utc),
      waitH: a.wait_hours,
      tideMiss: a.tide_miss,
      shifted: a.is_berth_shift,
    })),
    unplaced: (plan.unassigned_request_ids ?? []).length,
    solveMs: plan.solve_ms,
  };
}
