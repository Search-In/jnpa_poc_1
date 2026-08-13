/**
 * The reveal gate — the thing that stops one eye being shown before the other.
 *
 * Driven against a fake view rather than a real SceneView: the behaviour under
 * test is the SEQUENCING (what it waits on, what it refuses to wait on, when it
 * gives up), and a real view would only add a WebGL context jsdom cannot give it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  allDrawnCleanly,
  whenAssetsDrawn,
  type DrawableView,
  type SettledWatcher,
  type UpdatingSource,
} from './viewReady';

/** A layer view that starts busy and can be told it has finished. */
class FakeLayerView implements UpdatingSource {
  updating = true;
  constructor(private readonly onChange: () => void) {}
  finish(): void {
    this.updating = false;
    this.onChange();
  }
}

/** A SceneView, reduced to the two things the gate uses. */
class FakeView implements DrawableView {
  readonly layerViews = new Map<unknown, FakeLayerView>();
  private listeners = new Set<() => void>();
  private readonly ready: Promise<unknown>;

  constructor(
    private readonly opts: {
      failsToInit?: boolean;
      /** Layers whose layer view never arrives (dropped by the budget). */
      missing?: readonly unknown[];
    } = {}
  ) {
    this.ready = opts.failsToInit ? Promise.reject(new Error('no webgl')) : Promise.resolve(null);
    this.ready.catch(() => {});
  }

  when(): Promise<unknown> {
    return this.ready;
  }

  whenLayerView(layer: unknown): Promise<UpdatingSource> {
    if (this.opts.missing?.includes(layer)) return Promise.reject(new Error('not in map'));
    let lv = this.layerViews.get(layer);
    if (!lv) {
      lv = new FakeLayerView(() => this.notify());
      this.layerViews.set(layer, lv);
    }
    return Promise.resolve(lv);
  }

  finishAll(): void {
    for (const lv of this.layerViews.values()) lv.updating = false;
    this.notify();
  }

  finish(layer: unknown): void {
    this.layerViews.get(layer)?.finish();
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }

  /** The injected watcher: re-evaluates the predicate on every change. */
  readonly watcher: SettledWatcher = (isSettled, onChange) => {
    const listener = () => onChange(isSettled());
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  };

  get watcherCount(): number {
    return this.listeners.size;
  }
}

/** Let the microtask queue drain. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

const YARD = { title: 'yard' };
const CRANES = { title: 'cranes' };

describe('whenAssetsDrawn', () => {
  it('resolves once every tracked layer has finished', async () => {
    const view = new FakeView();
    const p = whenAssetsDrawn(view, [YARD, CRANES], 5_000, { watchSettled: view.watcher });
    await settle();
    view.finishAll();
    await expect(p).resolves.toBe('drawn');
  });

  it('does NOT resolve while one layer is still loading', async () => {
    const view = new FakeView();
    let done = false;
    const p = whenAssetsDrawn(view, [YARD, CRANES], 5_000, {
      watchSettled: view.watcher,
    }).then((o) => {
      done = true;
      return o;
    });
    await settle();
    view.finish(YARD);
    await settle();
    // Revealing here would show a port with a yard and no cranes.
    expect(done).toBe(false);
    view.finish(CRANES);
    await expect(p).resolves.toBe('drawn');
  });

  it('resolves immediately when the assets were already there', async () => {
    // A second run off a warm cache, or the second eye after the first — which
    // is the whole reason the eyes are started one after the other.
    const view = new FakeView();
    const p = whenAssetsDrawn(view, [YARD], 5_000, { watchSettled: view.watcher });
    await view.whenLayerView(YARD);
    view.finishAll();
    await expect(p).resolves.toBe('drawn');
  });

  it('does not wait on a layer the budget dropped', async () => {
    // Trucks and the tug are removed on a constrained link. A dropped layer has
    // no layer view, and must not be able to hold the gate shut forever.
    const view = new FakeView({ missing: [CRANES] });
    const p = whenAssetsDrawn(view, [YARD, CRANES], 5_000, { watchSettled: view.watcher });
    await settle();
    view.finish(YARD);
    await expect(p).resolves.toBe('drawn');
  });

  it('resolves when there is nothing to wait on at all', async () => {
    const view = new FakeView({ missing: [YARD] });
    await expect(whenAssetsDrawn(view, [YARD], 5_000, { watchSettled: view.watcher })).resolves.toBe(
      'drawn'
    );
    await expect(whenAssetsDrawn(view, [], 5_000, { watchSettled: view.watcher })).resolves.toBe(
      'drawn'
    );
  });

  it('opens the gate anyway when patience runs out', async () => {
    vi.useFakeTimers();
    try {
      const view = new FakeView();
      const p = whenAssetsDrawn(view, [YARD], 12_000, { watchSettled: view.watcher });
      await vi.advanceTimersByTimeAsync(12_050);
      // A walkthrough that refuses to start, with the phone already in the
      // holder, is worse than one that starts half-textured.
      await expect(p).resolves.toBe('timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a view that could not initialise instead of hanging', async () => {
    const view = new FakeView({ failsToInit: true });
    await expect(whenAssetsDrawn(view, [YARD], 5_000, { watchSettled: view.watcher })).resolves.toBe(
      'failed'
    );
  });

  it('removes its watcher, whichever way it ends', async () => {
    const view = new FakeView();
    const p = whenAssetsDrawn(view, [YARD], 5_000, { watchSettled: view.watcher });
    await settle();
    expect(view.watcherCount).toBe(1);
    view.finishAll();
    await p;
    expect(view.watcherCount).toBe(0);
  });

  it('settles once, even if a layer flaps between busy and idle', async () => {
    // Which it will: the scene animator rewrites geometry twenty times a second
    // and the auto-tour keeps the camera moving.
    const view = new FakeView();
    const seen: string[] = [];
    void whenAssetsDrawn(view, [YARD], 5_000, { watchSettled: view.watcher }).then((o) =>
      seen.push(o)
    );
    await settle();
    view.finishAll();
    view.layerViews.get(YARD)!.updating = true;
    view.finishAll();
    await settle();
    expect(seen).toEqual(['drawn']);
  });
});

describe('allDrawnCleanly', () => {
  it('distinguishes a finished scene from one that is still streaming', () => {
    expect(allDrawnCleanly(['drawn', 'drawn'])).toBe(true);
    expect(allDrawnCleanly(['drawn', 'timeout'])).toBe(false);
    expect(allDrawnCleanly(['failed'])).toBe(false);
    expect(allDrawnCleanly([])).toBe(false);
  });
});
