/**
 * Device capability probes for the walkthrough.
 *
 * The immersive view is the heaviest thing in the app, and in stereo it renders
 * the whole port TWICE. A demo laptop absorbs that; a phone does not. These
 * probes let the scene pick a budget instead of shipping desktop settings to a
 * handset and calling the result "laggy".
 *
 * Deliberately capability-based (pointer type, memory, core count) rather than
 * user-agent sniffing, which is both unreliable and ages badly.
 */

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
  if (!isCoarsePointer()) return false;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = navigator.hardwareConcurrency ?? 8;
  const memory = nav.deviceMemory ?? 8;
  return cores <= 8 || memory <= 8;
}

/** Frames per second the scene animator should target on this device. */
export function animationHz(stereo: boolean): number {
  if (!isCoarsePointer()) return 30;
  // Two views on a phone: update the world at 20 Hz and leave the rest of the
  // budget to the renderer. Nothing here — a crane at walking pace, a hull at
  // 9 knots, a tide — is fast enough for the difference to be visible.
  return stereo ? 20 : 24;
}
