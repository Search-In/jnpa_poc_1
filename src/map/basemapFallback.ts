/**
 * basemapFallback — ArcGIS token-death / offline survival (spec §A4 / B1.3: the
 * known single point of failure). The online Esri basemaps fetch tiles from
 * Esri's CDN and need a valid token; on a venue with no Wi-Fi, or when the ArcGIS
 * trial token expires mid-demo, those tiles blank out. This module:
 *   1. `initialBasemap()` — online 'hybrid' normally, or an instant local
 *      basemap when `?offline=1` (so the fallback is rehearsable before the demo,
 *      the "simulate token expiry" dev toggle).
 *   2. `installBasemapFallback(view)` — watches the view; on a genuine basemap
 *      load / layerview-create failure it swaps in the local Basemap so the
 *      operational marine layers (channel, berths, vessels, anchorage) stay
 *      fully legible on a neutral sea-toned canvas — the map never goes blank.
 *
 * The local base is a single full-extent graphic in a dark sea tone (no external
 * tiles, no token) — an honest "bundled offline basemap".
 */
import Basemap from '@arcgis/core/Basemap';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Extent from '@arcgis/core/geometry/Extent';
import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol';
import TileLayer from '@arcgis/core/layers/TileLayer';
import type MapView from '@arcgis/core/views/MapView';
import type SceneView from '@arcgis/core/views/SceneView';

/** True when the operator asked for the offline rehearsal (`?offline=1`). */
export function isOfflineRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('offline') === '1';
  } catch {
    return false;
  }
}

/**
 * A fully local Basemap: one world-covering polygon in a light neutral water tone
 * (matching the Calcite-light shell) with no external tile source. Renders
 * instantly, needs no token — the operational layers draw on top.
 */
export function makeOfflineBasemap(): Basemap {
  const bg = new GraphicsLayer({ title: 'Offline base (local, no tiles)' });
  bg.add(
    new Graphic({
      geometry: new Extent({
        xmin: -20037508, ymin: -20037508, xmax: 20037508, ymax: 20037508,
        spatialReference: { wkid: 3857 },
      }),
      symbol: new SimpleFillSymbol({
        color: [222, 232, 240, 1], // light neutral water — reads under the light UI
        outline: { color: [198, 210, 220, 1], width: 0.5 },
      }),
    }),
  );
  return new Basemap({
    baseLayers: [bg],
    title: 'Offline (bundled, no external tiles)',
    id: 'jnpa-uc1-offline',
  });
}

/**
 * Esri's public imagery service — the one that answers anonymously.
 *
 * Verified with a live request: `…/World_Imagery/MapServer` and its tiles both
 * return HTTP 200 with real bytes and no token.
 */
export const WORLD_IMAGERY_URL =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';

/**
 * Satellite imagery with no API key.
 *
 * WHY THIS IS BUILT BY HAND rather than `basemap: 'hybrid'`. As of ArcGIS JS
 * 4.29 the well-known basemap IDs ('hybrid', 'satellite', 'streets', …) no
 * longer resolve to the old arcgisonline services — they resolve to the
 * **basemap styles service**, `basemapstyles-api.arcgis.com`, which REQUIRES an
 * API key. Without one it answers **401**, `Basemap.load()` rejects, and the
 * console shows:
 *
 *   [esri.Basemap] #load() Failed to load basemap (title: 'Basemap', id: 'hybrid')
 *
 * Every map in the app then falls through to `installBasemapFallback` and
 * renders the bundled flat grey. That is the real cause of "the map tiles take
 * too long to load, or sometimes just don't load" — they were never going to
 * load. Measured directly from the page:
 *
 *   basemapstyles-api.arcgis.com/…/styles/arcgis/imagery   401
 *   services.arcgisonline.com/…/World_Imagery/MapServer     200
 *   services.arcgisonline.com/…/World_Imagery/tile/10/…     200  image/jpeg
 *
 * So the tile layer is named explicitly. This is not a downgrade or a
 * workaround for a missing key — it is the same imagery the old 'hybrid' ID
 * used to serve, requested from the endpoint that still serves it anonymously.
 *
 * Setting `VITE_ARCGIS_API_KEY` does not change this and does not need to; if
 * the org ever gets a key, `esriConfig.apiKey` plus the string IDs would work
 * again, and this stays correct either way.
 */
export function makeKeylessBasemap(): Basemap {
  return new Basemap({
    baseLayers: [new TileLayer({ url: WORLD_IMAGERY_URL, title: 'World imagery' })],
    title: 'Imagery',
    id: 'jnpa-imagery',
  });
}

/**
 * The basemap to start with:
 *   • `?offline=1` → bundled local base (no tiles at all)
 *   • otherwise    → keyless Esri satellite imagery
 */
export function initialBasemap(): Basemap {
  if (isOfflineRequested()) return makeOfflineBasemap();
  return makeKeylessBasemap();
}

/**
 * Watch the view and swap to the local offline basemap ONLY on a genuine load
 * failure — a bad/expired token, or the base tile layer failing to create its
 * LayerView (network/token death). Deliberately does NOT use a `view.updating`
 * timeout (that false-positives on ordinary pan/zoom + tile streaming).
 * Idempotent; returns a cleanup fn. `onFallback` fires once so the caller can
 * surface an "offline basemap engaged" badge.
 */
export function installBasemapFallback(
  view: MapView | SceneView,
  opts: { onFallback?: () => void } = {},
): () => void {
  if (isOfflineRequested()) {
    opts.onFallback?.();
    return () => {};
  }
  let swapped = false;
  const handles: Array<{ remove: () => void }> = [];

  const swap = (reason: string) => {
    if (swapped || !view.map) return;
    swapped = true;
     
    console.warn(`[basemapFallback] online basemap unavailable (${reason}); engaging local offline basemap.`);
    try {
      view.map.basemap = makeOfflineBasemap();
    } catch {
      /* view may be tearing down */
    }
    opts.onFallback?.();
  };

  view
    .when()
    .then(() => {
      const bm = view.map?.basemap;
      if (!bm) return;
      if (typeof bm.load === 'function') {
        bm.load().catch(() => swap('basemap load rejected'));
      }
      const h = view.on('layerview-create-error', (e: __esri.ViewLayerviewCreateErrorEvent) => {
        const inBasemap = bm.baseLayers?.includes(e.layer) || bm.referenceLayers?.includes(e.layer);
        if (inBasemap) swap('base layerview-create-error');
      });
      handles.push(h);
    })
    .catch(() => swap('view failed to initialise'));

  return () => {
    handles.forEach((h) => h.remove());
  };
}
