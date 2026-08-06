/**
 * Manual CRAFT assignment store — operational transactions, demo scope.
 *
 * NOTE ON SCOPE. PILOT assignments no longer live here: they are backend-persisted via
 * `/api/marine/manual-pilot-assignment` and read through `data/uc3/manualPilot.ts`, so
 * Vessel Calls, Port Craft, Marine State and the Timeline all see them. The pilot half of
 * this store is retained only because craft assignments still use the same shape; nothing
 * reads `pilots` any more, and it should be removed when craft is promoted to the backend
 * too.
 *
 * WHY THIS EXISTS
 * ---------------
 * A vessel can complete VESPRO → CALINF → CALINV → BERMAN → BERALT and appear correctly
 * in Vessel Calls while no pilot card or pilot memo has been imported for it (VIA S0814
 * is the reference case). That is a valid business state — marine operations have not
 * started — not a parser fault. This store lets an operator carry the lifecycle forward
 * in that gap, without touching imported data.
 *
 * WHAT IT IS NOT
 * --------------
 * It is a TRANSACTION log, never master data. Pilots come from the Pilot Register
 * (core.pilot / the imported movements) and craft from the Fleet Register
 * (core.port_craft); nothing here creates either. It also writes nothing to the backend:
 * `/api/marine/pilotage` and `/api/marine/state/port-craft` stay byte-identical, and the
 * Marine Projection never sees these rows.
 *
 * CONSEQUENCE, STATED PLAINLY
 * ---------------------------
 * Because the lifecycle engine reads core.pilotage exclusively, a manual assignment is
 * DISPLAYED in the lifecycle, not COMPUTED by it. Assigning a pilot here does not change
 * `portcraft_state`, VESARR, or any backend-derived status.
 *
 * IMPORTED DATA ALWAYS WINS
 * -------------------------
 * `supersede()` is the whole policy: once an import produces a real pilotage row for a
 * call, that call's manual assignment is marked superseded — hidden from the operational
 * views, kept in the Assignments tab for audit, and NEVER deleted. Merging is deliberately
 * not offered; blending imported and manual timestamps would fabricate a movement that
 * never happened.
 *
 * Persisted to sessionStorage exactly as <ruleStore> does — same key shape, same
 * swallow-on-failure, same mock-first posture.
 */
import { create } from 'zustand';

/** Assigned → Onboard → Released. Mirrors the pilot workflow without re-deriving it. */
export type AssignmentStatus = 'Assigned' | 'Onboard' | 'Released';

interface BaseAssignment {
  id: string;
  /** The vessel call this transaction belongs to — the join key to everything else. */
  callId: number;
  vcn: string;
  via: string;
  vesselName: string;
  status: AssignmentStatus;
  assignedAt: number;
  boardedAt: number;
  releasedAt: number;
  /** Set when an import later delivered real data for this call. Never deleted. */
  supersededAt: number;
}

export interface PilotAssignment extends BaseAssignment {
  /** Roster code or acknowledged name — whatever the Register knows them by. */
  pilotId: string;
  pilotName: string;
}

export interface CraftAssignment extends BaseAssignment {
  craftId: number;
  craftName: string;
  /** Tug | Pilot Launch | … — straight from the Fleet Register, never invented. */
  craftType: string;
}

const KEY = 'jnpa.marineAssignments.v1';

interface Persisted {
  pilots: PilotAssignment[];
  craft: CraftAssignment[];
  seq: number;
}

function load(): Persisted {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Persisted;
  } catch {
    /* ignore — a corrupt blob must not stop the screen rendering */
  }
  return { pilots: [], craft: [], seq: 0 };
}

function persist(s: Persisted): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export interface AssignmentStore extends Persisted {
  assignPilot: (a: Omit<PilotAssignment, 'id' | 'status' | 'assignedAt' | 'boardedAt'
                                        | 'releasedAt' | 'supersededAt'>) => string;
  assignCraft: (a: Omit<CraftAssignment, 'id' | 'status' | 'assignedAt' | 'boardedAt'
                                        | 'releasedAt' | 'supersededAt'>) => string;
  /** Assigned → Onboard. `now` is injected so callers stay testable. */
  boardPilot: (id: string, now?: number) => void;
  /** → Released. Applies to either kind; the craft equivalent of 'disembarked'. */
  release: (id: string, now?: number) => void;
  /**
   * Mark every LIVE assignment whose call now has imported data as superseded.
   * Idempotent, non-destructive, and the only path by which imported data displaces a
   * manual record.
   */
  supersede: (callIdsWithImportedData: readonly number[], now?: number) => void;
  /** Demo housekeeping — drops manual transactions only. Imported data is untouched. */
  clearAll: () => void;
}

/** A manual assignment counts for a call only while it is live (not superseded). */
export function isLive(a: BaseAssignment): boolean {
  return a.supersededAt === 0;
}

export const useAssignmentStore = create<AssignmentStore>((set, get) => ({
  ...load(),

  assignPilot: (a) => {
    const seq = get().seq + 1;
    const id = `PA-${seq}`;
    const next: Persisted = {
      ...get(),
      seq,
      pilots: [...get().pilots, {
        ...a, id, status: 'Assigned', assignedAt: Date.now(),
        boardedAt: 0, releasedAt: 0, supersededAt: 0,
      }],
    };
    persist(next);
    set(next);
    return id;
  },

  assignCraft: (a) => {
    const seq = get().seq + 1;
    const id = `CA-${seq}`;
    const next: Persisted = {
      ...get(),
      seq,
      craft: [...get().craft, {
        ...a, id, status: 'Assigned', assignedAt: Date.now(),
        boardedAt: 0, releasedAt: 0, supersededAt: 0,
      }],
    };
    persist(next);
    set(next);
    return id;
  },

  boardPilot: (id, now = Date.now()) => {
    const next: Persisted = {
      ...get(),
      pilots: get().pilots.map((p) =>
        p.id === id && p.status === 'Assigned'
          ? { ...p, status: 'Onboard', boardedAt: now } : p),
    };
    persist(next);
    set(next);
  },

  release: (id, now = Date.now()) => {
    const done = <T extends BaseAssignment>(x: T): T =>
      (x.id === id && x.status !== 'Released'
        ? { ...x, status: 'Released' as AssignmentStatus, releasedAt: now } : x);
    const next: Persisted = {
      ...get(),
      pilots: get().pilots.map(done),
      craft: get().craft.map(done),
    };
    persist(next);
    set(next);
  },

  supersede: (callIds, now = Date.now()) => {
    const hit = new Set(callIds);
    const mark = <T extends BaseAssignment>(x: T): T =>
      (hit.has(x.callId) && x.supersededAt === 0 ? { ...x, supersededAt: now } : x);
    const pilots = get().pilots.map(mark);
    const craft = get().craft.map(mark);
    // Only write when something actually changed — supersede() runs on every render of
    // the operational views, and an unconditional set() would loop.
    const changed = pilots.some((p, i) => p !== get().pilots[i])
                 || craft.some((c, i) => c !== get().craft[i]);
    if (!changed) return;
    const next: Persisted = { ...get(), pilots, craft };
    persist(next);
    set(next);
  },

  clearAll: () => {
    const next: Persisted = { pilots: [], craft: [], seq: get().seq };
    persist(next);
    set(next);
  },
}));
