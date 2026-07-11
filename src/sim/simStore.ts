/**
 * Simulator store — the shared demo clock + scenario levers that drive the whole
 * board (spec §B1.4, §B2.10-11). A single sim clock advances (in sim-hours) while
 * running; panels key their derived data on `tick` so the map, KPIs, DUKC windows
 * and gantt update in real time. Levers (weather, tide offset, pilot/tug
 * availability, channel-depth delta) let a What-If scenario perturb the twin.
 *
 * Deterministic: the clock advances by a fixed step per real second, seeded from
 * the demo seed — no Date.now / Math.random in the advance path, so a rehearsed
 * run reproduces exactly. State is persisted to sessionStorage so a browser
 * refresh mid-demo restores the sim clock / scenario / camera (crash recovery).
 */
import { create } from 'zustand';

/** A scenario's lever set — perturbations applied to the twin vs the shadow run. */
export interface SimLevers {
  /** Weather severity 0..1 (0 = calm, 1 = storm) → pilotage limits. */
  weatherSeverity: number;
  /** Metres added/removed from tide predictions (siltation, surge). */
  tideOffsetM: number;
  /** Metres of channel-depth loss (siltation) applied to controlling depth. */
  channelDepthDeltaM: number;
  /** Pilots unavailable (count) → JIT slippage. */
  pilotsDown: number;
  /** Tugs unavailable (count) → unberthing slip. */
  tugsDown: number;
  /** Berths out of service (ids). */
  berthsOut: string[];
  /** Extra arrivals compressed into the window (vessel bunching). */
  extraArrivals: number;
}

export const NEUTRAL_LEVERS: SimLevers = {
  weatherSeverity: 0,
  tideOffsetM: 0,
  channelDepthDeltaM: 0,
  pilotsDown: 0,
  tugsDown: 0,
  berthsOut: [],
  extraArrivals: 0,
};

export interface TourState {
  scenarioId: string | null;
  step: number;
  auto: boolean;
}

interface SimState {
  /** Sim-hours elapsed since the demo epoch. */
  clockH: number;
  running: boolean;
  /** Sim-hours advanced per real second when running. */
  rate: number;
  /** Fixed demo seed for reproducibility. */
  seed: number;
  levers: SimLevers;
  /** Active scenario id (null = free run). */
  scenarioId: string | null;
  /** Guided-tour state (narrated step-through). */
  tour: TourState;
  /** Asset ids the active scenario is spotlighting on the map. */
  highlights: string[];

  tick: () => void;
  setRunning: (running: boolean) => void;
  setRate: (rate: number) => void;
  setLevers: (patch: Partial<SimLevers>) => void;
  resetLevers: () => void;
  loadScenario: (id: string, levers: SimLevers) => void;
  clearScenario: () => void;
  setHighlights: (ids: string[]) => void;
  startTour: (id: string, auto: boolean) => void;
  gotoStep: (step: number) => void;
  endTour: () => void;
  restore: () => void;
}

const PERSIST_KEY = 'jnpa-uc1-sim';

interface Persisted {
  clockH: number;
  levers: SimLevers;
  scenarioId: string | null;
  tour: TourState;
  highlights: string[];
}

function persist(s: SimState): void {
  try {
    const p: Persisted = { clockH: s.clockH, levers: s.levers, scenarioId: s.scenarioId, tour: s.tour, highlights: s.highlights };
    sessionStorage.setItem(PERSIST_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — fine */
  }
}

export const useSimStore = create<SimState>((set, get) => ({
  clockH: 0,
  running: false,
  rate: 0.5, // 0.5 sim-hours per real second → 5-day horizon in ~2.8 min
  seed: 1234,
  levers: { ...NEUTRAL_LEVERS },
  scenarioId: null,
  tour: { scenarioId: null, step: 0, auto: true },
  highlights: [],

  tick: () => {
    const s = get();
    if (!s.running) return;
    const next = { clockH: Number((s.clockH + s.rate * 0.25).toFixed(3)) }; // called ~4×/s
    set(next);
  },
  setRunning: (running) => { set({ running }); persist(get()); },
  setRate: (rate) => set({ rate }),
  setLevers: (patch) => { set({ levers: { ...get().levers, ...patch } }); persist(get()); },
  resetLevers: () => { set({ levers: { ...NEUTRAL_LEVERS } }); persist(get()); },
  loadScenario: (id, levers) => { set({ scenarioId: id, levers: { ...NEUTRAL_LEVERS, ...levers } }); persist(get()); },
  clearScenario: () => { set({ scenarioId: null, levers: { ...NEUTRAL_LEVERS }, highlights: [] }); persist(get()); },
  setHighlights: (ids) => { set({ highlights: ids }); persist(get()); },
  startTour: (id, auto) => { set({ tour: { scenarioId: id, step: 0, auto } }); persist(get()); },
  gotoStep: (step) => { set({ tour: { ...get().tour, step } }); persist(get()); },
  endTour: () => { set({ tour: { scenarioId: null, step: 0, auto: true }, highlights: [] }); persist(get()); },

  restore: () => {
    try {
      const raw = sessionStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Persisted;
      set({ clockH: p.clockH ?? 0, levers: { ...NEUTRAL_LEVERS, ...p.levers }, scenarioId: p.scenarioId ?? null, tour: p.tour ?? { scenarioId: null, step: 0, auto: true }, highlights: p.highlights ?? [] });
    } catch {
      /* ignore */
    }
  },
}));

/** Has the operator perturbed the twin (any non-neutral lever)? */
export function hasOverrides(l: SimLevers): boolean {
  return (
    l.weatherSeverity > 0 ||
    l.tideOffsetM !== 0 ||
    l.channelDepthDeltaM !== 0 ||
    l.pilotsDown > 0 ||
    l.tugsDown > 0 ||
    l.berthsOut.length > 0 ||
    l.extraArrivals > 0
  );
}
