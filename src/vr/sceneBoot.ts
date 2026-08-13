/**
 * Bringing the eyes up — the ordering decision, separated from the SceneView
 * construction it orders.
 *
 * A SceneView resolves its own tiles, meshes and textures. Two views of the same
 * map do not share that work; they share only the HTTP cache underneath. So on a
 * thin link, two views started together interleave requests for the SAME bytes,
 * both finish late, and they finish at different times — one eye showing a
 * finished port while the other still shows bare ground. That is the reported
 * "left side is not displaying, or rendering late, the 3D assets which are
 * available on the right side".
 *
 * Starting the second view once the first has drawn turns almost all of its
 * fetches into cache hits, so the pair converges together and the total wait is
 * barely longer than one view's. On a fast link the parallelism is free and the
 * wait is dominated by the GPU rather than the network, so they start together.
 *
 * This module is generic over the view type and takes every side effect as a
 * dependency, so the ORDERING can be tested — including the cancellation paths,
 * which is where a half-built scene would otherwise leak a live WebGL context on
 * every mode flip.
 */
import type { DrawOutcome } from './viewReady';

/** Which eye a view is being built for. */
export type EyeSlot = 'left' | 'right';

export interface BootDeps<V> {
  /** Construct a SceneView in the given eye's container. */
  makeView: (slot: EyeSlot) => V;
  /** Register the view: install fallbacks, publish it, write the opening camera. */
  adopt: (view: V, slot: EyeSlot) => void;
  /** Resolve when the view has drawn, or when patience runs out. */
  waitDrawn: (view: V) => Promise<DrawOutcome>;
  /** True once the component has unmounted — checked after every await. */
  isCancelled: () => boolean;
  /** Called when the first eye is up and the second is waiting on it. */
  onFirstEye?: () => void;
  /** Called once, when the scene may be revealed. */
  onReady: (outcomes: DrawOutcome[]) => void;
}

export interface BootOptions {
  stereo: boolean;
  /** Build the second eye only after the first has drawn. */
  sequential: boolean;
}

/**
 * Build the scene's views and resolve when it may be shown.
 *
 * Returns the outcomes it revealed on, or `null` if it was cancelled part way —
 * the caller's cleanup owns destroying whatever was adopted.
 */
export async function bootViews<V>(
  opts: BootOptions,
  deps: BootDeps<V>
): Promise<DrawOutcome[] | null> {
  const first = deps.makeView('left');
  deps.adopt(first, 'left');

  if (!opts.stereo) {
    const outcome = await deps.waitDrawn(first);
    if (deps.isCancelled()) return null;
    deps.onReady([outcome]);
    return [outcome];
  }

  if (opts.sequential) {
    deps.onFirstEye?.();
    const a = await deps.waitDrawn(first);
    // Cancelled while the first eye was loading: do NOT build the second. A
    // SceneView created after unmount is a live WebGL context nobody holds a
    // reference to, and mode flips are the common case here.
    if (deps.isCancelled()) return null;

    const second = deps.makeView('right');
    deps.adopt(second, 'right');
    const b = await deps.waitDrawn(second);
    if (deps.isCancelled()) return null;
    deps.onReady([a, b]);
    return [a, b];
  }

  const second = deps.makeView('right');
  deps.adopt(second, 'right');
  const outcomes = await Promise.all([deps.waitDrawn(first), deps.waitDrawn(second)]);
  if (deps.isCancelled()) return null;
  deps.onReady(outcomes);
  return outcomes;
}
