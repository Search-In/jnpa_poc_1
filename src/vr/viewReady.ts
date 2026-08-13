/**
 * "Are this view's 3D assets there yet?" — and the gate that keeps both eyes
 * from being revealed until they both are.
 *
 * WHY IT MATTERS IN STEREO. A SceneView resolves its own tiles, meshes and
 * textures; two views of the same map do NOT share that work, they only share
 * the HTTP cache underneath. Started together on a thin link they interleave
 * their requests and finish at different times, so one eye shows a finished port
 * while the other still shows bare ground with cranes missing. The brain cannot
 * fuse that — it is the reported "left side is not displaying or rendering late
 * the 3D assets which are available on the right side".
 *
 * WHY NOT `view.updating`. That is the obvious signal and it is the wrong one.
 * It is true whenever ANYTHING in the view is working, which here includes two
 * things that never stop: the scene animator rewrites hull and crane geometry
 * twenty times a second, and the auto-tour flies the camera continuously, so
 * the basemap is forever streaming tiles for a viewpoint that has already moved.
 * A gate waiting on `view.updating` would therefore never open on its own and
 * would sit until its timeout on EVERY device, including a fast desktop.
 *
 * So the gate waits on the specific layer views that carry the load the viewer
 * would notice missing — the glTF port assets — and explicitly not on the
 * animated layers or the basemap. Imagery arriving late is invisible anyway,
 * because a bundled ground underlay is painted beneath it (`vrBasemap.ts`).
 *
 * The timeout is not a formality. On a bad link a layer view may never settle,
 * and a walkthrough that refuses to start — with the phone already in the
 * holder — is worse than one that starts half-textured. So the gate always
 * opens, and the caller is told which way it went.
 */
import { watch } from '@arcgis/core/core/reactiveUtils';

/** How a wait ended. */
export type DrawOutcome =
  /** Every tracked layer reported it had finished. */
  | 'drawn'
  /** Patience ran out — reveal it anyway, still streaming. */
  | 'timeout'
  /** The view failed to initialise at all. */
  | 'failed';

/** Anything with an `updating` flag — a LayerView, as far as this module cares. */
export interface UpdatingSource {
  updating: boolean;
}

/** The part of a SceneView this module needs — structural, so it is fakeable. */
export interface DrawableView {
  when(): Promise<unknown>;
  whenLayerView(layer: unknown): Promise<UpdatingSource>;
}

/** Subscribe to a predicate over accessor state. Injected so the gate is testable. */
export type SettledWatcher = (
  isSettled: () => boolean,
  onChange: (settled: boolean) => void
) => { remove: () => void };

/** The real watcher. `reactiveUtils.watch` tracks whatever the getter reads. */
export const arcgisSettledWatcher: SettledWatcher = (isSettled, onChange) =>
  watch(isSettled, (v) => onChange(Boolean(v)));

export interface WaitDeps {
  watchSettled?: SettledWatcher;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

/**
 * Resolve once every one of `layers` has a layer view that has stopped
 * updating, or after `timeoutMs`.
 *
 * Never rejects: a view that fails to initialise resolves 'failed' so the caller
 * can carry on with one eye rather than hanging on a promise that will not come.
 * A layer whose layer view never arrives is skipped rather than blocking — the
 * scenery budget drops layers by design, and a dropped layer must not be able to
 * hold the gate shut.
 */
export function whenAssetsDrawn(
  view: DrawableView,
  layers: readonly unknown[],
  timeoutMs: number,
  deps: WaitDeps = {}
): Promise<DrawOutcome> & { cancel: () => void } {
  const watchSettled = deps.watchSettled ?? arcgisSettledWatcher;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let settled = false;
  let handle: { remove: () => void } | null = null;
  let timer: unknown = null;
  let finish!: (outcome: DrawOutcome) => void;

  const promise = new Promise<DrawOutcome>((resolve) => {
    finish = (outcome: DrawOutcome) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimer(timer);
      handle?.remove();
      handle = null;
      resolve(outcome);
    };

    timer = setTimer(() => finish('timeout'), Math.max(0, timeoutMs));

    view
      .when()
      .then(async () => {
        if (settled) return;
        const views = (
          await Promise.all(
            layers.map((l) => view.whenLayerView(l).catch(() => null))
          )
        ).filter((lv): lv is UpdatingSource => lv != null);

        if (settled) return;
        // Nothing to wait for: no scenery in this budget, or every layer view
        // failed. The view itself is up, which is as ready as it gets.
        if (!views.length) {
          finish('drawn');
          return;
        }

        const isSettled = () => views.every((lv) => !lv.updating);
        if (isSettled()) {
          finish('drawn');
          return;
        }
        handle = watchSettled(isSettled, (ok) => {
          if (ok) finish('drawn');
        });
      })
      .catch(() => finish('failed'));
  });

  /**
   * Give up waiting and release everything.
   *
   * Without this an unmounted scene left a live `reactiveUtils` watch and a
   * timer of up to 25 seconds holding references to the layer views of a
   * SceneView that had already been destroyed — every time the operator flipped
   * between 3D and VR, or left and re-entered.
   */
  return Object.assign(promise, {
    cancel: () => finish('failed'),
  });
}

/** True when every view drew properly — i.e. nothing was revealed half-loaded. */
export function allDrawnCleanly(outcomes: DrawOutcome[]): boolean {
  return outcomes.length > 0 && outcomes.every((o) => o === 'drawn');
}
