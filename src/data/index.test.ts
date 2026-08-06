import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAdapter, createBaseAdapter } from './index';
import { LiveOverlayAdapter } from './LiveOverlayAdapter';
import { MockAdapter } from './MockAdapter';
import { SimAdapter } from '@/sim/SimAdapter';
import { SHIPPING_LINES } from './mock/fixtures';
import type { DataAdapter } from './types';
import type { ShippingLine } from '@/types/domain';

/**
 * Adapter composition — `createAdapter` always wraps the mode's base driver in
 * SimAdapter, and hybrid additionally wraps MockAdapter in LiveOverlayAdapter.
 * These tests pin that the shipping-line read survives BOTH wrappers unchanged,
 * which is what makes it available in every mode.
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createBaseAdapter', () => {
  it('selects the driver for each mode', () => {
    expect(createBaseAdapter('mock')).toBeInstanceOf(MockAdapter);
    expect(createBaseAdapter('hybrid')).toBeInstanceOf(LiveOverlayAdapter);
    // 'live' builds ArcGISAdapter; asserted via mode rather than importing the
    // ArcGIS SDK-heavy class into the test environment.
    expect(createBaseAdapter('live').mode).toBe('live');
  });

  it('reports mock mode for hybrid (the overlay is additive, not a mode)', () => {
    expect(createBaseAdapter('hybrid').mode).toBe('mock');
  });
});

describe('getShippingLines through the wrapper chain', () => {
  it('SimAdapter delegates to its base untouched', async () => {
    const spy = vi.fn(async () => [LINE]);
    const lines = await new SimAdapter(stubBase(spy)).getShippingLines();

    expect(spy).toHaveBeenCalledTimes(1);
    // Reference data has no simulated counterpart, so no applySim overlay runs.
    expect(lines).toEqual([LINE]);
  });

  it('LiveOverlayAdapter delegates to its base untouched', async () => {
    const spy = vi.fn(async () => [LINE]);
    const lines = await new LiveOverlayAdapter(stubBase(spy)).getShippingLines();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([LINE]);
  });

  it('propagates a rejection rather than swallowing it', async () => {
    // useAdapterQuery surfaces a rejected promise as `error`; a wrapper that
    // swallowed it would leave the UI stuck on "loading".
    const boom = stubBase(async () => {
      throw new Error('[UC3] backend down');
    });
    await expect(new SimAdapter(boom).getShippingLines()).rejects.toThrow(/backend down/);
    await expect(new LiveOverlayAdapter(boom).getShippingLines()).rejects.toThrow(/backend down/);
  });
});

describe('mock composition stays offline', () => {
  it('createAdapter("mock") returns the fixture with no network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // The full app-wide chain: SimAdapter → MockAdapter.
    const lines = await createAdapter('mock').getShippingLines();

    expect(lines).toEqual(SHIPPING_LINES);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('createAdapter("hybrid") also serves the fixture offline', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // SimAdapter → LiveOverlayAdapter → MockAdapter.
    const lines = await createAdapter('hybrid').getShippingLines();

    expect(lines).toEqual(SHIPPING_LINES);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
