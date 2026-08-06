/**
 * Operational phrasing for the lifecycle values on a Port-Craft demand row.
 *
 * PRESENTATION ONLY. Every entry is a 1:1 relabelling of a value the backend engine
 * already decided — no value is combined, ranked, inferred or invented. Nothing here
 * changes what is counted; it changes what an operator reads.
 *
 * It lives in the component layer, NOT in the connector: `portCraftState.ts` maps wire →
 * domain faithfully and must keep the backend's own vocabulary so other consumers (and
 * tests) can compare against the API verbatim.
 *
 * The vocabularies below are exhaustive against services/marine/state_engine.py
 * (derive_state) plus the four parser stages in parsers/pcs_common.py. An unrecognised
 * value FALLS THROUGH VERBATIM rather than being hidden — if the engine gains a state,
 * the operator sees the raw word instead of a blank cell, and the gap is obvious.
 */

/** `status` — the headline stage. Engine values first, then the parser stages. */
const STAGE: Record<string, string> = {
  // derived by the engine once milestones exist
  Departed: 'Departed',
  Sailing: 'Sailing from Berth',
  'At Berth': 'Currently Berthed',
  'Pilot Boarded': 'Pilot Onboard',
  Anchored: 'At Anchorage',
  // parser stages, before any milestone
  'Berth Allotted': 'Berth Allotted',
  'Berth Planned': 'Berth Applied For',
  'VCN Allotted': 'Call Number Issued',
  Planned: 'Voyage Registered',
};

const ARRIVAL: Record<string, string> = {
  Completed: 'Arrival Completed',
  Anchored: 'Waiting at Anchorage',
  Pending: 'Arrival Pending',
};

const PILOT: Record<string, string> = {
  Completed: 'Pilot Operation Completed',
  Active: 'Pilot Onboard',
  Pending: 'Pilot Not Yet Boarded',
};

const BERTH: Record<string, string> = {
  Released: 'Berth Released',
  Occupied: 'Currently Berthed',
  Allotted: 'Berth Allotted',
  Pending: 'No Berth Yet',
};

const DEPARTURE: Record<string, string> = {
  Completed: 'Departed',
  Sailing: 'Sailing',
  Pending: 'Departure Pending',
};

/**
 * `movement_phase` — why the call counts toward craft demand. This is the reason the row
 * appears at all, so it is phrased as a reason rather than a category name.
 */
const PHASE_REASON: Record<string, string> = {
  Inbound: 'Inbound movement — pilot aboard, not yet berthed',
  Alongside: 'Alongside — berthed and not yet departed',
  Outbound: 'Outbound movement — sailed, not yet cleared',
};

/**
 * `status` → the stage the lifecycle ladder reaches NEXT.
 *
 * A read of the engine's own ordering (state_engine.EVENT_ORDER), not a prediction: it
 * says which milestone comes after the current one, never when it will happen or whether
 * it will. Only the states this table can actually contain are mapped — a call reaches the
 * demand list only when `portcraft_state` is Busy, which requires pilot-boarded, berthed
 * or sailed. Anything else falls through to '' and the cell is left blank rather than
 * guessed.
 */
const NEXT_STAGE: Record<string, string> = {
  Anchored: 'Pilot Boarding',
  'Pilot Boarded': 'Berthing',
  'At Berth': 'Departure',
  Sailing: 'Departure',
  Departed: 'Completed',
};

/** Look up a phrase, falling through to the raw value so nothing is silently lost. */
function phrase(map: Record<string, string>, value: string): string {
  return value ? (map[value] ?? value) : '';
}

export const stageLabel = (v: string) => phrase(STAGE, v);
export const arrivalLabel = (v: string) => phrase(ARRIVAL, v);
export const pilotLabel = (v: string) => phrase(PILOT, v);
export const berthLabel = (v: string) => phrase(BERTH, v);
export const departureLabel = (v: string) => phrase(DEPARTURE, v);
export const phaseReason = (v: string) => phrase(PHASE_REASON, v);

/**
 * Craft state, as the operator reads it. 'Busy' means THIS CALL is in a phase that
 * requires marine support — it never means a specific craft is engaged, because nothing
 * in the schema links a craft to a call.
 */
export const craftLabel = (v: string): string =>
  v === 'Busy' ? 'Requires marine support' : v === 'Idle' ? 'No support required' : v;

/**
 * Next stage on the ladder. Unlike the others this does NOT fall through to the raw
 * value — an unmapped stage has no known successor, and echoing the CURRENT stage into a
 * "next" column would read as a prediction the data never made. Blank is the honest cell.
 */
export const nextStageLabel = (v: string): string => NEXT_STAGE[v] ?? '';
