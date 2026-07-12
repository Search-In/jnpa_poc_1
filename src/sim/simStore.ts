/**
 * Simulator store — the shared demo clock + scenario levers + direct data
 * overrides that drive the whole board (spec §B1.4, §B2.10-11). A single sim
 * clock advances (in sim-hours) while running; panels key their derived data on
 * `tick`/`version` so the map, KPIs, DUKC windows and gantt update in real time.
 *
 * Two layers of perturbation:
 *  - `levers`    — environment/resource What-If knobs (weather, tide, channel
 *                  depth, pilots/tugs down, berths out, extra arrivals) applied
 *                  by `derive.ts`. These model *causes*.
 *  - `overrides` — direct data mutations keyed to the actual data forms/entities
 *                  (spawn extra vessels, force a berth's status, take a specific
 *                  craft offline, nudge a headline KPI). These model *effects*
 *                  the operator wants to stage on the map + dashboard directly.
 *
 * Both are overlaid on every adapter read by `SimAdapter` (see ./SimAdapter),
 * so the existing map + dashboard react with no per-panel wiring — exactly the
 * PoC_2 "control room" pattern.
 *
 * Cross-tab: a `BroadcastChannel('jnpa-uc1-sim')` (backed by localStorage)
 * mirrors state so the standalone Simulator page (`#/simulator`, its own tab)
 * drives the dashboard tab live. A monotonic `version` bumps on every mutation
 * so `useAppStore` / `useAdapterQuery` consumers refetch through `SimAdapter`.
 *
 * Deterministic: the clock advances by a fixed step per real second, seeded from
 * the demo seed — no Date.now / Math.random in the advance path, so a rehearsed
 * run reproduces exactly. Session state is persisted so a browser refresh
 * mid-demo restores the sim clock / scenario / overrides (crash recovery).
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

/** Berth statuses an operator can force from the simulator. */
export type BerthStatusOverride = 'available' | 'occupied' | 'reserved' | 'maintenance';

/** A signed adjustment to a headline KPI's value (added to the computed value). */
export interface KpiDeltas {
  /** Hours added to pre-berthing delay. */
  preBerthingDelay: number;
  /** Hours added to pre-sailing delay. */
  preSailingDelay: number;
  /** Hours added to average vessel TAT. */
  avgTat: number;
  /** Percentage points added to Just-In-Time %. */
  jitPct: number;
  /** Percentage points added to forecast accuracy. */
  forecastAccuracy: number;
  /** Percentage points added to berth occupancy. */
  berthOccupancy: number;
}

export const NEUTRAL_KPI_DELTAS: KpiDeltas = {
  preBerthingDelay: 0,
  preSailingDelay: 0,
  avgTat: 0,
  jitPct: 0,
  forecastAccuracy: 0,
  berthOccupancy: 0,
};

/**
 * Direct data overrides — the "manage data on the map + dashboard" layer,
 * mirroring the data forms' entities (vessels, berths, port craft) plus the
 * headline metrics. Overlaid non-destructively by `SimAdapter`/`applySim`.
 */
export interface SimOverrides {
  /** Extra vessels to inject into the live stream (spawned approaching JNPA). */
  spawnVessels: number;
  /**
   * Force N of the injected/streamed vessels' nav-status. 0 = leave as-is.
   * Lets the operator flood the anchorage or the approach lanes on the map.
   */
  forceAnchored: number;
  forceApproaching: number;
  /** Per-berth forced status (BERTH_ID → status). Absent = leave as-is. */
  berthStatus: Record<string, BerthStatusOverride>;
  /** Craft ids forced out of service (maintenance) — the Port Craft board. */
  craftOut: string[];
  /** Signed adjustments applied to the headline KPI values. */
  kpiDeltas: KpiDeltas;
}

export const NEUTRAL_OVERRIDES: SimOverrides = {
  spawnVessels: 0,
  forceAnchored: 0,
  forceApproaching: 0,
  berthStatus: {},
  craftOut: [],
  kpiDeltas: { ...NEUTRAL_KPI_DELTAS },
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
  overrides: SimOverrides;
  /**
   * Monotonic mutation counter. Consumers put this in query deps so any lever/
   * override change forces a refetch through `SimAdapter`. Also bumped by
   * `applyRemote` when another tab broadcasts, so cross-tab updates propagate.
   */
  version: number;
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
  setOverrides: (patch: Partial<SimOverrides>) => void;
  setBerthStatus: (berthId: string, status: BerthStatusOverride | null) => void;
  toggleCraftOut: (craftId: string) => void;
  setKpiDelta: (key: keyof KpiDeltas, value: number) => void;
  resetOverrides: () => void;
  resetAll: () => void;
  loadScenario: (id: string, levers: SimLevers) => void;
  clearScenario: () => void;
  setHighlights: (ids: string[]) => void;
  startTour: (id: string, auto: boolean) => void;
  gotoStep: (step: number) => void;
  endTour: () => void;
  restore: () => void;
  /** Apply state broadcast from another tab (no re-broadcast, avoids loops). */
  applyRemote: (p: Persisted) => void;
}

const PERSIST_KEY = 'jnpa-uc1-sim';
const CHANNEL_NAME = 'jnpa-uc1-sim';

interface Persisted {
  clockH: number;
  running: boolean;
  levers: SimLevers;
  overrides: SimOverrides;
  scenarioId: string | null;
  tour: TourState;
  highlights: string[];
  version: number;
}

/** BroadcastChannel for live cross-tab push (guarded — may be unavailable). */
let channel: BroadcastChannel | null = null;
function getChannel(): BroadcastChannel | null {
  if (channel) return channel;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    channel = null;
  }
  return channel;
}

function snapshot(s: SimState): Persisted {
  return {
    clockH: s.clockH,
    running: s.running,
    levers: s.levers,
    overrides: s.overrides,
    scenarioId: s.scenarioId,
    tour: s.tour,
    highlights: s.highlights,
    version: s.version,
  };
}

/** Persist to sessionStorage (crash recovery) + broadcast to other tabs. */
function persist(s: SimState, broadcast = true): void {
  const p = snapshot(s);
  try {
    sessionStorage.setItem(PERSIST_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable — fine */
  }
  if (broadcast) {
    try {
      getChannel()?.postMessage(p);
    } catch {
      /* channel unavailable — fine */
    }
  }
}

export const useSimStore = create<SimState>((set, get) => ({
  clockH: 0,
  running: false,
  rate: 0.5, // 0.5 sim-hours per real second → 5-day horizon in ~2.8 min
  seed: 1234,
  levers: { ...NEUTRAL_LEVERS },
  overrides: { ...NEUTRAL_OVERRIDES, kpiDeltas: { ...NEUTRAL_KPI_DELTAS }, berthStatus: {}, craftOut: [] },
  version: 0,
  scenarioId: null,
  tour: { scenarioId: null, step: 0, auto: true },
  highlights: [],

  tick: () => {
    const s = get();
    if (!s.running) return;
    const next = { clockH: Number((s.clockH + s.rate * 0.25).toFixed(3)) }; // called ~4×/s
    set(next);
  },
  setRunning: (running) => { set({ running, version: get().version + 1 }); persist(get()); },
  setRate: (rate) => { set({ rate }); persist(get()); },

  setLevers: (patch) => { set({ levers: { ...get().levers, ...patch }, version: get().version + 1 }); persist(get()); },
  resetLevers: () => { set({ levers: { ...NEUTRAL_LEVERS }, version: get().version + 1 }); persist(get()); },

  setOverrides: (patch) => { set({ overrides: { ...get().overrides, ...patch }, version: get().version + 1 }); persist(get()); },
  setBerthStatus: (berthId, status) => {
    const next = { ...get().overrides.berthStatus };
    if (status === null) delete next[berthId];
    else next[berthId] = status;
    set({ overrides: { ...get().overrides, berthStatus: next }, version: get().version + 1 });
    persist(get());
  },
  toggleCraftOut: (craftId) => {
    const out = new Set(get().overrides.craftOut);
    if (out.has(craftId)) out.delete(craftId);
    else out.add(craftId);
    set({ overrides: { ...get().overrides, craftOut: [...out] }, version: get().version + 1 });
    persist(get());
  },
  setKpiDelta: (key, value) => {
    set({ overrides: { ...get().overrides, kpiDeltas: { ...get().overrides.kpiDeltas, [key]: value } }, version: get().version + 1 });
    persist(get());
  },
  resetOverrides: () => {
    set({ overrides: { ...NEUTRAL_OVERRIDES, kpiDeltas: { ...NEUTRAL_KPI_DELTAS }, berthStatus: {}, craftOut: [] }, version: get().version + 1 });
    persist(get());
  },
  resetAll: () => {
    set({
      levers: { ...NEUTRAL_LEVERS },
      overrides: { ...NEUTRAL_OVERRIDES, kpiDeltas: { ...NEUTRAL_KPI_DELTAS }, berthStatus: {}, craftOut: [] },
      scenarioId: null,
      highlights: [],
      version: get().version + 1,
    });
    persist(get());
  },

  loadScenario: (id, levers) => { set({ scenarioId: id, levers: { ...NEUTRAL_LEVERS, ...levers }, version: get().version + 1 }); persist(get()); },
  clearScenario: () => { set({ scenarioId: null, levers: { ...NEUTRAL_LEVERS }, highlights: [], version: get().version + 1 }); persist(get()); },
  setHighlights: (ids) => { set({ highlights: ids, version: get().version + 1 }); persist(get()); },
  startTour: (id, auto) => { set({ tour: { scenarioId: id, step: 0, auto } }); persist(get()); },
  gotoStep: (step) => { set({ tour: { ...get().tour, step } }); persist(get()); },
  endTour: () => { set({ tour: { scenarioId: null, step: 0, auto: true }, highlights: [], version: get().version + 1 }); persist(get()); },

  restore: () => {
    try {
      const raw = sessionStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<Persisted>;
      set({
        clockH: p.clockH ?? 0,
        levers: { ...NEUTRAL_LEVERS, ...p.levers },
        overrides: {
          ...NEUTRAL_OVERRIDES,
          ...p.overrides,
          kpiDeltas: { ...NEUTRAL_KPI_DELTAS, ...p.overrides?.kpiDeltas },
          berthStatus: { ...p.overrides?.berthStatus },
          craftOut: [...(p.overrides?.craftOut ?? [])],
        },
        scenarioId: p.scenarioId ?? null,
        tour: p.tour ?? { scenarioId: null, step: 0, auto: true },
        highlights: p.highlights ?? [],
        version: (p.version ?? 0) + 1,
      });
    } catch {
      /* ignore */
    }
  },

  applyRemote: (p) => {
    // Adopt a remote snapshot only if it's newer, and never re-broadcast.
    if (p.version <= get().version) return;
    set({
      clockH: p.clockH,
      running: p.running,
      levers: { ...NEUTRAL_LEVERS, ...p.levers },
      overrides: {
        ...NEUTRAL_OVERRIDES,
        ...p.overrides,
        kpiDeltas: { ...NEUTRAL_KPI_DELTAS, ...p.overrides?.kpiDeltas },
        berthStatus: { ...p.overrides?.berthStatus },
        craftOut: [...(p.overrides?.craftOut ?? [])],
      },
      scenarioId: p.scenarioId ?? null,
      tour: p.tour ?? { scenarioId: null, step: 0, auto: true },
      highlights: p.highlights ?? [],
      version: p.version,
    });
    // Mirror to this tab's sessionStorage without re-broadcasting.
    persist(get(), false);
  },
}));

/**
 * Wire the cross-tab BroadcastChannel to the store. Called once at app start
 * (both the dashboard and the simulator tab call it). Returns a teardown fn.
 */
export function connectSimBroadcast(): () => void {
  const ch = getChannel();
  if (!ch) return () => {};
  const onMessage = (ev: MessageEvent<Persisted>) => {
    if (ev.data && typeof ev.data.version === 'number') {
      useSimStore.getState().applyRemote(ev.data);
    }
  };
  ch.addEventListener('message', onMessage);
  return () => ch.removeEventListener('message', onMessage);
}

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

/** Has the operator staged any direct data override (vessels/berths/craft/KPIs)? */
export function hasDataOverrides(o: SimOverrides): boolean {
  return (
    o.spawnVessels > 0 ||
    o.forceAnchored > 0 ||
    o.forceApproaching > 0 ||
    Object.keys(o.berthStatus).length > 0 ||
    o.craftOut.length > 0 ||
    Object.values(o.kpiDeltas).some((v) => v !== 0)
  );
}
