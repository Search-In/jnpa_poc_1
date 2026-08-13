/**
 * Device capability probes for the walkthrough.
 *
 * The immersive view is the heaviest thing in the app, and in stereo it renders
 * the whole port TWICE. A demo laptop absorbs that; a phone does not. These
 * probes let the scene pick a budget instead of shipping desktop settings to a
 * handset and calling the result "laggy".
 *
 * Deliberately capability-based (pointer type, memory, core count, the Network
 * Information API) rather than user-agent sniffing, which is both unreliable and
 * ages badly.
 *
 * These are the thin live-reading wrappers. Everything that turns a reading into
 * a DECISION — quality, render scale, which layers, which tile services, field
 * of view — lives in `sceneBudget.ts`, where it is a pure function and can be
 * tested against a simulated handset on a simulated 3G link.
 */
import {
  isLowPowerProfile,
  readDeviceProfile,
  sceneBudget,
  type NetworkClass,
} from './sceneBudget';

/** A touch-first device: phone or tablet, i.e. the cardboard case. */
export function isCoarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

/**
 * True when the device looks weak enough that stereo needs the lowest settings:
 * a coarse pointer plus few cores or little memory. `deviceMemory` and
 * `hardwareConcurrency` are both optional, so absence never forces the low path
 * on a machine that might cope.
 */
export function isLowPowerDevice(): boolean {
  return isLowPowerProfile(readDeviceProfile());
}

/** How much bandwidth the link looks like it has right now. */
export function networkClass(): NetworkClass {
  return readDeviceProfile().network;
}

/**
 * Fraction of the eye box's pixels to actually render, upscaled by CSS to fill
 * it — the "render scale" every game exposes.
 *
 * A phone at devicePixelRatio 3 asks for nine device pixels per CSS pixel, and
 * stereo asks for two of those buffers. Rendering at 60% linear is 36% of the
 * pixels: the single biggest lever available, and through a cardboard lens
 * (which is itself soft and magnified) the softening is close to invisible.
 */
export function renderScale(stereo: boolean): number {
  return sceneBudget(readDeviceProfile(), stereo).renderScale;
}

/** Frames per second the scene animator should target on this device. */
export function animationHz(stereo: boolean): number {
  return sceneBudget(readDeviceProfile(), stereo).animationHz;
}

/** The full budget for the current device, for the scene to build against. */
export function currentBudget(
  stereo: boolean,
  opts: { headTracked?: boolean; eyeBox?: { width: number; height: number } } = {}
): ReturnType<typeof sceneBudget> {
  return sceneBudget(readDeviceProfile(), stereo, opts);
}
