/**
 * PlacePicker — the top-down map you click to plant the viewer.
 *
 * A lightweight 2D `MapView` (cheap to spin up, and unambiguous for choosing a
 * spot) showing the port assets, the impacted assets, and a pin with a facing
 * arrow. Clicking anywhere moves the pin; dragging the heading dial spins it.
 */
import { useEffect, useRef } from 'react';
import Map from '@arcgis/core/Map';
import MapView from '@arcgis/core/views/MapView';
import Graphic from '@arcgis/core/Graphic';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Point from '@arcgis/core/geometry/Point';
import type { Berth } from '@/types/domain';
import { buildPortAssets2dLayer } from '@/map/portAssets2d';
import { initialBasemap } from '@/map/basemapFallback';
import { PORT_CENTER } from '@/map/portGeometry';
import { asset3dPosition } from '@/map/scene3d';
import { tokens } from '@/theme/tokens';
import { useVrStore } from './vrStore';
import { resolveImpactPosition } from './impactLayers';
import type { AssetImpact } from './impactModel';

const SEVERITY_COLOR: Record<string, string> = {
  critical: tokens.bad,
  warn: tokens.warn,
  info: tokens.accent,
};

export function PlacePicker({ impacts, berths }: { impacts: AssetImpact[]; berths: Berth[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const pinRef = useRef<GraphicsLayer | null>(null);
  const impactRef = useRef<GraphicsLayer | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const map = new Map({ basemap: initialBasemap() });
    map.add(buildPortAssets2dLayer());

    const impactLayer = new GraphicsLayer({ title: '_vr_impacts', listMode: 'hide' });
    const pinLayer = new GraphicsLayer({ title: '_vr_pin', listMode: 'hide' });
    map.addMany([impactLayer, pinLayer]);
    impactRef.current = impactLayer;
    pinRef.current = pinLayer;

    const view = new MapView({
      container: containerRef.current,
      map,
      center: PORT_CENTER,
      zoom: 13,
      ui: { components: ['zoom'] },
      popupEnabled: false,
    });
    viewRef.current = view;

    const handle = view.on('click', (e) => {
      if (!e.mapPoint) return;
      useVrStore.getState().place(e.mapPoint.longitude, e.mapPoint.latitude);
    });

    return () => {
      handle.remove();
      view.destroy();
      viewRef.current = null;
      pinRef.current = null;
      impactRef.current = null;
    };
  }, []);

  // Impacted assets, so the operator can choose to stand somewhere meaningful.
  useEffect(() => {
    const layer = impactRef.current;
    if (!layer) return;
    const anchors = asset3dPosition();
    layer.removeAll();
    for (const i of impacts) {
      if (i.severity === 'none') continue;
      const pos = resolveImpactPosition(i, berths, anchors);
      if (!pos) continue;
      layer.add(
        new Graphic({
          geometry: new Point({ longitude: pos[0], latitude: pos[1] }),
          symbol: {
            type: 'simple-marker',
            style: 'circle',
            size: 14,
            color: [0, 0, 0, 0],
            outline: { color: SEVERITY_COLOR[i.severity] ?? tokens.accent, width: 2 },
          } as never,
        })
      );
    }
  }, [impacts, berths]);

  // The viewer pin + facing arrow.
  const longitude = useVrStore((s) => s.longitude);
  const latitude = useVrStore((s) => s.latitude);
  const heading = useVrStore((s) => s.heading);
  useEffect(() => {
    const layer = pinRef.current;
    if (!layer) return;
    layer.removeAll();
    layer.add(
      new Graphic({
        geometry: new Point({ longitude, latitude }),
        symbol: {
          type: 'simple-marker',
          style: 'circle',
          size: 12,
          color: tokens.accent,
          outline: { color: '#fff', width: 2 },
        } as never,
      })
    );
    // A triangle rotated to the look bearing — reads as "you are facing this way".
    layer.add(
      new Graphic({
        geometry: new Point({ longitude, latitude }),
        symbol: {
          type: 'simple-marker',
          style: 'triangle',
          size: 20,
          color: tokens.accent,
          outline: { color: '#fff', width: 1 },
          // Esri marker angle is clockwise from north, same as our heading.
          angle: heading,
          yoffset: 14,
        } as never,
      })
    );
  }, [longitude, latitude, heading]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
