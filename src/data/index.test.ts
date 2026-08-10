import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { LiveOverlayAdapter } from './LiveOverlayAdapter';
import { SimAdapter } from '@/sim/SimAdapter';
import { SHIPPING_LINES } from './mock/fixtures';
import type { DataAdapter } from './types';
import type { ShippingLine } from '@/types/domain';

/**
 * Adapter composition — `createAdapter` always wraps the mode's base driver in
 * SimAdapter, and hybrid additionally wraps MockAdapter in LiveOverlayAdapter.
 * These tests pin that the shipping-line read survives BOTH wrappers unchanged,
 * which is what makes it available in every mode.
 *
 * UC1-011: when `VITE_UC3_ENABLED`, the mock path selects Uc3Adapter (corpus
 * derived positions). Tests that need a pure offline MockAdapter stub that off.
 */

const LINE: ShippingLine = {
  lineCode: 'TST',
  lineName: 'TST',
  source: 'ADVANCE_LIST',
  firstSeen: 1,
  lastSeen: 2,
  containerCount: 7,
};

/** Minimal stand-in — only the method under test is exercised. */
function stubBase(getShippingLines: () => Promise<ShippingLine[]>): DataAdapter {
  return { mode: 'mock', getShippingLines } as unknown as DataAdapter;
}

/** Constructor name — safe across `vi.resetModules()` (instanceof breaks on re-import). */
function ctorName(v: unknown): string {
  return (v as { constructor?: { name?: string } })?.constructor?.name ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock('./config');
});

async function loadIndex() {
  return import('./index');
}

describe('createBaseAdapter', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('selects ResilientCorpusAdapter on the mock path when UC-3 + derived vessels (UC1-011)', async () => {
    vi.doMock('./config', async () => {
      const actual = await vi.importActual<typeof import('./config')>('./config');
      return {
        env: {
          ...actual.env,
          uc3: { ...actual.env.uc3, enabled: true, derivedVessels: true },
        },
      };
    });
    const { createBaseAdapter } = await loadIndex();
    expect(ctorName(createBaseAdapter('mock'))).toBe('ResilientCorpusAdapter');
  });

  it('keeps MockAdapter when UC-3 is on but derived vessels are off (production-style fleet)', async () => {
    vi.doMock('./config', async () => {
      const actual = await vi.importActual<typeof import('./config')>('./config');
      return {
        env: {
          ...actual.env,
          uc3: { ...actual.env.uc3, enabled: true, derivedVessels: false },
        },
      };
    });
    const { createBaseAdapter } = await loadIndex();
    expect(ctorName(createBaseAdapter('mock'))).toBe('MockAdapter');
  });

  it('falls back to MockAdapter when UC-3 is disabled', async () => {
    vi.doMock('./config', async () => {
      const actual = await vi.importActual<typeof import('./config')>('./config');
      return {
        env: {
          ...actual.env,
          uc3: { ...actual.env.uc3, enabled: false },
        },
      };
    });
    const { createBaseAdapter } = await loadIndex();
    expect(ctorName(createBaseAdapter('mock'))).toBe('MockAdapter');
  });

  it('selects overlay / live drivers for hybrid and live', async () => {
    vi.doMock('./config', async () => {
      const actual = await vi.importActual<typeof import('./config')>('./config');
      return {
        env: {
          ...actual.env,
          uc3: { ...actual.env.uc3, enabled: false },
        },
      };
    });
    const { createBaseAdapter } = await loadIndex();
    expect(ctorName(createBaseAdapter('hybrid'))).toBe('LiveOverlayAdapter');
    expect(createBaseAdapter('live').mode).toBe('live');
  });

  it('reports mock mode for hybrid (the overlay is additive, not a mode)', async () => {
    vi.doMock('./config', async () => {
      const actual = await vi.importActual<typeof import('./config')>('./config');
      return {
        env: {
          ...actual.env,
          uc3: { ...actual.env.uc3, enabled: false },
        },
      };
    });
    const { createBaseAdapter } = await loadIndex();
    expect(createBaseAdapter('hybrid').mode).toBe('mock');
  });
});

describe('getShippingLines through the wrapper chain', () => {
  it('SimAdapter delegates to its base untouched', async () => {
    const spy = vi.fn(async () => [LINE]);
    const lines = await new SimAdapter(stubBase(spy)).getShippingLines();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([LINE]);
  });

  it('LiveOverlayAdapter delegates to its base untouched', async () => {
    const spy = vi.fn(async () => [LINE]);
    const lines = await new LiveOverlayAdapter(stubBase(spy)).getShippingLines();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([LINE]);
  });

  it('propagates a rejection rather than swallowing it', async () => {
    const boom = stubBase(async () => {
      throw new Error('[UC3] backend down');
    });
    await expect(new SimAdapter(boom).getShippingLines()).rejects.toThrow(/backend down/);
    await expect(new LiveOverlayAdapter(boom).getShippingLines()).rejects.toThrow(/backend down/);
  });
});

describe('mock composition stays offline when UC-3 is off', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('createAdapter("mock") returns the fixture with no network call', async () => {
    vi.doMock('./config', async () => {
      const actual = await vi.importActual<typeof import('./config')>('./config');
      return {
        env: {
          ...actual.env,
          uc3: { ...actual.env.uc3, enabled: false },
        },
      };
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { createAdapter } = await loadIndex();
    const lines = await createAdapter('mock').getShippingLines();

    expect(lines).toEqual(SHIPPING_LINES);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('createAdapter("hybrid") also serves the fixture offline', async () => {
    vi.doMock('./config', async () => {
      const actual = await vi.importActual<typeof import('./config')>('./config');
      return {
        env: {
          ...actual.env,
          uc3: { ...actual.env.uc3, enabled: false },
        },
      };
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { createAdapter } = await loadIndex();
    const lines = await createAdapter('hybrid').getShippingLines();

    expect(lines).toEqual(SHIPPING_LINES);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
