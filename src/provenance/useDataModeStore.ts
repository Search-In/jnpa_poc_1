/**
 * DATA_MODE + integration-fault store (Zustand). Single source of truth for:
 *   • the global provenance mode (SIM / REPLAY / LIVE) on the persistent banner;
 *   • each source's fallback rung (LIVE…OFFLINE), driven by the Integration
 *     Simulator Console;
 *   • injected latency (ms) per source;
 *   • a reconciliation audit-log — one entry per state transition, and a
 *     "reconciled on recovery" entry when a dropped source returns to LIVE.
 *
 * Nothing here touches a network. Faults are injected by the operator to
 * demonstrate the twin's graceful-degradation behaviour (spec §A2 crit 3 / B1.2).
 */
import { create } from 'zustand';
import {
  type DataMode,
  type SourceId,
  type SourceState,
  SOURCES,
  SOURCE_BY_ID,
  isFlowing,
} from './sources';

export interface SourceRuntime {
  state: SourceState;
  /** Injected one-way latency in ms (0 = nominal). */
  latencyMs: number;
  /** Epoch ms when the source last left LIVE (for the staleness watermark). */
  degradedSince: number | null;
}

export interface AuditEntry {
  id: string;
  ts: number;
  source: SourceId;
  from: SourceState;
  to: SourceState;
  /** True when this transition is a recovery back to a flowing feed. */
  recovery: boolean;
  note: string;
}

interface DataModeState {
  mode: DataMode;
  /** Whether the Integration Simulator Console slide-over is open. */
  consoleOpen: boolean;
  sources: Record<SourceId, SourceRuntime>;
  audit: AuditEntry[];
  /** Monotonic counter → deterministic ids (no Math.random in the demo path). */
  seq: number;

  setMode: (mode: DataMode) => void;
  setConsoleOpen: (open: boolean) => void;
  setSourceState: (id: SourceId, state: SourceState, note?: string) => void;
  setLatency: (id: SourceId, latencyMs: number) => void;
  /** Restore every source to LIVE (the "reconcile all" button). */
  reconcileAll: () => void;
  /** Reset to the pristine SIM demo baseline. */
  resetAll: () => void;
}

function freshSources(): Record<SourceId, SourceRuntime> {
  return Object.fromEntries(
    SOURCES.map((s) => [s.id, { state: 'LIVE', latencyMs: 0, degradedSince: null }]),
  ) as Record<SourceId, SourceRuntime>;
}

/** A monotonic clock the store can read without Date.now in the render path. */
function now(): number {
  return typeof performance !== 'undefined' ? Math.round(performance.timeOrigin + performance.now()) : 0;
}

export const useDataModeStore = create<DataModeState>((set, get) => ({
  mode: 'SIM',
  consoleOpen: false,
  sources: freshSources(),
  audit: [],
  seq: 0,

  setMode: (mode) => set({ mode }),
  setConsoleOpen: (consoleOpen) => set({ consoleOpen }),

  setSourceState: (id, state, note) => {
    const cur = get().sources[id];
    if (!cur || cur.state === state) return;
    const seq = get().seq + 1;
    const t = now();
    const recovery = !isFlowing(cur.state) && isFlowing(state);
    const entry: AuditEntry = {
      id: `A${seq}`,
      ts: t,
      source: id,
      from: cur.state,
      to: state,
      recovery,
      note:
        note ??
        (recovery
          ? `${SOURCE_BY_ID[id].label} recovered → reconciled against last-known-good`
          : `${SOURCE_BY_ID[id].label} → ${state}`),
    };
    set({
      seq,
      audit: [entry, ...get().audit].slice(0, 200),
      sources: {
        ...get().sources,
        [id]: {
          ...cur,
          state,
          degradedSince: isFlowing(state) ? null : (cur.degradedSince ?? t),
        },
      },
    });
  },

  setLatency: (id, latencyMs) => {
    const cur = get().sources[id];
    if (!cur) return;
    set({ sources: { ...get().sources, [id]: { ...cur, latencyMs } } });
  },

  reconcileAll: () => {
    for (const s of SOURCES) get().setSourceState(s.id, 'LIVE', `${s.label} reconciled (reconcile-all)`);
    set((st) => ({
      sources: Object.fromEntries(
        Object.entries(st.sources).map(([k, v]) => [k, { ...v, latencyMs: 0 }]),
      ) as Record<SourceId, SourceRuntime>,
    }));
  },

  resetAll: () => set({ sources: freshSources(), audit: [], seq: 0 }),
}));

/** Any source not fully LIVE → the global chip flips to a degraded look. */
export function anyDegraded(sources: Record<SourceId, SourceRuntime>): boolean {
  return Object.values(sources).some((s) => s.state !== 'LIVE');
}

/** The worst (lowest) rung currently active, for the banner summary. */
export function worstState(sources: Record<SourceId, SourceRuntime>): SourceState {
  const order: SourceState[] = ['OFFLINE', 'IMPUTED', 'CACHED', 'DEGRADED', 'LIVE'];
  for (const st of order) {
    if (Object.values(sources).some((s) => s.state === st)) return st;
  }
  return 'LIVE';
}
