/**
 * The eye-startup ordering — the fix for "one side renders later than the other".
 *
 * Driven with fake views, because what is under test is WHEN each view is built
 * and when the scene is revealed, not what a SceneView does with a WebGL context.
 */
import { describe, expect, it, vi } from 'vitest';
import { bootViews, type BootDeps, type EyeSlot } from './sceneBoot';
import type { DrawOutcome } from './viewReady';

interface FakeView {
  slot: EyeSlot;
  resolve: (o: DrawOutcome) => void;
  drawn: Promise<DrawOutcome>;
}

/** Records the order everything happened in. */
function rig(opts: { cancelAfter?: number } = {}) {
  const log: string[] = [];
  const views: FakeView[] = [];
  let cancelled = false;
  let adopts = 0;

  const deps: BootDeps<FakeView> = {
    makeView: (slot) => {
      log.push(`make:${slot}`);
      let resolve!: (o: DrawOutcome) => void;
      const drawn = new Promise<DrawOutcome>((r) => {
        resolve = r;
      });
      const v: FakeView = { slot, resolve, drawn };
      views.push(v);
      return v;
    },
    adopt: (v) => {
      log.push(`adopt:${v.slot}`);
      adopts += 1;
      if (opts.cancelAfter != null && adopts >= opts.cancelAfter) cancelled = true;
    },
    waitDrawn: (v) => {
      log.push(`wait:${v.slot}`);
      return v.drawn;
    },
    isCancelled: () => cancelled,
    onFirstEye: () => log.push('first-eye'),
    onReady: (outcomes) => log.push(`ready:${outcomes.join(',')}`),
  };

  return {
    log,
    views,
    deps,
    cancel: () => {
      cancelled = true;
    },
  };
}

/** Let the microtask queue drain. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('bootViews — mono', () => {
  it('builds one view and reveals when it has drawn', async () => {
    const r = rig();
    const p = bootViews({ stereo: false, sequential: false }, r.deps);
    await settle();
    expect(r.views).toHaveLength(1);
    r.views[0].resolve('drawn');
    await expect(p).resolves.toEqual(['drawn']);
    expect(r.log).toEqual(['make:left', 'adopt:left', 'wait:left', 'ready:drawn']);
  });

  it('never takes the sequential path, whatever it is told', async () => {
    const r = rig();
    const p = bootViews({ stereo: false, sequential: true }, r.deps);
    await settle();
    expect(r.views).toHaveLength(1);
    expect(r.log).not.toContain('first-eye');
    r.views[0].resolve('drawn');
    await p;
  });
});

describe('bootViews — stereo, parallel (a fast link)', () => {
  it('builds both eyes before waiting on either', async () => {
    const r = rig();
    const p = bootViews({ stereo: true, sequential: false }, r.deps);
    await settle();
    // Both exist immediately: on a fast link the parallelism is free and the
    // wait is the GPU's, not the network's.
    expect(r.log.slice(0, 4)).toEqual(['make:left', 'adopt:left', 'make:right', 'adopt:right']);
    r.views[0].resolve('drawn');
    r.views[1].resolve('drawn');
    await expect(p).resolves.toEqual(['drawn', 'drawn']);
  });

  it('reveals only when the SLOWER eye is done', async () => {
    const r = rig();
    let done = false;
    const p = bootViews({ stereo: true, sequential: false }, r.deps).then((v) => {
      done = true;
      return v;
    });
    await settle();
    r.views[0].resolve('drawn');
    await settle();
    // Revealing here is the bug: the brain cannot fuse a finished port in one
    // eye with a half-built one in the other.
    expect(done).toBe(false);
    expect(r.log).not.toContain('ready:drawn,drawn');
    r.views[1].resolve('drawn');
    await p;
    expect(done).toBe(true);
  });
});

describe('bootViews — stereo, sequential (3G)', () => {
  it('does not build the second eye until the first has drawn', async () => {
    const r = rig();
    const p = bootViews({ stereo: true, sequential: true }, r.deps);
    await settle();

    // One view only. Two views started together interleave requests for the
    // same tiles and meshes on one pipe, so both finish late AND at different
    // times — the reported symptom.
    expect(r.views).toHaveLength(1);
    expect(r.log).toEqual(['make:left', 'adopt:left', 'first-eye', 'wait:left']);

    r.views[0].resolve('drawn');
    await settle();
    // Now the second eye starts, onto a warm cache.
    expect(r.views).toHaveLength(2);
    expect(r.views[1].slot).toBe('right');

    r.views[1].resolve('drawn');
    await expect(p).resolves.toEqual(['drawn', 'drawn']);
  });

  it('announces the first-eye phase so the gate can say what it is waiting for', async () => {
    const r = rig();
    const p = bootViews({ stereo: true, sequential: true }, r.deps);
    await settle();
    expect(r.log.indexOf('first-eye')).toBeGreaterThan(-1);
    expect(r.log.indexOf('first-eye')).toBeLessThan(r.log.indexOf('wait:left'));
    r.views[0].resolve('drawn');
    await settle();
    r.views[1].resolve('drawn');
    await p;
  });

  it('reveals a still-streaming scene rather than never revealing at all', async () => {
    const r = rig();
    const p = bootViews({ stereo: true, sequential: true }, r.deps);
    await settle();
    r.views[0].resolve('timeout');
    await settle();
    r.views[1].resolve('timeout');
    // The gate always opens: a walkthrough that refuses to start, with the phone
    // already in the holder, is worse than one that starts half-textured.
    await expect(p).resolves.toEqual(['timeout', 'timeout']);
  });
});

describe('bootViews — cancellation', () => {
  it('does not build the second eye if it unmounted while the first was loading', async () => {
    const r = rig();
    const p = bootViews({ stereo: true, sequential: true }, r.deps);
    await settle();
    r.cancel();
    r.views[0].resolve('drawn');
    await expect(p).resolves.toBeNull();
    // A SceneView built after unmount is a live WebGL context nobody holds a
    // reference to — and mode flips make this the common path, not a corner one.
    expect(r.views).toHaveLength(1);
    expect(r.log).not.toContain('make:right');
  });

  it('does not reveal a scene that has been torn down', async () => {
    const r = rig();
    const p = bootViews({ stereo: true, sequential: false }, r.deps);
    await settle();
    r.cancel();
    r.views[0].resolve('drawn');
    r.views[1].resolve('drawn');
    await expect(p).resolves.toBeNull();
    expect(r.log.some((l) => l.startsWith('ready'))).toBe(false);
  });

  it('does not reveal a mono scene that has been torn down', async () => {
    const r = rig();
    const p = bootViews({ stereo: false, sequential: false }, r.deps);
    await settle();
    r.cancel();
    r.views[0].resolve('drawn');
    await expect(p).resolves.toBeNull();
    expect(r.log.some((l) => l.startsWith('ready'))).toBe(false);
  });
});

describe('bootViews — invariants', () => {
  it('adopts every view it builds, so nothing is ever orphaned', async () => {
    for (const sequential of [false, true]) {
      const made: EyeSlot[] = [];
      const adopted: EyeSlot[] = [];
      const pending: Array<(o: DrawOutcome) => void> = [];
      const deps: BootDeps<{ slot: EyeSlot }> = {
        makeView: (slot) => {
          made.push(slot);
          return { slot };
        },
        adopt: (v) => adopted.push(v.slot),
        waitDrawn: () => new Promise<DrawOutcome>((r) => pending.push(r)),
        isCancelled: () => false,
        onReady: vi.fn(),
      };
      const p = bootViews({ stereo: true, sequential }, deps);
      await settle();
      pending.forEach((r) => r('drawn'));
      await settle();
      pending.forEach((r) => r('drawn'));
      await p;
      expect(adopted).toEqual(made);
      expect(made).toEqual(['left', 'right']);
    }
  });
});
