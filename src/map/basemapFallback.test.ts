/**
 * initialBasemap() branching — the "blank white world" regression.
 *
 * Without an API key the Esri imagery bases ('hybrid'/'satellite') still report
 * `loaded` while serving EMPTY tiles, so the VR walkthrough flew over a white
 * void. Since ArcGIS Online TRIAL subscriptions cannot issue API keys at all,
 * key-less is the normal state for a PoC org — it must still render real
 * geography, via the keyless 'osm' base.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Basemap from '@arcgis/core/Basemap';
import { initialBasemap, makeKeylessBasemap, isOfflineRequested } from './basemapFallback';

/** Point window.location.search at a query string for one assertion. */
function withSearch(search: string, run: () => void): void {
  const spy = vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    search,
  } as Location);
  try {
    run();
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe('initialBasemap', () => {
  it('serves satellite imagery when an API key is present', () => {
    expect(initialBasemap(true)).toBe('hybrid');
  });

  it('serves the keyless osm base when there is NO API key', () => {
    // The regression guard: must NOT be 'hybrid' (empty tiles => white void),
    // and must NOT be the flat grey offline polygon either.
    const bm = initialBasemap(false);
    expect(bm).toBe('osm');
    expect(bm).not.toBe('hybrid');
    expect(bm).not.toBeInstanceOf(Basemap);
  });

  it('defaults to the imagery base so existing call sites are unchanged', () => {
    expect(initialBasemap()).toBe('hybrid');
  });

  it('prefers the bundled offline base over osm when ?offline=1, key or not', () => {
    withSearch('?offline=1', () => {
      expect(initialBasemap(true)).toBeInstanceOf(Basemap);
      expect(initialBasemap(false)).toBeInstanceOf(Basemap);
    });
  });
});

describe('makeKeylessBasemap', () => {
  it('names a base with no Esri service URL, so it needs no token', () => {
    // 'osm' is the one built-in whose layer is a plain OpenStreetMap tile
    // layer; every imagery base points at services.arcgisonline.com.
    expect(makeKeylessBasemap()).toBe('osm');
  });
});

describe('isOfflineRequested', () => {
  it('is false without the flag and true with it', () => {
    withSearch('', () => expect(isOfflineRequested()).toBe(false));
    withSearch('?offline=1', () => expect(isOfflineRequested()).toBe(true));
  });
});
