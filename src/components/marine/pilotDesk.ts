/**
 * What the Pilot column on Vessels ▸ Vessel Calls shows, and which action it offers.
 * PURE — no network, no React. The I/O lives in ./usePilotDesk, the markup in ./PilotCell.
 *
 * NOTHING HERE DECIDES PILOT STATE. The gateway attaches a projected lifecycle to every
 * row of `GET /marine/calls` (`services/marine/service.py::_attach_lifecycle`), and that
 * projection is `project(call, events, manual)` — it has already folded in both imported
 * pilot memos AND operator assignments. So `call.lifecycle.pilotState` is the answer, and
 * this module only translates it into operator wording and decides which button, if any,
 * the cell may offer. That is what stops the Vessel Calls tab becoming a second opinion
 * about who is on a vessel — the mistake PilotAssignmentsTab's header warns about.
 *
 * The two lookups it takes are for things the lifecycle does NOT carry:
 *   • WHO the pilot is — lifecycle has state, never identity;
 *   • the manual assignment's `id` — Board and Release are PATCHes against that id, so a
 *     call with no manual record simply has no button, however engaged its pilot is.
 */

import type { VesselCall } from '@/types/domain';
import type { Pilotage } from '@/types/domain';
import type { ManualPilotAssignment } from '@/data/uc3/manualPilot';
import { isPilotAssignable, pilotLabel } from '@/components/marine/pilotLifecycle';

/* -------------------------------------------------------------- movement legs */

/**
 * The legs a manual assignment can declare, in the gateway's own vocabulary
 * (`core.pilotage.movement_type`, and the CHECK added by migration 0054).
 *
 * WHY THE OPERATOR IS ASKED AT ALL. Releasing a pilot used to record PILOT_DISEMBARKED
 * and nothing else, and derive_state's status ladder never reads that rung — so a call
 * driven through this fallback stayed at 'Pilot Boarded' for ever, contradicting the
 * 'Completed' shown beside it. The engine could not do better unaided: a pilot stepping
 * off means the vessel BERTHED inbound and SAILED outbound, one event with opposite
 * conclusions. Asking captures the fact instead of guessing it.
 */
export const MOVEMENTS = [
  { value: 'INWARD', label: 'Inward — arriving', completes: 'berths her', berth: 'optional' },
  { value: 'OUTWARD', label: 'Outward — departing', completes: 'sails her', berth: 'none' },
  { value: 'SHIFTING', label: 'Shifting berth', completes: 'berths her', berth: 'required' },
] as const;

/**
 * Does this leg need a destination berth, and must the operator supply one?
 *
 *   SHIFTING  required — a shift IS its destination. Released without one it recorded
 *                        'she is fast alongside' while the call still named the berth she
 *                        had just left, which is what calls 217 and 224 did.
 *   INWARD    optional — BERALT normally allotted a berth already, so the picker prefills
 *                        it; a call with none allotted can still be berthed by choosing.
 *   OUTWARD   none     — she is leaving. Release frees the berth instead of taking one.
 */
export function berthRequirement(movementType: string): 'required' | 'optional' | 'none' {
  const m = MOVEMENTS.find((x) => x.value === movementType.trim().toUpperCase());
  return m ? m.berth : 'none';
}

/** The berth to preselect: whatever the call already has, so INWARD confirms rather than retypes. */
export function defaultBerthId(call: VesselCall): number | null {
  return call.berthId;
}

export type MovementValue = (typeof MOVEMENTS)[number]['value'];

/**
 * Which legs are PHYSICALLY POSSIBLE for this call, and why the others are not.
 *
 * The vocabulary offered all three legs to every assignable call, so 1080 of the 1505
 * assignable calls in the corpus — every one whose arrival is still Pending — could be
 * sent shifting from a berth they were not at, or sailed without ever having arrived.
 * The movement would then write a milestone that contradicts the vessel's own lifecycle.
 *
 * Each rule is a statement about WHERE SHE IS, read from the projection, never from
 * stored columns:
 *
 *   INWARD    she has not arrived yet — that is what an inward movement is for. Once
 *             arrival is Completed there is nothing to bring in.
 *   SHIFTING  she is AT A BERTH. A shift is berth-to-berth; from anchorage or from sea
 *             the movement is an arrival, not a shift.
 *   OUTWARD   she is IN PORT. A vessel that never arrived cannot depart.
 *
 * A call with no lifecycle yields nothing legal — the projection has no opinion about
 * where she is, and guessing is what this whole module exists to avoid.
 */
export function legalMovements(call: VesselCall): {
  value: MovementValue; label: string; legal: boolean; why: string;
}[] {
  const lc = call.lifecycle;
  return MOVEMENTS.map((m) => {
    if (!lc) {
      return { value: m.value, label: m.label, legal: false,
               why: 'No lifecycle for this call — where she is, is unknown.' };
    }
    if (m.value === 'INWARD') {
      const legal = lc.arrivalState !== 'Completed';
      return { value: m.value, label: m.label, legal,
               why: legal ? '' : 'She has already arrived — nothing to bring in.' };
    }
    if (m.value === 'SHIFTING') {
      return { value: m.value, label: m.label, legal: lc.isAtBerth,
               why: lc.isAtBerth ? '' : 'Not at a berth — there is nothing to shift from.' };
    }
    return { value: m.value, label: m.label, legal: lc.isInPort,
             why: lc.isInPort ? '' : 'Not in port — she cannot depart before she arrives.' };
  });
}

/** Just the legal ones, for a picker. */
export function allowedMovements(call: VesselCall): MovementValue[] {
  return legalMovements(call).filter((m) => m.legal).map((m) => m.value);
}

/**
 * The leg to PRESELECT for a call. A default the operator can override, never a
 * derivation — nothing downstream reads it, and Release uses whatever they confirmed.
 *
 * A vessel already alongside is overwhelmingly taking a pilot to leave; one that is not
 * is taking one to come in. Getting the common case right costs the operator a glance
 * instead of a decision, and the wrong guess is one dropdown away from corrected.
 */
export function defaultMovement(call: VesselCall): MovementValue {
  const allowed = allowedMovements(call);
  // A vessel already alongside is overwhelmingly taking a pilot to leave; one that is not
  // is taking one to come in. Fall back to whatever IS legal when the preference is not.
  const preferred: MovementValue = call.lifecycle?.isAtBerth ? 'OUTWARD' : 'INWARD';
  if (allowed.includes(preferred)) return preferred;
  return allowed[0] ?? 'INWARD';
}

/** Operator wording for a stored leg; '' when none was declared. */
export function movementLabel(movementType: string): string {
  const m = MOVEMENTS.find((x) => x.value === movementType.trim().toUpperCase());
  return m ? m.label : '';
}

/** The mutation a row may offer, or null when the cell is read-only. */
export type PilotAction = 'assign' | 'board' | 'release' | null;

/** Which record decided what the cell displays. */
export type PilotSource = 'Imported' | 'Manual' | '';

export interface CallPilotView {
  /** Engine vocabulary, verbatim from the projection ('' when it has no opinion). */
  state: string;
  /** Operator wording for `state` — what the chip reads. */
  label: string;
  /** Chip vocabulary term, resolved to a colour by lifecycleTone. */
  tone: string;
  /** Pilot name or roster code; '' when nobody is on it. */
  pilot: string;
  action: PilotAction;
  /** Manual assignment id — the target of a Board/Release PATCH. Null for imported. */
  assignmentId: number | null;
  source: PilotSource;
  /** Leg the live manual assignment declared; '' for imported or undeclared. */
  movementType: string;
  /** Destination berth the live assignment declared; null when none applies. */
  berthId: number | null;
  /**
   * Why there is no action, when that needs saying. Rendered as the cell's `title` so a
   * disabled-looking row can always explain itself instead of just being blank.
   */
  reason: string;
}

/**
 * Engine `pilot_state` → what a duty officer reads.
 *
 * 'Active' is the engine's word for an imported boarding and 'Onboard' the projection's
 * word for a manual one; they describe the same situation, so both read 'Pilot onboard'.
 * Keeping them distinct in the chip would expose which CSV a fact came from, which is
 * exactly the distinction the operator does not care about.
 */
const WORDING: Record<string, string> = {
  Pending: 'Awaiting pilot',
  Required: 'Awaiting pilot',
  Assigned: 'Assigned',
  Onboard: 'Pilot onboard',
  Active: 'Pilot onboard',
  Completed: 'Completed',
  Released: 'Completed',
};

/**
 * Chip tone term for a pilot state. Deliberately routed through the SHARED lifecycle
 * vocabulary rather than a private colour map: 'Pending' is amber everywhere in this app
 * (attention, not fault) and this column must not be the one place it is grey.
 */
const TONE_TERM: Record<string, string> = {
  Pending: 'Pending',
  Required: 'Pending',
  Assigned: 'Allotted',
  Onboard: 'Pilot Boarded',
  Active: 'Active',
  Completed: 'Completed',
  Released: 'Released',
};

/**
 * Index active manual assignments by call. Pure.
 *
 * Superseded rows are skipped: the backend deactivates one the moment an imported memo
 * lands for that call, so an inactive record is by definition no longer operational and
 * offering Board on it would produce a write the gateway refuses.
 *
 * Should two active rows somehow share a call, the most recently started one wins — the
 * same "latest activity speaks" rule buildPilotRegister uses.
 */
export function indexManualByCall(
  manual: readonly ManualPilotAssignment[],
): Map<number, ManualPilotAssignment> {
  const by = new Map<number, ManualPilotAssignment>();
  for (const a of manual) {
    if (!a.active) continue;
    const prev = by.get(a.callId);
    const started = (x: ManualPilotAssignment) => x.boardedAt || x.assignedAt;
    if (!prev || started(a) >= started(prev)) by.set(a.callId, a);
  }
  return by;
}

/**
 * Index imported pilotage by call, keeping the movement that best names the pilot.
 * Pure. An OPEN movement (boarded, not disembarked) outranks a finished one, matching
 * buildPilotRegister's precedence, so a vessel on its second job shows the current pilot.
 */
export function indexImportedByCall(rows: readonly Pilotage[]): Map<number, Pilotage> {
  const by = new Map<number, Pilotage>();
  const open = (p: Pilotage) => p.pilotBoardedAt > 0 && p.pilotDisembarkedAt === 0;
  for (const p of rows) {
    if (p.callId === null) continue;
    const prev = by.get(p.callId);
    if (!prev) { by.set(p.callId, p); continue; }
    if (open(p) && !open(prev)) { by.set(p.callId, p); continue; }
    if (open(p) === open(prev) && p.pilotBoardedAt > prev.pilotBoardedAt) by.set(p.callId, p);
  }
  return by;
}

/**
 * The Pilot cell for one call.
 *
 * ACTION RULES, in the order they are tested:
 *
 *   1. An IMPORTED memo makes the cell read-only whatever the state. The manual endpoints
 *      act on a manual assignment id, which imported rows do not have, and POSTing a new
 *      assignment onto such a call returns 409. Rendering a button that can only fail is
 *      worse than rendering none, so the reason is stated instead.
 *   2. A live MANUAL assignment offers the next step of its own workflow —
 *      Assigned → Board, Onboard → Release, Released → nothing.
 *   3. Otherwise the projection decides eligibility through isPilotAssignable, which
 *      answers "does this call need a pilot?" from pilot_state and departure_state rather
 *      than from stored timestamps.
 *
 * A call with NO lifecycle gets no action: the projection has nothing to say about it, and
 * guessing from columns is precisely what isPilotAssignable exists to prevent.
 */
export function buildCallPilotView(
  call: VesselCall,
  manualByCall: ReadonlyMap<number, ManualPilotAssignment>,
  importedByCall: ReadonlyMap<number, Pilotage>,
): CallPilotView {
  const state = call.lifecycle?.pilotState ?? '';
  const base = {
    state,
    label: WORDING[state] ?? state,
    tone: TONE_TERM[state] ?? state,
  };

  const imported = importedByCall.get(call.callId);
  if (imported) {
    return {
      ...base,
      pilot: pilotLabel(imported),
      action: null,
      assignmentId: null,
      source: 'Imported',
      movementType: '',
      berthId: null,
      reason: 'Imported pilot memo — this call is owned by the imported record.',
    };
  }

  const manual = manualByCall.get(call.callId);
  if (manual) {
    return {
      ...base,
      // The projection is authoritative for the STATE, but a freshly written assignment
      // can be read back before the projection refreshes; the record's own status is the
      // one the Board/Release button must agree with, so it labels the chip.
      label: WORDING[manual.status] ?? base.label,
      tone: TONE_TERM[manual.status] ?? base.tone,
      pilot: manual.pilotName || manual.pilotCode,
      action: manual.status === 'Assigned' ? 'board'
        : manual.status === 'Onboard' ? 'release'
        : null,
      assignmentId: manual.id,
      source: 'Manual',
      movementType: manual.movementType,
      berthId: manual.berthId,
      reason: manual.status === 'Released' ? 'Pilot released — the movement is finished.' : '',
    };
  }

  if (!call.lifecycle) {
    return { ...base, label: base.label || '—', pilot: '', action: null, assignmentId: null,
             source: '', movementType: '', berthId: null,
             reason: 'No lifecycle for this call — the projection has no opinion yet.' };
  }

  const assignable = isPilotAssignable(call) && allowedMovements(call).length > 0;
  return {
    ...base,
    pilot: '',
    action: assignable ? 'assign' : null,
    assignmentId: null,
    source: '',
    movementType: '',
    berthId: null,
    reason: assignable ? ''
      : call.lifecycle.departureState === 'Completed'
        ? 'Vessel has sailed — no pilot needed.'
        : isPilotAssignable(call)
          // Eligible for a pilot, but no leg is physically possible from where she is.
          ? 'No movement is possible from her current position.'
          : `Pilot state is ${state || 'unknown'} — not awaiting assignment.`,
  };
}

/**
 * How to name a vessel that has none.
 *
 * 49% of calls in the corpus carry no `vessel_name` — a CALINF seeds the row before the
 * name is known — so an operator identifies them by VCN or VIA off the manifest. The
 * assign picker used to require a name outright, which silently made those calls
 * impossible to crew; the backend only ever needed `call_id`, so the name was a display
 * convenience being enforced as a precondition.
 */
export function callLabel(call: VesselCall): string {
  return call.vesselName || call.vcn || call.viaNo || `Call #${call.callId}`;
}

/**
 * Can this call be identified well enough to assign against? Pure.
 *
 * Every call has a `callId`, so the honest answer is always yes — the guard exists only
 * so a caller can skip rows that would be unlabelable in a dropdown, and `callLabel`
 * guarantees that never happens. Kept as a named predicate so the OLD rule (a vessel name
 * AND a VCN or VIA) has one place to have been replaced rather than several.
 */
export function isCallIdentifiable(call: VesselCall): boolean {
  return call.callId > 0;
}
