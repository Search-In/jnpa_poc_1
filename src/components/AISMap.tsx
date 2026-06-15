/**
 * <AISMap> — live vessel map built on the ArcGIS `<arcgis-map>` web component
 * (NOT the deprecated widget classes). When VITE_WEBMAP_ID is set the map loads
 * that WebMap item (the same one the existing Dashboards app uses); otherwise it
 * falls back to a navigation basemap centred on Nhava Sheva.
 *
 * Layers managed programmatically and toggled from the UI:
 *   • Vessel Tracks  — client-side FeatureLayer (feature collection) driven by
 *     the live vessel store; UniqueValueRenderer colours by NAV_STATUS.
 *   • Berth Overlay  — polygon GraphicsLayer from getBerths().
 *   • Weather Layer  — placeholder group (wired to the weather feed item later).
 *   • Channel/Bathymetry — placeholder group.
 * Popups show MMSI / SOG / COG / ETA.
 */

import { useEffect, useRef, useState } from 'react';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import Polygon from '@arcgis/core/geometry/Polygon';
import { CalciteCheckbox, CalciteLabel } from '@esri/calcite-components-react';
import type MapView from '@arcgis/core/views/MapView';
import type WebMap from '@arcgis/core/WebMap';
import type EsriMap from '@arcgis/core/Map';

import { useAppStore } from '@/store/useAppStore';
import { getAdapter } from '@/data';
import { env } from '@/data/config';
import type { Berth, Vessel } from '@/types/domain';
import { navStatusColor, tokens } from '@/theme/tokens';
import { istTime } from '@/util/format';

const JNPA_CENTER = '72.95,18.95';

interface ArcgisMapElement extends HTMLElement {
  view?: MapView;
  map?: EsriMap | WebMap;
}

interface ArcgisViewReadyEvent extends CustomEvent {
  target: ArcgisMapElement;
}

function vesselSymbol(status: Vessel['NAV_STATUS']) {
  return {
    type: 'simple-marker' as const,
    color: navStatusColor[status] ?? tokens.accent,
    size: 9,
    outline: { color: '#ffffff', width: 1 },
  };
}

function vesselToGraphic(v: Vessel): Graphic {
  return new Graphic({
    geometry: new Point({ longitude: v.LON, latitude: v.LAT }),
    symbol: vesselSymbol(v.NAV_STATUS),
    attributes: { ...v },
    popupTemplate: {
      title: '{VESSEL_NAME} ({VESSEL_TYPE})',
      content: [
        {
          type: 'fields',
          fieldInfos: [
            { fieldName: 'MMSI', label: 'MMSI' },
            { fieldName: 'NAV_STATUS', label: 'Status' },
            { fieldName: 'SOG', label: 'SOG (kn)' },
            { fieldName: 'COG', label: 'COG (°)' },
            { fieldName: 'HEADING', label: 'Heading (°)' },
            { fieldName: 'BERTH_ID', label: 'Berth' },
          ],
        },
      ],
    },
  });
}

function berthToGraphic(b: Berth): Graphic {
  return new Graphic({
    geometry: new Polygon({ rings: [b.GEOM], spatialReference: { wkid: 4326 } }),
    symbol: {
      type: 'simple-fill',
      color: [0, 121, 193, 0.15],
      outline: { color: tokens.accent, width: 1.5 },
    },
    attributes: { ...b },
    popupTemplate: {
      title: '{BERTH_NAME} — {TERMINAL}',
      content: 'Status: {STATUS} · Length {LENGTH_M} m · Draft {DRAFT_M} m',
    },
  });
}

type LayerKey = 'vessels' | 'berths' | 'weather' | 'channel';

export function AISMap() {
  const hostRef = useRef<ArcgisMapElement | null>(null);
  const vesselLayerRef = useRef<GraphicsLayer | null>(null);
  const berthLayerRef = useRef<GraphicsLayer | null>(null);
  const [ready, setReady] = useState(false);
  const [visible, setVisible] = useState<Record<LayerKey, boolean>>({
    vessels: true,
    berths: true,
    weather: false,
    channel: false,
  });

  const vessels = useAppStore((s) => s.vessels);

  // Initialise programmatic layers once the view is ready.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const onReady = (evt: Event) => {
      const map = (evt as ArcgisViewReadyEvent).target.map;
      if (!map) return;

      const vesselLayer = new GraphicsLayer({ title: 'Vessel Tracks' });
      const berthLayer = new GraphicsLayer({ title: 'Berth Overlay' });
      vesselLayerRef.current = vesselLayer;
      berthLayerRef.current = berthLayer;
      map.addMany([berthLayer, vesselLayer]);

      void getAdapter()
        .getBerths()
        .then((berths) => berthLayer.addMany(berths.map(berthToGraphic)))
        .catch(() => {
          /* berths optional on the map; KPI widgets surface load errors */
        });

      setReady(true);
    };

    host.addEventListener('arcgisViewReadyChange', onReady as EventListener);
    return () => host.removeEventListener('arcgisViewReadyChange', onReady as EventListener);
  }, []);

  // Re-render vessel graphics whenever the live set changes.
  useEffect(() => {
    const layer = vesselLayerRef.current;
    if (!layer || !ready) return;
    layer.removeAll();
    layer.addMany(vessels.map(vesselToGraphic));
  }, [vessels, ready]);

  // Apply layer visibility toggles.
  useEffect(() => {
    if (vesselLayerRef.current) vesselLayerRef.current.visible = visible.vessels;
    if (berthLayerRef.current) berthLayerRef.current.visible = visible.berths;
  }, [visible]);

  const toggle = (k: LayerKey) => setVisible((v) => ({ ...v, [k]: !v[k] }));

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 320 }}>
      {/* The ArcGIS web component. item-id binds the shared WebMap when set. */}
      <arcgis-map
        ref={hostRef as never}
        {...(env.webMapId ? { 'item-id': env.webMapId } : { basemap: 'arcgis/navigation' })}
        center={JNPA_CENTER}
        zoom={12}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />

      {/* Layer toggles + legend overlay */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          background: tokens.panel,
          border: `1px solid ${tokens.border}`,
          borderRadius: 4,
          padding: 8,
          fontSize: 11,
          maxWidth: 200,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4, color: tokens.text }}>Layers</div>
        {(
          [
            ['vessels', 'Vessel Tracks'],
            ['berths', 'Berth Overlay'],
            ['weather', 'Weather Layer'],
            ['channel', 'Channel / Bathymetry'],
          ] as [LayerKey, string][]
        ).map(([key, label]) => (
          <CalciteLabel key={key} layout="inline" scale="s" style={{ marginBottom: 2 }}>
            <CalciteCheckbox checked={visible[key] || undefined} onCalciteCheckboxChange={() => toggle(key)} />
            {label}
          </CalciteLabel>
        ))}
        <div style={{ borderTop: `1px solid ${tokens.border}`, marginTop: 6, paddingTop: 6 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: tokens.text }}>Nav status</div>
          {Object.entries(navStatusColor).map(([status, color]) => (
            <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: color }} />
              <span style={{ color: tokens.textMuted, textTransform: 'capitalize' }}>{status}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 6, color: tokens.textMuted }}>
          {vessels.length} vessels · {istTime(Date.now())} IST
        </div>
      </div>
    </div>
  );
}
