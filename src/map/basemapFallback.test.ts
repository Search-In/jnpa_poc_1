/**
 * `initialBasemap()` — the "the map tiles don't load" bug.
 *
 * As of ArcGIS JS 4.29 the well-known basemap IDs ('hybrid', 'satellite', …) no
 * longer resolve to the old arcgisonline services; they resolve to the basemap
 * STYLES service, which requires an API key and answers **401** without one.
 * Measured live from the running page:
 *
 *   basemapstyles-api.arcgis.com/…/styles/arcgis/imagery   401
 *   services.arcgisonline.com/…/World_Imagery/MapServer     200
 *   services.arcgisonline.com/…/World_Imagery/tile/10/…     200  image/jpeg
 *
 * So every map in the app was failing its basemap load and falling through to
 * the bundled flat grey. These tests pin the fix: name the anonymous service
 * explicitly, never a string ID.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Basemap from '@arcgis/core/Basemap';
import {
  initialBasemap,
  isOfflineRequested,
  makeKeylessBasemap,
  makeOfflineBasemap,
  WORLD_IMAGERY_URL,
} from './basemapFallback';

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

describe('makeKeylessBasemap', () => {
  it('names the imagery service directly, never a string ID', () => {
    // A string ID goes to basemapstyles-api and 401s. This is the whole fix.
    const bm = makeKeylessBasemap();
    expect(bm).toBeInstanceOf(Basemap);
    expect(bm.baseLayers.length).toBe(1);
    expect((bm.baseLayers.getItemAt(0) as { url?: string }).url).toBe(WORLD_IMAGERY_URL);
  });

  it('points at the endpoint that answers anonymously', () => {
    expect(WORLD_IMAGERY_URL).toContain('services.arcgisonline.com');
    expect(WORLD_IMAGERY_URL).toContain('World_Imagery');
    expect(WORLD_IMAGERY_URL).not.toContain('basemapstyles');
  });

  it('is real satellite imagery, not a street-map substitute', () => {
    // An earlier attempt fell back to 'osm' on the theory that imagery needed a
    // key. It does not — the imagery service is anonymous; only the styles
    // service is gated.
    const layer = makeKeylessBasemap().baseLayers.getItemAt(0) as { type?: string };
    expect(layer.type).toBe('tile');
  });
});

describe('initialBasemap', () => {
  it('serves keyless satellite imagery by default', () => {
    const bm = initialBasemap();
    expect(bm).toBeInstanceOf(Basemap);
    expect((bm.baseLayers.getItemAt(0) as { url?: string }).url).toBe(WORLD_IMAGERY_URL);
  });

  it('prefers the bundled offline base when ?offline=1', () => {
    withSearch('?offline=1', () => {
      const bm = initialBasemap();
      expect(bm).toBeInstanceOf(Basemap);
      expect(bm.id).toBe('jnpa-uc1-offline');
      // No external tile service at all in the offline rehearsal.
      expect(bm.baseLayers.some((l) => (l as { type?: string }).type === 'tile')).toBe(false);
    });
  });
});

describe('makeOfflineBasemap', () => {
  it('renders instantly from bundled geometry, with no tile request', () => {
    const bm = makeOfflineBasemap();
    expect(bm.baseLayers.length).toBe(1);
    expect((bm.baseLayers.getItemAt(0) as { type?: string }).type).toBe('graphics');
  });
});

describe('isOfflineRequested', () => {
  it('is false without the flag and true with it', () => {
    withSearch('', () => expect(isOfflineRequested()).toBe(false));
    withSearch('?offline=1', () => expect(isOfflineRequested()).toBe(true));
  });
});
