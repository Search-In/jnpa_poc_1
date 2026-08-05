/**
 * World-route map for container tracking — ArcGIS MapView + GraphicsLayer.
 * Draws the sea path polyline and origin / destination / current markers.
 */

import { useEffect, useRef } from 'react';
import EsriMap from '@arcgis/core/Map';
import MapView from '@arcgis/core/views/MapView';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Polyline from '@arcgis/core/geometry/Polyline';
import Point from '@arcgis/core/geometry/Point';
import SimpleLineSymbol from '@arcgis/core/symbols/SimpleLineSymbol';
import SimpleMarkerSymbol from '@arcgis/core/symbols/SimpleMarkerSymbol';
import { initialBasemap, installBasemapFallback } from '@/map/basemapFallback';
import { tokens } from '@/theme/tokens';
import type { ContainerRoutePoint, ContainerTrackResult } from '@/data/ldb/types';

function buildGraphics(track: ContainerTrackResult): Graphic[] {
  const graphics: Graphic[] = [];
  const path: ContainerRoutePoint[] =
    track.routePath.length > 0
      ? track.routePath
      : track.originLat != null &&
          track.originLng != null &&
          track.destinationLat != null &&
          track.destinationLng != null
        ? [
            { lat: track.originLat, lng: track.originLng },
            { lat: track.destinationLat, lng: track.destinationLng },
          ]
        : [];

  if (path.length >= 2) {
    graphics.push(
      new Graphic({
        geometry: new Polyline({
          paths: [path.map((p) => [p.lng, p.lat])],
          spatialReference: { wkid: 4326 },
        }),
        symbol: new SimpleLineSymbol({
          color: tokens.accent,
          width: 2.5,
          style: 'short-dot',
        }),
      }),
    );
  }

  const addPin = (lat: number | null, lng: number | null, color: string, size = 12) => {
    if (lat == null || lng == null) return;
    graphics.push(
      new Graphic({
        geometry: new Point({ longitude: lng, latitude: lat }),
        symbol: new SimpleMarkerSymbol({
          style: 'circle',
          color,
          size,
          outline: { color: tokens.panel, width: 2 },
        }),
      }),
    );
  };

  addPin(track.originLat, track.originLng, tokens.bad, 14);
  addPin(track.destinationLat, track.destinationLng, tokens.accent, 12);
  // Approximate "current" position mid-route for in-transit demo.
  if (path.length >= 2 && /transit/i.test(track.status)) {
    const mid = path[Math.min(2, path.length - 1)];
    addPin(mid.lat, mid.lng, tokens.bad, 10);
  }

  return graphics;
}

export function ContainerTrackMap({ track }: { track: ContainerTrackResult }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const layerRef = useRef<GraphicsLayer | null>(null);

  useEffect(() => {
    if (!hostRef.current || viewRef.current) return;
    const layer = new GraphicsLayer({ title: 'Container route' });
    layerRef.current = layer;
    const map = new EsriMap({ basemap: initialBasemap(), layers: [layer] });
    const view = new MapView({
      container: hostRef.current,
      map,
      center: [90, 15],
      zoom: 3,
      ui: { components: ['zoom'] },
      constraints: { minZoom: 2, maxZoom: 12 },
    });
    viewRef.current = view;
    installBasemapFallback(view);
    return () => {
      view.destroy();
      viewRef.current = null;
      layerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    const layer = layerRef.current;
    if (!view || !layer) return;
    layer.removeAll();
    const graphics = buildGraphics(track);
    layer.addMany(graphics);

    const pts = track.routePath.length
      ? track.routePath
      : [
          ...(track.originLng != null && track.originLat != null
            ? [{ lat: track.originLat, lng: track.originLng }]
            : []),
          ...(track.destinationLng != null && track.destinationLat != null
            ? [{ lat: track.destinationLat, lng: track.destinationLng }]
            : []),
        ];
    if (pts.length === 0) return;
    const lons = pts.map((p) => p.lng);
    const lats = pts.map((p) => p.lat);
    void view.goTo(
      {
        target: {
          type: 'extent',
          xmin: Math.min(...lons) - 5,
          ymin: Math.min(...lats) - 5,
          xmax: Math.max(...lons) + 5,
          ymax: Math.max(...lats) + 5,
          spatialReference: { wkid: 4326 },
        },
      },
      { animate: true, duration: 600 },
    ).catch(() => {
      /* ignore goTo cancellation */
    });
  }, [track]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 360 }}>
      <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: 12,
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: 14,
          padding: '6px 12px',
          background: tokens.panel,
          border: `1px solid ${tokens.border}`,
          borderRadius: tokens.radius.sm,
          fontSize: 11,
          color: tokens.textMuted,
          zIndex: 1,
          boxShadow: `0 1px 4px ${tokens.shadow}`,
        }}
      >
        <LegendDot color={tokens.warn} label="Truck" />
        <LegendDot color={tokens.accent} label="Vessel" />
        <LegendDot color={tokens.bad} label="Rail" />
        <LegendDot color={tokens.good} label="Others" />
      </div>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }}
      />
      {label}
    </span>
  );
}
