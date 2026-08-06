/**
 * Pilot workflow → operator language. PRESENTATION ONLY.
 *
 * Every status here is a RENAME of a value the backend already decided
 * (`extras.lifecycle.pilot_status`, produced by services/marine/pilot_status.py from the
 * Marine Projection). Nothing is ranked, combined or derived from timestamps — if the
 * backend has no opinion, neither does this module. That is what keeps the Pilotage
 * screen from becoming a second lifecycle engine.
 *
 * The engine vocabulary is precise but reads like a message spec ('Departure Pilot
 * Completed'). A duty officer wants to know who is free and who is working, so each
 * engine value maps to a plainer phrase. The mapping is one-way and total.
 */

import type { Pilotage } from '@/types/domain';
import type { ManualPilotAssignment } from '@/data/uc3/manualPilot';
import type { VesselCall } from '@/types/domain';

/* -------------------------------------------------------------- pilot identity */

/**
 * Pilot NAME from the open `extras` jsonb (ACKPLM's `pilot_name`), '' when absent.
 * Advance-sheet rows carry a roster CODE instead and no name — the two corpora are
 * disjoint, so a row has one or the other, never both.
 */
export function pilotName(p: Pilotage): string {
  const v = p.extras?.pilot_name;
  return typeof v === 'string' ? v.trim() : '';
}

/** Whatever identifies the pilot on this movement: roster code first, then name. */
export function pilotLabel(p: Pilotage): string {
  return p.pilotCode || pilotName(p) || '';
}

/**
 * Berth this movement involves, read from the raw sheet strings the parser preserved.
 * An INWARD movement takes a berth (`raw_to_berth`); an OUTWARD one leaves one
 * (`raw_from_berth`). The typed from/to FKs are unresolved on all but one row, so the
 * raw value is the only berth the API actually carries.
 */
export function berthCode(p: Pilotage): string {
  const to = p.extras?.raw_to_berth;
  const from = p.extras?.raw_from_berth;
  const pick = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  return pick(to) || pick(from);
}

/* -------------------------------------------------------------- vocabulary maps */

/**
 * Engine `pilot_status` → what the duty officer reads.
 *
 * 'Pilot Completed' and 'Departure Pilot Completed' both mean the job is over; the
 * movement column already says which leg it was, so both collapse to 'Completed'
 * rather than repeating that distinction in the status chip.
 */
const OPERATIONAL: Record<string, string> = {
  Planned: 'Waiting Assignment',
  'Pilot Requested': 'Assigned',
  'Pilot Boarded': 'Pilot Onboard',
  'Pilot Completed': 'Completed',
  'Departure Pilot Completed': 'Completed',
};

/** Operator-facing status for one movement. Unknown values pass through verbatim. */
export function operationalStatus(pilotStatus: string | null | undefined): string {
  if (!pilotStatus) return '';
  return OPERATIONAL[pilotStatus.trim()] ?? pilotStatus.trim();
}

/** Movement type → the stage of the visit it belongs to. */
const STAGE: Record<string, string> = {
  INWARD: 'Arriving',
  OUTWARD: 'Departing',
  SHIFTING: 'Shifting Berth',
};

/** Plain-language stage for a movement type. Unknown values pass through verbatim. */
export function movementStage(movementType: string | null | undefined): string {
  if (!movementType) return '';
  const k = movementType.trim().toUpperCase();
  return STAGE[k] ?? movementType.trim();
}

/* ------------------------------------------------------- assignment eligibility */

/**
 * Pilot states from which a manual assignment may be made.
 *
 * 'Required' is accepted alongside 'Pending' so the picker keeps working if the engine
 * ever renames the idle state; anything outside this set means a pilot is already
 * engaged or the job is finished.
 */
const ASSIGNABLE_PILOT_STATES: ReadonlySet<string> = new Set(['Pending', 'Required']);

/**
 * May this call be offered in the Pilot Assignment picker?
 *
 * DERIVED FROM THE PROJECTION, NOT FROM STORED COLUMNS. This used to read
 * `atd === 0 && (ata > 0 || eta > 0)` — raw vessel_call fields — which asked "is this
 * call open?" rather than "does it need a pilot?". A vessel whose pilot job was already
 * Completed still satisfied that predicate and stayed in the dropdown, so an operator
 * could assign a second pilot to a movement that was finished.
 *
 * The lifecycle answers it directly:
 *   pilot_state Pending/Required  -> nobody is on it            ELIGIBLE
 *   pilot_state Assigned/Onboard  -> a pilot is already engaged  NOT eligible
 *   pilot_state Completed/Released-> the job is done             NEVER eligible
 *   departure_state Completed     -> the vessel has sailed       NOT eligible
 *
 * A call with NO lifecycle is not eligible either: the projection has no opinion about
 * it, and guessing from columns is precisely what this function exists to stop.
 */
export function isPilotAssignable(call: VesselCall): boolean {
  const lc = call.lifecycle;
  if (!lc) return false;
  if (!ASSIGNABLE_PILOT_STATES.has(lc.pilotState)) return false;
  // A sailed vessel needs no pilot, whatever its pilot_state says.
  if (lc.departureState === 'Completed') return false;
  return true;
}

/**
 * Pilot states meaning A PILOT IS ENGAGED on this movement.
 *
 * Named rather than written inline at the call site so the vocabulary lives in one place:
 * 'Active' is the ENGINE's word for an imported boarding, 'Assigned'/'Onboard' are the
 * projection's words for a manual one. Listing all three is what makes imported and
 * manual behave identically — no consumer needs to know which source produced the state.
 *
 * 'Completed' and 'Released' are deliberately absent: the pilot's job has ended, so the
 * movement needs no further craft.
 */
const PILOT_ENGAGED_STATES: ReadonlySet<string> = new Set(['Assigned', 'Onboard', 'Active']);

/**
 * May this call be offered in the Port Craft picker?
 *
 * THE MARINE RULE. Craft follow the pilot: a launch carries the pilot out, tugs and
 * mooring boats work the movement he is running. So a vessel becomes a craft target when
 * a pilot is engaged, and stops being one when that job ends or the vessel sails.
 *
 * DERIVED FROM THE PROJECTION, NOT FROM STORED COLUMNS. This gate used to read
 * `atd === 0 && (ata > 0 || eta > 0)` — the pre-projection predicate that Phase 4 removed
 * from the pilot picker but never from here. It was wrong in BOTH directions, measured
 * against live data:
 *
 *   * 86 vessels WITH a pilot were hidden, because assigning a pilot writes neither ATA
 *     nor ETA and the timestamp gate discarded them after the pilot check had passed;
 *   * 134 vessels whose pilot job had COMPLETED were still offered craft, because the
 *     old gate unioned every imported pilotage call_id regardless of completion.
 *
 * Reading the lifecycle answers the operational question directly and fixes both.
 *
 * A call with NO lifecycle is not eligible: the projection has no opinion about it, and
 * guessing from columns is exactly what this replaces.
 */
export function isCraftAssignable(call: VesselCall): boolean {
  const lc = call.lifecycle;
  if (!lc) return false;
  // A sailed vessel needs no craft, whatever its pilot state says.
  if (lc.departureState === 'Completed') return false;
  return PILOT_ENGAGED_STATES.has(lc.pilotState);
}

/* -------------------------------------------------------------- pilot register */

/** Where a register row's CURRENT status came from. */
export type AssignmentSource = 'Imported' | 'Manual' | '';

/** One pilot's current operational position. */
export interface PilotRegisterRow {
  /** Roster code where the corpus has one, else the acknowledged name. */
  pilotId: string;
  /** Name when known. Roster-coded pilots have no name in the corpus. */
  name: string;
  /** Busy | Available. */
  status: string;
  /** Vessel currently held, '' when free. */
  vessel: string;
  via: string;
  /** Movement leg in plain language ('Arriving'/'Departing'), '' for a manual row. */
  movement: string;
  /** Finer position within the job — 'Pilot Onboard', 'Assigned', 'Completed'. */
  stage: string;
  /** Which record decided `status`. Blank when the pilot is idle. */
  source: AssignmentSource;
  /** Start of the current job (epoch ms), 0 when free. */
  since: number;
  /** Most recent activity of any kind (epoch ms) — the register's Last Updated. */
  lastUpdated: number;
  /** Imported movements this pilot appears on, open or finished. */
  movements: number;
}

function blank(id: string, name: string): PilotRegisterRow {
  return { pilotId: id, name, status: 'Available', vessel: '', via: '',
           movement: '', stage: '', source: '', since: 0, lastUpdated: 0, movements: 0 };
}

/**
 * Fold imported movements AND manual assignments into ONE row per pilot.
 *
 * The register is the LIVE operational view: who is working right now and on what. It is
 * not a history — core.pilotage remains the imported record and is never modified here.
 *
 * PRECEDENCE. An OPEN imported movement (boarded, not yet disembarked) is the strongest
 * statement the system has about a pilot, and always wins. A manual assignment decides the
 * status only when no open imported movement contradicts it. That is deliberately
 * narrower than "any imported movement wins": a pilot whose imported movements have all
 * FINISHED is genuinely free to take a manual job, and reading a closed movement as
 * authoritative would show them idle while they are out on a vessel.
 *
 * SUPERSEDED assignments are ignored outright — the backend deactivates one the moment an
 * import lands for that call, so an inactive row is by definition no longer operational.
 *
 * NO DUPLICATES. Rows are keyed by pilot identity, so a pilot holding both an imported
 * movement and a manual assignment appears exactly once, with `source` naming which record
 * decided the status on display.
 *
 * Ordering puts busy pilots first, then most recently active, so the top of the table is
 * the part of the roster that is actually working.
 */
export function buildPilotRegister(
  rows: readonly Pilotage[],
  manual: readonly ManualPilotAssignment[] = [],
): PilotRegisterRow[] {
  const by = new Map<string, PilotRegisterRow>();
  const get = (id: string, name: string) => {
    let r = by.get(id);
    if (!r) { r = blank(id, name); by.set(id, r); }
    if (!r.name && name) r.name = name;
    return r;
  };

  // --- imported movements ------------------------------------------------------------
  for (const p of rows) {
    const id = pilotLabel(p);
    if (!id) continue; // a movement with no pilot identity names nobody
    const r = get(id, pilotName(p));
    r.movements += 1;
    r.lastUpdated = Math.max(r.lastUpdated, p.pilotBoardedAt, p.submittedAt);

    const open = p.pilotBoardedAt > 0 && p.pilotDisembarkedAt === 0;
    if (open && p.pilotBoardedAt >= r.since) {
      r.status = 'Busy';
      r.vessel = p.vesselName || '';
      r.via = p.viaNo || '';
      r.movement = movementStage(p.movementType);
      r.stage = operationalStatus(p.lifecycle?.pilotStatus) || 'Pilot Onboard';
      r.source = 'Imported';
      r.since = p.pilotBoardedAt;
    }
  }

  // --- manual assignments, where no open imported movement already speaks -------------
  for (const a of manual) {
    if (!a.active) continue;              // superseded by an import; not operational
    const id = a.pilotCode;
    if (!id) continue;
    const r = get(id, a.pilotName || '');
    const started = a.boardedAt || a.assignedAt;
    r.lastUpdated = Math.max(r.lastUpdated, a.releasedAt, a.boardedAt, a.assignedAt);

    if (r.source === 'Imported') continue; // an open imported movement outranks this
    // Busy while Assigned or Onboard; a released assignment frees the pilot.
    if (a.status !== 'Released' && started >= r.since) {
      r.status = 'Busy';
      r.vessel = a.vesselName || '';
      r.via = a.viaNo || '';
      r.movement = '';                     // a manual assignment records no movement leg
      r.stage = a.status === 'Onboard' ? 'Pilot Onboard' : 'Assigned';
      r.source = 'Manual';
      r.since = started;
    } else if (a.status === 'Released' && r.status === 'Available' && !r.stage) {
      // Idle, but say WHY — the last thing that happened to this pilot was a release.
      r.stage = 'Completed';
      r.source = 'Manual';
    }
  }

  return [...by.values()].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'Busy' ? -1 : 1;
    if (b.since !== a.since) return b.since - a.since;
    return a.pilotId.localeCompare(b.pilotId);
  });
}

/**
 * Availability wording for the register. Deliberately only two values: the backend
 * distinguishes 'on a movement' from 'not on a movement' and nothing finer, so
 * Unavailable/Maintenance would be invented state.
 */
export function availabilityLabel(status: string): string {
  return status === 'Busy' ? 'On a movement' : 'Free';
}

/**
 * VCN carried in the open `extras` jsonb, '' when absent.
 *
 * Only the PCS pilot-memo rows have one — advance-sheet movements are keyed by VIA and
 * never received a VCN — so this is a searchable identifier on 87 of 423 rows, not a
 * field the table can display for everyone.
 */
export function vcnOf(p: Pilotage): string {
  const v = p.extras?.vcn;
  return typeof v === 'string' ? v.trim() : '';
}
