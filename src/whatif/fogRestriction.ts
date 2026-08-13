/**
 * UC-1 What-If — Fog / Night Navigation Restriction: visibility below 1 km.
 *
 * Same architecture as the vessel-omission scenario (see vesselOmission.ts):
 * a pure, deterministic function over adapter reads, reusing the shared engine
 * result envelope so the answer carries its method, input provenance, query
 * trace and `data_available` flag. NON-DESTRUCTIVE by construction — reads its
 * inputs, returns a value, writes nothing, publishes nothing.
 *
 * The business rule (stated by the ticket, applied exactly):
 *
 *     restriction is ACTIVE when visibility < 1 km  (strictly less than)
 *
 * Visibility in this system is measured in NAUTICAL MILES
 * (`WeatherReading.visibilityNm`, via `DataAdapter.getWeather()`), so the
 * reading is converted at 1 NM = 1.852 km — a declared unit conversion, not an
 * assumption. Exactly 1.0 km is NOT below 1 km and does not trigger.
 *
 * DATA HONESTY — the two inputs this system does NOT have:
 *
 *  - NIGHT: there is no sunrise/sunset or day/night indicator anywhere in the
 *    application (no solar utility, no night flag in any feed). The night half
 *    of "fog / night" is therefore reported as UNAVAILABLE on every result —
 *    the scenario evaluates the fog (visibility) rule only, and says so.
 *
 *  - RESTRICTION DURATION: no feed carries a visibility forecast and no
 *    existing business rule maps a measured visibility to a hold length (the
 *    walkthrough's "4-hour hold" is a scripted narrative, not a rule; the
 *    pilot-transfer minimum in derive.ts is a boolean with a different
 *    threshold, ~1 NM). The expected duration is therefore a caller-supplied
 *    PARAMETER; without it the engine reports the restriction status and
 *    declares the schedule impact not calculable — it never invents a delay.
 *
 * When a duration IS supplied, the impact model is the one the product already
 * uses for weather holds (M1/M6 narrative and `applyPlanLevers`): a restriction
 * suspends pilot boarding and vessel movements, so a call that has not yet
 * berthed shifts WHOLE — berthing and departure move together, the turn is
 * preserved; a vessel alongside cannot sail, so only its departure moves; a
 * departed call is not affected by a restriction happening now.
 */
import type { BerthingPlanEntry, WeatherReading } from '@/types/domain';
import type { EngineAssumption, EngineQuery } from './engineClient';
import {
  DEFAULT_DOWNSTREAM_HORIZON_H,
  jnpaCallsFor,
  type OmissionCallRef,
  type OmissionUnavailable,
} from './vesselOmission';

const H = 3_600_000;

/** The ticket's business threshold. Restriction is active strictly BELOW this. */
export const VISIBILITY_THRESHOLD_KM = 1;
/** International nautical mile. */
export const NM_TO_KM = 1.852;

/* ------------------------------------------------------------------ request */

export interface FogRestrictionRequest {
  /** Vessel identity — MMSI, the key the berthing plan uses. */
  mmsi: string;
  /** The specific JNPA call (PLAN_ID). Optional when the vessel has exactly one. */
  planId?: string;
  /** Evaluation instant (epoch ms). An input, so the engine stays deterministic. */
  now: number;
  /**
   * Hypothetical visibility in km (PARAMETER — "you set this"). Absent → the
   * measured weather reading is used. This is how a tester exercises the
   * scenario when the live reading is clear; it is declared, never silent.
   */
  visibilityOverrideKm?: number;
  /**
   * Expected duration of the restriction in hours (PARAMETER). No feed carries
   * a visibility forecast and no configured rule defines one, so without this
   * the schedule impact is reported as not calculable.
   */
  holdDurationH?: number;
  /** Downstream berth-queue horizon in hours (PARAMETER; default 48). */
  downstreamHorizonH?: number;
}

/* ------------------------------------------------------------------- result */

/** The visibility rule evaluation, with full provenance. */
export interface FogRestrictionStatus {
  /** Visibility used, km. Null when no reading and no override exist. */
  visibilityKm: number | null;
  /** The raw measured reading (NM) when one was used; null under an override. */
  visibilityNm: number | null;
  visibilitySource: 'MEASURED' | 'PARAMETER' | null;
  thresholdKm: number;
  /** true = ACTIVE (< 1 km); false = not triggered; null = visibility unavailable. */
  active: boolean | null;
}

export interface FogOriginalSchedule {
  plannedStart: number;
  plannedEnd: number;
  actualStart: number | null;
  actualEnd: number | null;
  /** Berthing reference: ATB when known, else planned start. Null when neither usable. */
  eta: number | null;
  /** Departure reference: ATD when known, else planned end. Null when neither usable. */
  etd: number | null;
  /** Signed deviation vs plan in hours (+ = late). Null until actuals exist. */
  scheduleDeviationH: number | null;
}

export interface FogSimulatedSchedule {
  navigation: 'NORMAL' | 'RESTRICTED';
  /** Berthing under the restriction. Unchanged when already berthed. */
  eta: number | null;
  /** Departure under the restriction. */
  etd: number | null;
  /** Hours of delay the restriction adds to this call. Null = not calculable. */
  delayH: number | null;
  scheduleDeviationH: number | null;
}

export interface FogDownstream {
  berthId: string;
  laterCallsAtBerth: OmissionCallRef[];
  /**
   * Hours the delayed departure runs into the next call's planned window at the
   * same berth — upper bound on the knock-on delay (that vessel's own readiness
   * is unknown to this system). Null when no later call / not calculable.
   */
  nextCallKnockOnH: number | null;
}

export interface FogRestrictionResult {
  scenario: 'fog-restriction';
  method: string;
  executedAt: number;
  vessel: { mmsi: string; name: string };
  call: OmissionCallRef;
  restriction: FogRestrictionStatus;
  original: FogOriginalSchedule;
  simulated: FogSimulatedSchedule;
  downstream: FogDownstream;
  figures: Record<string, number | string | boolean | null>;
  assumptions: EngineAssumption[];
  queries: EngineQuery[];
  unavailable: OmissionUnavailable[];
  data_available: boolean;
  notes: string[];
}

export interface FogRestrictionError {
  code: 'NO_JNPA_CALL' | 'CALL_NOT_FOUND' | 'AMBIGUOUS_CALL' | 'CALL_CANCELLED';
  message: string;
  candidates?: OmissionCallRef[];
}

export type FogRestrictionOutcome =
  | { kind: 'result'; result: FogRestrictionResult }
  | { kind: 'error'; error: FogRestrictionError };

/* ------------------------------------------------------------------ helpers */

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
const round2 = (n: number): number => Number(n.toFixed(2));

/**
 * Evaluate the visibility rule on its own — used by the panel to show the
 * current restriction state before any vessel is selected. Pure.
 */
export function evaluateVisibility(
  weather: WeatherReading | null,
  overrideKm?: number
): FogRestrictionStatus {
  if (typeof overrideKm === 'number' && Number.isFinite(overrideKm) && overrideKm >= 0) {
    return {
      visibilityKm: overrideKm,
      visibilityNm: null,
      visibilitySource: 'PARAMETER',
      thresholdKm: VISIBILITY_THRESHOLD_KM,
      // Strictly below 1 km — exactly 1.0 km does NOT trigger.
      active: overrideKm < VISIBILITY_THRESHOLD_KM,
    };
  }
  const nm = weather && typeof weather.visibilityNm === 'number' && Number.isFinite(weather.visibilityNm)
    ? weather.visibilityNm
    : null;
  if (nm === null) {
    return {
      visibilityKm: null,
      visibilityNm: null,
      visibilitySource: null,
      thresholdKm: VISIBILITY_THRESHOLD_KM,
      active: null,
    };
  }
  const km = nm * NM_TO_KM;
  return {
    visibilityKm: round2(km),
    visibilityNm: nm,
    visibilitySource: 'MEASURED',
    thresholdKm: VISIBILITY_THRESHOLD_KM,
    // Compare the unrounded conversion so the strict rule is exact.
    active: km < VISIBILITY_THRESHOLD_KM,
  };
}

/* ------------------------------------------------------------------- engine */

/**
 * Simulate the fog / night navigation restriction on one JNPA call. Pure:
 * reads `plan` and `weather`, writes nothing. Repeat runs with the same inputs
 * return the same result — nothing accumulates.
 */
export function simulateFogRestriction(
  plan: BerthingPlanEntry[],
  weather: WeatherReading | null,
  req: FogRestrictionRequest
): FogRestrictionOutcome {
  /* ---- selection (same rules as the omission scenario) ---- */

  const calls = jnpaCallsFor(plan, req.mmsi);
  if (calls.length === 0) {
    return {
      kind: 'error',
      error: {
        code: 'NO_JNPA_CALL',
        message:
          'Selected vessel does not have a JNPA port call in the berthing plan window — there is no schedule to impact.',
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
    return {
      kind: 'error',
      error: {
        code: 'AMBIGUOUS_CALL',
        message: `Vessel ${req.mmsi} has ${calls.length} JNPA port calls in the window. Select the specific call.`,
        candidates: calls.map(ref),
      },
    };
  } else {
    call = calls[0];
  }
  if (!call) {
    return {
      kind: 'error',
      error: { code: 'NO_JNPA_CALL', message: 'No JNPA port call resolved for this vessel.' },
    };
  }
  if (call.STATUS === 'cancelled') {
    return {
      kind: 'error',
      error: {
        code: 'CALL_CANCELLED',
        message: `Port call ${call.PLAN_ID} is cancelled in the operational plan — a navigation restriction has no schedule to impact.`,
      },
    };
  }

  /* ---- the visibility rule ---- */

  const restriction = evaluateVisibility(weather, req.visibilityOverrideKm);
  const horizonH = req.downstreamHorizonH ?? DEFAULT_DOWNSTREAM_HORIZON_H;

  const notes: string[] = [];
  const unavailable: OmissionUnavailable[] = [];
  const assumptions: EngineAssumption[] = [];

  if (restriction.visibilitySource === 'MEASURED') {
    assumptions.push({
      field: 'visibility',
      value: `${restriction.visibilityNm} NM (${restriction.visibilityKm} km)`,
      reason:
        'Latest weather reading from DataAdapter.getWeather(). The feed reports nautical miles; converted at 1 NM = 1.852 km.',
      source: 'MEASURED',
    });
  } else if (restriction.visibilitySource === 'PARAMETER') {
    assumptions.push({
      field: 'visibility',
      value: `${restriction.visibilityKm} km`,
      reason: 'Hypothetical visibility set by the operator for this what-if run — not a measurement.',
      source: 'PARAMETER',
    });
  } else {
    unavailable.push({
      field: 'visibility',
      reason:
        'The weather reading carries no visibility value and no hypothetical visibility was set — the restriction rule cannot be evaluated.',
    });
  }

  assumptions.push({
    field: 'visibility_threshold',
    value: `< ${VISIBILITY_THRESHOLD_KM} km (strict)`,
    reason:
      'The stated business rule: navigation is restricted when visibility is strictly below 1 km. Exactly 1.0 km does not trigger it. (The existing pilot-transfer minimum in the twin, ~1 NM, is a separate rule and is not used here.)',
    source: 'PARAMETER',
  });

  // The night half of "fog / night": this system has no day/night indicator.
  unavailable.push({
    field: 'night_condition',
    reason:
      'No sunrise/sunset times or day/night flag exist anywhere in this application or its feeds. The night restriction cannot be evaluated — this result covers the fog (visibility) rule only.',
  });

  /* ---- original schedule (read-only) ---- */

  const plannedStart = ts(call.PLANNED_START);
  const plannedEnd = ts(call.PLANNED_END);
  const actualStart = ts(call.ACTUAL_START);
  const actualEnd = ts(call.ACTUAL_END);

  const eta = actualStart ?? plannedStart;
  const etd = actualEnd ?? plannedEnd;
  if (eta === null) {
    unavailable.push({
      field: 'original_eta',
      reason: 'The plan entry carries no berthing time (actual or planned).',
    });
  }
  if (etd === null) {
    unavailable.push({
      field: 'original_etd',
      reason: 'The plan entry carries no departure time (actual or planned).',
    });
  }

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

  /* ---- simulated schedule ---- */

  const departed = actualEnd !== null;
  const berthed = actualStart !== null;

  let delayH: number | null;
  let simEta: number | null;
  let simEtd: number | null;

  if (restriction.active === false) {
    // No restriction — the simulated schedule IS the original. Zero, not blank.
    delayH = 0;
    simEta = eta;
    simEtd = etd;
  } else if (restriction.active === null) {
    delayH = null;
    simEta = null;
    simEtd = null;
    unavailable.push({
      field: 'schedule_impact',
      reason: 'The restriction rule could not be evaluated (visibility unavailable), so no schedule impact can be stated.',
    });
  } else if (req.holdDurationH === undefined) {
    // Restriction detected, but its duration is not derivable from any data or
    // configured rule in this system — say so instead of inventing a delay.
    delayH = null;
    simEta = null;
    simEtd = null;
    unavailable.push({
      field: 'restriction_duration',
      reason:
        'No feed carries a visibility forecast and no configured business rule maps a visibility reading to a hold length. Set the expected restriction duration to compute the schedule impact.',
    });
    unavailable.push({
      field: 'schedule_impact',
      reason: 'Not calculable without the restriction duration above.',
    });
  } else {
    const hold = Math.max(0, req.holdDurationH);
    assumptions.push({
      field: 'restriction_duration',
      value: `${hold} h`,
      reason:
        'Expected duration of the visibility restriction, set by the operator — no forecast exists to derive it from.',
      source: 'PARAMETER',
    });
    if (departed) {
      delayH = 0;
      simEta = eta;
      simEtd = etd;
      notes.push(
        'This call has already departed — a restriction active now does not move a departed vessel. Impact is zero for this call.'
      );
    } else if (berthed) {
      // Alongside: cannot sail while movements are suspended → departure moves.
      delayH = round1(hold);
      simEta = eta;
      simEtd = etd !== null ? etd + hold * H : null;
      assumptions.push({
        field: 'impact_model',
        value: 'departure held',
        reason:
          'The vessel is alongside; a movement suspension delays its unberthing/sailing, so the departure moves by the hold while the berthing time is already in the past.',
        source: 'DERIVED',
      });
    } else {
      // Not yet berthed: the whole call shifts — the twin's existing weather-hold
      // rule (M1/M6, applyPlanLevers): berthing and departure move together, the
      // turn is preserved.
      delayH = round1(hold);
      simEta = eta !== null ? eta + hold * H : null;
      simEtd = etd !== null ? etd + hold * H : null;
      assumptions.push({
        field: 'impact_model',
        value: 'whole call shifts',
        reason:
          "The vessel has not berthed; a pilotage/movement suspension holds it at the anchorage, so the whole call shifts by the hold and the turn is preserved — the twin's existing weather-hold rule.",
        source: 'DERIVED',
      });
    }
  }

  const simulatedDeviationH =
    delayH !== null && scheduleDeviationH !== null ? round1(scheduleDeviationH + delayH) : null;

  /* ---- downstream (berth queue) ---- */

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
  let nextCallKnockOnH: number | null = null;
  if (nextAtBerth && simEtd !== null && delayH !== null && delayH > 0) {
    nextCallKnockOnH = round1(Math.max(0, (simEtd - nextAtBerth.PLANNED_START) / H));
    assumptions.push({
      field: 'next_call_knock_on',
      value: nextCallKnockOnH,
      reason:
        'Hours the delayed departure runs into the next call’s planned window at the same berth — an upper bound from berth occupancy alone; the restriction may hold that vessel too, which this figure does not model.',
      source: 'DERIVED',
    });
  } else if (nextAtBerth && delayH === 0) {
    nextCallKnockOnH = 0;
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
      purpose: 'Latest weather reading (visibility)',
      api: 'DataAdapter.getWeather()',
      sql: 'weather.visibilityNm  // nautical miles; converted ×1.852 to km — client-side over the adapter read',
      params: {},
      row_count: weather ? 1 : 0,
    },
    {
      purpose: 'JNPA berthing plan entries for the selected vessel',
      api: 'DataAdapter.getBerthPlan(window)',
      sql: `plan.filter(p => p.MMSI === '${req.mmsi}')`,
      params: { mmsi: req.mmsi, planId: call.PLAN_ID },
      row_count: calls.length,
    },
    {
      purpose: 'Later calls at the same berth inside the downstream horizon',
      api: 'DataAdapter.getBerthPlan(window)',
      sql: `plan.filter(p => p.BERTH_ID === '${call.BERTH_ID}' && p.PLANNED_START >= call.PLANNED_START && p.PLANNED_START <= call.PLANNED_START + ${horizonH}h && p.STATUS !== 'cancelled')`,
      params: { berthId: call.BERTH_ID, horizonHours: horizonH },
      row_count: laterAtBerth.length,
    },
  ];

  notes.push(
    'Simulation only: the operational berthing plan, ETAs/ETDs and events are not modified, and no operational event is published.'
  );

  const result: FogRestrictionResult = {
    scenario: 'fog-restriction',
    method:
      'Visibility is read from the latest weather reading (nautical miles, converted at 1 NM = 1.852 km) or from an operator-set hypothetical value, and compared strictly against the 1 km business threshold. When the restriction is active and an expected duration is set, the impact follows the twin’s existing weather-hold rule: a call not yet berthed shifts whole (berthing and departure move together, turn preserved); a vessel alongside has only its departure held; a departed call is unaffected. The delayed departure is then compared with later calls at the same berth to bound the knock-on. Night cannot be evaluated — no day/night data exists in this system.',
    executedAt: req.now,
    vessel: { mmsi: call.MMSI, name: call.VESSEL_NAME },
    call: ref(call),
    restriction,
    original: {
      plannedStart: call.PLANNED_START,
      plannedEnd: call.PLANNED_END,
      actualStart: call.ACTUAL_START,
      actualEnd: call.ACTUAL_END,
      eta,
      etd,
      scheduleDeviationH,
    },
    simulated: {
      navigation: restriction.active === true ? 'RESTRICTED' : 'NORMAL',
      eta: simEta,
      etd: simEtd,
      delayH,
      scheduleDeviationH: simulatedDeviationH,
    },
    downstream: {
      berthId: call.BERTH_ID,
      laterCallsAtBerth: laterAtBerth.map(ref),
      nextCallKnockOnH,
    },
    figures: {
      visibility_km: restriction.visibilityKm,
      visibility_source: restriction.visibilitySource,
      visibility_threshold_km: VISIBILITY_THRESHOLD_KM,
      restriction_active: restriction.active,
      hold_duration_hours: req.holdDurationH ?? null,
      schedule_delay_hours: delayH,
      schedule_deviation_before_hours: scheduleDeviationH,
      schedule_deviation_after_hours: simulatedDeviationH,
      downstream_calls_at_berth: laterAtBerth.length,
      next_call_knock_on_hours: nextCallKnockOnH,
      navigation: restriction.active === true ? 'RESTRICTED' : 'NORMAL',
    },
    assumptions,
    queries,
    unavailable,
    // The headline question ("what schedule impact?") is answered when the
    // delay is a number — including a legitimate 0 (no restriction / departed).
    data_available: delayH !== null,
    notes,
  };

  return { kind: 'result', result };
}
