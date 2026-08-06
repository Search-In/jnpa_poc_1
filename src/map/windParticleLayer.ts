/**
 * windParticleLayer — ArcGIS MediaLayer carrying the Zoom Earth–style wind
 * particle canvas georeferenced to FIELD_EXTENT. Shared by AISMap (2D) and
 * PortScene (3D).
 */

import MediaLayer from '@arcgis/core/layers/MediaLayer';
import LocalMediaElementSource from '@arcgis/core/layers/support/LocalMediaElementSource';
import ImageElement from '@arcgis/core/layers/support/ImageElement';
import ExtentAndRotationGeoreference from '@arcgis/core/layers/support/ExtentAndRotationGeoreference';
import Extent from '@arcgis/core/geometry/Extent';
import { fetchWindGrid, type WindGrid } from '@/data/windField';
import { FIELD_EXTENT } from './tideField';
import {
  startWindAnimation,
  WIND_CANVAS_H,
  WIND_CANVAS_W,
  type WindParticleHandle,
} from './windParticles';

function georef(): ExtentAndRotationGeoreference {
  return new ExtentAndRotationGeoreference({
    extent: new Extent({ ...FIELD_EXTENT, spatialReference: { wkid: 4326 } }),
  });
}

export function windParticleLayer(): MediaLayer {
  return new MediaLayer({
    title: 'Wind (particles)',
    visible: false,
    opacity: 0.92,
    source: new LocalMediaElementSource({ elements: [] }),
  });
}

export interface WindLayerController {
  /** Fetch grid (if needed) and start the particle loop. */
  start: () => Promise<void>;
  stop: () => void;
  setVisible: (v: boolean) => void;
  destroy: () => void;
  /** Latest grid speed max (kn), or null before first fetch. */
  speedMax: () => number | null;
}

/**
 * Bind animation lifecycle to a MediaLayer. Mutates the layer's element
 * collection in place (MediaLayer rejects source reassignment after load).
 */
export function bindWindParticleLayer(layer: MediaLayer): WindLayerController {
  let handle: WindParticleHandle | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let grid: WindGrid | null = null;
  let starting: Promise<void> | null = null;
  let alive = true;

  const pushFrame = () => {
    if (!canvas || !alive) return;
    const source = layer.source as LocalMediaElementSource;
    const elements = source.elements;
    const element = new ImageElement({
      image: canvas,
      georeference: georef(),
    });
    elements.removeAll();
    elements.add(element);
  };

  const stopAnim = () => {
    handle?.stop();
    handle = null;
  };

  const start = async () => {
    if (!alive) return;
    if (handle) return;
    if (starting) return starting;
    starting = (async () => {
      try {
        grid = await fetchWindGrid();
        if (!alive) return;
        if (!canvas) {
          canvas = document.createElement('canvas');
          canvas.width = WIND_CANVAS_W;
          canvas.height = WIND_CANVAS_H;
        }
        stopAnim();
        handle = startWindAnimation(canvas, grid, { onFrame: pushFrame });
        pushFrame();
      } finally {
        starting = null;
      }
    })();
    return starting;
  };

  return {
    start,
    stop: () => {
      stopAnim();
      const source = layer.source as LocalMediaElementSource;
      source.elements.removeAll();
    },
    setVisible: (v: boolean) => {
      layer.visible = v;
      if (v) void start();
      else {
        stopAnim();
      }
    },
    destroy: () => {
      alive = false;
      stopAnim();
      canvas = null;
      grid = null;
    },
    speedMax: () => grid?.speedMax ?? null,
  };
}
