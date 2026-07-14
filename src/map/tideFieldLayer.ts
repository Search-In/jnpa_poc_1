/**
 * tideFieldLayer — the ArcGIS MediaLayer that carries the interpolated tide/
 * sea-state raster (see tideField.ts). A MediaLayer + a canvas-backed ImageElement
 * georeferenced to the water-side FIELD_EXTENT renders the field as a continuous
 * surface in BOTH the 2D MapView and the 3D SceneView (MediaLayer supports both),
 * INCOIS-OSF style. Isolated here so scene3d/AISMap share one builder + updater.
 */

import MediaLayer from '@arcgis/core/layers/MediaLayer';
import LocalMediaElementSource from '@arcgis/core/layers/support/LocalMediaElementSource';
import ImageElement from '@arcgis/core/layers/support/ImageElement';
import ExtentAndRotationGeoreference from '@arcgis/core/layers/support/ExtentAndRotationGeoreference';
import Extent from '@arcgis/core/geometry/Extent';
import type { TideStation } from '@/types/domain';
import { FIELD_EXTENT, type FieldVar, renderFieldCanvas } from './tideField';

function georef(): ExtentAndRotationGeoreference {
  return new ExtentAndRotationGeoreference({
    extent: new Extent({ ...FIELD_EXTENT, spatialReference: { wkid: 4326 } }),
  });
}

/**
 * Build the media layer with an explicit LocalMediaElementSource. The source's
 * `elements` collection is EDITED in place afterwards — MediaLayer rejects a
 * reassignment of `layer.source` once the layer has loaded ("source cannot be
 * changed after the layer is loaded"), so we mutate the collection instead.
 * Off by default — toggled from the map controls.
 */
export function tideFieldLayer(): MediaLayer {
  return new MediaLayer({
    title: 'Tide & Sea State',
    visible: false,
    source: new LocalMediaElementSource({ elements: [] }),
  });
}

/**
 * Re-render the raster image from the current stations + selected variable and
 * swap it into the layer's element collection (not by reassigning `.source`).
 * Returns the value range so the caller can update the colorbar. Clears the
 * image when there are no stations.
 */
export function updateTideField(
  layer: MediaLayer,
  stations: TideStation[],
  v: FieldVar,
): [number, number] | null {
  const source = layer.source as LocalMediaElementSource;
  const elements = source.elements;
  const rendered = renderFieldCanvas(stations, v);
  if (!rendered) {
    elements.removeAll();
    return null;
  }
  const element = new ImageElement({
    image: rendered.canvas,
    georeference: georef(),
  });
  // Replace the single field image in place.
  elements.removeAll();
  elements.add(element);
  return rendered.range;
}
