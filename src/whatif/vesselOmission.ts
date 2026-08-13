/**
 * UC-1 What-If — Vessel Omission: a line skips its JNPA call for schedule
 * recovery.
 *
 * Why this is computed HERE and not in the UC-3 engine
 * ----------------------------------------------------
 * The nine catalogued scenarios are answered by the shared engine behind
 * `POST /api/cargo/simulate/{id}` (see engineClient.ts) because their data —
 * berthing, traffic, gate tables — lives in the UC-3 database. Vessel omission
 * is different: everything it needs is the JNPA berthing plan this dashboard
 * already reads through its `DataAdapter`, and the walkthrough must run offline
 * (mock mode is zero-credential by design). So it follows the other UC-1
 * pattern — a pure, deterministic function over adapter reads, like the lever
 * engine in `src/sim/` — and reuses the engine's RESULT envelope (figures,
 * assumptions with provenance, query trace, `data_available`) so the answer is
 * presented and audited the same way as the catalogued ones.
 *
 * NON-DESTRUCTIVE by construction: this module never writes. It takes the plan
 * as a value, mutates nothing, publishes nothing, and returns a result object.
 * The operational plan, stores and adapters are untouched — the simulated
 * schedule exists only in the returned result.
 *
 * DATA HONESTY (the rule this file is built around): the berthing plan is the
 * ONLY schedule source in this application. It carries the JNPA call window —
 * it does NOT carry the vessel's rotation (previous/next port) or any
 * downstream port ETA. Every figure below is therefore one of:
 *   MEASURED  — read directly from the plan entry (planned/actual window);
 *   DERIVED   — arithmetic on measured values, formula stated;
 *   PARAMETER — set by the caller (e.g. the downstream horizon);
 * and anything that would need data the system does not hold (next-port ETA,
 * anchorage arrival time, voyage number) is returned as `null` with a stated
 * reason in `unavailable` — never a realistic-looking guess.
 */
import type { BerthingPlanEntry } from '@/types/domain';
import type { EngineAssumption, EngineQuery } from './engineClient';

/** Milliseconds per hour, matching the convention across src/sim. */
const H = 3_600_000;

/** Default downstream look-ahead over the berth queue (same 48 h horizon the
 *  Notice uses for the berth-cascade question I-B). */
export const DEFAULT_DOWNSTREAM_HORIZON_H = 48;

/* ------------------------------------------------------------------ request */

/**
 * The simulation request. Naming follows the data the repo actually has:
 * vessels are identified by MMSI (the `BerthingPlanEntry`/`Vessel` key) and a
 * JNPA port call by its PLAN_ID. There is no voyage id in the adapter data —
 * see `unavailable` in the result.
 */
export interface VesselOmissionRequest {
  /** Vessel identity — MMSI, the key the berthing plan uses. */
  mmsi: string;
  /**
   * The specific JNPA call (PLAN_ID) to omit. Optional when the vessel has
   * exactly one call in the window; REQUIRED when it has several — the engine
   * refuses to pick one arbitrarily.
   */
  planId?: string;
  /** Evaluation instant (epoch ms). Passed in so the engine stays deterministic. */
  now: number;
  /** Downstream berth-queue horizon in hours (PARAMETER; default 48). */
  downstreamHorizonH?: number;
}

/* ------------------------------------------------------------------- result */

/** A reference to one candidate JNPA call, for disambiguation. */
export interface OmissionCallRef {
  planId: string;
  berthId: string;
  plannedStart: number;
  plannedEnd: number;
  status: BerthingPlanEntry['STATUS'];
}

/** A value the data could not support, with the reason stated. */
export interface OmissionUnavailable {
  field: string;
  reason: string;
}

/** Original (operational) JNPA call schedule — read, never modified. */
export interface OmissionOriginalSchedule {
  plannedStart: number;
  plannedEnd: number;
  actualStart: number | null;
  actualEnd: number | null;
  /** Departure the downstream schedule is measured against: ATD when known, else planned end. Null when neither is usable. */
  departure: number | null;
  /** Alongside duration in hours (actuals preferred, else planned). Null when the window is unusable. */
  callDurationH: number | null;
  /** Signed deviation vs plan in hours (+ = running late). Null until actuals exist. */
  scheduleDeviationH: number | null;
}

/** The hypothetical schedule with the JNPA call omitted. */
export interface OmissionSimulatedSchedule {
  /** Always 'OMITTED' — the simulation's whole premise. */
  callStatus: 'OMITTED';
  /**
   * When the vessel proceeds past JNPA instead of calling: the earlier of the
   * planned and actual berthing start (DERIVED lower bound — true anchorage
   * arrival time is not in the data). Null when no start time is usable.
   */
  passBy: number | null;
  /** JNPA call duration under omission — 0 by definition. */
  callDurationH: 0;
  /** Signed deviation vs the original downstream plan after omission (hours). */
  scheduleDeviationH: number | null;
}

/** Downstream effect on the JNPA berth queue — the one downstream impact the data supports. */
export interface OmissionDownstream {
  /** Berth the omitted call would have occupied. */
  berthId: string;
  /** Freed window [from, to] at that berth. Null when the window is unusable. */
  berthFreedFrom: number | null;
  berthFreedTo: number | null;
  /** Later calls at the same berth inside the horizon. */
  laterCallsAtBerth: OmissionCallRef[];
  /**
   * Upper bound on how much the next call at this berth could advance (hours):
   * min(recovered time, that call's planned start − freed start), floored at 0.
   * Null when there is no later call or the window is unusable.
   */
  nextCallPotentialAdvanceH: number | null;
}

/**
 * The full simulation result. Envelope fields (`figures`, `assumptions`,
 * `queries`, `data_available`, `notes`) match the shared engine contract in
 * engineClient.ts so the answer is auditable the same way; the typed schedule
 * blocks on top are what the comparison UI renders.
 */
export interface VesselOmissionResult {
  scenario: 'vessel-omission';
  method: string;
  /** When the simulation was executed (the request's `now`). */
  executedAt: number;
  vessel: { mmsi: string; name: string };
  omittedCall: OmissionCallRef;
  original: OmissionOriginalSchedule;
  simulated: OmissionSimulatedSchedule;
  /**
   * THE business answer: hours of schedule the vessel recovers by skipping
   * JNPA = original departure − simulated pass-by. Null when the plan entry
   * lacks a usable window (never fabricated). Legitimately 0 when the data
   * shows no recoverable time.
   */
  recoveredH: number | null;
  downstream: OmissionDownstream;
  figures: Record<string, number | string | boolean | null>;
  assumptions: EngineAssumption[];
  queries: EngineQuery[];
  unavailable: OmissionUnavailable[];
  data_available: boolean;
  notes: string[];
}

/** Validation failure — returned, not thrown, so the UI renders it as a message. */
export interface VesselOmissionError {
  code:
    | 'NO_JNPA_CALL'
    | 'CALL_NOT_FOUND'
    | 'AMBIGUOUS_CALL'
    | 'ALREADY_CANCELLED';
  message: string;
  /** For AMBIGUOUS_CALL: the calls the user must choose between. */
  candidates?: OmissionCallRef[];
}

export type VesselOmissionOutcome =
  | { kind: 'result'; result: VesselOmissionResult }
  | { kind: 'error'; error: VesselOmissionError };

/* ------------------------------------------------------------------ helpers */

/** Epoch-ms fields use 0 for "unknown" in the live feeds; treat non-positive/non-finite as absent. */
function ts(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

function ref(p: BerthingPlanEntry): OmissionCallRef {
  return {
    planId: p.PLAN_ID,
    berthId: p.BERTH_ID,
    plannedStart: p.PLANNED_START,
    plannedEnd: p.PLANNED_END,
    status: p.STATUS,
  };
}

const round1 = (h: number): number => Number(h.toFixed(1));

/** All of a vessel's JNPA calls in the plan, earliest first — the selection list. */
export function jnpaCallsFor(plan: BerthingPlanEntry[], mmsi: string): BerthingPlanEntry[] {
  return plan
    .filter((p) => p.MMSI === mmsi)
    .slice()
    .sort((a, b) => a.PLANNED_START - b.PLANNED_START);
}

/* ------------------------------------------------------------------- engine */

/**
 * Simulate omitting one JNPA port call. Pure: reads `plan`, writes nothing.
 *
 * Recovered time =
 *   original departure (ATD, else planned end)
 *   − simulated pass-by (earlier of planned and actual berthing start)
 * floored at zero. Every input's provenance is stated in `assumptions`; every
 * input the data lacks is listed in `unavailable` with the reason.
 */
export function simulateVesselOmission(
  plan: BerthingPlanEntry[],
  req: VesselOmissionRequest
): VesselOmissionOutcome {
  const calls = jnpaCallsFor(plan, req.mmsi);

  if (calls.length === 0) {
    return {
      kind: 'error',
      error: {
        code: 'NO_JNPA_CALL',
        message:
          'Selected vessel does not have a JNPA port call in the berthing plan window — there is nothing to omit.',
      },
    };
  }

  let call: BerthingPlanEntry | undefined;
  if (req.planId !== undefined) {
    call = calls.find((c) => c.PLAN_ID === req.planId);
    if (!call) {
      return {
        kind: 'error',
        error: {
          code: 'CALL_NOT_FOUND',
          message: `Port call '${req.planId}' does not belong to vessel ${req.mmsi} in the berthing plan window.`,
          candidates: calls.map(ref),
        },
      };
    }
  } else if (calls.length > 1) {
    // Never pick one of several JNPA calls silently.
    return {
      kind: 'error',
      error: {
        code: 'AMBIGUOUS_CALL',
        message: `Vessel ${req.mmsi} has ${calls.length} JNPA port calls in the window. Select the specific call to omit.`,
        candidates: calls.map(ref),
      },
    };
  } else {
    call = calls[0];
  }
  if (!call) {
    // Unreachable (calls.length >= 1 here), but keeps indexed access honest.
    return {
      kind: 'error',
      error: { code: 'NO_JNPA_CALL', message: 'No JNPA port call resolved for this vessel.' },
    };
  }

  if (call.STATUS === 'cancelled') {
    return {
      kind: 'error',
      error: {
        code: 'ALREADY_CANCELLED',
        message: `Port call ${call.PLAN_ID} is already cancelled in the operational plan — omitting it recovers nothing that is not already recovered.`,
      },
    };
  }

  const horizonH = req.downstreamHorizonH ?? DEFAULT_DOWNSTREAM_HORIZON_H;
  const notes: string[] = [];
  const unavailable: OmissionUnavailable[] = [];
  const assumptions: EngineAssumption[] = [];

  const plannedStart = ts(call.PLANNED_START);
  const plannedEnd = ts(call.PLANNED_END);
  const actualStart = ts(call.ACTUAL_START);
  const actualEnd = ts(call.ACTUAL_END);

  /* ---- original schedule (read-only) ---- */

  // Departure the downstream schedule hangs off: ATD when it exists, else the plan.
  const departure = actualEnd ?? plannedEnd;
  if (departure === null) {
    unavailable.push({
      field: 'original_departure',
      reason:
        'Neither an actual nor a planned departure time is present on this plan entry, so no recovery can be calculated from it.',
    });
  } else {
    assumptions.push({
      field: 'original_departure',
      value: departure,
      reason: actualEnd !== null
        ? 'Actual time departed (ATD) from the berthing plan.'
        : 'Planned departure from the berthing plan — no ATD yet.',
      source: 'MEASURED',
    });
  }
  if (departure !== null && actualEnd === null && call.END_ESTIMATED) {
    notes.push(
      'The planned departure on this entry was defaulted by the feed (END_ESTIMATED) — the source carried no end time.'
    );
  }

  // Alongside duration, actuals preferred.
  const durStart = actualStart ?? plannedStart;
  const durEnd = actualEnd ?? plannedEnd;
  const callDurationH =
    durStart !== null && durEnd !== null && durEnd > durStart
      ? round1((durEnd - durStart) / H)
      : null;
  if (callDurationH === null) {
    unavailable.push({
      field: 'original_call_duration',
      reason: 'The plan entry does not carry a usable alongside window (start/end missing or inverted).',
    });
  }

  // Deviation vs plan — only when actuals exist; never projected.
  let scheduleDeviationH: number | null = null;
  if (actualEnd !== null && plannedEnd !== null) {
    scheduleDeviationH = round1((actualEnd - plannedEnd) / H);
  } else if (actualStart !== null && plannedStart !== null) {
    scheduleDeviationH = round1((actualStart - plannedStart) / H);
    notes.push(
      'Schedule deviation is measured at berthing (ATB vs plan) — the call has not departed, so departure deviation does not exist yet.'
    );
  } else {
    unavailable.push({
      field: 'schedule_deviation_before',
      reason: 'No actuals exist for this call yet, so its deviation from plan is not yet a measurement.',
    });
  }

  /* ---- simulated schedule (the hypothesis — exists only in this result) ---- */

  // When the vessel would proceed past JNPA instead of calling. True anchorage
  // arrival is not in the data; the earlier of planned/actual berthing start is
  // the defensible lower bound, and is declared as derived.
  const passBy =
    plannedStart !== null && actualStart !== null
      ? Math.min(plannedStart, actualStart)
      : plannedStart ?? actualStart;
  if (passBy === null) {
    unavailable.push({
      field: 'simulated_pass_by',
      reason: 'The plan entry carries no berthing start time (planned or actual) to anchor the omission on.',
    });
  } else {
    assumptions.push({
      field: 'simulated_pass_by',
      value: passBy,
      reason:
        'Earlier of the planned and actual berthing start. The true anchorage arrival time is not recorded in the berthing plan, so this is the conservative lower bound on when the vessel could have proceeded.',
      source: 'DERIVED',
    });
  }

  // THE answer. Floored at 0 — 0 is a legitimate result, not an error.
  const recoveredH =
    departure !== null && passBy !== null ? round1(Math.max(0, (departure - passBy) / H)) : null;
  if (recoveredH === null) {
    unavailable.push({
      field: 'recovered_time',
      reason: 'Recovered time needs both a departure and a pass-by time; one of them is missing above.',
    });
  }

  const simulatedDeviationH =
    recoveredH !== null && scheduleDeviationH !== null
      ? round1(scheduleDeviationH - recoveredH)
      : recoveredH !== null
        ? round1(-recoveredH)
        : null;

  /* ---- downstream ---- */

  // Next-port data simply does not exist in this system. Say so.
  unavailable.push({
    field: 'next_port_eta',
    reason:
      'The system holds no port-rotation data (previous/next port or downstream ETAs) for vessels — the berthing plan covers JNPA only. The downstream schedule shift is reported as a delta (the recovered time), not as absolute ETAs.',
  });
  unavailable.push({
    field: 'voyage_id',
    reason:
      'The berthing plan identifies calls by PLAN_ID and vessels by MMSI; no voyage number is present in the adapter data.',
  });

  // The one downstream effect the data DOES support: the freed berth window and
  // what the queue behind it could do with it.
  const horizonEnd = (plannedStart ?? req.now) + horizonH * H;
  const laterAtBerth = plan
    .filter(
      (p) =>
        p.PLAN_ID !== call.PLAN_ID &&
        p.BERTH_ID === call.BERTH_ID &&
        p.STATUS !== 'cancelled' &&
        plannedStart !== null &&
        p.PLANNED_START >= plannedStart &&
        p.PLANNED_START <= horizonEnd
    )
    .sort((a, b) => a.PLANNED_START - b.PLANNED_START);

  const nextAtBerth = laterAtBerth[0];
  let nextCallPotentialAdvanceH: number | null = null;
  if (nextAtBerth && passBy !== null && recoveredH !== null) {
    nextCallPotentialAdvanceH = round1(
      Math.max(0, Math.min(recoveredH, (nextAtBerth.PLANNED_START - passBy) / H))
    );
    assumptions.push({
      field: 'next_call_potential_advance',
      value: nextCallPotentialAdvanceH,
      reason:
        'Upper bound from berth availability alone: min(recovered time, next call planned start − freed start). Whether that vessel can actually arrive earlier is not known to this system.',
      source: 'DERIVED',
    });
  }

  assumptions.push({
    field: 'downstream_horizon_hours',
    value: horizonH,
    reason: 'Berth-queue look-ahead window (same horizon the Notice uses for the berth-cascade question).',
    source: 'PARAMETER',
  });

  /* ---- envelope ---- */

  const queries: EngineQuery[] = [
    {
      purpose: 'JNPA berthing plan entries for the selected vessel',
      api: 'DataAdapter.getBerthPlan(window)',
      sql: `plan.filter(p => p.MMSI === '${req.mmsi}')  // client-side over the adapter read; no database in this app`,
      params: { mmsi: req.mmsi, planId: call.PLAN_ID },
      row_count: calls.length,
    },
    {
      purpose: 'Later calls at the freed berth inside the downstream horizon',
      api: 'DataAdapter.getBerthPlan(window)',
      sql: `plan.filter(p => p.BERTH_ID === '${call.BERTH_ID}' && p.PLANNED_START >= omitted.PLANNED_START && p.PLANNED_START <= omitted.PLANNED_START + ${horizonH}h && p.STATUS !== 'cancelled')`,
      params: { berthId: call.BERTH_ID, horizonHours: horizonH },
      row_count: laterAtBerth.length,
    },
  ];

  if (call.STATUS === 'completed' || call.STATUS === 'active') {
    notes.push(
      `This call is ${call.STATUS === 'completed' ? 'already completed' : 'alongside now'} — the omission is a retrospective what-if (what COULD have been recovered), not an executable action.`
    );
  }
  notes.push(
    'Simulation only: the operational berthing plan, schedules and events are not modified, and no operational event is published.'
  );

  const result: VesselOmissionResult = {
    scenario: 'vessel-omission',
    method:
      'The selected JNPA call is marked OMITTED in a hypothetical copy of the schedule. The vessel is taken to proceed past JNPA at the earlier of its planned and actual berthing start; recovered time is the original departure (ATD, else planned end) minus that pass-by instant, floored at zero. The downstream schedule shift equals the recovered time (no downstream port data exists to recompute absolute ETAs); the freed berth window is compared against later calls at the same berth to bound what the queue could recover.',
    executedAt: req.now,
    vessel: { mmsi: call.MMSI, name: call.VESSEL_NAME },
    omittedCall: ref(call),
    original: {
      plannedStart: call.PLANNED_START,
      plannedEnd: call.PLANNED_END,
      actualStart: call.ACTUAL_START,
      actualEnd: call.ACTUAL_END,
      departure,
      callDurationH,
      scheduleDeviationH,
    },
    simulated: {
      callStatus: 'OMITTED',
      passBy,
      callDurationH: 0,
      scheduleDeviationH: simulatedDeviationH,
    },
    recoveredH,
    downstream: {
      berthId: call.BERTH_ID,
      berthFreedFrom: passBy,
      berthFreedTo: departure,
      laterCallsAtBerth: laterAtBerth.map(ref),
      nextCallPotentialAdvanceH,
    },
    figures: {
      recovered_hours: recoveredH,
      original_call_duration_hours: callDurationH,
      simulated_call_duration_hours: 0,
      schedule_deviation_before_hours: scheduleDeviationH,
      schedule_deviation_after_hours: simulatedDeviationH,
      next_port_eta_shift_hours: recoveredH !== null ? -recoveredH : null,
      downstream_calls_at_berth: laterAtBerth.length,
      next_call_potential_advance_hours: nextCallPotentialAdvanceH,
      jnpa_call_status: 'OMITTED',
    },
    assumptions,
    queries,
    unavailable,
    data_available: recoveredH !== null,
    notes,
  };

  return { kind: 'result', result };
}
