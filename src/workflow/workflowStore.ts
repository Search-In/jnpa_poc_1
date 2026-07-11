/**
 * Automated-workflow ledger store (Zustand) — spec §B2.12.
 *
 * The twin can run marine workflows in two governance modes:
 *   • ADVISORY (default) — every workflow only *proposes* an action; a human
 *     acknowledges and/or applies it (human-in-the-loop sign-off).
 *   • AUTO — proposals are applied automatically the moment they fire.
 *
 * Every fired workflow is appended to an immutable-ish ledger (newest first) so
 * the demo can show triggers firing visibly and the resulting governance trail.
 *
 * Determinism: ids come from a monotonic `seq` (no Math.random), and timestamps
 * use performance.timeOrigin + performance.now() rather than Date.now in the
 * mutation path — matching the rest of the UC-1 demo clock discipline.
 */
import { create } from 'zustand';

/** Governance posture for the whole workflow engine. */
export type WorkflowMode = 'AUTO' | 'ADVISORY';

/** Lifecycle of a single fired workflow. */
export type WorkflowStatus = 'proposed' | 'applied' | 'acknowledged';

/** A machine-classified trigger — drives the severity colour bar in the ledger. */
export type WorkflowTrigger =
  | 'ukc-breach'
  | 'eta-slip'
  | 'weather-alert'
  | 'berth-release';

/** One row in the automated-workflow ledger. */
export interface WorkflowRun {
  id: string;
  /** performance.timeOrigin + performance.now() at fire time. */
  ts: number;
  trigger: WorkflowTrigger;
  title: string;
  detail: string;
  /** The (simulated) action the workflow proposes/applies. */
  proposal: string;
  status: WorkflowStatus;
  /** Governance posture captured at fire time. */
  governance: WorkflowMode;
}

/** Payload accepted by fire() — status/governance are stamped by the store. */
export interface WorkflowFireInput {
  trigger: WorkflowTrigger;
  title: string;
  detail: string;
  proposal: string;
}

interface WorkflowState {
  /** Governance posture. Default ADVISORY = human sign-off required. */
  mode: WorkflowMode;
  /** Ledger, newest first. */
  runs: WorkflowRun[];
  /** Monotonic id counter → deterministic ids (no Math.random). */
  seq: number;

  setMode: (mode: WorkflowMode) => void;
  /**
   * Fire a workflow. Prepends a WorkflowRun. In AUTO mode the run lands as
   * 'applied' immediately; in ADVISORY it lands as 'proposed' awaiting sign-off.
   */
  fire: (run: WorkflowFireInput) => void;
  /** Mark a run acknowledged (human saw it, no auto-apply). */
  ack: (id: string) => void;
  /** Mark a run applied (action taken). */
  apply: (id: string) => void;
  /** Empty the ledger. */
  clear: () => void;
}

/** Monotonic wall-clock read without Date.now in the mutation path. */
function now(): number {
  return typeof performance !== 'undefined'
    ? Math.round(performance.timeOrigin + performance.now())
    : 0;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  mode: 'ADVISORY',
  runs: [],
  seq: 0,

  setMode: (mode) => set({ mode }),

  fire: (run) => {
    const seq = get().seq + 1;
    const mode = get().mode;
    const entry: WorkflowRun = {
      id: `W${seq}`,
      ts: now(),
      trigger: run.trigger,
      title: run.title,
      detail: run.detail,
      proposal: run.proposal,
      // AUTO applies proposals automatically; ADVISORY waits for sign-off.
      status: mode === 'AUTO' ? 'applied' : 'proposed',
      governance: mode,
    };
    set({ seq, runs: [entry, ...get().runs].slice(0, 200) });
  },

  ack: (id) =>
    set({
      runs: get().runs.map((r) =>
        r.id === id ? { ...r, status: 'acknowledged' } : r,
      ),
    }),

  apply: (id) =>
    set({
      runs: get().runs.map((r) =>
        r.id === id ? { ...r, status: 'applied' } : r,
      ),
    }),

  clear: () => set({ runs: [], seq: 0 }),
}));
