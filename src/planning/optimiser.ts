/**
 * Berth-plan optimiser (spec C-3): decision support, not a black box. Given a set
 * of berthing requests and berths, propose a conflict-free assignment that
 * minimises an EXPLAINABLE objective:
 *
 *   cost = w_wait · Σ waiting hours
 *        + w_tide · (count of calls starting outside a go window)
 *        + w_shift · (count of calls moved from their requested berth/time)
 *
 * The algorithm is a transparent greedy: sort requests by requested start, place
 * each on the earliest-feasible slot of a length/draft-compatible berth. It is
 * NOT claimed to be globally optimal — it is a defensible heuristic a planner
 * accepts or edits. Pure/deterministic (stable sort, no clock/random).
 */

import type { Berth } from '@/types/domain';
import { MS_PER_HOUR } from '@/kpi/helpers';
import { intervalsOverlap } from './constraints';

export interface BerthRequest {
  planId: string;
  mmsi: string;
  vesselName: string;
  /** Requested berth (optional preference). */
  requestedBerthId?: string;
  requestedStartMs: number;
  durationMs: number;
  loaM: number;
  draftM: number;
}

export interface GoWindow {
  fromMs: number;
  toMs: number;
}

export interface OptimiserWeights {
  wait: number;
  tide: number;
  shift: number;
}
export const DEFAULT_WEIGHTS: OptimiserWeights = { wait: 1, tide: 2, shift: 0.5 };

export interface Assignment {
  planId: string;
  mmsi: string;
  vesselName: string;
  berthId: string;
  startMs: number;
  endMs: number;
  /** Hours the call waited past its requested start. */
  waitH: number;
  /** True if the start falls inside a go window. */
  inGoWindow: boolean;
  /** True if berth or start changed from the request. */
  shifted: boolean;
}

export interface OptimiserResult {
  assignments: Assignment[];
  unplaced: BerthRequest[];
  /** The objective value (lower is better) and its components. */
  cost: number;
  breakdown: { waitH: number; tideMisses: number; shifts: number };
}

function inAnyWindow(ms: number, windows: GoWindow[]): boolean {
  if (windows.length === 0) return true; // no tidal constraint modelled → always ok
  return windows.some((w) => ms >= w.fromMs && ms < w.toMs);
}

/** Earliest window start ≥ t, or t if none/unconstrained. */
function nextWindowStart(t: number, windows: GoWindow[]): number {
  if (windows.length === 0) return t;
  const containing = windows.find((w) => t >= w.fromMs && t < w.toMs);
  if (containing) return t;
  const future = windows.filter((w) => w.fromMs >= t).sort((a, b) => a.fromMs - b.fromMs);
  return future.length ? future[0].fromMs : t;
}

/**
 * Optimise. `windowsByBerth` optionally gives per-berth go windows; absent →
 * that berth is treated as always-feasible. Returns the proposed plan + cost.
 */
export function optimiseBerthPlan(
  requests: BerthRequest[],
  berths: Berth[],
  windowsByBerth: Map<string, GoWindow[]> = new Map(),
  weights: OptimiserWeights = DEFAULT_WEIGHTS
): OptimiserResult {
  // Stable sort by requested start (earliest first) — deterministic.
  const queue = [...requests].sort((a, b) => a.requestedStartMs - b.requestedStartMs);
  const occupancy = new Map<string, { s: number; e: number }[]>();
  berths.forEach((b) => occupancy.set(b.BERTH_ID, []));

  const assignments: Assignment[] = [];
  const unplaced: BerthRequest[] = [];

  for (const req of queue) {
    // Candidate berths: length + draft compatible, preferred berth first.
    const candidates = berths
      .filter((b) => b.LENGTH_M >= req.loaM && b.DRAFT_M >= req.draftM && b.STATUS !== 'maintenance')
      .sort((a, b) => {
        if (a.BERTH_ID === req.requestedBerthId) return -1;
        if (b.BERTH_ID === req.requestedBerthId) return 1;
        return a.BERTH_ID.localeCompare(b.BERTH_ID);
      });

    // Find the earliest feasible start on each candidate berth, then choose the
    // berth that berths the vessel soonest (ties → preferred berth, then ID) —
    // so a busy preferred berth yields to a free alternative instead of waiting.
    const earliestFeasibleStart = (berthId: string): number => {
      const windows = windowsByBerth.get(berthId) ?? [];
      const slots = occupancy.get(berthId)!;
      let start = nextWindowStart(req.requestedStartMs, windows);
      let guard = 0;
      while (guard++ < 500) {
        const end = start + req.durationMs;
        const conflict = slots.find((s) => intervalsOverlap(start, end, s.s, s.e));
        if (!conflict) return start;
        start = nextWindowStart(conflict.e, windows);
      }
      return start;
    };

    let best: { berthId: string; start: number } | null = null;
    for (const berth of candidates) {
      const start = earliestFeasibleStart(berth.BERTH_ID);
      if (
        !best ||
        start < best.start ||
        (start === best.start && berth.BERTH_ID === req.requestedBerthId)
      ) {
        best = { berthId: berth.BERTH_ID, start };
      }
    }

    if (best) {
      const windows = windowsByBerth.get(best.berthId) ?? [];
      occupancy.get(best.berthId)!.push({ s: best.start, e: best.start + req.durationMs });
      assignments.push({
        planId: req.planId,
        mmsi: req.mmsi,
        vesselName: req.vesselName,
        berthId: best.berthId,
        startMs: best.start,
        endMs: best.start + req.durationMs,
        waitH: Math.max(0, (best.start - req.requestedStartMs) / MS_PER_HOUR),
        inGoWindow: inAnyWindow(best.start, windows),
        shifted: best.berthId !== req.requestedBerthId || best.start !== req.requestedStartMs,
      });
    } else {
      unplaced.push(req);
    }
  }

  const waitH = assignments.reduce((s, a) => s + a.waitH, 0);
  const tideMisses = assignments.filter((a) => !a.inGoWindow).length;
  const shifts = assignments.filter((a) => a.shifted).length;
  const cost = weights.wait * waitH + weights.tide * tideMisses + weights.shift * shifts;

  return {
    assignments,
    unplaced,
    cost: Math.round(cost * 100) / 100,
    breakdown: { waitH: Math.round(waitH * 10) / 10, tideMisses, shifts },
  };
}
