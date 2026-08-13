/**
 * The local scene frame, and the two rotation conventions that live either side
 * of it. Both of these have already caused visible bugs, so they are pinned.
 */
import { describe, expect, it } from 'vitest';
import { PORT_CENTER, TERMINAL_QUAYS, offsetMeters } from '@/map/portGeometry';
import {
  distanceM,
  headingToDirection,
  headingToYaw,
  headingToYawAlongX,
  M_PER_DEG_LAT,
  ORIGIN,
  toGeodetic,
  toLocal,
} from './geo';

describe('toLocal / toGeodetic', () => {
  it('puts the port centre at the origin', () => {
    const p = toLocal(PORT_CENTER[0], PORT_CENTER[1]);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.z).toBeCloseTo(0, 6);
    expect(p.y).toBe(0);
  });

  it('round-trips to millimetre accuracy', () => {
    for (const [lng, lat] of [
      [72.9, 18.9],
      [73.0, 19.0],
      [72.87, 18.88],
    ] as const) {
      const p = toLocal(lng, lat);
      const back = toGeodetic(p.x, p.z);
      // 1e-8° is about a millimetre at this latitude.
      expect(back.longitude).toBeCloseTo(lng, 8);
      expect(back.latitude).toBeCloseTo(lat, 8);
    }
  });

  it('is Y-up with −Z north, which is what three.js expects', () => {
    // A point one degree of latitude NORTH must land at negative z.
    const north = toLocal(ORIGIN[0], ORIGIN[1] + 1);
    expect(north.z).toBeCloseTo(-M_PER_DEG_LAT, 0);
    expect(north.x).toBeCloseTo(0, 6);
    // A point east must land at positive x.
    expect(toLocal(ORIGIN[0] + 0.01, ORIGIN[1]).x).toBeGreaterThan(0);
  });

  it('carries elevation straight through as y', () => {
    expect(toLocal(ORIGIN[0], ORIGIN[1], 42).y).toBe(42);
  });

  it('agrees with the surveyed geometry’s own metric offsets', () => {
    // `offsetMeters` is what the rest of the app uses to move a point a known
    // number of metres. The local frame has to measure the same distance, or the
    // WebGL port would be a different size from the Esri one.
    const q = TERMINAL_QUAYS.GTI;
    const moved = offsetMeters(q.mid, q.landward, 500);
    const a = toLocal(q.mid[0], q.mid[1]);
    const b = toLocal(moved[0], moved[1]);
    expect(distanceM(a, b)).toBeCloseTo(500, 0);
  });
});

describe('headingToDirection', () => {
  it('points north at 0° and east at 90°', () => {
    const n = headingToDirection(0);
    expect(n.x).toBeCloseTo(0, 9);
    expect(n.z).toBeCloseTo(-1, 9);
    const e = headingToDirection(90);
    expect(e.x).toBeCloseTo(1, 9);
    expect(e.z).toBeCloseTo(0, 9);
  });

  it('is a unit vector at every bearing', () => {
    for (let b = 0; b < 360; b += 17) {
      const d = headingToDirection(b);
      expect(Math.hypot(d.x, d.z)).toBeCloseTo(1, 9);
    }
  });
});

describe('the two rotation conventions', () => {
  /** Rotate (x, z) about +Y by θ, the way three.js does. */
  const rotY = (x: number, z: number, theta: number) => ({
    x: x * Math.cos(theta) + z * Math.sin(theta),
    z: -x * Math.sin(theta) + z * Math.cos(theta),
  });

  it('headingToYaw turns a −Z-facing MODEL to the bearing', () => {
    // glTF assets here are authored facing −Z.
    for (const bearing of [0, 37, 90, 208, 315]) {
      const r = rotY(0, -1, headingToYaw(bearing));
      const want = headingToDirection(bearing);
      expect(r.x).toBeCloseTo(want.x, 9);
      expect(r.z).toBeCloseTo(want.z, 9);
    }
  });

  it('headingToYawAlongX turns a +X-LONG box to the bearing', () => {
    // A quay is a BoxGeometry(length, height, depth): its long axis is +X.
    for (const bearing of [0, 37, 90, 208, 315]) {
      const r = rotY(1, 0, headingToYawAlongX(bearing));
      const want = headingToDirection(bearing);
      expect(r.x).toBeCloseTo(want.x, 9);
      expect(r.z).toBeCloseTo(want.z, 9);
    }
  });

  it('differs from the model convention by exactly a quarter turn', () => {
    // Using the wrong one laid every quay across the water at right angles to
    // where it belongs. They are not interchangeable and the difference is
    // constant, so it is asserted rather than left to be rediscovered.
    for (const bearing of [0, 37, 208]) {
      const delta = headingToYawAlongX(bearing) - headingToYaw(bearing);
      expect(delta).toBeCloseTo(Math.PI / 2, 9);
    }
  });
});

describe('distanceM', () => {
  it('measures on the ground, ignoring height', () => {
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 300, y: 900, z: 400 };
    expect(distanceM(a, b)).toBeCloseTo(500, 6);
  });
});
