import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IPD_M,
  bearingTo,
  clampTilt,
  eyeCameras,
  groundDistanceM,
  normalizeHeading,
  offsetByBearing,
  orientationToLook,
  smoothLook,
  walk,
  type ViewerPose,
} from './stereo';

const POSE: ViewerPose = {
  longitude: 72.945,
  latitude: 18.945,
  z: 1.7,
  heading: 0,
  tilt: 90,
};

describe('normalizeHeading / clampTilt', () => {
  it('wraps into [0,360)', () => {
    expect(normalizeHeading(0)).toBe(0);
    expect(normalizeHeading(360)).toBe(0);
    expect(normalizeHeading(-90)).toBe(270);
    expect(normalizeHeading(450)).toBe(90);
  });

  it('clamps tilt to the ArcGIS legal range', () => {
    expect(clampTilt(-10)).toBe(0);
    expect(clampTilt(90)).toBe(90);
    expect(clampTilt(200)).toBe(180);
  });
});

describe('offsetByBearing', () => {
  it('moves north for bearing 0 and east for bearing 90', () => {
    const north = offsetByBearing(72.945, 18.945, 0, 1000);
    expect(north.latitude).toBeGreaterThan(18.945);
    expect(north.longitude).toBeCloseTo(72.945, 9);

    const east = offsetByBearing(72.945, 18.945, 90, 1000);
    expect(east.longitude).toBeGreaterThan(72.945);
    expect(east.latitude).toBeCloseTo(18.945, 9);
  });

  it('round-trips a there-and-back offset to within a centimetre', () => {
    // The longitude scale is recomputed at each point's own latitude, so a
    // 500 m round trip leaves a few millimetres of flat-earth residue. That is
    // four orders of magnitude below the IPD this module actually has to
    // resolve, so a centimetre bound is the honest assertion here.
    const there = offsetByBearing(72.945, 18.945, 37, 500);
    const back = offsetByBearing(there.longitude, there.latitude, 217, 500);
    expect(groundDistanceM(72.945, 18.945, back.longitude, back.latitude)).toBeLessThan(0.01);
  });
});

describe('eyeCameras', () => {
  it('separates the eyes by exactly the IPD, perpendicular to the look', () => {
    const { left, right } = eyeCameras(POSE, DEFAULT_IPD_M);
    const d = groundDistanceM(
      left.position.longitude,
      left.position.latitude,
      right.position.longitude,
      right.position.latitude
    );
    expect(d).toBeCloseTo(DEFAULT_IPD_M, 6);
  });

  it('puts the right eye east when facing north', () => {
    const { left, right } = eyeCameras(POSE);
    expect(right.position.longitude).toBeGreaterThan(left.position.longitude);
    // Facing north, the eye line is east-west: latitudes stay equal.
    expect(right.position.latitude).toBeCloseTo(left.position.latitude, 12);
  });

  it('rotates the eye line with the heading', () => {
    const { left, right } = eyeCameras({ ...POSE, heading: 90 });
    // Facing east, the eye line runs north-south.
    expect(right.position.latitude).toBeLessThan(left.position.latitude);
    expect(right.position.longitude).toBeCloseTo(left.position.longitude, 12);
  });

  it('keeps both eyes on the same heading, tilt and altitude (parallel projection)', () => {
    const { left, right } = eyeCameras({ ...POSE, heading: 208, tilt: 75 });
    expect(left.heading).toBe(right.heading);
    expect(left.tilt).toBe(right.tilt);
    expect(left.position.z).toBe(right.position.z);
    expect(left.heading).toBe(208);
    expect(left.tilt).toBe(75);
  });

  it('normalises an out-of-range pose', () => {
    const { left } = eyeCameras({ ...POSE, heading: -30, tilt: 400 });
    expect(left.heading).toBe(330);
    expect(left.tilt).toBe(180);
  });
});

describe('orientationToLook', () => {
  it('returns null for an incomplete reading', () => {
    expect(orientationToLook(null, 0, 0)).toBeNull();
    expect(orientationToLook(0, null, 0)).toBeNull();
    expect(orientationToLook(0, 0, null)).toBeNull();
    expect(orientationToLook(Number.NaN, 0, 0)).toBeNull();
  });

  it('reads a flat, face-up phone as looking straight down', () => {
    // beta=0, gamma=0 → device -Z points at the ground.
    const look = orientationToLook(0, 0, 0);
    expect(look).not.toBeNull();
    expect(look!.tilt).toBeCloseTo(0, 5);
  });

  it('reads an upright phone as looking at the horizon', () => {
    // Tipped up 90° about X → the screen faces the user, -Z points forward.
    const look = orientationToLook(0, 90, 0);
    expect(look!.tilt).toBeCloseTo(90, 5);
    expect(look!.heading).toBeCloseTo(0, 5);
  });

  it('turns the heading with alpha', () => {
    const look = orientationToLook(90, 90, 0);
    // alpha rotates the device counter-clockwise about the vertical, which is a
    // clockwise change in compass heading.
    expect(look!.tilt).toBeCloseTo(90, 5);
    expect(look!.heading).toBeCloseTo(270, 5);
  });

  it('always produces a legal ArcGIS camera orientation', () => {
    for (let a = 0; a < 360; a += 37) {
      for (let b = -180; b <= 180; b += 41) {
        for (let g = -90; g <= 90; g += 23) {
          const look = orientationToLook(a, b, g)!;
          expect(look.heading).toBeGreaterThanOrEqual(0);
          expect(look.heading).toBeLessThan(360);
          expect(look.tilt).toBeGreaterThanOrEqual(0);
          expect(look.tilt).toBeLessThanOrEqual(180);
        }
      }
    }
  });
});

describe('smoothLook', () => {
  it('passes the first reading through unchanged', () => {
    const next = { heading: 100, tilt: 80 };
    expect(smoothLook(null, next)).toEqual(next);
  });

  it('blends toward the new reading', () => {
    const out = smoothLook({ heading: 0, tilt: 90 }, { heading: 100, tilt: 50 }, 0.5);
    expect(out.heading).toBeCloseTo(50, 6);
    expect(out.tilt).toBeCloseTo(70, 6);
  });

  it('takes the short way around the compass', () => {
    // 350° → 10° must pass through 0°, not sweep backwards through 180°.
    const out = smoothLook({ heading: 350, tilt: 90 }, { heading: 10, tilt: 90 }, 0.5);
    expect(out.heading).toBeCloseTo(0, 6);
  });
});

describe('walk', () => {
  it('moves along the heading', () => {
    const next = walk({ ...POSE, heading: 90 }, 100, 0);
    expect(next.longitude).toBeGreaterThan(POSE.longitude);
    expect(
      groundDistanceM(POSE.longitude, POSE.latitude, next.longitude, next.latitude)
    ).toBeCloseTo(100, 3);
  });

  it('strafes perpendicular to the heading', () => {
    const next = walk({ ...POSE, heading: 0 }, 0, 50);
    expect(next.longitude).toBeGreaterThan(POSE.longitude);
    expect(
      groundDistanceM(POSE.longitude, POSE.latitude, next.longitude, next.latitude)
    ).toBeCloseTo(50, 3);
  });
});

describe('bearingTo / groundDistanceM', () => {
  it('reports north as 0 and east as 90', () => {
    const n = offsetByBearing(72.945, 18.945, 0, 500);
    expect(bearingTo(72.945, 18.945, n.longitude, n.latitude)).toBeCloseTo(0, 3);
    const e = offsetByBearing(72.945, 18.945, 90, 500);
    expect(bearingTo(72.945, 18.945, e.longitude, e.latitude)).toBeCloseTo(90, 3);
  });

  it('is zero for coincident points', () => {
    expect(groundDistanceM(72.945, 18.945, 72.945, 18.945)).toBe(0);
    expect(bearingTo(72.945, 18.945, 72.945, 18.945)).toBe(0);
  });
});

describe('eyeCameras — field of view', () => {
  it('leaves the camera’s own FOV alone when none is asked for', () => {
    const { left, right } = eyeCameras(POSE);
    expect(left.fov).toBeUndefined();
    expect(right.fov).toBeUndefined();
  });

  it('gives BOTH eyes the same field of view', () => {
    const { left, right } = eyeCameras(POSE, DEFAULT_IPD_M, 97);
    // A mismatch here is not a subtle rendering difference — it is two
    // different projections of one scene, which the brain cannot fuse.
    expect(left.fov).toBe(97);
    expect(right.fov).toBe(97);
  });

  it('ignores a nonsense value rather than blanking the projection', () => {
    const { left } = eyeCameras(POSE, DEFAULT_IPD_M, Number.NaN);
    expect(left.fov).toBeUndefined();
  });
});
