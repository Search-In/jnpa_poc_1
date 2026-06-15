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
import { CRAFT_SPRITES, GLYPHS, VESSEL_SPRITES, spriteForVesselType } from '@/assets/registry';

const JNPA_CENTER = '72.95,18.95';

/** Icons shown in the map legend. */
const LEGEND_SPRITES = [
  { label: 'Container', sprite: VESSEL_SPRITES.container },
  { label: 'Bulk carrier', sprite: VESSEL_SPRITES.bulk },
  { label: 'Tanker', sprite: VESSEL_SPRITES.tanker },
  { label: 'Tug', sprite: CRAFT_SPRITES.tug },
  { label: 'Pilot', sprite: CRAFT_SPRITES.pilot },
  { label: 'Mooring', sprite: CRAFT_SPRITES.mooring },
  { label: 'Anchored', sprite: GLYPHS.anchor },
  { label: 'Berth', sprite: GLYPHS.berth },
];

interface ArcgisMapElement extends HTMLElement {
  view?: MapView;
  map?: EsriMap | WebMap;
}

interface ArcgisViewReadyEvent extends CustomEvent {
  target: ArcgisMapElement;
}

const VESSEL_POPUP = {
  title: '{VESSEL_NAME} ({VESSEL_TYPE})',
  content: [
    {
      type: 'fields' as const,
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
};

/** Status halo drawn behind the sprite so NAV_STATUS stays readable. */
function haloSymbol(status: Vessel['NAV_STATUS']) {
  return {
    type: 'simple-marker' as const,
    color: navStatusColor[status] ?? tokens.accent,
    size: 16,
    outline: { color: '#ffffff', width: 1 },
  };
}

/** The realistic top-down vessel sprite, rotated to the vessel's heading. */
function spriteSymbol(v: Vessel) {
  const sprite = spriteForVesselType(v.VESSEL_TYPE);
  // ArcGIS picture-marker `angle` is clockwise from north — same convention as
  // AIS heading — and our sprites are drawn bow-up, so heading maps 1:1.
  const angle = v.HEADING || v.COG || 0;
  return {
    type: 'picture-marker' as const,
    url: sprite.url,
    width: sprite.width,
    height: sprite.height,
    angle,
  };
}

/**
 * A vessel renders as up to two stacked graphics: a status halo, the rotated
 * sprite, and (when anchored) an anchor glyph instead of a heading sprite.
 * Returns them as an array so the caller can add them all to the layer.
 */
function vesselToGraphics(v: Vessel): Graphic[] {
  const geometry = new Point({ longitude: v.LON, latitude: v.LAT });
  const attributes = { ...v };
  const halo = new Graphic({ geometry, attributes, symbol: haloSymbol(v.NAV_STATUS) });

  if (v.NAV_STATUS === 'anchored') {
    const anchor = new Graphic({
      geometry,
      attributes,
      symbol: {
        type: 'picture-marker',
        url: GLYPHS.anchor.url,
        width: GLYPHS.anchor.width,
        height: GLYPHS.anchor.height,
      },
      popupTemplate: VESSEL_POPUP,
    });
    return [halo, anchor];
  }

  const sprite = new Graphic({
    geometry,
    attributes,
    symbol: spriteSymbol(v),
    popupTemplate: VESSEL_POPUP,
  });
  return [halo, sprite];
}

/** Berth renders as a footprint polygon plus a quay/bollard marker at centroid. */
function berthToGraphics(b: Berth): Graphic[] {
  const polygon = new Polygon({ rings: [b.GEOM], spatialReference: { wkid: 4326 } });
  const attributes = { ...b };
  const popupTemplate = {
    title: '{BERTH_NAME} — {TERMINAL}',
    content: 'Status: {STATUS} · Length {LENGTH_M} m · Draft {DRAFT_M} m',
  };
  const footprint = new Graphic({
    geometry: polygon,
    attributes,
    symbol: {
      type: 'simple-fill',
      color: [0, 121, 193, 0.15],
      outline: { color: tokens.accent, width: 1.5 },
    },
    popupTemplate,
  });
  const marker = new Graphic({
    geometry: polygon.centroid ?? new Point({ longitude: b.GEOM[0][0], latitude: b.GEOM[0][1] }),
    attributes,
    symbol: {
      type: 'picture-marker',
      url: GLYPHS.berth.url,
      width: GLYPHS.berth.width,
      height: GLYPHS.berth.height,
    },
    popupTemplate,
  });
  return [footprint, marker];
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
        .then((berths) => berthLayer.addMany(berths.flatMap(berthToGraphics)))
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
    layer.addMany(vessels.flatMap(vesselToGraphics));
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
        <div style={{ borderTop: `1px solid ${tokens.border}`, marginTop: 6, paddingTop: 6 }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: tokens.text }}>Vessel type</div>
          {LEGEND_SPRITES.map(({ label, sprite }) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <img
                src={sprite.url}
                alt=""
                aria-hidden
                style={{ width: 12, height: 'auto', maxHeight: 18 }}
              />
              <span style={{ color: tokens.textMuted }}>{label}</span>
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
