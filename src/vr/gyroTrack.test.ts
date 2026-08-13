/**
 * Head-tracking regression — a phone in a cardboard holder, simulated.
 *
 * "The gyro feels odd" is not a testable statement, so this file turns it into
 * two that are:
 *
 *  - **Jitter**: with the head held still, how much does the horizon move?
 *    That is what is felt as shimmer, and it is magnified by the lens.
 *  - **Lag**: during a head turn, how far behind the head is the world? That is
 *    what is felt as swimming, and it is what makes people take the viewer off.
 *
 * Both are measured against the previous fixed-weight filter (`smoothLook`),
 * which is kept for exactly this purpose — a claim that the new tracker is
 * better is worth nothing unless the old one is measured on the same stream.
 *
 * The stream itself is synthetic but not idealised: sensor noise, a variable
 * sample rate, and a scripted head movement, all from a seeded generator so the
 * numbers are the same on every run.
 */
import { describe, expect, it } from 'vitest';
import { HeadTracker } from './headTracking';
import { LookFilter } from './oneEuro';
import { normalizeHeading, orientationToLook, smoothLook } from './stereo';

// ---------------------------------------------------------------------------
// A simulated phone
// ---------------------------------------------------------------------------

/**
 * The `deviceorientation` reading a phone would emit while being looked through
 * at a given compass bearing and elevation.
 *
 * Inverts `orientationToLook` for the `gamma = 0` case — the phone upright in a
 * holder, which is the only case a cardboard viewer produces. With gamma zero
 * the forward axis reduces to `heading = −alpha` and `tilt = beta`, and the
 * round-trip test below proves that rather than asserting it.
 */
function orientationFor(heading: number, tilt: number): { alpha: number; beta: number; gamma: number } {
  return { alpha: normalizeHeading(-heading), beta: tilt, gamma: 0 };
}

/** Deterministic uniform noise — a seeded LCG, so a run never flakes. */
function noiseSource(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 0x1_0000_0000) * 2 - 1; // [-1, 1)
  };
}

interface Sample {
  heading: number;
  tilt: number;
  tMs: number;
}

/**
 * A scripted head movement, sampled at `hz`, with `noiseDeg` of sensor noise
 * applied to the ANGLES (which is where a magnetometer's error actually lands).
 */
function stream(opts: {
  durationS: number;
  hz: number;
  headingAt: (tS: number) => number;
  tiltAt?: (tS: number) => number;
  noiseDeg?: number;
  seed?: number;
}): Sample[] {
  const rand = noiseSource(opts.seed ?? 12345);
  const n = Math.round(opts.durationS * opts.hz);
  const out: Sample[] = [];
  for (let i = 0; i <= n; i++) {
    const tS = i / opts.hz;
    const noise = opts.noiseDeg ?? 0;
    out.push({
      tMs: tS * 1000,
      heading: opts.headingAt(tS) + rand() * noise,
      tilt: (opts.tiltAt?.(tS) ?? 90) + rand() * noise,
    });
  }
  return out;
}

/** Run a stream through the real tracker. */
function runTracker(samples: Sample[], tracker = new HeadTracker()): number[] {
  return samples
    .map((s) => {
      const o = orientationFor(s.heading, s.tilt);
      return tracker.update({ ...o, timeStampMs: s.tMs })?.heading;
    })
    .filter((h): h is number => h != null);
}

/** Run the same stream through the filter this replaced. */
function runLegacy(samples: Sample[], alpha = 0.25): number[] {
  let last: { heading: number; tilt: number } | null = null;
  return samples.map((s) => {
    const o = orientationFor(s.heading, s.tilt);
    const look = orientationToLook(o.alpha, o.beta, o.gamma)!;
    last = smoothLook(last, look, alpha);
    return last.heading;
  });
}

/** Signed error between two compass bearings, degrees. */
function angleError(a: number, b: number): number {
  let d = normalizeHeading(a - b);
  if (d > 180) d -= 360;
  return d;
}

/** RMS of the sample-to-sample change — how much the horizon trembles. */
function rmsStepDeg(headings: number[]): number {
  if (headings.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < headings.length; i++) {
    const d = angleError(headings[i], headings[i - 1]);
    sum += d * d;
  }
  return Math.sqrt(sum / (headings.length - 1));
}

// ---------------------------------------------------------------------------

describe('the simulated phone', () => {
  it('round-trips through orientationToLook, so the rig measures the real path', () => {
    for (const heading of [0, 37, 135, 224.5, 359]) {
      for (const tilt of [35, 90, 140]) {
        const o = orientationFor(heading, tilt);
        const look = orientationToLook(o.alpha, o.beta, o.gamma)!;
        expect(Math.abs(angleError(look.heading, heading))).toBeLessThan(1e-6);
        expect(look.tilt).toBeCloseTo(tilt, 6);
      }
    }
  });
});

describe('jitter — the head held still', () => {
  const STILL = stream({
    durationS: 4,
    hz: 60,
    headingAt: () => 135,
    // 0.6° of noise is what a phone's fused magnetometer/gyro heading actually
    // wanders by at rest; it is the shimmer this filter exists to remove.
    noiseDeg: 0.6,
    seed: 7,
  });

  it('removes essentially all of the sensor tremble', () => {
    const tracked = runTracker(STILL);
    // Skip the acquisition transient — the first reading is passed through by
    // design so the view does not fade in from nowhere.
    const settled = tracked.slice(30);
    expect(rmsStepDeg(settled)).toBeLessThan(0.05);
  });

  it('is steadier than the fixed-weight filter it replaced', () => {
    const now = rmsStepDeg(runTracker(STILL).slice(30));
    const before = rmsStepDeg(runLegacy(STILL).slice(30));
    // Not a marginal improvement: the whole point of an adaptive cutoff is that
    // it can be much heavier at rest than a fixed weight can afford to be,
    // because it gets to open up again the moment the head actually moves.
    // Measured ≈2.8×; asserted at 2× so a tuning nudge does not fail the build
    // for being 2.7×.
    expect(now).toBeLessThan(before / 2);
  });

  it('stays steady on a phone that samples slowly', () => {
    // A budget handset under thermal load may only manage 20 Hz. Each step then
    // covers three times as long, so the per-step bound scales with it — what
    // must not happen is the filter degrading into the raw feed.
    const slow = stream({
      durationS: 4,
      hz: 20,
      headingAt: () => 135,
      noiseDeg: 0.6,
      seed: 7,
    });
    expect(rmsStepDeg(runTracker(slow).slice(10))).toBeLessThan(0.12);
  });

  it('does not drift away from where the head is actually pointing', () => {
    const tracked = runTracker(STILL);
    const settled = tracked.slice(30);
    for (const h of settled) expect(Math.abs(angleError(h, 135))).toBeLessThan(0.5);
  });
});

describe('lag — a head turn', () => {
  /** A 90°/s sweep: brisk, but well short of a snap turn. */
  const sweep = (hz: number) =>
    stream({
      durationS: 2,
      hz,
      headingAt: (t) => 20 + Math.min(1, t) * 90,
      noiseDeg: 0.4,
      seed: 21,
    });

  it('keeps the world within a couple of degrees of the head mid-turn', () => {
    const samples = sweep(60);
    const tracked = runTracker(samples);
    // Sample the middle of the sweep, where the rate is constant and the lag is
    // at its steady-state worst.
    const errors: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      const t = samples[i].tMs / 1000;
      if (t < 0.4 || t > 0.95) continue;
      errors.push(Math.abs(angleError(tracked[i], 20 + t * 90)));
    }
    const worst = Math.max(...errors);
    expect(worst).toBeLessThan(2.5);
  });

  it('lands on the target once the head stops', () => {
    const samples = sweep(60);
    const tracked = runTracker(samples);
    expect(Math.abs(angleError(tracked[tracked.length - 1], 110))).toBeLessThan(0.6);
  });

  it('does not overshoot when the head stops — prediction is capped for this reason', () => {
    const samples = sweep(60);
    const tracked = runTracker(samples);
    // Anything past ~113° would be the predictor throwing the camera beyond
    // where the head went, which reads far worse than the lag it removes.
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].tMs / 1000 < 1) continue;
      expect(angleError(tracked[i], 110)).toBeLessThan(3.5);
    }
  });

  it('behaves the same at 20 Hz as at 60 Hz — the phone gets to choose its rate', () => {
    const at = (hz: number) => {
      const samples = sweep(hz);
      const tracked = runTracker(samples);
      const i = samples.findIndex((s) => s.tMs >= 800);
      return angleError(tracked[i], 20 + (samples[i].tMs / 1000) * 90);
    };
    // Same physical motion, three sample rates, same amount of lag: that is the
    // property a fixed blend weight cannot have, and it is why tracking used to
    // feel different on different handsets and different from second to second
    // on one handset under thermal throttling.
    const fast = at(60);
    const mid = at(30);
    const slow = at(20);
    expect(Math.abs(fast - mid)).toBeLessThan(1);
    expect(Math.abs(fast - slow)).toBeLessThan(1.5);
  });

  it('is what the fixed-weight filter could NOT do', () => {
    const legacyAt = (hz: number) => {
      const samples = sweep(hz);
      const tracked = runLegacy(samples);
      const i = samples.findIndex((s) => s.tMs >= 800);
      return Math.abs(angleError(tracked[i], 20 + (samples[i].tMs / 1000) * 90));
    };
    // The old filter's lag scales with the sample interval, so the same head
    // turn trailed by several times as much on a slow-sampling phone.
    expect(legacyAt(20)).toBeGreaterThan(legacyAt(60) * 2);
  });
});

describe('compass wrap', () => {
  it('turns the short way through north instead of spinning the world', () => {
    const samples = stream({
      durationS: 1.2,
      hz: 60,
      // 340° → 20°, straight through 0.
      headingAt: (t) => normalizeHeading(340 + Math.min(1, t) * 40),
      noiseDeg: 0.3,
      seed: 99,
    });
    const tracked = runTracker(samples);
    for (let i = 0; i < samples.length; i++) {
      const want = normalizeHeading(340 + Math.min(1, samples[i].tMs / 1000) * 40);
      // Never more than a few degrees off the intended path — a long-way-round
      // filter would swing through 180° here.
      expect(Math.abs(angleError(tracked[i], want))).toBeLessThan(4);
    }
  });
});

describe('robustness', () => {
  it('keeps the last pose when a reading is incomplete', () => {
    const tracker = new HeadTracker();
    expect(tracker.update({ alpha: null, beta: 90, gamma: 0, timeStampMs: 0 })).toBeNull();
    expect(tracker.update({ alpha: 10, beta: null, gamma: 0, timeStampMs: 16 })).toBeNull();
    expect(tracker.update({ alpha: Number.NaN, beta: 90, gamma: 0, timeStampMs: 32 })).toBeNull();
  });

  it('prefers the iOS compass heading over the derived one', () => {
    const tracker = new HeadTracker();
    const o = orientationFor(10, 90);
    const out = tracker.update({ ...o, compassHeading: 200, timeStampMs: 0 })!;
    expect(out.heading).toBeCloseTo(200, 3);
  });

  it('re-acquires cleanly after the sensor stalls rather than integrating the gap', () => {
    const tracker = new HeadTracker();
    // Settle at 90°.
    for (let i = 0; i < 60; i++) {
      tracker.update({ ...orientationFor(90, 90), timeStampMs: i * 16.7 });
    }
    // Two seconds of nothing (backgrounded tab, sensor throttled), then the head
    // is somewhere completely different.
    const after = tracker.update({ ...orientationFor(270, 90), timeStampMs: 3000 })!;
    // A filter that carried the 2 s dt through would take a single enormous step
    // and either snap or ring; re-acquiring puts us straight on the new bearing.
    expect(Math.abs(angleError(after.heading, 270))).toBeLessThan(1);
  });

  it('survives a nonsensical timestamp without producing NaN', () => {
    const tracker = new HeadTracker();
    const a = tracker.update({ ...orientationFor(45, 90), timeStampMs: Number.NaN })!;
    const b = tracker.update({ ...orientationFor(46, 90), timeStampMs: Number.NaN })!;
    expect(Number.isFinite(a.heading)).toBe(true);
    expect(Number.isFinite(b.heading)).toBe(true);
  });

  it('never emits a tilt outside the camera’s legal range', () => {
    const tracker = new HeadTracker();
    for (const tilt of [1, 5, 90, 175, 179]) {
      for (let i = 0; i < 20; i++) {
        const out = tracker.update({ ...orientationFor(0, tilt), timeStampMs: i * 16.7 })!;
        expect(out.tilt).toBeGreaterThanOrEqual(0);
        expect(out.tilt).toBeLessThanOrEqual(180);
      }
      tracker.reset();
    }
  });

  it('resets to a clean acquire', () => {
    const tracker = new HeadTracker(new LookFilter());
    for (let i = 0; i < 40; i++) {
      tracker.update({ ...orientationFor(0, 90), timeStampMs: i * 16.7 });
    }
    tracker.reset();
    const first = tracker.update({ ...orientationFor(180, 90), timeStampMs: 0 })!;
    expect(Math.abs(angleError(first.heading, 180))).toBeLessThan(1);
  });
});
