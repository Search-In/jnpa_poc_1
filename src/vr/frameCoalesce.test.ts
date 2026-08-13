/**
 * Frame coalescing — one camera write per drawn frame, from two producers.
 */
import { describe, expect, it, vi } from 'vitest';
import { coalesceToFrame, type FrameScheduler } from './frameCoalesce';

/** A hand-cranked rAF, so "next frame" is a function call. */
function fakeScheduler() {
  const queue = new Map<number, () => void>();
  let next = 1;
  const scheduler: FrameScheduler = {
    request: (cb) => {
      const h = next++;
      queue.set(h, cb);
      return h;
    },
    cancel: (h) => {
      queue.delete(h);
    },
  };
  return {
    scheduler,
    /** Fire everything booked for the next frame. */
    tick() {
      const due = [...queue.values()];
      queue.clear();
      for (const cb of due) cb();
    },
    get booked() {
      return queue.size;
    },
  };
}

describe('coalesceToFrame', () => {
  it('runs once per frame however many times it is asked', () => {
    const fn = vi.fn();
    const raf = fakeScheduler();
    const c = coalesceToFrame(fn, raf.scheduler);

    // 60 sensor readings and 30 tour poses inside one frame — the real case.
    for (let i = 0; i < 90; i++) c.schedule();
    expect(fn).not.toHaveBeenCalled();
    expect(raf.booked).toBe(1);

    raf.tick();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('runs again on the next frame after a new request', () => {
    const fn = vi.fn();
    const raf = fakeScheduler();
    const c = coalesceToFrame(fn, raf.scheduler);
    c.schedule();
    raf.tick();
    c.schedule();
    raf.tick();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not run on a frame nobody asked for', () => {
    const fn = vi.fn();
    const raf = fakeScheduler();
    coalesceToFrame(fn, raf.scheduler);
    raf.tick();
    expect(fn).not.toHaveBeenCalled();
  });

  it('reports whether a frame is booked', () => {
    const raf = fakeScheduler();
    const c = coalesceToFrame(() => {}, raf.scheduler);
    expect(c.pending).toBe(false);
    c.schedule();
    expect(c.pending).toBe(true);
    raf.tick();
    expect(c.pending).toBe(false);
  });

  it('drops pending work on cancel — an unmounted view must not be written to', () => {
    const fn = vi.fn();
    const raf = fakeScheduler();
    const c = coalesceToFrame(fn, raf.scheduler);
    c.schedule();
    c.cancel();
    raf.tick();
    expect(fn).not.toHaveBeenCalled();
    expect(raf.booked).toBe(0);
  });

  it('runs pending work immediately on flush, and only once', () => {
    const fn = vi.fn();
    const raf = fakeScheduler();
    const c = coalesceToFrame(fn, raf.scheduler);
    c.schedule();
    c.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    raf.tick();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flushes nothing when nothing is pending', () => {
    const fn = vi.fn();
    const c = coalesceToFrame(fn, fakeScheduler().scheduler);
    c.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('falls back to running inline where there is no rAF at all', () => {
    // SSR, or a test runner without one. Dropping the work silently would leave
    // the camera frozen; running it inline is the honest degradation.
    const fn = vi.fn();
    const c = coalesceToFrame(fn, null);
    c.schedule();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(c.pending).toBe(false);
  });

  it('lets the callback see the newest state, not the state at request time', () => {
    // This is why it is coalesce-and-re-read rather than a queue of poses: the
    // 89 intermediate camera positions inside one frame are not just wasted
    // work, they are the wrong answer.
    let latest = 0;
    const seen: number[] = [];
    const raf = fakeScheduler();
    const c = coalesceToFrame(() => seen.push(latest), raf.scheduler);
    for (let i = 1; i <= 5; i++) {
      latest = i;
      c.schedule();
    }
    raf.tick();
    expect(seen).toEqual([5]);
  });
});
