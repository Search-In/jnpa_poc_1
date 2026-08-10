/**
 * The walkthrough view is only defensible if it tells the SAME story as the
 * dashboard. These tests lock that down: neutral levers must leave the scene
 * clean, each scripted scenario must light up the assets its narrative claims,
 * and every anchor the view rings must resolve on the real map.
 */
import { describe, expect, it } from 'vitest';
import { BERTHS } from '@/data/mock/fixtures';
import { NEUTRAL_LEVERS, type SimLevers } from '@/sim/simStore';
import { SCENARIOS, scenarioLevers } from '@/sim/scenarios';
import { asset3dPosition } from '@/map/scene3d';
import { pilotageSuspended, weatherAt } from '@/sim/derive';
import { causalEdgesFor, computeImpacts, overallSeverity } from './impactModel';

const CLOCK = 6;
/** Low water on the sim tide curve — where the deep-draft windows actually bite. */
const LOW_WATER_H = 9;
/** High water — the same scenario must be benign here. */
const HIGH_WATER_H = 3;

function run(levers: Partial<SimLevers>, scenarioId: string | null = null, clockH = CLOCK) {
  return computeImpacts({
    levers: { ...NEUTRAL_LEVERS, ...levers },
    clockH,
    berths: BERTHS,
    scenarioId,
  });
}

describe('neutral baseline', () => {
  it('reports no impacted assets when nothing is perturbed', () => {
    const m = run({});
    expect(m.impacts).toHaveLength(0);
    expect(overallSeverity(m.impacts)).toBe('none');
  });

  it('still reports the ambient environment', () => {
    const m = run({});
    const w = weatherAt(CLOCK, NEUTRAL_LEVERS);
    expect(m.environment.tideM).toBe(w.tideM);
    expect(m.environment.windKt).toBe(w.windKt);
    expect(m.environment.pilotageSuspended).toBe(false);
    expect(m.environment.channelDepthDeltaM).toBe(0);
  });

  it('is deterministic — the same input yields the same output', () => {
    expect(run({ weatherSeverity: 0.85 })).toEqual(run({ weatherSeverity: 0.85 }));
  });
});

describe('M1 — monsoon pilotage suspension', () => {
  const m = run(scenarioLevers('M1'), 'M1');

  it('agrees with the engine that pilotage is suspended', () => {
    expect(pilotageSuspended(weatherAt(CLOCK, scenarioLevers('M1')))).toBe(true);
    expect(m.environment.pilotageSuspended).toBe(true);
  });

  it('impacts the pilot boarding ground, critically', () => {
    const pbg = m.impacts.find((i) => i.assetId === 'PBG');
    expect(pbg).toBeDefined();
    expect(pbg!.severity).toBe('critical');
    expect(pbg!.headline).toMatch(/suspended/i);
    // The label must quantify WHY, not just assert it.
    expect(pbg!.detail).toMatch(/limit/);
  });

  it('builds a queue at the waiting anchorage', () => {
    expect(m.impacts.some((i) => i.assetId === 'ANCH-WAIT')).toBe(true);
  });
});

describe('M2 — channel draft restriction', () => {
  const m = run(scenarioLevers('M2'), 'M2');

  it('carries the depth loss into the environment readout', () => {
    expect(m.environment.channelDepthDeltaM).toBeCloseTo(-0.5, 6);
    expect(m.environment.controllingDepthM).toBeLessThan(15);
  });

  it('closes the deep-draft window at low water, at the deepest-design terminals', () => {
    const low = run(scenarioLevers('M2'), 'M2', LOW_WATER_H);
    const deep = low.impacts.filter((i) => i.kind === 'terminal' && /deep-draft/i.test(i.headline));
    expect(deep.length).toBeGreaterThan(0);
    // BMCT and GTI carry the 16.5 m design draft — they lose the window first.
    expect(deep.some((i) => i.assetId === 'BMCT')).toBe(true);
    expect(deep.some((i) => i.assetId === 'GTI')).toBe(true);
    expect(deep[0].detail).toMatch(/margin/);
    // The shallow-draft terminal keeps its window — the loss must be selective,
    // otherwise the scene would cry wolf across the whole port.
    expect(deep.some((i) => i.assetId === 'JNPCT')).toBe(false);
  });

  it('is tide-gated — the same depth loss is benign at high water', () => {
    const high = run(scenarioLevers('M2'), 'M2', HIGH_WATER_H);
    const deep = high.impacts.filter((i) => i.kind === 'terminal' && /deep-draft/i.test(i.headline));
    expect(deep).toHaveLength(0);
  });
});

describe('M3 — berth outage', () => {
  const levers = scenarioLevers('M3');
  const m = run(levers, 'M3');

  it('marks the named berth out of service', () => {
    for (const id of levers.berthsOut) {
      const hit = m.impacts.find((i) => i.berthId === id);
      expect(hit).toBeDefined();
      expect(hit!.severity).toBe('critical');
      expect(hit!.headline).toMatch(/out of service/i);
    }
  });

  it('propagates to the parent terminal so the replan is visible on the quay', () => {
    expect(m.impacts.some((i) => i.kind === 'terminal' && i.assetId === 'GTI')).toBe(true);
  });
});

describe('oil spill closes the fairway', () => {
  it('flags the closed segments as critical', () => {
    const m = run({ oilSpill: 0.7 });
    const closed = m.impacts.filter((i) => i.kind === 'channel' && /closed/i.test(i.headline));
    expect(closed.map((i) => i.assetId).sort()).toEqual(['CH-INNER', 'CH-TURN']);
    expect(m.environment.movementsSuspended).toBe(true);
  });
});

describe('label quality', () => {
  it('every impact carries a non-empty label, headline and quantified detail', () => {
    for (const s of SCENARIOS) {
      const m = run(scenarioLevers(s.id), s.id);
      for (const i of m.impacts) {
        expect(i.label.trim().length, `${s.id}/${i.assetId} label`).toBeGreaterThan(0);
        expect(i.headline.trim().length, `${s.id}/${i.assetId} headline`).toBeGreaterThan(0);
        expect(i.detail.trim().length, `${s.id}/${i.assetId} detail`).toBeGreaterThan(0);
        expect(i.severity).not.toBe('none');
      }
    }
  });

  it('orders impacts worst-first within each asset family', () => {
    const m = run({ weatherSeverity: 0.9, berthsOut: ['GTI-1'], extraArrivals: 4 });
    const rank = { none: 0, info: 1, warn: 2, critical: 3 } as const;
    const byKind = new Map<string, number[]>();
    for (const i of m.impacts) {
      const arr = byKind.get(i.kind) ?? [];
      arr.push(rank[i.severity]);
      byKind.set(i.kind, arr);
    }
    for (const [, ranks] of byKind) {
      expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    }
  });
});

describe('causal edges', () => {
  it('resolve both endpoints on the real 3D map', () => {
    const anchors = asset3dPosition();
    for (const s of SCENARIOS) {
      for (const e of causalEdgesFor(s.chain)) {
        expect(anchors.has(e.fromAssetId), `${s.id}: ${e.fromAssetId}`).toBe(true);
        expect(anchors.has(e.toAssetId), `${s.id}: ${e.toAssetId}`).toBe(true);
      }
    }
  });

  it('never emits a self-loop or a duplicate', () => {
    for (const s of SCENARIOS) {
      const edges = causalEdgesFor(s.chain);
      const keys = edges.map((e) => `${e.fromAssetId}->${e.toAssetId}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const e of edges) expect(e.fromAssetId).not.toBe(e.toAssetId);
    }
  });

  it('carries a mechanism label on every edge — the HOW requirement', () => {
    for (const s of SCENARIOS) {
      for (const e of causalEdgesFor(s.chain)) {
        expect(e.mechanism.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('is empty in free run', () => {
    expect(run({ weatherSeverity: 0.9 }, null).edges).toHaveLength(0);
  });
});
