/**
 * The 1€ filter itself — the properties `gyroTrack.test.ts` relies on, tested
 * at the level where they are unambiguous.
 */
import { describe, expect, it } from 'vitest';
import {
  alphaFor,
  AngleOneEuro,
  DEFAULT_PREDICT_S,
  HEAD_TRACKING,
  LookFilter,
  motionGate,
  OneEuroFilter,
  PREDICT_CAP_DEG,
  PREDICT_GATE_HI_DPS,
  PREDICT_GATE_LO_DPS,
  shortWay,
  wrap360,
} from './oneEuro';

describe('alphaFor', () => {
  it('is the standard first-order low-pass weight', () => {
    // tau = 1/(2π·1) = 0.159 s; at dt = 0.159 s the weight is exactly a half.
    expect(alphaFor(1, 1 / (2 * Math.PI))).toBeCloseTo(0.5, 9);
  });

  it('rises toward 1 as the sample interval grows', () => {
    // The same cutoff means the same behaviour in TIME, so a longer gap between
    // samples must weight the new sample more. This is the property a fixed
    // blend weight does not have.
    expect(alphaFor(1, 0.5)).toBeGreaterThan(alphaFor(1, 0.016));
    expect(alphaFor(1, 10)).toBeLessThanOrEqual(1);
  });

  it('rises with the cutoff frequency', () => {
    expect(alphaFor(20, 0.016)).toBeGreaterThan(alphaFor(1, 0.016));
  });

  it('survives degenerate inputs rather than dividing by zero', () => {
    expect(Number.isFinite(alphaFor(0, 0.016))).toBe(true);
    expect(Number.isFinite(alphaFor(1, 0))).toBe(true);
  });
});

describe('OneEuroFilter', () => {
  it('passes the first sample through unchanged', () => {
    // A filter that faded in from zero would swing the camera up from the
    // ground on the first reading.
    expect(new OneEuroFilter().filter(42, 1 / 60)).toBe(42);
  });

  it('converges on a constant input', () => {
    const f = new OneEuroFilter();
    f.filter(0, 1 / 60);
    let out = 0;
    for (let i = 0; i < 400; i++) out = f.filter(10, 1 / 60);
    expect(out).toBeCloseTo(10, 3);
  });

  it('smooths harder when the signal is quiet than when it is moving', () => {
    const still = new OneEuroFilter();
    const moving = new OneEuroFilter();
    still.filter(0, 1 / 60);
    moving.filter(0, 1 / 60);
    // Warm both up: one held at zero, one ramping fast.
    for (let i = 1; i < 30; i++) {
      still.filter(0, 1 / 60);
      moving.filter(i * 3, 1 / 60);
    }
    // Now give each the same 1-unit step and see how much of it lands.
    const stillStep = still.filter(1, 1 / 60);
    const movingBefore = moving.filter(29 * 3, 1 / 60);
    const movingStep = moving.filter(29 * 3 + 1, 1 / 60) - movingBefore;
    expect(stillStep).toBeLessThan(movingStep);
  });

  it('exposes the smoothed rate the predictor needs', () => {
    const f = new OneEuroFilter();
    f.filter(0, 1 / 60);
    for (let i = 1; i < 120; i++) f.filter(i * (60 / 60), 1 / 60); // 60 units/s
    expect(f.rate).toBeGreaterThan(40);
    expect(f.rate).toBeLessThan(80);
  });

  it('clamps an absurd dt instead of taking an infinite step', () => {
    const f = new OneEuroFilter();
    f.filter(0, 1 / 60);
    expect(Number.isFinite(f.filter(10, 0))).toBe(true);
    expect(Number.isFinite(f.filter(10, 1e6))).toBe(true);
  });

  it('starts clean after reset', () => {
    const f = new OneEuroFilter();
    for (let i = 0; i < 50; i++) f.filter(0, 1 / 60);
    f.reset();
    expect(f.filter(99, 1 / 60)).toBe(99);
    expect(f.rate).toBe(0);
  });
});

describe('shortWay / wrap360', () => {
  it('takes the short rotation', () => {
    expect(shortWay(10)).toBe(10);
    expect(shortWay(-10)).toBe(-10);
    expect(shortWay(350)).toBe(-10);
    expect(shortWay(-350)).toBe(10);
    expect(shortWay(180)).toBe(180);
    expect(shortWay(720 + 5)).toBeCloseTo(5, 9);
  });

  it('wraps into [0, 360)', () => {
    expect(wrap360(370)).toBe(10);
    expect(wrap360(-10)).toBe(350);
    expect(wrap360(0)).toBe(0);
  });
});

describe('AngleOneEuro', () => {
  it('crosses north without spinning the world', () => {
    const f = new AngleOneEuro();
    f.filter(355, 1 / 60);
    const outs: number[] = [];
    // 355° → 5°, one degree at a time.
    for (let i = 1; i <= 10; i++) outs.push(f.filter(wrap360(355 + i), 1 / 60));
    // Every output stays within a few degrees of the path. A filter working on
    // the wrapped angle would swing back through 180° here.
    for (const o of outs) {
      const err = Math.abs(shortWay(o - 0));
      expect(err).toBeLessThan(12);
    }
  });

  it('tracks a full revolution without accumulating error', () => {
    const f = new AngleOneEuro();
    let out = f.filter(0, 1 / 60);
    for (let deg = 1; deg <= 720; deg++) out = f.filter(wrap360(deg), 1 / 60);
    expect(Math.abs(shortWay(out - 0))).toBeLessThan(3);
  });
});

describe('motionGate', () => {
  it('is shut when the head is only breathing', () => {
    expect(motionGate(0)).toBe(0);
    expect(motionGate(PREDICT_GATE_LO_DPS)).toBe(0);
    expect(motionGate(-PREDICT_GATE_LO_DPS)).toBe(0);
  });

  it('is fully open on a real head turn', () => {
    expect(motionGate(PREDICT_GATE_HI_DPS)).toBe(1);
    expect(motionGate(500)).toBe(1);
    expect(motionGate(-500)).toBe(1);
  });

  it('opens smoothly, so there is no click at the threshold', () => {
    const mid = (PREDICT_GATE_LO_DPS + PREDICT_GATE_HI_DPS) / 2;
    expect(motionGate(mid)).toBeCloseTo(0.5, 6);
    // Zero slope at both ends: no discontinuity in the camera's velocity.
    const eps = 0.01;
    expect(motionGate(PREDICT_GATE_LO_DPS + eps)).toBeLessThan(1e-5);
    expect(1 - motionGate(PREDICT_GATE_HI_DPS - eps)).toBeLessThan(1e-5);
  });

  it('is symmetric — turning left and right feel the same', () => {
    for (const r of [5, 20, 30, 100]) expect(motionGate(r)).toBe(motionGate(-r));
  });
});

describe('LookFilter', () => {
  it('never places the camera further ahead than the cap allows', () => {
    const f = new LookFilter();
    let prevIn = 0;
    let out = f.filter(0, 90, 1 / 60);
    // A 600°/s spin — far faster than a person turns.
    for (let i = 1; i < 60; i++) {
      prevIn = wrap360(i * 10);
      out = f.filter(prevIn, 90, 1 / 60);
    }
    expect(Math.abs(shortWay(out.heading - prevIn))).toBeLessThanOrEqual(PREDICT_CAP_DEG + 1);
  });

  it('keeps tilt inside the camera’s legal range under any input', () => {
    const f = new LookFilter();
    for (const tilt of [0, 0.5, 179.5, 180]) {
      for (let i = 0; i < 40; i++) {
        const out = f.filter(0, tilt, 1 / 60);
        expect(out.tilt).toBeGreaterThanOrEqual(0);
        expect(out.tilt).toBeLessThanOrEqual(180);
      }
      f.reset();
    }
  });

  it('adds no lead at all while the head is still', () => {
    const f = new LookFilter();
    for (let i = 0; i < 200; i++) f.filter(120, 90, 1 / 60);
    const out = f.filter(120, 90, 1 / 60);
    // If prediction leaked through here it would show up as the shimmer the
    // filter exists to remove — it was measured at 3× the residual before the
    // gate was added.
    expect(Math.abs(shortWay(out.heading - 120))).toBeLessThan(0.01);
  });

  it('can have prediction switched off entirely', () => {
    const f = new LookFilter(HEAD_TRACKING, 0);
    let out = f.filter(0, 90, 1 / 60);
    for (let i = 1; i < 60; i++) out = f.filter(i, 90, 1 / 60);
    // With no lead the output must trail the input, never lead it.
    expect(shortWay(out.heading - 59)).toBeLessThan(0);
  });

  it('predicts by about one rendered frame', () => {
    // Sanity check on the constant: enough to cancel the render pipeline's own
    // lag, small enough that a direction reversal cannot swing the world.
    expect(DEFAULT_PREDICT_S).toBeGreaterThan(0.01);
    expect(DEFAULT_PREDICT_S).toBeLessThan(0.05);
  });
});

describe('the tuning', () => {
  it('is a set, not three independent dials', () => {
    // Documented so a future nudge re-runs the sweep instead of guessing.
    expect(HEAD_TRACKING.minCutoffHz).toBeGreaterThan(0);
    expect(HEAD_TRACKING.beta).toBeGreaterThan(0);
    expect(HEAD_TRACKING.dCutoffHz).toBeGreaterThan(0);
    // A minCutoff above ~2 Hz stops removing the sensor's own tremble; a beta
    // above ~0.3 hands it straight back on every noisy sample.
    expect(HEAD_TRACKING.minCutoffHz).toBeLessThan(2);
    expect(HEAD_TRACKING.beta).toBeLessThan(0.3);
  });
});
