/**
 * The head tracker, as a plain object with no React and no browser events.
 *
 * `useGyro` used to do the sensor maths inline, which meant the only way to find
 * out whether look-around felt right was to put a phone in a viewer and turn
 * your head. Pulling the pipeline out here makes it drivable from a synthetic
 * stream — a scripted head turn plus measured sensor noise — so "smooth" becomes
 * a number in a test rather than an opinion (`gyroTrack.test.ts`).
 *
 * The pipeline is:
 *
 *   raw (alpha, beta, gamma)  →  look direction (heading, tilt)
 *                             →  1€ filter on a MEASURED dt
 *                             →  one-frame forward prediction
 *
 * Two things it deliberately does NOT do:
 *
 *  - **Compensate for screen orientation.** The look direction is the screen's
 *    normal, and rotating the phone about that normal (portrait ↔ landscape)
 *    leaves it unchanged. It only affects roll, which `SceneView.camera` cannot
 *    express anyway.
 *  - **Assume a sample rate.** `deviceorientation` fires anywhere from 15 Hz to
 *    60 Hz depending on handset, thermal state and how busy the main thread is.
 *    Every interval is measured from the event's own timestamp, so the amount of
 *    smoothing is a property of TIME, not of how many events happened to arrive.
 */
import { LookFilter } from './oneEuro';
import { normalizeHeading, orientationToLook } from './stereo';

/** One `deviceorientation` reading, reduced to what the tracker needs. */
export interface RawOrientation {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
  /** iOS `webkitCompassHeading` — true north, which `alpha` does not carry. */
  compassHeading?: number | null;
  /** `event.timeStamp`, milliseconds. */
  timeStampMs: number;
}

export interface Look {
  heading: number;
  tilt: number;
}

/**
 * Longest gap that is still treated as continuous motion, seconds. A bigger gap
 * means the feed stalled (backgrounded tab, sensor throttled); carrying the
 * measured dt through the filter would then apply a single enormous step and
 * snap the world. Restarting the filter instead makes the resumption a clean
 * re-acquire.
 */
const MAX_GAP_S = 0.4;

/** Assumed interval for the first sample, and for a nonsensical timestamp. */
const NOMINAL_DT_S = 1 / 60;

export class HeadTracker {
  private readonly filter: LookFilter;
  private lastTsMs: number | null = null;

  constructor(filter: LookFilter = new LookFilter()) {
    this.filter = filter;
  }

  /**
   * Feed one reading. Returns the pose to look from, or `null` when the reading
   * is incomplete — iOS emits nulls before motion permission is granted, and the
   * caller must keep the last good pose rather than snapping to zero.
   */
  update(r: RawOrientation): Look | null {
    const look = orientationToLook(r.alpha, r.beta, r.gamma);
    if (!look) return null;

    // iOS: prefer the real compass over the derived alpha, which is not
    // referenced to north there at all.
    const heading =
      r.compassHeading != null && Number.isFinite(r.compassHeading)
        ? normalizeHeading(r.compassHeading)
        : look.heading;

    const dt = this.step(r.timeStampMs);
    return this.filter.filter(heading, look.tilt, dt);
  }

  /** Drop the filter state — used when tracking stops or the feed stalls. */
  reset(): void {
    this.filter.reset();
    this.lastTsMs = null;
  }

  /** Seconds since the previous reading, with the stall case handled. */
  private step(tsMs: number): number {
    const ts = Number.isFinite(tsMs) ? tsMs : null;
    if (ts == null || this.lastTsMs == null) {
      this.lastTsMs = ts;
      return NOMINAL_DT_S;
    }
    const dt = (ts - this.lastTsMs) / 1000;
    this.lastTsMs = ts;
    if (!(dt > 0)) return NOMINAL_DT_S;
    if (dt > MAX_GAP_S) {
      // The feed stalled. Re-acquire rather than integrate the gap.
      this.filter.reset();
      return NOMINAL_DT_S;
    }
    return dt;
  }
}
