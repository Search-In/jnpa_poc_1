/**
 * The audited answer for a UC-1 scenario.
 *
 * Why UC-1 does not compute these itself
 * --------------------------------------
 * The lever engine in `src/sim/` is the right tool for the walkthrough: it is
 * instant, offline, deterministic, and it drives the map, the causal guide and
 * the VR scene. What it cannot do is satisfy the JNPA Notice §1.d requirement —
 * *"the API queries used to obtain the underlying data, so the working can be
 * traced"*. A figure computed in this browser has no query to show.
 *
 * It also cannot see the data. `leverPlanSlip` applies one uniform slip to every
 * call in the plan, so it cannot say WHICH later calls are displaced or by how
 * much — which is precisely what I-B asks for. The berthing records that answer
 * that live in the UC-3 database.
 *
 * So the two coexist deliberately:
 *
 *   levers    the story — what moves, where, and why (map, guide, VR)
 *   engine    the numbers — displaced calls, cumulative delay, the query trace
 *
 * The engine is the same one UC-2 and UC-3 call, so a figure quoted in this
 * dashboard is the same figure quoted in the other two. That is the whole point
 * of not reimplementing it here.
 */
import { env } from '../data/config';
import { http } from '../data/uc3/client';

/** Mirrors services/cargo/simulation/base.py::SimulationResult. */
export interface EngineAssumption {
  field: string;
  value: unknown;
  reason: string;
  source: 'MEASURED' | 'DERIVED' | 'ASSUMED' | 'PARAMETER';
}

export interface EngineQuery {
  purpose: string;
  sql: string;
  params: Record<string, unknown>;
  api?: string;
  row_count?: number;
  error?: string;
}

export interface EngineResult {
  scenario: string;
  method: string;
  result: Record<string, unknown>;
  // Booleans are part of this contract: channel-closure reports
  // `berth_lock_reached` and modal-shift `gate_absorbs_load` as figures.
  figures: Record<string, number | string | boolean | null>;
  assumptions: EngineAssumption[];
  queries: EngineQuery[];
  recommendations: Array<{ action: string; reason: string; [k: string]: unknown }>;
  data_available: boolean;
  notes: string[];
}

/**
 * Which audited scenario answers which UC-1 walkthrough scenario.
 *
 * Only two of the ten map. M9 and M5 are the marine scenarios the JNPA Notice
 * actually asks about (I-B and I-A); the other eight are briefing-level
 * capabilities with no dated Notice question behind them, so there is nothing to
 * cross-check them against and no entry is invented for them.
 */
export const ENGINE_FOR_SCENARIO: Record<string, { scenario: string; label: string }> = {
  M9: { scenario: 'berth-cascade', label: 'I-B — Extended Berth Window' },
  M5: { scenario: 'vessel-bunching', label: 'I-A — Vessel Bunching' },
};

/**
 * Default parameters, set to the dates the Notice states so the briefed question
 * runs without anyone typing. Both are overridable by the caller.
 */
export function defaultParams(scenario: string): Record<string, unknown> {
  if (scenario === 'berth-cascade') {
    // "On 2nd August 2026, a vessel's operation is overrun by six hours."
    return { as_of: '2026-08-02T00:00:00Z', delay_hours: 6, horizon_hours: 48 };
  }
  // "On 6 August 2026 a large number of vessels are alongside…"
  return { as_of: '2026-08-06T00:00:00Z', objective: 'waiting_time', horizon_hours: 24 };
}

export class EngineUnavailable extends Error {}

/**
 * Run one audited scenario.
 *
 * Throws :class:`EngineUnavailable` when the gateway is not reachable, which the
 * caller renders as "the audited figures need the gateway" rather than as a
 * broken panel. The walkthrough itself never depends on this — a scenario runs,
 * the map moves and the VR scene reacts whether or not the engine answers.
 */
export async function runEngineScenario(
  scenario: string,
  params: Record<string, unknown> = {},
): Promise<EngineResult> {
  if (!env.uc3.enabled) {
    throw new EngineUnavailable(
      'The UC-3 gateway is switched off (VITE_UC3_ENABLED=false), so the audited ' +
      'figures cannot be fetched. The walkthrough below still runs.',
    );
  }
  try {
    return await http<EngineResult>(`/cargo/simulate/${encodeURIComponent(scenario)}`, {
      method: 'POST',
      body: JSON.stringify({ ...defaultParams(scenario), ...params }),
    });
  } catch (err) {
    throw new EngineUnavailable(
      err instanceof Error
        ? `The audited figures could not be fetched: ${err.message}`
        : 'The audited figures could not be fetched.',
    );
  }
}
