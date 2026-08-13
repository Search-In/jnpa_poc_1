/**
 * The walkthrough's basemap — how many tile services it asks for, and whether
 * there is ever a moment where the ground is white.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import { groundUnderlayLayer, vrBasemap, WORLD_IMAGERY_URL } from './vrBasemap';
import { PORT_CENTER } from '@/map/portGeometry';

/** How many of the basemap's layers actually fetch tiles. */
function tileLayerCount(basemap: { baseLayers: { toArray(): unknown[] } }): number {
  return basemap.baseLayers
    .toArray()
    .filter((l) => (l as { type?: string }).type === 'tile').length;
}

const originalSearch = window.location.search;

afterEach(() => {
  if (window.location.search !== originalSearch) {
    window.history.replaceState({}, '', window.location.pathname);
  }
});

describe('groundUnderlayLayer', () => {
  it('is a single bundled polygon — no request, no token', () => {
    const layer = groundUnderlayLayer();
    expect(layer.graphics.length).toBe(1);
    expect(layer.type).toBe('graphics');
  });

  it('covers the whole area the walkthrough can reach', () => {
    const layer = groundUnderlayLayer();
    const extent = layer.graphics.getItemAt(0)!.geometry!.extent!;
    // The camera never leaves JNPA — the outer anchorage is the furthest it
    // goes — so the underlay only has to cover the port, not the world.
    expect(extent.xmin).toBeLessThan(PORT_CENTER[0] - 0.2);
    expect(extent.xmax).toBeGreaterThan(PORT_CENTER[0] + 0.2);
    expect(extent.ymin).toBeLessThan(PORT_CENTER[1] - 0.2);
    expect(extent.ymax).toBeGreaterThan(PORT_CENTER[1] + 0.2);
  });

  it('is hidden from the layer list — it is scenery, not an operational layer', () => {
    expect(groundUnderlayLayer().listMode).toBe('hide');
  });
});

describe('vrBasemap', () => {
  it('puts the bundled ground BENEATH the imagery', () => {
    const bm = vrBasemap({ underlay: true });
    const layers = bm.baseLayers.toArray();
    // Order is the whole point: below the imagery it is a backdrop that the
    // tiles paint over; above it, it would hide the port.
    expect((layers[0] as GraphicsLayer).type).toBe('graphics');
    expect((layers[1] as { url?: string }).url).toBe(WORLD_IMAGERY_URL);
  });

  it('asks for exactly one tile service, on any link', () => {
    const bm = vrBasemap({ underlay: true });
    expect(tileLayerCount(bm)).toBe(1);
    // The dashboard's 'hybrid' adds a reference tile service for place names.
    // The walkthrough never asks for it: labels are drawn in screen space, so in
    // a first-person scene they hang in the sky, and through a cardboard lens
    // they are unreadable. What matters is labelled in 3D from the impact model.
    expect(bm.referenceLayers.length).toBe(0);
  });

  it('can be built without the underlay', () => {
    const bm = vrBasemap({ underlay: false });
    expect(bm.baseLayers.length).toBe(1);
    expect(tileLayerCount(bm)).toBe(1);
  });

  it('uses the public imagery service — the one that answers without a key', () => {
    // Verified anonymous: this is why the 3D views have always worked with no
    // ArcGIS API key, and why an earlier "the ground is white so it must be
    // auth" diagnosis was wrong.
    expect(WORLD_IMAGERY_URL).toContain('services.arcgisonline.com');
    expect(WORLD_IMAGERY_URL).toContain('World_Imagery');
  });

  it('honours the offline rehearsal switch', () => {
    window.history.replaceState({}, '', `${window.location.pathname}?offline=1`);
    const bm = vrBasemap({ underlay: true });
    // `?offline=1` must behave here exactly as it does on the dashboard: no
    // external tiles at all.
    expect(tileLayerCount(bm)).toBe(0);
    expect(bm.id).toBe('jnpa-uc1-offline');
  });
});
