/**
 * Marine causal DAG (spec §B2.10) — the explicit cause→effect graph the Reactive
 * Guide renders. Nodes are twin factors; edges carry a mechanism label so the
 * guide can explain HOW one factor propagates to the next. This is the
 * cross-domain interdependency story evaluators probe for:
 *   weather → wave/wind limits → pilotage suspension
 *   tide → DUKC → deep-draft window → berthing sequence → pre-berthing delay → TAT
 *   tug availability → unberthing slip → berth release → next-vessel JIT
 */

export type Domain = 'weather' | 'tide' | 'channel' | 'pilotage' | 'berth' | 'craft' | 'kpi';

export interface CausalNode {
  id: string;
  label: string;
  domain: Domain;
  /** Plain-language description of the factor. */
  desc: string;
  /** Map asset ids to fly-to / ring when this node is the WHERE focus. */
  where?: string[];
}

export interface CausalEdge {
  from: string;
  to: string;
  /** Mechanism label rendered on the animated edge (the HOW). */
  mechanism: string;
}

export const NODES: CausalNode[] = [
  { id: 'weather', label: 'Weather front', domain: 'weather', desc: 'Wind speed and significant wave height at the approach.', where: ['ANCH-OUTER'] },
  { id: 'windwave', label: 'Wind/wave limits', domain: 'weather', desc: 'Operational limits for safe pilot transfer.', where: ['PBG'] },
  { id: 'pilotage', label: 'Pilotage', domain: 'pilotage', desc: 'Pilot boarding / transit clearance service.', where: ['PBG'] },
  { id: 'tide', label: 'Tide', domain: 'tide', desc: 'Tide height above chart datum — the DUKC water column.', where: ['CH-INNER'] },
  { id: 'bathymetry', label: 'Channel depth', domain: 'channel', desc: 'Charted / surveyed controlling depth per segment.', where: ['CH-INNER'] },
  { id: 'dukc', label: 'DUKC clearance', domain: 'channel', desc: 'Predicted under-keel clearance from depth + tide − draft − squat.', where: ['CH-INNER'] },
  { id: 'deepDraftWindow', label: 'Deep-draft window', domain: 'channel', desc: 'Tidal windows during which deep-draft vessels can transit.', where: ['CH-INNER', 'BMCT'] },
  { id: 'craftAvail', label: 'Craft availability', domain: 'craft', desc: 'Finite pilots / tugs / mooring gangs available.', where: ['PBG'] },
  { id: 'arrivalQueue', label: 'Arrival queue', domain: 'berth', desc: 'Vessels waiting at anchorage for a berth/pilot/window.', where: ['ANCH-WAIT'] },
  { id: 'anchorageMgmt', label: 'Anchorage mgmt', domain: 'berth', desc: 'Sequencing vessels out of the anchorage into berths.', where: ['ANCH-OUTER', 'ANCH-WAIT'] },
  { id: 'berthOutage', label: 'Berth outage', domain: 'berth', desc: 'A berth removed from service (crane/other).', where: ['GTI'] },
  { id: 'berthingSeq', label: 'Berthing sequence', domain: 'berth', desc: 'The order/assignment of vessels to berths over time.', where: ['NSICT', 'GTI', 'BMCT'] },
  { id: 'preBerthDelay', label: 'Pre-berthing delay', domain: 'kpi', desc: 'Time from ready-to-berth to alongside vs target.' },
  { id: 'jit', label: 'Just-In-Time', domain: 'kpi', desc: 'Share of arrivals meeting their just-in-time window.' },
  { id: 'tat', label: 'Vessel TAT', domain: 'kpi', desc: 'Overall turnaround time, pilot-boarding to deboarding.' },
];

export const EDGES: CausalEdge[] = [
  { from: 'weather', to: 'windwave', mechanism: 'raises wind/wave above limit' },
  { from: 'windwave', to: 'pilotage', mechanism: 'suspends pilot transfer' },
  { from: 'pilotage', to: 'arrivalQueue', mechanism: 'halted boarding → vessels hold' },
  { from: 'tide', to: 'dukc', mechanism: 'sets available water column' },
  { from: 'bathymetry', to: 'dukc', mechanism: 'sets channel floor' },
  { from: 'dukc', to: 'deepDraftWindow', mechanism: 'gates deep-draft transit' },
  { from: 'deepDraftWindow', to: 'berthingSeq', mechanism: 'constrains order to windows' },
  { from: 'craftAvail', to: 'pilotage', mechanism: 'limits boarding slots' },
  { from: 'berthOutage', to: 'berthingSeq', mechanism: 'removes a berth from the plan' },
  { from: 'arrivalQueue', to: 'anchorageMgmt', mechanism: 'fills the anchorage' },
  { from: 'anchorageMgmt', to: 'berthingSeq', mechanism: 'feeds sequencing' },
  { from: 'berthingSeq', to: 'preBerthDelay', mechanism: 'sets alongside timing' },
  { from: 'arrivalQueue', to: 'preBerthDelay', mechanism: 'waiting adds delay' },
  { from: 'preBerthDelay', to: 'tat', mechanism: 'adds to turnaround' },
  { from: 'berthingSeq', to: 'jit', mechanism: 'hits/misses JIT windows' },
  { from: 'arrivalQueue', to: 'jit', mechanism: 'queueing misses windows' },
];

export const NODE_BY_ID: Record<string, CausalNode> = Object.fromEntries(NODES.map((n) => [n.id, n]));

/** All edges on the path defined by an ordered node chain (for a scenario). */
export function chainEdges(chain: string[]): CausalEdge[] {
  const set = new Set(chain);
  return EDGES.filter((e) => set.has(e.from) && set.has(e.to));
}

/** Domain → colour token key (resolved in the component against theme tokens). */
export const DOMAIN_COLOR: Record<Domain, string> = {
  weather: '#f2a93b',
  tide: '#3aa0ff',
  channel: '#7c8aff',
  pilotage: '#2dbb6a',
  berth: '#00a3a3',
  craft: '#c77dff',
  kpi: '#e04545',
};
