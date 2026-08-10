import { afterEach, describe, expect, it, vi } from 'vitest';
import { animationHz, isCoarsePointer, isLowPowerDevice } from './device';

/** Pretend to be a device with the given pointer type and hardware. */
function stubDevice(opts: { coarse: boolean; cores?: number; memory?: number }) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('coarse') ? opts.coarse : false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
  }));
  if (opts.cores !== undefined) {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(opts.cores);
  }
  if (opts.memory !== undefined) {
    Object.defineProperty(navigator, 'deviceMemory', {
      value: opts.memory,
      configurable: true,
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isCoarsePointer', () => {
  it('is true on a touch device', () => {
    stubDevice({ coarse: true });
    expect(isCoarsePointer()).toBe(true);
  });

  it('is false on a mouse-driven machine', () => {
    stubDevice({ coarse: false });
    expect(isCoarsePointer()).toBe(false);
  });
});

describe('isLowPowerDevice', () => {
  it('never downgrades a desktop, however few cores it reports', () => {
    // A fine pointer means a real machine; the stereo path is not even reachable
    // in a cardboard holder there.
    stubDevice({ coarse: false, cores: 2, memory: 2 });
    expect(isLowPowerDevice()).toBe(false);
  });

  it('downgrades a modest phone', () => {
    stubDevice({ coarse: true, cores: 4, memory: 4 });
    expect(isLowPowerDevice()).toBe(true);
  });

  it('does not downgrade a high-end tablet', () => {
    stubDevice({ coarse: true, cores: 12, memory: 16 });
    expect(isLowPowerDevice()).toBe(false);
  });
});

describe('animationHz', () => {
  it('runs at 30 Hz on a desktop, mono or stereo', () => {
    stubDevice({ coarse: false });
    expect(animationHz(false)).toBe(30);
    expect(animationHz(true)).toBe(30);
  });

  it('drops to 20 Hz for stereo on a handset', () => {
    stubDevice({ coarse: true });
    expect(animationHz(true)).toBe(20);
    expect(animationHz(false)).toBe(24);
  });

  it('never returns a rate that would stall the animation', () => {
    for (const coarse of [true, false]) {
      stubDevice({ coarse });
      for (const stereo of [true, false]) {
        expect(animationHz(stereo)).toBeGreaterThanOrEqual(20);
        expect(animationHz(stereo)).toBeLessThanOrEqual(60);
      }
    }
  });
});
