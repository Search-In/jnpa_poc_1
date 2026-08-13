/**
 * `useGyro` end to end — permission, feed selection, and the frame coalescing
 * that keeps the sensor from writing more camera poses than the scene draws.
 *
 * This is the one piece of the tracking chain that is React and browser events
 * rather than maths, so it is worth exercising as a hook rather than trusting
 * that the pieces wire up.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGyro } from './useGyro';

/** A hand-cranked rAF, so "next frame" is a function call. */
function installFakeRaf() {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const h = next++;
    queue.set(h, cb);
    return h;
  });
  vi.stubGlobal('cancelAnimationFrame', (h: number) => {
    queue.delete(h);
  });
  return {
    tick() {
      const due = [...queue.values()];
      queue.clear();
      act(() => {
        for (const cb of due) cb(performance.now());
      });
    },
    get booked() {
      return queue.size;
    },
  };
}

/**
 * A reading for a phone held upright in a holder, looking at `heading`/`tilt`.
 * (With gamma zero the W3C frame reduces to heading = −alpha, tilt = beta; that
 * inversion is proved in `gyroTrack.test.ts`.)
 */
function fire(type: string, heading: number, tilt = 90) {
  const e = new Event(type) as DeviceOrientationEvent & {
    alpha: number;
    beta: number;
    gamma: number;
  };
  Object.assign(e, { alpha: ((-heading % 360) + 360) % 360, beta: tilt, gamma: 0 });
  act(() => {
    window.dispatchEvent(e);
  });
}

let raf: ReturnType<typeof installFakeRaf>;

/** jsdom implements no motion sensors at all, so the phone has to be supplied. */
class FakeDeviceOrientationEvent extends Event {}

beforeEach(() => {
  raf = installFakeRaf();
  vi.stubGlobal('DeviceOrientationEvent', FakeDeviceOrientationEvent);
  // jsdom's default document URL is a secure context, but pin it: the hook
  // refuses to arm on an insecure origin, and that check must be exercised
  // deliberately rather than by accident.
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('arming', () => {
  it('starts idle and reports nothing until asked', () => {
    const { result } = renderHook(() => useGyro(true, vi.fn()));
    expect(result.current.status).toBe('idle');
    expect(result.current.live).toBe(false);
    expect(result.current.message).toBeNull();
  });

  it('refuses on an insecure origin, before prompting', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const { result } = renderHook(() => useGyro(true, vi.fn()));
    await act(async () => {
      await result.current.request();
    });
    // The #1 cause of "the gyro doesn't work": over http://<lan-ip> the event
    // simply never fires, silently. Saying so beats a frozen horizon.
    expect(result.current.status).toBe('insecure');
    expect(result.current.message).toMatch(/HTTPS/i);
  });

  it('reports a device with no orientation sensor at all', async () => {
    vi.stubGlobal('DeviceOrientationEvent', undefined);
    const { result } = renderHook(() => useGyro(true, vi.fn()));
    await act(async () => {
      await result.current.request();
    });
    expect(result.current.status).toBe('unsupported');
  });

  it('honours a declined iOS permission prompt', async () => {
    class Gated extends Event {
      static requestPermission = async () => 'denied';
    }
    vi.stubGlobal('DeviceOrientationEvent', Gated);
    const { result } = renderHook(() => useGyro(true, vi.fn()));
    await act(async () => {
      await result.current.request();
    });
    expect(result.current.status).toBe('denied');
  });

  it('arms once an iOS prompt is granted', async () => {
    class Gated extends Event {
      static requestPermission = async () => 'granted';
    }
    vi.stubGlobal('DeviceOrientationEvent', Gated);
    const { result } = renderHook(() => useGyro(true, vi.fn()));
    await act(async () => {
      await result.current.request();
    });
    expect(result.current.status).toBe('waiting');
  });
});

describe('the feed', () => {
  async function armed(onLook = vi.fn()) {
    const hook = renderHook(() => useGyro(true, onLook));
    await act(async () => {
      await hook.result.current.request();
    });
    return { hook, onLook };
  }

  it('goes live on the first reading and reports a pose', async () => {
    const { hook, onLook } = await armed();
    expect(hook.result.current.status).toBe('waiting');

    fire('deviceorientationabsolute', 135);
    raf.tick();

    expect(hook.result.current.status).toBe('live');
    expect(onLook).toHaveBeenCalledTimes(1);
    const [heading, tilt] = onLook.mock.calls[0];
    expect(heading).toBeCloseTo(135, 3);
    expect(tilt).toBeCloseTo(90, 3);
  });

  it('publishes ONCE per frame however many readings arrive', async () => {
    const { onLook } = await armed();
    // A phone sampling at 60 Hz against a scene drawing at 20 in stereo. Every
    // reading used to become a camera write into both SceneViews.
    for (let i = 0; i < 12; i++) fire('deviceorientationabsolute', 100 + i);
    expect(onLook).not.toHaveBeenCalled();
    raf.tick();
    expect(onLook).toHaveBeenCalledTimes(1);
  });

  it('publishes the NEWEST reading, not the first of the batch', async () => {
    const { onLook } = await armed();
    for (let i = 0; i < 8; i++) fire('deviceorientationabsolute', 100 + i * 5);
    raf.tick();
    const [heading] = onLook.mock.calls[0];
    // The eight intermediate poses are not merely wasted work — they are stale
    // by the time the frame is drawn.
    expect(heading).toBeGreaterThan(100);
  });

  it('ignores the relative feed once the absolute one is alive', async () => {
    const { onLook } = await armed();
    fire('deviceorientationabsolute', 200);
    raf.tick();
    onLook.mockClear();

    // Plain `deviceorientation` is relative on Android and drifts; letting the
    // two feeds both write would make the port rotate under the viewer.
    fire('deviceorientation', 20);
    raf.tick();
    expect(onLook).not.toHaveBeenCalled();
  });

  it('falls back to the relative feed when no absolute one arrives', async () => {
    const { onLook } = await armed();
    fire('deviceorientation', 77);
    raf.tick();
    expect(onLook).toHaveBeenCalledTimes(1);
    expect(onLook.mock.calls[0][0]).toBeCloseTo(77, 3);
  });

  it('drops an incomplete reading rather than snapping to zero', async () => {
    const { onLook } = await armed();
    const e = new Event('deviceorientationabsolute') as DeviceOrientationEvent;
    Object.assign(e, { alpha: null, beta: null, gamma: null });
    act(() => {
      window.dispatchEvent(e);
    });
    raf.tick();
    // iOS emits nulls before motion permission is granted.
    expect(onLook).not.toHaveBeenCalled();
  });

  it('smooths a noisy hold instead of passing the tremble through', async () => {
    const { onLook } = await armed();
    const wobble = [0.4, -0.5, 0.3, -0.2, 0.5, -0.4, 0.2, -0.3];
    for (const d of wobble) {
      fire('deviceorientationabsolute', 90 + d);
      raf.tick();
    }
    const out = onLook.mock.calls.map((c) => c[0] as number);
    const spread = Math.max(...out) - Math.min(...out);
    const inputSpread = Math.max(...wobble) - Math.min(...wobble);
    expect(spread).toBeLessThan(inputSpread);
  });
});

describe('teardown', () => {
  it('stops listening and cancels its pending frame on unmount', async () => {
    const onLook = vi.fn();
    const hook = renderHook(() => useGyro(true, onLook));
    await act(async () => {
      await hook.result.current.request();
    });
    fire('deviceorientationabsolute', 42);
    expect(raf.booked).toBe(1);

    act(() => hook.unmount());
    expect(raf.booked).toBe(0);

    // A listener still attached after unmount would write into a destroyed view.
    fire('deviceorientationabsolute', 99);
    raf.tick();
    expect(onLook).not.toHaveBeenCalled();
  });

  it('disarms when the view leaves VR, so re-entry re-requests access', async () => {
    const onLook = vi.fn();
    const hook = renderHook(({ on }) => useGyro(on, onLook), {
      initialProps: { on: true },
    });
    await act(async () => {
      await hook.result.current.request();
    });
    fire('deviceorientationabsolute', 10);
    raf.tick();
    expect(hook.result.current.live).toBe(true);

    hook.rerender({ on: false });
    expect(hook.result.current.status).toBe('idle');
    onLook.mockClear();
    fire('deviceorientationabsolute', 250);
    raf.tick();
    expect(onLook).not.toHaveBeenCalled();
  });
});
