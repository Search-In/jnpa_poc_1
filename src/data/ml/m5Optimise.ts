/**
 * UC1-M5 berth optimiser — Gen-2 CP-SAT / greedy (`POST /uc1/m5/optimise`).
 *
 * UC1-068: Analytics "Optimise" uses the submitted Python pack, not the older
 * in-browser TypeScript greedy (`planning/optimiser.ts`).
 *
 * The dashboard berth roster uses published quay totals (BMCT ~1000 m, GTI ~712 m)
 * for planning honesty. M5's request schema caps `length_m` at 600 (per-berth
 * design envelope). We clamp on the wire so Optimise does not 422 on DEMO data
 * while still preserving berth identity and relative fit.
 */

import type { Berth } from '@/types/domain';
import type { BerthRequest } from '@/planning/optimiser';
import { mlHttp } from './client';

export const M5_OPTIMISE_PATH = '/uc1/m5/optimise';

/** M5 Pydantic bounds (uc1_m5_berth_optimiser.BerthModel / BerthRequestModel). */
export const M5_BOUNDS = {
  lengthM: { min: 1, max: 600 },
  draftM: { min: 0.1, max: 25 },
  loaM: { min: 1, max: 500 },
  serviceHours: { min: 0.25, max: 240 },
} as const;

export interface M5OptimiseResult {
  algorithm: string;
  cost: number;
  breakdown: { waitH: number; tideMisses: number; shifts: number };
  assignments: Array<{
    planId: string;
    vesselName: string;
    berthId: string;
    waitH: number;
  }>;
  unplaced: number;
  solveMs: number;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Clamp dashboard berth/request dims into M5's schema. Pure. */
export function clampForM5(input: {
  lengthM?: number;
  draftM?: number;
  loaM?: number;
  serviceHours?: number;
}): { length_m: number; max_draft_m: number; loa_m: number; service_hours: number } {
  return {
    length_m: clamp(Number(input.lengthM), M5_BOUNDS.lengthM.min, M5_BOUNDS.lengthM.max, 350),
    max_draft_m: clamp(Number(input.draftM), M5_BOUNDS.draftM.min, M5_BOUNDS.draftM.max, 15),
    loa_m: clamp(Number(input.loaM), M5_BOUNDS.loaM.min, M5_BOUNDS.loaM.max, 300),
    service_hours: clamp(
      Number(input.serviceHours),
      M5_BOUNDS.serviceHours.min,
      M5_BOUNDS.serviceHours.max,
      24,
    ),
  };
}

/** Build the M5 request body from the live berth plan. Pure. */
export function buildM5OptimiseBody(
  requests: BerthRequest[],
  berths: Berth[],
  algorithm: 'auto' | 'cpsat' | 'greedy' = 'auto',
): Record<string, unknown> {
  return {
    algorithm,
    tide_policy: 'soft',
    requests: requests.map((r) => {
      const dims = clampForM5({
        loaM: r.loaM,
        draftM: r.draftM,
        serviceHours: r.durationMs / 3_600_000,
      });
      return {
        request_id: r.planId,
        vessel_id: r.mmsi,
        vessel_name: r.vesselName,
        loa_m: dims.loa_m,
        draft_m: dims.max_draft_m,
        requested_berth_id: r.requestedBerthId ?? berths[0]?.BERTH_ID ?? 'BMCT-01',
        requested_start_utc: toIso(r.requestedStartMs),
        service_hours: dims.service_hours,
        priority: 5,
      };
    }),
    berths: berths.map((b) => {
      const dims = clampForM5({ lengthM: b.LENGTH_M, draftM: b.DRAFT_M });
      return {
        berth_id: b.BERTH_ID,
        terminal: b.TERMINAL,
        length_m: dims.length_m,
        max_draft_m: dims.max_draft_m,
        out_of_service: false,
      };
    }),
  };
}

/** Map wire JSON → panel shape. Pure. */
export function mapM5OptimiseResponse(raw: Record<string, unknown>): M5OptimiseResult {
  const cost = (raw.cost ?? {}) as Record<string, unknown>;
  const waitH = Number(cost.wait_hours_total ?? 0);
  const tideMisses = Number(cost.tide_misses ?? 0);
  const shifts = Number(cost.berth_shifts ?? cost.shifts ?? 0);
  const wWait = Number((cost.weights as Record<string, unknown> | undefined)?.wait_hour ?? 1);
  const wTide = Number((cost.weights as Record<string, unknown> | undefined)?.tide_miss ?? 2);
  const wShift = Number((cost.weights as Record<string, unknown> | undefined)?.berth_shift ?? 0.5);
  const objective =
    Number.isFinite(Number(cost.total_cost))
      ? Number(cost.total_cost)
      : Number.isFinite(Number(cost.total))
        ? Number(cost.total)
        : wWait * waitH + wTide * tideMisses + wShift * shifts;

  const assignments = Array.isArray(raw.assignments) ? raw.assignments : [];
  return {
    algorithm: String(raw.algorithm ?? 'unknown'),
    cost: Math.round(objective * 100) / 100,
    breakdown: {
      waitH: Math.round(waitH * 10) / 10,
      tideMisses,
      shifts,
    },
    assignments: assignments.map((a) => {
      const row = (a ?? {}) as Record<string, unknown>;
      return {
        planId: String(row.request_id ?? ''),
        vesselName: String(row.vessel_name ?? ''),
        berthId: String(row.berth_id ?? ''),
        waitH: Number(row.wait_hours ?? 0),
      };
    }),
    unplaced: Array.isArray(raw.unassigned_request_ids)
      ? raw.unassigned_request_ids.length
      : 0,
    solveMs: Number(raw.solve_ms ?? 0),
  };
}

/** Run the Gen-2 berth optimiser. */
export async function optimiseM5(
  requests: BerthRequest[],
  berths: Berth[],
  algorithm: 'auto' | 'cpsat' | 'greedy' = 'auto',
): Promise<M5OptimiseResult> {
  if (requests.length === 0) throw new Error('[ML] /uc1/m5/optimise — no berth requests');
  const raw = await mlHttp<Record<string, unknown>>(M5_OPTIMISE_PATH, {
    method: 'POST',
    body: JSON.stringify(buildM5OptimiseBody(requests, berths, algorithm)),
  });
  return mapM5OptimiseResponse(raw);
}
