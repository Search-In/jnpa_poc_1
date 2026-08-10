/**
 * The scene may only change because the ENGINE says something changed. These
 * tests pin that: calm weather renders calm, a suspended-pilotage flag actually
 * stops the hulls, and a berth outage actually stops the cranes on that quay.
 */
import { describe, expect, it } from 'vitest';
import { BERTHS } from '@/data/mock/fixtures';
import { NEUTRAL_LEVERS } from '@/sim/simStore';
import { scenarioLevers } from '@/sim/scenarios';
import { computeImpacts, type VrEnvironment } from './impactModel';
import {
  CRANE_TRAVEL_M,
  MEAN_TIDE_M,
  advanceVessel,
  craneVisuals,
  hash01,
  holdState,
  seaBand,
  seaMotion,
  staticHeel,
  waterSurfaceZ,
  weatherVisual,
  type MovingVessel,
} from './liveWorld';
import { groundDistanceM } from './stereo';

function envOf(over: Partial<VrEnvironment> = {}): VrEnvironment {
  return {
    tideM: 2.6,
    windKt: 10,
    windDir: 225,
    seaStateM: 1.0,
    visibilityNm: 8,
    rainMmHr: 0,
    pilotageSuspended: false,
    movementsSuspended: false,
    controllingDepthM: 15,
    channelDepthDeltaM: 0,
    ...over,
  };
}

describe('weatherVisual', () => {
  it('renders a calm day as sunny', () => {
    const w = weatherVisual(envOf());
    expect(w.type).toBe('sunny');
  });

  it('renders low visibility as fog, even when it is also raining', () => {
    // Visibility is what actually stops pilot transfer, and fog and rain look
    // nothing alike — the evaluator must SEE the stated reason.
    const w = weatherVisual(envOf({ visibilityNm: 0.6, rainMmHr: 40 }));
    expect(w.type).toBe('foggy');
    if (w.type === 'foggy') expect(w.fogStrength).toBeGreaterThan(0.5);
  });

  it('thickens the fog as visibility drops', () => {
    const a = weatherVisual(envOf({ visibilityNm: 1.4 }));
    const b = weatherVisual(envOf({ visibilityNm: 0.3 }));
    expect(a.type).toBe('foggy');
    expect(b.type).toBe('foggy');
    if (a.type === 'foggy' && b.type === 'foggy') {
      expect(b.fogStrength).toBeGreaterThan(a.fogStrength);
    }
  });

  it('renders a monsoon as rain with heavy cloud', () => {
    const w = weatherVisual(envOf({ rainMmHr: 30, seaStateM: 3.4, windKt: 34 }));
    expect(w.type).toBe('rainy');
    if (w.type === 'rainy') {
      expect(w.precipitation).toBeGreaterThan(0.3);
      expect(w.cloudCover).toBeGreaterThan(0.5);
    }
  });

  it('renders a storm sea as rain even with no reported rainfall', () => {
    expect(weatherVisual(envOf({ seaStateM: 3.2, rainMmHr: 0 })).type).toBe('rainy');
  });

  it('never emits an out-of-range intensity', () => {
    for (const vis of [0.1, 1, 3, 10]) {
      for (const rain of [0, 5, 80]) {
        for (const sea of [0.2, 1.5, 4]) {
          const w = weatherVisual(envOf({ visibilityNm: vis, rainMmHr: rain, seaStateM: sea }));
          const vals = Object.entries(w)
            .filter(([k]) => k !== 'type')
            .map(([, v]) => v as number);
          for (const v of vals) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
          }
        }
      }
    }
  });
});

describe('waterSurfaceZ', () => {
  it('puts mean tide at the basemap sea level', () => {
    expect(waterSurfaceZ(envOf({ tideM: MEAN_TIDE_M }))).toBe(0);
  });

  it('rises and falls with the tide', () => {
    expect(waterSurfaceZ(envOf({ tideM: 4.3 }))).toBeCloseTo(1.7, 3);
    expect(waterSurfaceZ(envOf({ tideM: 1.0 }))).toBeCloseTo(-1.6, 3);
  });
});

describe('holdState', () => {
  it('runs traffic when nothing is wrong', () => {
    expect(holdState(envOf())).toEqual({ holding: false, reason: null });
  });

  it('holds on suspended pilotage and on a marine incident', () => {
    expect(holdState(envOf({ pilotageSuspended: true })).holding).toBe(true);
    expect(holdState(envOf({ movementsSuspended: true })).holding).toBe(true);
    expect(holdState(envOf({ pilotageSuspended: true })).reason).toMatch(/pilotage/i);
  });
});

describe('craneVisuals', () => {
  const calm = computeImpacts({
    levers: NEUTRAL_LEVERS,
    clockH: 6,
    berths: BERTHS,
    scenarioId: null,
  });

  it('finds the surveyed cranes', () => {
    const cranes = craneVisuals(BERTHS, calm.impacts, 0);
    expect(cranes.length).toBeGreaterThan(10);
    for (const c of cranes) {
      expect(Number.isFinite(c.longitude)).toBe(true);
      expect(Number.isFinite(c.latitude)).toBe(true);
    }
  });

  it('works the cranes on a quay that has a ship alongside', () => {
    const cranes = craneVisuals(BERTHS, calm.impacts, 0);
    const occupied = new Set(BERTHS.filter((b) => b.STATUS === 'occupied').map((b) => b.TERMINAL));
    expect(occupied.size).toBeGreaterThan(0);
    for (const c of cranes) {
      if (occupied.has(c.terminalId)) expect(c.state).toBe('working');
    }
  });

  it('stops and flags every crane on a quay whose berth is out of service', () => {
    const m3 = computeImpacts({
      levers: { ...NEUTRAL_LEVERS, ...scenarioLevers('M3') },
      clockH: 6,
      berths: BERTHS,
      scenarioId: 'M3',
    });
    const cranes = craneVisuals(BERTHS, m3.impacts, 0);
    const gti = cranes.filter((c) => c.terminalId === 'GTI');
    expect(gti.length).toBeGreaterThan(0);
    for (const c of gti) expect(c.state).toBe('blocked');
    // A blocked crane does not gantry-travel, at any point in the cycle.
    const later = craneVisuals(BERTHS, m3.impacts, 11);
    for (const c of later.filter((x) => x.terminalId === 'GTI')) {
      const home = gti.find((g) => g.key === c.key)!;
      expect(c.longitude).toBe(home.longitude);
      expect(c.latitude).toBe(home.latitude);
    }
  });

  it('gantry-travels a working crane within its rail limit', () => {
    const at = (t: number) => craneVisuals(BERTHS, calm.impacts, t);
    const working = at(0).filter((c) => c.state === 'working');
    expect(working.length).toBeGreaterThan(0);

    let maxTravel = 0;
    let moved = false;
    for (const t of [0, 3, 6, 9, 12, 15, 18, 21]) {
      for (const c of at(t)) {
        if (c.state !== 'working') continue;
        const home = working.find((w) => w.key === c.key);
        if (!home) continue;
        const d = groundDistanceM(home.longitude, home.latitude, c.longitude, c.latitude);
        if (d > 0.5) moved = true;
        maxTravel = Math.max(maxTravel, d);
      }
    }
    expect(moved, 'a working crane should move').toBe(true);
    // Never further than a full stroke off its start point.
    expect(maxTravel).toBeLessThanOrEqual(CRANE_TRAVEL_M * 2 + 1);
  });

  it('freezes every crane under prefers-reduced-motion', () => {
    const a = craneVisuals(BERTHS, calm.impacts, 0, true);
    const b = craneVisuals(BERTHS, calm.impacts, 9, true);
    expect(b.map((c) => c.longitude)).toEqual(a.map((c) => c.longitude));
    // The state colouring still reads — only the motion stops.
    expect(a.some((c) => c.state === 'working')).toBe(true);
  });

  it('is deterministic', () => {
    expect(craneVisuals(BERTHS, calm.impacts, 4.5)).toEqual(craneVisuals(BERTHS, calm.impacts, 4.5));
  });
});

describe('advanceVessel', () => {
  const hull = (over: Partial<MovingVessel> = {}): MovingVessel => ({
    mmsi: '419000123',
    name: 'MV BHARAT EXPRESS',
    longitude: 72.9,
    latitude: 18.92,
    heading: 0,
    sog: 10,
    navStatus: 'approaching',
    held: false,
    ...over,
  });

  it('makes way at its own speed over ground', () => {
    const v = hull({ sog: 10, heading: 0 });
    const next = advanceVessel(v, 60, 0, false);
    // 10 kn for 60 s ≈ 308 m.
    const d = groundDistanceM(v.longitude, v.latitude, next.longitude, next.latitude);
    expect(d).toBeCloseTo(10 * 0.514444 * 60, 0);
    expect(next.latitude).toBeGreaterThan(v.latitude);
    expect(next.held).toBe(false);
  });

  it('stops an inbound hull dead when movements are held', () => {
    const v = hull({ navStatus: 'approaching' });
    const next = advanceVessel(v, 60, 0, true);
    expect(next.longitude).toBe(v.longitude);
    expect(next.latitude).toBe(v.latitude);
    expect(next.held).toBe(true);
  });

  it('swings a held hull about its anchor instead of freezing it solid', () => {
    const v = hull();
    const a = advanceVessel(v, 1, 0, true);
    const b = advanceVessel(v, 1, 10, true);
    expect(a.heading).not.toBe(b.heading);
    for (const h of [a.heading, b.heading]) {
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
    }
  });

  it('does not hold a vessel already moored or berthing', () => {
    for (const status of ['moored', 'berthing', 'anchored']) {
      const next = advanceVessel(hull({ navStatus: status }), 30, 0, true);
      expect(next.held, status).toBe(false);
    }
  });

  it('leaves position untouched under prefers-reduced-motion', () => {
    const v = hull();
    const next = advanceVessel(v, 60, 0, false, true);
    expect(next.longitude).toBe(v.longitude);
    expect(next.latitude).toBe(v.latitude);
    expect(next.heading).toBe(v.heading);
  });

  it('is deterministic', () => {
    expect(advanceVessel(hull(), 3, 7, true)).toEqual(advanceVessel(hull(), 3, 7, true));
  });
});

describe('seaMotion', () => {
  it('is flat calm in a flat calm sea', () => {
    const m = seaMotion(0, 5, 0.3);
    expect(m.heaveM).toBe(0);
    expect(m.rollDeg).toBe(0);
    expect(m.pitchDeg).toBe(0);
  });

  it('rolls harder as the sea builds', () => {
    const peak = (hs: number) => {
      let r = 0;
      for (let t = 0; t < 30; t += 0.1) r = Math.max(r, Math.abs(seaMotion(hs, t, 0).rollDeg));
      return r;
    };
    expect(peak(3.5)).toBeGreaterThan(peak(1));
    expect(peak(1)).toBeGreaterThan(peak(0.2));
  });

  it('rolls more than it pitches, as a real hull does', () => {
    const peakOf = (pick: (m: ReturnType<typeof seaMotion>) => number) => {
      let v = 0;
      for (let t = 0; t < 30; t += 0.1) v = Math.max(v, Math.abs(pick(seaMotion(4, t, 0))));
      return v;
    };
    expect(peakOf((m) => m.rollDeg)).toBeGreaterThan(peakOf((m) => m.pitchDeg));
  });

  it('caps motion so a storm never capsizes the model', () => {
    for (let t = 0; t < 60; t += 0.25) {
      const m = seaMotion(12, t, 0.7);
      expect(Math.abs(m.rollDeg)).toBeLessThanOrEqual(11);
      expect(Math.abs(m.pitchDeg)).toBeLessThanOrEqual(4.5);
      expect(Math.abs(m.heaveM)).toBeLessThanOrEqual(2.2);
    }
  });

  it('de-synchronises the fleet by phase', () => {
    expect(seaMotion(3, 5, 0.1).rollDeg).not.toBe(seaMotion(3, 5, 0.6).rollDeg);
  });

  it('freezes under prefers-reduced-motion', () => {
    expect(seaMotion(4, 7, 0.2, true)).toEqual({ heaveM: 0, rollDeg: 0, pitchDeg: 0 });
  });

  it('is deterministic', () => {
    expect(seaMotion(2.5, 13.25, 0.4)).toEqual(seaMotion(2.5, 13.25, 0.4));
  });
});

describe('seaBand / staticHeel', () => {
  it('bands the sea state so hull attitude is only re-applied when it matters', () => {
    // The band is a cache key for an expensive glTF symbol swap; if it changed
    // continuously the walkthrough would rebuild ship symbols every frame,
    // which is what previously grew the tab to ~2.5 GB.
    expect(seaBand(1.21)).toBe(seaBand(1.24));
    expect(seaBand(1.2)).not.toBe(seaBand(1.8));
    expect(seaBand(-3)).toBe(0);
    expect(seaBand(99)).toBe(8);
  });

  it('sits every hull upright in a calm sea', () => {
    for (const phase of [0, 0.3, 0.99]) {
      expect(staticHeel(0.2, phase)).toEqual({ rollDeg: 0, pitchDeg: 0 });
    }
  });

  it('heels hulls further as the sea builds, each by its own angle', () => {
    const calm = Math.abs(staticHeel(1.0, 0.1).rollDeg);
    const rough = Math.abs(staticHeel(4.0, 0.1).rollDeg);
    expect(rough).toBeGreaterThan(calm);
    // Different hulls take different angles, so the fleet does not look cloned.
    expect(staticHeel(4, 0.1).rollDeg).not.toBe(staticHeel(4, 0.85).rollDeg);
  });

  it('caps heel so a storm never lays a model on its side', () => {
    for (const hs of [4, 6, 8, 20]) {
      for (const p of [0, 0.25, 0.5, 0.75, 1]) {
        const h = staticHeel(hs, p);
        expect(Math.abs(h.rollDeg)).toBeLessThanOrEqual(9);
        expect(Math.abs(h.pitchDeg)).toBeLessThanOrEqual(3.5);
      }
    }
  });

  it('depends only on the band, so it is stable within one', () => {
    expect(staticHeel(3.1, 0.4)).toEqual(staticHeel(3.24, 0.4));
  });
});

describe('hash01', () => {
  it('is stable and inside [0,1)', () => {
    for (const k of ['crane:GTI:1', 'crane:BMCT:4', '419000123']) {
      const v = hash01(k);
      expect(v).toBe(hash01(k));
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(hash01('a')).not.toBe(hash01('b'));
  });
});
