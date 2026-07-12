/**
 * Scripted marine scenarios M1–M5 (spec §B2.11). Each is a one-click lever set
 * plus guided-tour steps with talking points mapped to a rubric criterion, and
 * the causal chain it exercises (consumed by the ReactiveGuide). Free-parameter
 * mode is just the levers panel; these are the rehearsed one-click runs.
 *
 * Every effect is framed as a SIMULATED result under stated assumptions — never
 * a claimed baseline improvement (integrity rule, spec §A3).
 */
import type { SimLevers } from './simStore';
import { NEUTRAL_LEVERS } from './simStore';

export interface TourStep {
  /** Camera preset to fly to for this beat. */
  preset: 'overview' | 'anchorage' | 'channel' | 'berths' | 'pilot';
  /** Which dashboard tab to spotlight. */
  tab: string;
  title: string;
  /** Plain-language narration (offline, template-free prose). */
  narrative: string;
  /** Asset ids to ring on the map for this step. */
  highlights?: string[];
}

export interface Scenario {
  id: string;
  code: string; // M1..M5
  title: string;
  /** One-line hook for the scenario card. */
  summary: string;
  /** The rubric criterion this scenario primarily evidences. */
  rubric: string;
  levers: Partial<SimLevers>;
  /** Ordered causal-chain node ids (into causalGraph) this scenario lights up. */
  chain: string[];
  steps: TourStep[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'M1',
    code: 'M1',
    title: 'Monsoon pilotage suspension',
    summary: 'A 4-hour weather hold builds an arrival queue; recovery re-sequences the line-up.',
    rubric: 'C5 — what-if + reactive causality',
    levers: { weatherSeverity: 0.85 },
    chain: ['weather', 'windwave', 'pilotage', 'arrivalQueue', 'preBerthDelay', 'jit'],
    steps: [
      { preset: 'anchorage', tab: 'scenarios', title: 'Weather front arrives', narrative: 'Sustained winds and wave height cross the pilotage limit. The twin suspends pilot transfers — no vessel boards a pilot until the hold clears.', highlights: ['ANCH-OUTER', 'PBG'] },
      { preset: 'pilot', tab: 'craft', title: 'Pilot boarding halts', narrative: 'With boarding suspended, inbound vessels hold at the anchorage. Pilots idle; the boarding ground is quiet.', highlights: ['PBG'] },
      { preset: 'overview', tab: 'gantt', title: 'Arrival queue builds', narrative: 'Simulated: over the 4-hour hold an arrival queue forms. Pre-berthing delay rises against target as the window is lost.', highlights: ['ANCH-OUTER', 'ANCH-WAIT'] },
      { preset: 'berths', tab: 'kpis', title: 'Recovery sequencing', narrative: 'When the hold lifts, the twin proposes a recovery sequence — deep-draft vessels take the next tidal window first. Just-In-Time recovers as the delayed arrivals berth against their slots; the turn (TAT) is preserved since the whole call shifts, not the alongside time.', highlights: ['GTI', 'BMCT'] },
    ],
  },
  {
    id: 'M2',
    code: 'M2',
    title: 'Channel draft restriction',
    summary: 'Siltation drops controlling depth −0.5 m; deep-draft vessels lose tidal windows and replan.',
    rubric: 'C5 + DUKC defensibility',
    levers: { channelDepthDeltaM: -0.5 },
    chain: ['bathymetry', 'dukc', 'deepDraftWindow', 'berthingSeq', 'preBerthDelay'],
    steps: [
      { preset: 'channel', tab: 'dukc', title: 'Siltation reduces depth', narrative: 'A survey shows −0.5 m over the maintained inner channel. The DUKC floor rises: the same tide now clears less draft.', highlights: ['CH-INNER'] },
      { preset: 'channel', tab: 'dukc', title: 'Deep-draft windows shrink', narrative: 'Simulated: BMCT-class deep-draft transits lose their marginal windows entirely at neap tides — go/no-go bands contract on the corridor.', highlights: ['CH-INNER', 'BMCT'] },
      { preset: 'overview', tab: 'gantt', title: 'Berthing sequence replans', narrative: 'The gantt reshuffles deep-draft calls onto the surviving high-water windows; shallow-draft calls fill the gaps. Pre-berthing delay is the trade the plan makes visible.', highlights: ['BMCT', 'GTI'] },
    ],
  },
  {
    id: 'M3',
    code: 'M3',
    title: 'Berth outage (crane breakdown)',
    summary: 'A crane fails at a GTI berth; calls reallocate across terminals.',
    rubric: 'C5 — interdependencies + automated workflow',
    levers: { berthsOut: ['GTI-1'] },
    chain: ['berthOutage', 'berthingSeq', 'preBerthDelay'],
    steps: [
      { preset: 'berths', tab: 'gantt', title: 'Crane breakdown', narrative: 'A quay crane at GTI Berth 1 goes out of service. The berth is hatched out-of-service on the plan and its call must wait for a compatible slot.', highlights: ['GTI'] },
      { preset: 'overview', tab: 'gantt', title: 'Reallocation proposal', narrative: 'Simulated: the GTI-1 call waits for a compatible berth across NSICT/NSIGT/BMCT within draft limits — its pre-berthing delay rises as the reassignment window is found.', highlights: ['NSICT', 'NSIGT', 'BMCT'] },
      { preset: 'overview', tab: 'workflows', title: 'Workflow proposal', narrative: 'The berth-outage condition raises a proposed Workflow Run: reallocation + stakeholder notification. In ADVISORY mode it waits for sign-off; in AUTO it would apply. Shown here as a proposal, not an executed reassignment.', highlights: ['GTI'] },
    ],
  },
  {
    id: 'M4',
    code: 'M4',
    title: 'Pilot shortage',
    summary: 'Two pilots unavailable; JIT slips and a prioritisation policy takes over.',
    rubric: 'C5 + Port Craft optimisation KPI',
    levers: { pilotsDown: 2 },
    chain: ['craftAvail', 'pilotage', 'arrivalQueue', 'jit'],
    steps: [
      { preset: 'pilot', tab: 'craft', title: 'Two pilots offline', narrative: 'The roster loses two pilots. The resource board flags the shortfall and the conflicts it creates against scheduled boardings.', highlights: ['PBG'] },
      { preset: 'overview', tab: 'kpis', title: 'JIT slips', narrative: 'Simulated: with fewer pilots, boarding slots compress and Just-In-Time arrival slips against target as vessels wait for a pilot.', highlights: ['ANCH-WAIT'] },
      { preset: 'pilot', tab: 'craft', title: 'Prioritisation policy', narrative: 'The board proposes a swap — reassign pilots to close the largest JIT gap first (e.g. deep-draft on a closing tide). Simulated delta shown vs do-nothing.', highlights: ['PBG', 'GTI'] },
    ],
  },
  {
    id: 'M5',
    code: 'M5',
    title: 'Vessel bunching (fog lifts)',
    summary: 'Fog clears and six arrivals compress; anchorage management + JIT re-sequencing.',
    rubric: 'C5 — reactive re-sequencing',
    levers: { extraArrivals: 6, weatherSeverity: 0.3 },
    chain: ['weather', 'arrivalQueue', 'anchorageMgmt', 'berthingSeq', 'jit'],
    steps: [
      { preset: 'anchorage', tab: 'scenarios', title: 'Fog lifts', narrative: 'Visibility recovers and six delayed arrivals present at once — they appear as fresh contacts filling the outer and waiting anchorages. The twin must sequence them into finite berths.', highlights: ['ANCH-OUTER', 'ANCH-WAIT'] },
      { preset: 'overview', tab: 'gantt', title: 'Bunched arrivals compress slots', narrative: 'Simulated: the compression pushes berthing later across the affected calls, so Just-In-Time slips against target — the reactive playbook is to space arrivals to berth availability and tidal windows rather than berth first-come.', highlights: ['NSICT', 'GTI', 'BMCT'] },
      { preset: 'overview', tab: 'kpis', title: 'JIT under compression', narrative: 'The JIT gauge and convergence view show the cost of the bunch — arrivals missing their just-in-time windows — which is what a re-sequencing plan would then recover.', highlights: [] },
    ],
  },
];

export const SCENARIO_BY_ID: Record<string, Scenario> = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

/** Merge a scenario's partial levers onto the neutral baseline. */
export function scenarioLevers(id: string): SimLevers {
  const sc = SCENARIO_BY_ID[id];
  return { ...NEUTRAL_LEVERS, ...(sc?.levers ?? {}) };
}
