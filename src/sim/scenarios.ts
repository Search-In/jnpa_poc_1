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
import type { LifecycleHandoff } from './lifecycleHandoff';

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
  /**
   * Where this disruption continues once UC-1 has told its part.
   *
   * Absent on a scenario whose consequences stay inside vessel traffic. Present only
   * where the causal chain genuinely crosses into another twin — see lifecycleHandoff.
   */
  handoff?: LifecycleHandoff;
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
    // The hold does not end at the anchorage. Vessels that berth late discharge late,
    // which is a cargo problem before it is a corridor one — so the chain runs
    // UC-1 → UC-2 → UC-3, in the order the consequences actually arrive.
    handoff: {
      twin: 'UC2',
      scenarioId: 'S7',
      cta: 'Continue in UC-2 · Cargo & Logistics',
      because:
        'The four calls held at the anchorage still have to be discharged. They berth late '
        + 'and in one block, so the next thing this monsoon touches is the yard.',
    },
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
  {
    id: 'M6',
    code: 'M6',
    title: 'Rain squall — visibility hold',
    summary: 'A heavy rain squall drops visibility below the transfer minimum; pilotage holds until it lifts.',
    rubric: 'C5 — weather (rain) reactive causality',
    levers: { rainMmHr: 40, weatherSeverity: 0.3 },
    chain: ['rain', 'visibility', 'pilotage', 'arrivalQueue', 'preBerthDelay', 'jit'],
    steps: [
      { preset: 'anchorage', tab: 'tide', title: 'Rain squall arrives', narrative: 'Rainfall spikes to ~40 mm/h at the approach. The weather reading now carries a rain intensity and visibility falls sharply as the squall passes over the pilot boarding ground.', highlights: ['ANCH-OUTER', 'PBG'] },
      { preset: 'pilot', tab: 'craft', title: 'Visibility below limit', narrative: 'Simulated: horizontal visibility drops under the ~1 nm small-craft transfer minimum. The twin suspends pilot boarding for the duration of the squall — a visibility hold, distinct from the wind/wave hold in M1.', highlights: ['PBG'] },
      { preset: 'overview', tab: 'kpis', title: 'Queue + JIT slip, then recovery', narrative: 'Inbound vessels hold at the anchorage during the squall; pre-berthing delay rises and Just-In-Time slips against target. As the rain clears, visibility recovers and the held arrivals berth against their slots — the turn is preserved since the whole call shifts.', highlights: ['ANCH-WAIT'] },
    ],
  },
  {
    id: 'M7',
    code: 'M7',
    title: 'Oil spill — fairway closure',
    summary: 'A spill in the inner channel closes the maintained reach while it is boomed; deep-draft transits defer.',
    rubric: 'C5 — marine incident + interdependencies',
    levers: { oilSpill: 0.7 },
    chain: ['incident', 'channelClosure', 'deepDraftWindow', 'berthingSeq', 'preBerthDelay', 'jit'],
    steps: [
      { preset: 'channel', tab: 'dukc', title: 'Spill reported in the fairway', narrative: 'A hydrocarbon spill is reported on the maintained inner channel. The incident secures the fairway: the inner (and, as it spreads, the turning) reach is closed to traffic while booms and skimmers deploy.', highlights: ['CH-INNER', 'CH-TURN'] },
      { preset: 'channel', tab: 'dukc', title: 'Transit route removed', narrative: 'Simulated: with the fairway closed, deep-draft transits lose their route entirely (not just their tidal window). Pilot movements are suspended while the incident is active.', highlights: ['CH-INNER', 'BMCT'] },
      { preset: 'overview', tab: 'gantt', title: 'Berthing sequence defers', narrative: 'Calls dependent on the closed reach defer until the fairway reopens; pre-berthing delay rises and Just-In-Time slips for the affected vessels (the turn is preserved since the whole call shifts). The gantt shows the deferral and the recovery re-sequencing once containment clears.', highlights: ['BMCT', 'GTI'] },
    ],
  },
  {
    id: 'M8',
    code: 'M8',
    title: 'Marine accident — grounding',
    summary: 'A grounding/collision suspends movements and ties up a tug; the line-up re-sequences on recovery.',
    rubric: 'C5 — marine accident + resource contention',
    levers: { accident: 0.6, tugsDown: 1 },
    chain: ['incident', 'pilotage', 'arrivalQueue', 'berthingSeq', 'preBerthDelay'],
    steps: [
      { preset: 'channel', tab: 'craft', title: 'Accident in the approach', narrative: 'A vessel grounds on a falling tide in the approach. Movements are suspended around the casualty and a tug is committed to the response, removing it from the roster.', highlights: ['CH-INNER', 'PBG'] },
      { preset: 'pilot', tab: 'craft', title: 'Movements held, tug committed', narrative: 'Simulated: pilot boarding halts while the incident is worked and the committed tug is unavailable for berthing/unberthing — a compounded resource + safety constraint.', highlights: ['PBG'] },
      { preset: 'overview', tab: 'gantt', title: 'Queue builds, then re-sequences', narrative: 'An arrival queue forms during the hold; pre-berthing delay rises. When movements resume, the twin proposes a recovery sequence prioritising the calls with the tightest closing tides.', highlights: ['ANCH-WAIT', 'BMCT'] },
    ],
  },
  {
    id: 'M9',
    code: 'M9',
    title: 'Extended berth window — service overrun',
    summary: 'Alongside windows overrun by ~6 h; late berth release slips the next vessel and lifts TAT.',
    rubric: 'C5 — berth-release cascade',
    levers: { berthWindowExtendH: 6 },
    chain: ['berthingSeq', 'berthService', 'berthRelease', 'tat'],
    steps: [
      { preset: 'berths', tab: 'gantt', title: 'Alongside window extends', narrative: 'Cargo operations overrun and the alongside/service window extends by ~6 hours across the affected calls — the gantt bars lengthen at the berth end (departure moves later than arrival).', highlights: ['NSICT', 'GTI'] },
      { preset: 'overview', tab: 'kpis', title: 'TAT rises with the longer turn', narrative: 'Simulated: because the departure moves more than the arrival, turnaround (ATD − ATA) grows — Average Vessel TAT rises against target while pre-berthing delay is largely unchanged.', highlights: ['NSICT'] },
      { preset: 'overview', tab: 'gantt', title: 'Late release cascades', narrative: 'The berth frees later than planned — the release cascade the reactive twin makes explicit: the next vessel’s window is pushed as the alongside overrun propagates down the sequence.', highlights: ['GTI', 'BMCT'] },
    ],
  },
  {
    id: 'M10',
    code: 'M10',
    title: 'Dredging campaign — depth restored',
    summary: 'Siltation has cut controlling depth; a dredging campaign restores most of it and deep-draft windows recover.',
    rubric: 'C5 — dredging workflow (end-to-end)',
    levers: { channelDepthDeltaM: -0.5, dredgeRestoreM: 0.4 },
    chain: ['dredging', 'bathymetry', 'dukc', 'deepDraftWindow', 'berthingSeq'],
    steps: [
      { preset: 'channel', tab: 'dukc', title: 'Siltation vs dredging', narrative: 'Survey shows −0.5 m of siltation on the maintained inner channel. A maintenance dredging campaign restores +0.4 m — the net controlling depth is −0.1 m rather than the full loss.', highlights: ['CH-INNER'] },
      { preset: 'channel', tab: 'dukc', title: 'Deep-draft windows recover', narrative: 'Simulated: with depth largely restored, the DUKC floor drops back and deep-draft go/no-go windows reopen on the corridor — the dredging closes most of the gap that siltation opened in M2.', highlights: ['CH-INNER', 'BMCT'] },
      { preset: 'overview', tab: 'gantt', title: 'Plan relaxes', narrative: 'The berthing sequence relaxes back toward the unrestricted plan as the recovered windows absorb the deep-draft calls — pre-berthing delay eases relative to the siltation-only case.', highlights: ['BMCT', 'GTI'] },
    ],
  },
];

export const SCENARIO_BY_ID: Record<string, Scenario> = Object.fromEntries(SCENARIOS.map((s) => [s.id, s]));

/** Merge a scenario's partial levers onto the neutral baseline. */
export function scenarioLevers(id: string): SimLevers {
  const sc = SCENARIO_BY_ID[id];
  return { ...NEUTRAL_LEVERS, ...(sc?.levers ?? {}) };
}
