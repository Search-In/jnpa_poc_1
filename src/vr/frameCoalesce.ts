/**
 * Run a callback at most once per animation frame, however often it is asked for.
 *
 * TWO PRODUCERS, ONE CONSUMER. The walkthrough's camera is moved by the head
 * tracker (up to 60 sensor readings a second) and by the auto-tour director (20–30
 * a second), while the scene renders at 20–30 fps in stereo on a handset. Applied
 * as they arrive, that is two or three camera writes for every frame actually
 * drawn — and all but the last are discarded, having been paid for out of the
 * same main-thread budget the renderer is already short of.
 *
 * Coalescing also buys a correctness property that matters more than the cycles:
 * both eyes are written from ONE pose in ONE task, so the stereo pair can never
 * be a frame out of step with each other.
 *
 * `raf` is injectable so the behaviour can be driven deterministically in a test
 * — and so the whole thing degrades to a direct call in an environment with no
 * `requestAnimationFrame` at all, rather than silently never running.
 */

export interface FrameScheduler {
  request: (cb: () => void) => number;
  cancel: (handle: number) => void;
}

/** The browser's own, or null where there is none (SSR, some test runners). */
export function browserScheduler(): FrameScheduler | null {
  if (typeof requestAnimationFrame !== 'function') return null;
  return {
    request: (cb) => requestAnimationFrame(cb),
    cancel: (h) => cancelAnimationFrame(h),
  };
}

export interface Coalescer {
  /** Ask for `fn` to run on the next frame. Repeat calls before it fires are free. */
  schedule: () => void;
  /** Run immediately if anything is pending, and clear the pending frame. */
  flush: () => void;
  /** Drop any pending frame without running it. */
  cancel: () => void;
  /** True while a frame is booked — for tests and diagnostics. */
  readonly pending: boolean;
}

export function coalesceToFrame(
  fn: () => void,
  scheduler: FrameScheduler | null = browserScheduler()
): Coalescer {
  let handle = 0;
  let dirty = false;

  const run = () => {
    handle = 0;
    if (!dirty) return;
    dirty = false;
    fn();
  };

  return {
    schedule() {
      dirty = true;
      // No scheduler: better to do the work now than to drop it. This is the
      // path a hidden tab does NOT take — there `requestAnimationFrame` exists,
      // it just does not fire, which is exactly what should happen when there
      // is nothing on screen to update.
      if (!scheduler) {
        run();
        return;
      }
      if (!handle) handle = scheduler.request(run);
    },
    flush() {
      if (handle && scheduler) {
        scheduler.cancel(handle);
        handle = 0;
      }
      run();
    },
    cancel() {
      if (handle && scheduler) scheduler.cancel(handle);
      handle = 0;
      dirty = false;
    },
    get pending() {
      return handle !== 0;
    },
  };
}
