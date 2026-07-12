/**
 * Guardrails for What-if module consistency — every scenario's claimed causal
 * chain must be (a) a connected path in the graph, (b) backed by a real,
 * measurable data effect for each KPI it names, and every asset id it spotlights
 * must actually resolve on the map. These pin the audit fixes so a future edit
 * that reintroduces a dead id, an orphan chain node, or an inert KPI claim fails
 * CI instead of silently shipping a scenario whose story the data doesn't back.
 */
import { describe, it, expect } from 'vitest';
import { SCENARIOS } from '@/sim/scenarios';
import { NODE_BY_ID, chainEdges } from '@/whatif/causalGraph';
import { asset3dPosition } from '@/map/scene3d';
import { buildKpiBundle, recomputePlanKpis } from '@/kpi';
import { applyPlanLevers, applyVessels } from '@/sim/applySim';
import { NEUTRAL_LEVERS, NEUTRAL_OVERRIDES } from '@/sim/simStore';
import {
  makeBerthingPlan,
  makeKpiSnapshots,
  makePredictions,
  makeVessels,
  BERTHS,
} from '@/data/mock/fixtures';

const T0 = 1_700_000_000_000;

/** Causal KPI node id → the headline card it should move. */
const KPI_NODE_TO_KEY = {
  preBerthDelay: 'preBerthingDelay',
  jit: 'jitPct',
  tat: 'avgTat',
} as const;

function baseBundle() {
  return buildKpiBundle({
    now: T0,
    vessels: makeVessels(T0, 0),
    plan: makeBerthingPlan(T0),
    predictions: makePredictions(T0),
    berthCount: BERTHS.length,
    snapshots: makeKpiSnapshots(T0),
    windowHours: 24,
  });
}

describe('scenario causal chains are connected', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.code}: every chain node exists and is on a connected edge path`, () => {
      // Every node id resolves.
      for (const id of sc.chain) expect(NODE_BY_ID[id], `${sc.code} node ${id}`).toBeTruthy();
      // No orphan: every node (for chains of length > 1) touches at least one edge.
      const edges = chainEdges(sc.chain);
      if (sc.chain.length > 1) {
        for (const id of sc.chain) {
          const touched = edges.some((e) => e.from === id || e.to === id);
          expect(touched, `${sc.code}: node "${id}" is an orphan (no edge)`).toBe(true);
        }
      }
    });
  }
});

describe('scenario highlight ids all resolve on the map', () => {
  const resolvable = asset3dPosition();
  for (const sc of SCENARIOS) {
    it(`${sc.code}: no dead highlight ids`, () => {
      for (const step of sc.steps) {
        for (const id of step.highlights ?? []) {
          expect(resolvable.has(id), `${sc.code} step highlight "${id}" does not resolve on the map`).toBe(true);
        }
      }
    });
  }
});

describe('causal-graph WHERE ids all resolve on the map', () => {
  const resolvable = asset3dPosition();
  it('every node.where id is a real map asset', () => {
    for (const node of Object.values(NODE_BY_ID)) {
      for (const id of node.where ?? []) {
        expect(resolvable.has(id), `node ${node.id} where "${id}" does not resolve`).toBe(true);
      }
    }
  });
});

describe('each scenario actually moves the KPIs its chain claims', () => {
  const base = baseBundle();
  for (const sc of SCENARIOS) {
    const claimedKpis = sc.chain
      .map((n) => KPI_NODE_TO_KEY[n as keyof typeof KPI_NODE_TO_KEY])
      .filter(Boolean) as string[];
    if (claimedKpis.length === 0) continue;
    it(`${sc.code}: ${claimedKpis.join(', ')} change under its levers`, () => {
      const levers = { ...NEUTRAL_LEVERS, ...sc.levers };
      const slipped = applyPlanLevers(makeBerthingPlan(T0), levers);
      const after = recomputePlanKpis(base, slipped, T0, BERTHS.length);
      for (const key of claimedKpis) {
        const b = base[key as keyof typeof base].value;
        const a = after[key as keyof typeof after].value;
        expect(a, `${sc.code}: ${key} did not move (${b} → ${a})`).not.toBe(b);
      }
    });
  }
});

describe('extraArrivals lever spawns visible anchorage/approach contacts (M5)', () => {
  it('adds vessels to the stream, not just slip', () => {
    const snapBase = { clockH: 0, levers: NEUTRAL_LEVERS, overrides: NEUTRAL_OVERRIDES };
    const withoutExtra = applyVessels([], snapBase);
    const withExtra = applyVessels([], {
      ...snapBase,
      levers: { ...NEUTRAL_LEVERS, extraArrivals: 6 },
    });
    expect(withExtra.length).toBe(withoutExtra.length + 6);
  });
});

describe('slip model moves turnaround, not only arrival timing', () => {
  const base = baseBundle();
  it('a service-time lever (tugsDown) raises TAT', () => {
    const slipped = applyPlanLevers(makeBerthingPlan(T0), { ...NEUTRAL_LEVERS, tugsDown: 3 });
    const after = recomputePlanKpis(base, slipped, T0, BERTHS.length);
    expect(after.avgTat.value).toBeGreaterThan(base.avgTat.value);
  });
  it('a pure arrival-hold lever (weather) leaves TAT unchanged (physically correct)', () => {
    const slipped = applyPlanLevers(makeBerthingPlan(T0), { ...NEUTRAL_LEVERS, weatherSeverity: 0.85 });
    const after = recomputePlanKpis(base, slipped, T0, BERTHS.length);
    expect(after.avgTat.value).toBe(base.avgTat.value);
  });
});
