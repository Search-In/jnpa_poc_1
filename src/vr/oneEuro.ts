/**
 * 1€ filter — adaptive smoothing for the head tracker.
 *
 * WHY NOT A PLAIN EXPONENTIAL FILTER. `smoothLook` blended the new reading in at
 * a FIXED weight. That forces a single compromise across two opposite
 * requirements, and it cannot satisfy both:
 *
 *  - **At rest** the sensor is noisy (±0.3–0.8° of white noise on a phone
 *    magnetometer/gyro fusion). A light filter leaves the horizon visibly
 *    trembling — through a cardboard lens, magnified, that is the "odd looking"
 *    shimmer.
 *  - **While turning your head** any filter is pure latency. A heavy filter
 *    makes the world lag behind the head, which is the single most reliable way
 *    to make someone motion-sick in a viewer.
 *
 * A fixed weight is also **rate-dependent**: `deviceorientation` fires anywhere
 * between 15 Hz and 60 Hz depending on the handset, the battery saver and how
 * busy the main thread is — so the same alpha produced a different amount of
 * smoothing on every device, and a *different* amount from second to second on
 * one device as the frame rate moved. That is why the tracking felt inconsistent.
 *
 * The 1€ filter (Casiez, Roussel & Vogel, CHI 2012) solves exactly this: it
 * estimates the signal's speed and widens its own cutoff frequency with it. Slow
 * or still → low cutoff → heavy smoothing → no jitter. Fast head turn → high
 * cutoff → almost no smoothing → no lag. And because the cutoff is expressed in
 * Hz and converted with the MEASURED `dt`, the behaviour is identical at 15 Hz
 * and at 60 Hz.
 *
 * Pure and dependency-free so the tracking can be regression-tested against a
 * synthetic gyro stream without a phone in the room (`oneEuro.test.ts`,
 * `gyroTrack.test.ts`).
 */

/** One first-order low-pass stage. */
class LowPass {
  private y: number | null = null;

  /** The last output — the "previous value" the 1€ derivative needs. */
  get last(): number | null {
    return this.y;
  }

  filter(x: number, alpha: number): number {
    this.y = this.y == null ? x : alpha * x + (1 - alpha) * this.y;
    return this.y;
  }

  reset(): void {
    this.y = null;
  }
}

/** Tuning for a 1€ filter, in the paper's own units. */
export interface OneEuroConfig {
  /**
   * Cutoff frequency at zero speed, Hz. Lower = steadier when you hold still.
   * This is the dial that removes sensor jitter.
   */
  minCutoffHz: number;
  /**
   * Speed coefficient. Higher = the filter opens up sooner as the head turns,
   * i.e. less lag while moving. This is the dial that removes latency.
   */
  beta: number;
  /** Cutoff of the derivative's own filter, Hz. The paper's default of 1 is fine. */
  dCutoffHz: number;
}

/**
 * Head-tracking tuning, picked by sweeping the parameter space against the
 * synthetic phone in `gyroTrack.test.ts` rather than by taste.
 *
 * Measured at this setting, on a stream with 0.6° of sensor noise:
 *
 *   residual jitter, head still   0.035°   (the previous filter: 0.097°)
 *   lag at 90°/s, sampling 60 Hz  1.13°
 *   lag at 90°/s, sampling 20 Hz  1.08°
 *   lag at 25°/s, sampling 60 Hz  1.29°
 *
 * Two properties matter more than any single number. The lag is nearly the same
 * at every sample rate — so tracking feels identical on a fast phone and a
 * throttled one, which a fixed blend weight can never manage. And it is nearly
 * the same at every head speed, so the world does not appear to change its
 * "weight" as you turn.
 *
 * The three numbers trade against each other and are only meaningful together:
 * raising `beta` alone buys speed and hands back the shimmer, lowering
 * `dCutoffHz` alone quietens the rate estimate and slows the adaptation. Re-run
 * the sweep rather than nudging one.
 */
export const HEAD_TRACKING: OneEuroConfig = {
  minCutoffHz: 0.8,
  beta: 0.12,
  dCutoffHz: 0.6,
};

/** Smoothing weight for a first-order low pass with cutoff `c` Hz over `dt` s. */
export function alphaFor(cutoffHz: number, dtS: number): number {
  const tau = 1 / (2 * Math.PI * Math.max(1e-6, cutoffHz));
  return 1 / (1 + tau / Math.max(1e-6, dtS));
}

/**
 * Scalar 1€ filter. `filter(value, dtS)` — `dtS` is the interval since the
 * previous sample, measured, not assumed.
 */
export class OneEuroFilter {
  private readonly x = new LowPass();
  private readonly dx = new LowPass();
  private prev: number | null = null;
  private smoothRate = 0;

  constructor(private readonly cfg: OneEuroConfig = HEAD_TRACKING) {}

  /**
   * The smoothed rate of change, units per second. Exposed because it is
   * already computed here and it is exactly what forward prediction needs —
   * re-deriving it outside would mean differencing the FILTERED signal, which
   * is both lagged and noisier.
   */
  get rate(): number {
    return this.smoothRate;
  }

  filter(value: number, dtS: number): number {
    const dt = Math.max(1e-3, Math.min(0.5, dtS));
    // Speed estimate, itself low-passed so a single noisy sample cannot punch
    // the cutoff wide open and let the jitter straight through.
    const rate = this.prev == null ? 0 : (value - this.prev) / dt;
    this.prev = value;
    this.smoothRate = this.dx.filter(rate, alphaFor(this.cfg.dCutoffHz, dt));
    const cutoff = this.cfg.minCutoffHz + this.cfg.beta * Math.abs(this.smoothRate);
    return this.x.filter(value, alphaFor(cutoff, dt));
  }

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.prev = null;
    this.smoothRate = 0;
  }
}

/**
 * 1€ filter for a compass angle.
 *
 * Filtering a heading directly is wrong at the wrap point: 359° → 1° is a 2°
 * head movement but a −358° arithmetic step, and a filter fed that will spin the
 * whole world backwards. So the angle is UNWRAPPED first — each sample is
 * accumulated as the short-way delta from the previous one, producing a
 * continuous signal with no discontinuity — filtered on that continuous line,
 * and only wrapped back to [0, 360) on the way out.
 */
export class AngleOneEuro {
  private readonly inner: OneEuroFilter;
  /** Continuous (unwrapped) input angle — may run far outside [0, 360). */
  private unwrapped: number | null = null;

  constructor(cfg: OneEuroConfig = HEAD_TRACKING) {
    this.inner = new OneEuroFilter(cfg);
  }

  /** Smoothed angular rate, degrees per second (signed, unwrapped). */
  get rate(): number {
    return this.inner.rate;
  }

  filter(angleDeg: number, dtS: number): number {
    if (this.unwrapped == null) {
      this.unwrapped = angleDeg;
    } else {
      this.unwrapped += shortWay(angleDeg - this.unwrapped);
    }
    return wrap360(this.inner.filter(this.unwrapped, dtS));
  }

  reset(): void {
    this.inner.reset();
    this.unwrapped = null;
  }
}

/** Shortest signed rotation, degrees, in (−180, 180]. */
export function shortWay(deltaDeg: number): number {
  let d = ((deltaDeg % 360) + 360) % 360;
  if (d > 180) d -= 360;
  return d;
}

/** Wrap to [0, 360). */
export function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * A filtered look direction: an angle filter for heading (wrap-aware) and a
 * plain one for tilt (which is bounded and never wraps).
 */
export class LookFilter {
  private readonly heading: AngleOneEuro;
  private readonly tilt: OneEuroFilter;

  constructor(
    cfg: OneEuroConfig = HEAD_TRACKING,
    /**
     * Forward prediction, seconds. The pose written this frame is not on screen
     * until the renderer has drawn it, so a tracker that reports exactly where
     * the head WAS always shows a world that trails the head. Extrapolating by
     * roughly one frame cancels that.
     *
     * Deliberately small and hard-capped (`PREDICT_CAP_DEG`): over-prediction
     * overshoots on every direction reversal, which is a worse artefact than
     * the lag it removes.
     */
    private readonly predictS: number = DEFAULT_PREDICT_S
  ) {
    this.heading = new AngleOneEuro(cfg);
    this.tilt = new OneEuroFilter(cfg);
  }

  filter(heading: number, tilt: number, dtS: number): { heading: number; tilt: number } {
    const h = this.heading.filter(heading, dtS);
    const t = this.tilt.filter(tilt, dtS);
    return {
      heading: wrap360(h + this.lead(this.heading.rate)),
      tilt: Math.min(180, Math.max(0, t + this.lead(this.tilt.rate))),
    };
  }

  reset(): void {
    this.heading.reset();
    this.tilt.reset();
  }

  /** How far ahead of the filtered value to place the camera, degrees. */
  private lead(rateDegPerS: number): number {
    const step = rateDegPerS * this.predictS * motionGate(rateDegPerS);
    return Math.min(PREDICT_CAP_DEG, Math.max(-PREDICT_CAP_DEG, step));
  }
}

/** One frame at 40 Hz — the middle of the range the scene actually renders at. */
export const DEFAULT_PREDICT_S = 0.025;

/** Hard limit on how far ahead of the sensor the camera may be placed, degrees. */
export const PREDICT_CAP_DEG = 4;

/**
 * Below this rate the head is not really turning, it is the sensor breathing.
 * Predicting on that noise puts the jitter straight back in — measured at three
 * times the residual tremble of no prediction at all, which is exactly the
 * shimmer the filter was there to remove.
 */
export const PREDICT_GATE_LO_DPS = 12;

/** At and above this rate the head is unambiguously turning: predict in full. */
export const PREDICT_GATE_HI_DPS = 45;

/**
 * Fade the predictor in with speed. A hard threshold would step the camera by
 * the whole prediction the moment the rate crossed it, which is visible as a
 * click at the start and end of every head turn; a smooth ramp is not.
 */
export function motionGate(rateDegPerS: number): number {
  const x =
    (Math.abs(rateDegPerS) - PREDICT_GATE_LO_DPS) / (PREDICT_GATE_HI_DPS - PREDICT_GATE_LO_DPS);
  const c = Math.min(1, Math.max(0, x));
  // Smoothstep: zero slope at both ends, so there is no discontinuity in the
  // camera's velocity where the gate opens or closes.
  return c * c * (3 - 2 * c);
}
