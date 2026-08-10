import { describe, expect, it } from 'vitest';
import { BERTHS } from '@/data/mock/fixtures';
import { PORT_CENTER } from '@/map/portGeometry';
import { NEUTRAL_LEVERS } from '@/sim/simStore';
import { SCENARIOS, scenarioLevers } from '@/sim/scenarios';
import { computeImpacts } from './impactModel';
import {
  DWELL_MS,
  FLIGHT_MS,
  buildShots,
  easeInOut,
  frameShot,
  lerpPose,
  orderByCausalChain,
  tourDurationMs,
  tourFrame,
} from './cinematic';
import { bearingTo, groundDistanceM, type ViewerPose } from './stereo';

const LOW_WATER_H = 9;

function modelFor(id: string, clockH = LOW_WATER_H) {
  return computeImpacts({
    levers: { ...NEUTRAL_LEVERS, ...scenarioLevers(id) },
    clockH,
    berths: BERTHS,
    scenarioId: id,
  });
}

describe('frameShot', () => {
  it('looks at the subject from outside it', () => {
    const target: [number, number] = [72.945, 18.945];
    const pose = frameShot(target, 'berth', PORT_CENTER);
    const d = groundDistanceM(pose.longitude, pose.latitude, target[0], target[1]);
    expect(d).toBeGreaterThan(50);
    // The camera heading must actually point at the target.
    const toTarget = bearingTo(pose.longitude, pose.latitude, target[0], target[1]);
    expect(Math.abs(toTarget - pose.heading)).toBeLessThan(1);
  });

  it('stands further back for the big, spread-out assets', () => {
    const t: [number, number] = [72.945, 18.945];
    const berth = frameShot(t, 'berth', PORT_CENTER);
    const channel = frameShot(t, 'channel', PORT_CENTER);
    expect(groundDistanceM(channel.longitude, channel.latitude, t[0], t[1])).toBeGreaterThan(
      groundDistanceM(berth.longitude, berth.latitude, t[0], t[1])
    );
    expect(channel.z).toBeGreaterThan(berth.z);
  });

  it('produces a legal camera orientation for every asset kind', () => {
    for (const kind of ['berth', 'terminal', 'pilot', 'anchorage', 'channel'] as const) {
      const p = frameShot([72.94, 18.94], kind, PORT_CENTER);
      expect(p.heading).toBeGreaterThanOrEqual(0);
      expect(p.heading).toBeLessThan(360);
      expect(p.tilt).toBeGreaterThan(0);
      expect(p.tilt).toBeLessThanOrEqual(180);
      expect(p.z).toBeGreaterThan(0);
    }
  });
});

describe('orderByCausalChain', () => {
  it('walks M1 from the weather out at sea to the berths', () => {
    const m = modelFor('M1');
    const ordered = orderByCausalChain(m.impacts, 'M1');
    const ids = ordered.map((i) => i.assetId);
    // The chain is weather → windwave → pilotage → arrivalQueue, whose anchors
    // are ANCH-OUTER → PBG → PBG → ANCH-WAIT: the boarding ground must be
    // presented before the queue it causes.
    const pbg = ids.indexOf('PBG');
    const wait = ids.indexOf('ANCH-WAIT');
    expect(pbg).toBeGreaterThanOrEqual(0);
    if (wait >= 0) expect(pbg).toBeLessThan(wait);
  });

  it('keeps every impact — ordering never drops one', () => {
    for (const s of SCENARIOS) {
      const m = modelFor(s.id);
      expect(orderByCausalChain(m.impacts, s.id)).toHaveLength(m.impacts.length);
    }
  });

  it('passes a free run through unchanged', () => {
    const m = modelFor('M1');
    expect(orderByCausalChain(m.impacts, null)).toEqual(m.impacts);
  });
});

describe('buildShots', () => {
  it('produces one beat per impacted place, with a caption', () => {
    const m = modelFor('M1');
    const shots = buildShots(m, BERTHS, PORT_CENTER);
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.length).toBeLessThanOrEqual(m.impacts.length);
    for (const s of shots) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.subtitle.trim().length).toBeGreaterThan(0);
      expect(s.dwellMs).toBeGreaterThan(0);
    }
  });

  it('never puts two beats in the same place', () => {
    for (const s of SCENARIOS) {
      const shots = buildShots(modelFor(s.id), BERTHS, PORT_CENTER);
      const places = shots.map((x) => `${x.pose.longitude.toFixed(4)},${x.pose.latitude.toFixed(4)}`);
      expect(new Set(places).size, s.id).toBe(places.length);
    }
  });

  it('holds longer on a critical beat', () => {
    const shots = buildShots(modelFor('M1'), BERTHS, PORT_CENTER);
    const crit = shots.find((s) => s.impact.severity === 'critical');
    const other = shots.find((s) => s.impact.severity !== 'critical');
    if (crit && other) expect(crit.dwellMs).toBeGreaterThan(other.dwellMs);
  });

  it('is empty when nothing is impacted', () => {
    const calm = computeImpacts({
      levers: NEUTRAL_LEVERS,
      clockH: 6,
      berths: BERTHS,
      scenarioId: null,
    });
    expect(buildShots(calm, BERTHS, PORT_CENTER)).toEqual([]);
  });
});

describe('easeInOut / lerpPose', () => {
  it('is pinned at both ends and monotonic', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(-2)).toBe(0);
    expect(easeInOut(3)).toBe(1);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const v = easeInOut(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('lands exactly on the destination', () => {
    const a: ViewerPose = { longitude: 72.9, latitude: 18.9, z: 10, heading: 10, tilt: 80 };
    const b: ViewerPose = { longitude: 72.95, latitude: 18.95, z: 120, heading: 200, tilt: 65 };
    const end = lerpPose(a, b, 1);
    expect(end.longitude).toBeCloseTo(b.longitude, 9);
    expect(end.latitude).toBeCloseTo(b.latitude, 9);
    expect(end.z).toBeCloseTo(b.z, 6);
    expect(end.heading).toBeCloseTo(b.heading, 6);
  });

  it('arcs upward through the middle so the camera clears the cranes', () => {
    const a: ViewerPose = { longitude: 72.9, latitude: 18.9, z: 20, heading: 0, tilt: 80 };
    const b: ViewerPose = { longitude: 72.95, latitude: 18.95, z: 20, heading: 0, tilt: 80 };
    expect(lerpPose(a, b, 0.5).z).toBeGreaterThan(60);
  });

  it('turns the short way around the compass', () => {
    const a: ViewerPose = { longitude: 0, latitude: 0, z: 1, heading: 350, tilt: 90 };
    const b: ViewerPose = { longitude: 0, latitude: 0, z: 1, heading: 10, tilt: 90 };
    const mid = lerpPose(a, b, 0.5).heading;
    expect(Math.min(mid, 360 - mid)).toBeLessThan(2);
  });
});

describe('tourFrame', () => {
  const m = modelFor('M1');
  const shots = buildShots(m, BERTHS, PORT_CENTER);
  const from: ViewerPose = {
    longitude: PORT_CENTER[0],
    latitude: PORT_CENTER[1],
    z: 14,
    heading: 0,
    tilt: 90,
  };

  it('returns null with no shots', () => {
    expect(tourFrame([], from, 0)).toBeNull();
  });

  it('starts travelling, then arrives and holds', () => {
    const t0 = tourFrame(shots, from, 0)!;
    expect(t0.index).toBe(0);
    expect(t0.arrived).toBe(false);

    const arrived = tourFrame(shots, from, FLIGHT_MS + 100)!;
    expect(arrived.index).toBe(0);
    expect(arrived.arrived).toBe(true);
  });

  it('advances to the next beat after the dwell', () => {
    if (shots.length < 2) return;
    const t = FLIGHT_MS + shots[0].dwellMs + 50;
    expect(tourFrame(shots, from, t)!.index).toBe(1);
  });

  it('holds the last beat past the end rather than snapping back', () => {
    const past = tourFrame(shots, from, tourDurationMs(shots) + 60_000)!;
    expect(past.index).toBe(shots.length - 1);
    expect(past.arrived).toBe(true);
  });

  it('always yields a legal camera pose across the whole run', () => {
    const total = tourDurationMs(shots);
    for (let t = 0; t <= total; t += 250) {
      const f = tourFrame(shots, from, t)!;
      expect(Number.isFinite(f.pose.longitude)).toBe(true);
      expect(Number.isFinite(f.pose.latitude)).toBe(true);
      expect(f.pose.z).toBeGreaterThan(0);
      expect(f.pose.heading).toBeGreaterThanOrEqual(0);
      expect(f.pose.heading).toBeLessThan(360);
      expect(f.pose.tilt).toBeGreaterThan(0);
      expect(f.pose.tilt).toBeLessThanOrEqual(180);
    }
  });

  it('cuts instead of flying under prefers-reduced-motion', () => {
    const f = tourFrame(shots, from, 10, true)!;
    expect(f.arrived).toBe(true);
    expect(f.pose).toEqual(shots[0].pose);
  });

  it('reports a duration that covers every beat', () => {
    expect(tourDurationMs(shots)).toBe(
      shots.reduce((s, x) => s + FLIGHT_MS + x.dwellMs, 0)
    );
    expect(tourDurationMs(shots)).toBeGreaterThanOrEqual(shots.length * (FLIGHT_MS + DWELL_MS));
  });
});
