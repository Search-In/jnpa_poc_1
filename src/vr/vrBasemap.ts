/**
 * The walkthrough's basemap, budgeted for the link it has to arrive over.
 *
 * THE PROBLEM THIS SOLVES. A SceneView's ground is white until its basemap tiles
 * arrive. On a demo laptop that is a few hundred milliseconds and nobody notices.
 * On 3G it is ten or twenty seconds of a viewer standing in a white void with the
 * cranes floating in it — and in stereo it happens twice, at different times,
 * because the two views are racing each other for the same pipe. "Map tiles take
 * too long to load, or sometimes just don't load" and "one side renders late" are
 * the same symptom seen from two angles.
 *
 * Three things happen here:
 *
 *  1. **A bundled ground underlay.** One flat sea-and-land-toned polygon over the
 *    port, as the FIRST base layer, so the ground is a plausible colour from the
 *    very first frame and the imagery paints over it as it streams. Costs one
 *    polygon and zero requests. It is not a substitute for the imagery — it is
 *    what stops the absence of imagery reading as a broken view.
 *  2. **No place-label overlay.** The dashboard's `'hybrid'` basemap is imagery
 *    PLUS a reference tile service for place names. That is a second tile
 *    service per view — four in a stereo pair — for text that does not belong in
 *    this view in any case: labels are drawn in screen space, so in a
 *    first-person scene they hang in the sky over the port, and through a
 *    cardboard lens they are unreadable. The walkthrough labels what matters
 *    itself, in 3D, from the impact model. So this is unconditional, not a
 *    budget decision.
 *  3. **An explicit imagery layer** rather than the `'satellite'` string, so the
 *    underlay can sit beneath it deterministically instead of being inserted into
 *    a collection that populates asynchronously.
 *
 * No API key is involved: `World_Imagery` answers anonymously (verified), which
 * is why the dashboard's 3D view has always worked without one.
 */
import Basemap from '@arcgis/core/Basemap';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Polygon from '@arcgis/core/geometry/Polygon';
import SimpleFillSymbol from '@arcgis/core/symbols/SimpleFillSymbol';
import TileLayer from '@arcgis/core/layers/TileLayer';
import { PORT_CENTER } from '@/map/portGeometry';
import {
  isOfflineRequested,
  makeOfflineBasemap,
  WORLD_IMAGERY_URL,
} from '@/map/basemapFallback';

export { WORLD_IMAGERY_URL };

/**
 * Half-width of the underlay, degrees. About 28 km each way from the port
 * centre: comfortably past the outer anchorage and the channel approaches, which
 * is as far as the walkthrough's camera ever goes, and small enough that it is
 * a handful of vertices rather than a world-covering sheet.
 */
const UNDERLAY_HALF_DEG = 0.25;

/**
 * The tone the ground shows before imagery arrives. A desaturated estuarine
 * grey-green: JNPA sits in the Thane creek mudflats, so this is roughly the
 * colour the imagery is about to paint anyway, and the transition is a change of
 * detail rather than a change of scene. A blue would read as open water and make
 * the terminals look like they were floating.
 */
const UNDERLAY_COLOR: [number, number, number, number] = [104, 112, 104, 1];

/** The bundled, request-free ground under the port. */
export function groundUnderlayLayer(): GraphicsLayer {
  const [lng, lat] = PORT_CENTER;
  const d = UNDERLAY_HALF_DEG;
  const layer = new GraphicsLayer({
    title: 'Ground underlay (bundled, no tiles)',
    listMode: 'hide',
  });
  layer.add(
    new Graphic({
      geometry: new Polygon({
        rings: [
          [
            [lng - d, lat - d],
            [lng + d, lat - d],
            [lng + d, lat + d],
            [lng - d, lat + d],
            [lng - d, lat - d],
          ],
        ],
        spatialReference: { wkid: 4326 },
      }),
      symbol: new SimpleFillSymbol({
        color: UNDERLAY_COLOR,
        outline: { width: 0 },
      }),
    })
  );
  return layer;
}

export interface VrBasemapOptions {
  /** Paint the bundled ground under the imagery. */
  underlay: boolean;
}

/**
 * Build the basemap for the walkthrough: one imagery tile service, over a
 * bundled ground.
 *
 * `?offline=1` still short-circuits to the fully bundled base, so the offline
 * rehearsal behaves here exactly as it does on the dashboard.
 */
export function vrBasemap(opts: VrBasemapOptions): Basemap {
  if (isOfflineRequested()) return makeOfflineBasemap();

  return new Basemap({
    baseLayers: [
      ...(opts.underlay ? [groundUnderlayLayer()] : []),
      new TileLayer({ url: WORLD_IMAGERY_URL, title: 'World imagery' }),
    ],
    title: 'Imagery',
    id: 'jnpa-vr-imagery',
  });
}
