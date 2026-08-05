/**
 * <AISMap> — live vessel map built on a programmatic ArcGIS `MapView`
 * (@arcgis/core, the same bundled API PortScene uses for its SceneView — NOT the
 * `<arcgis-map>` web component, which lazy-loads its runtime from the ArcGIS CDN
 * and renders blank when that CDN is unreachable). When VITE_WEBMAP_ID is set the
 * map loads that WebMap item; otherwise it falls back to an imagery basemap
 * centred on Nhava Sheva.
 *
 * Layers managed programmatically and toggled from the UI:
 *   • Vessel Tracks  — client-side FeatureLayer (feature collection) driven by
 *     the live vessel store; UniqueValueRenderer colours by NAV_STATUS.
 *   • Berth Overlay  — polygon GraphicsLayer from getBerths().
 *   • Weather Layer  — placeholder group (wired to the weather feed item later).
 *   • Channel/Bathymetry — placeholder group.
 * Popups show MMSI / SOG / COG / ETA.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Graphic from '@arcgis/core/Graphic';
import Point from '@arcgis/core/geometry/Point';
import Polygon from '@arcgis/core/geometry/Polygon';
import { CalciteCheckbox, CalciteLabel } from '@esri/calcite-components-react';
// Programmatic MapView (same @arcgis/core API PortScene uses for SceneView) —
// deliberately NOT the <arcgis-map> web component, which lazy-loads its runtime
// from the ArcGIS CDN and renders blank when that CDN is unreachable (offline /
// air-gap / slow registration). This keeps the 2D map as robust as the 3D scene.
import MapView from '@arcgis/core/views/MapView';
import EsriMap from '@arcgis/core/Map';
import WebMap from '@arcgis/core/WebMap';

import { useAppStore } from '@/store/useAppStore';
import { useSimStore } from '@/sim/simStore';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { tideFieldLayer, updateTideField } from '@/map/tideFieldLayer';
import { useTideFieldStore } from '@/map/tideFieldStore';
import type MediaLayer from '@arcgis/core/layers/MediaLayer';
import { env } from '@/data/config';
import { asset3dPosition } from '@/map/scene3d';
import { useHighlightIds } from '@/whatif/useHighlight';
import type { Berth, Vessel } from '@/types/domain';
import { navStatusColor, tokens, ukcColor } from '@/theme/tokens';
import { istTime } from '@/util/format';
import { CRAFT_SPRITES, GLYPHS, VESSEL_SPRITES, spriteForVesselType } from '@/assets/registry';
import { buildPortAssets2dLayer, setPortAssets2dVisible } from '@/map/portAssets2d';
import { initialBasemap, installBasemapFallback } from '@/map/basemapFallback';
import { liveVesselLayer2d, renderLiveVessels2d } from '@/map/liveVesselLayer';
import { useLiveVessels } from '@/map/useLiveVessels';

// In live mode, centre on the configured AIS region (which has real coverage);
// in mock mode, centre on Nhava Sheva. Driven by env so it switches to JNPA
// the moment a covering feed is configured.
const JNPA_CENTER = '72.95,18.95';
const initialCenter = env.dataMode === 'live' ? env.liveRegion.center : JNPA_CENTER;
const initialZoom = env.dataMode === 'live' ? env.liveRegion.zoom : 12;

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

/**
 * No `SOURCE` row: it printed the RAW enum ('mock' / 'live'), which is an
 * internal value, not a label — and a vessel's provenance is already carried by
 * the header DataModeChip, the per-panel SourceBadge, and the LIVE tag on real
 * hulls. This popup only ever opens on a simulated vessel anyway: while the live
 * AIS overlay is on, those graphics are removed from the map entirely, and real
 * AIS vessels use their own popup (liveVesselLayer.ts), titled "· live AIS".
 */
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


/** A vessel whose AIS ship type is missing/uncategorised (small craft, or
 *  static data not yet received). These are hidden when the toggle is off. */
function isUnknownType(vesselType: string): boolean {
  const t = vesselType.trim().toLowerCase();
  return t === '' || t === 'unknown';
}

/** Status halo drawn behind the sprite so NAV_STATUS stays readable. */
function haloSymbol(status: Vessel['NAV_STATUS']) {
  return {
    type: 'simple-marker' as const,
    color: navStatusColor[status] ?? tokens.accent,
    size: 16,
    outline: { color: '#ffffff', width: 1 },
  };
}

/**
 * Distinct ring drawn UNDER a real live-AIS vessel (SOURCE==='live'), so genuine
 * traffic is unmistakable next to the simulated fleet. A larger, hollow bright
 * green ring reads as a "live" badge without hiding the vessel's status halo.
 */
function liveRing() {
  return {
    type: 'simple-marker' as const,
    style: 'circle' as const,
    color: [0, 0, 0, 0],
    size: 24,
    outline: { color: '#22c55e', width: 2 },
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
  // Real live-AIS vessels get a green "LIVE" ring drawn first (underneath).
  const badge: Graphic[] =
    v.SOURCE === 'live' ? [new Graphic({ geometry, attributes, symbol: liveRing() })] : [];
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
    return [...badge, halo, anchor];
  }

  const sprite = new Graphic({
    geometry,
    attributes,
    symbol: spriteSymbol(v),
    popupTemplate: VESSEL_POPUP,
  });
  return [...badge, halo, sprite];
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

/** A 2D amber selection ring at [lng,lat] — the flat-map twin of PortScene's
 *  3D `selectionRing`, so a what-if/tour highlight reads the same on both maps. */
function selectionRing2d(lng: number, lat: number): Graphic {
  return new Graphic({
    geometry: new Point({ longitude: lng, latitude: lat }),
    symbol: {
      type: 'simple-marker',
      style: 'circle',
      color: [0, 0, 0, 0],
      size: 34,
      outline: { color: ukcColor.marginal, width: 3 },
    } as never,
  });
}

type LayerKey = 'vessels' | 'assets' | 'berths' | 'weather' | 'channel';

export function AISMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MapView | null>(null);
  const vesselLayerRef = useRef<GraphicsLayer | null>(null);
  const berthLayerRef = useRef<GraphicsLayer | null>(null);
  const assetLayerRef = useRef<GraphicsLayer | null>(null);
  const tideLayerRef = useRef<MediaLayer | null>(null);
  const liveLayerRef = useRef<GraphicsLayer | null>(null);
  const selectionLayerRef = useRef<GraphicsLayer | null>(null);
  const [ready, setReady] = useState(false);
  /**
   * When the configured WebMap can't load (commonly a private item with no
   * sign-in), we fall back to a public basemap so the map + live vessels still
   * render. `mapWarning` surfaces why.
   */
  const [webMapFailed, setWebMapFailed] = useState(false);
  const [mapWarning, setMapWarning] = useState<string | null>(null);
  const [visible, setVisible] = useState<Record<LayerKey, boolean>>({
    vessels: true,
    assets: true,
    berths: true,
    weather: false,
    channel: false,
  });
  // Hide vessels with no/unknown AIS ship type (small craft, or static data not
  // yet received). On by default; operators can turn off the clutter.
  const [showUnknown, setShowUnknown] = useState(true);

  const vessels = useAppStore((s) => s.vessels);
  // Real AIS traffic from the shared gateway (off until the operator toggles it;
  // see the render effect, which swaps it in for the simulated fleet).
  const { vessels: liveVessels, active: liveActive } = useLiveVessels();
  // What-if / guided-tour spotlight ids — ringed on the map, same as PortScene.
  const highlights = useHighlightIds();
  // Tide & sea-state raster field (same feed the Tide tab uses, so map + table
  // stay consistent). Re-fetches on a sim override. `variable` picks the field.
  const simVersion = useSimStore((s) => s.version);
  const { data: tideData } = useAdapterQuery(
    () => getAdapter().getTideStations(),
    [simVersion],
    60_000
  );
  // Memoised on purpose, not to quieten a lint rule — see the identical note in
  // PortScene. `tideData?.stations ?? []` is a new array identity every render
  // and feeds the tide effect below, which rebuilds the MediaLayer raster and
  // writes `setRange` into a store with no equality guard.
  const tideStations = useMemo(() => tideData?.stations ?? [], [tideData]);
  const fieldVar = useTideFieldStore((s) => s.variable);
  const setFieldRange = useTideFieldStore((s) => s.setRange);
  const tideVisible = useTideFieldStore((s) => s.visible);
  const toggleTideVisible = useTideFieldStore((s) => s.toggleVisible);

  // Whether to bind the WebMap: only if configured AND not already failed.
  const useWebMap = Boolean(env.webMapId) && !webMapFailed;

  // Create the MapView programmatically (no CDN web component). Re-runs if the
  // WebMap fails and we fall back to a public basemap.
  useEffect(() => {
    if (!containerRef.current) return;

    const [lon, lat] = initialCenter.split(',').map(Number);

    // Bind the shared WebMap when configured & not already failed; else a basemap
    // that survives offline / token-death: initialBasemap() is a bundled local
    // base when ?offline=1, otherwise 'hybrid' with installBasemapFallback below
    // swapping to the local base on a genuine tile/token failure (same mechanism
    // PortScene uses). So the 2D map is never blank.
    const map: EsriMap | WebMap = useWebMap
      ? new WebMap({ portalItem: { id: env.webMapId } })
      : new EsriMap({ basemap: initialBasemap() });

    const view = new MapView({
      container: containerRef.current,
      map,
      center: [lon, lat],
      zoom: initialZoom,
      // Vessel/berth detail shows in the Esri popup ANCHORED to the clicked
      // feature, inside the map — docking off is disabled so it never floats to
      // the side of the (narrow) map panel.
      popupEnabled: true,
      popup: {
        dockEnabled: false,
        dockOptions: { buttonEnabled: false, breakpoint: false },
        collision: 'reposition',
        alignment: 'auto',
      } as never,
    });
    viewRef.current = view;

    // Swap to the bundled offline base on real basemap failure (token death /
    // no CDN). Fires the warning once so the operator sees the degraded state.
    const teardownFallback = installBasemapFallback(view, {
      onFallback: () => setMapWarning('Offline basemap engaged — external map tiles unavailable.'),
    });

    const vesselLayer = new GraphicsLayer({ title: 'Vessel Tracks' });
    const berthLayer = new GraphicsLayer({ title: 'Berth Overlay' });
    // Static port infrastructure (cranes, yards, gates, trucks, tug, berthed
    // ships) placed from positions.json — the flat twin of the 3D model fleet.
    const assetLayer = buildPortAssets2dLayer();
    // Tide & sea-state raster field (off by default; toggled from the legend).
    const tideLayer = tideFieldLayer();
    // Real AIS traffic — hidden until the overlay is toggled on, and drawn above
    // the simulated fleet (which is hidden while it is on).
    const liveLayer = liveVesselLayer2d();
    liveLayer.visible = false;
    // Selection rings sit ON TOP so a highlighted asset reads over everything.
    const selectionLayer = new GraphicsLayer({ title: '_selection' });
    vesselLayerRef.current = vesselLayer;
    berthLayerRef.current = berthLayer;
    assetLayerRef.current = assetLayer;
    tideLayerRef.current = tideLayer;
    liveLayerRef.current = liveLayer;
    selectionLayerRef.current = selectionLayer;
    map.addMany([berthLayer, assetLayer, tideLayer, vesselLayer, liveLayer, selectionLayer]);

    view
      .when(() => {
        setReady(true);
        void getAdapter()
          .getBerths()
          .then((berths) => berthLayer.addMany(berths.flatMap(berthToGraphics)))
          .catch(() => {
            /* berths optional on the map; KPI widgets surface load errors */
          });
      })
      .catch(() => {
        /* view init interrupted (e.g. unmount); non-fatal */
      });

    // If the WebMap item fails to load (private item / no auth / bad id), drop
    // it and fall back to a public basemap so vessels still render.
    if (useWebMap) {
      (map as WebMap)
        .load()
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          setWebMapFailed(true);
          setMapWarning(`WebMap "${env.webMapId}" failed to load (${msg}). Showing a public basemap.`);
        });
    }

    return () => {
      viewRef.current = null;
      selectionLayerRef.current = null;
      liveLayerRef.current = null;
      tideLayerRef.current = null;
      teardownFallback();
      view.destroy();
    };
  }, [useWebMap]);

  // ---- ring + zoom to highlighted assets (what-if / guided tour) ----
  // Mirrors PortScene's highlight effect: resolve each id via asset3dPosition()
  // (terminals, anchorages, PBG, channel segments), drop an amber ring, and pan
  // to the set. Unresolvable ids are skipped. Runs once the view is ready.
  useEffect(() => {
    const layer = selectionLayerRef.current;
    const view = viewRef.current;
    if (!layer || !view || !ready) return;
    layer.removeAll();
    const pos = asset3dPosition();
    const targets: Point[] = [];
    for (const id of highlights) {
      const p = pos.get(id);
      if (!p) continue;
      layer.add(selectionRing2d(p[0], p[1]));
      targets.push(new Point({ longitude: p[0], latitude: p[1] }));
    }
    if (targets.length) {
      void view.goTo({ target: targets }, { duration: 800 }).catch(() => {});
    }
  }, [highlights, ready]);

  // Re-render vessel graphics whenever the simulated set (or the unknown filter)
  // changes. When the filter is off, drop vessels with no known ship type.
  //
  // While the live-AIS overlay is on the layer is EMPTIED, not merely hidden:
  // this effect re-runs on every sim tick, so leaving the graphics in place and
  // relying on the visibility flag alone would resurrect the simulated fleet the
  // moment anything else touched `visible`.
  useEffect(() => {
    const layer = vesselLayerRef.current;
    if (!layer || !ready) return;
    layer.removeAll();
    if (liveActive) return;
    const shown = showUnknown ? vessels : vessels.filter((v) => !isUnknownType(v.VESSEL_TYPE));
    layer.addMany(shown.flatMap(vesselToGraphics));
  }, [vessels, ready, showUnknown, liveActive]);

  // Re-render the tide/sea-state raster field on reading or variable change.
  useEffect(() => {
    const layer = tideLayerRef.current;
    if (!layer || !ready) return;
    const range = updateTideField(layer, tideStations, fieldVar);
    setFieldRange(range);
  }, [tideStations, fieldVar, ready, setFieldRange]);

  // Live AIS overlay. The simulated fleet is emptied above; the placed dummy
  // assets (yellow crane squares, yard stacks, gates, trucks, the tug and the
  // berthed hero ships) are hidden by the visibility effect below.
  //
  // NOT gated on `ready`: a GraphicsLayer accepts graphics before its view
  // exists, and gating meant a poll that landed early was dropped until the next
  // one 60 s later.
  useEffect(() => {
    const layer = liveLayerRef.current;
    if (!layer) return;
    if (!liveActive) {
      layer.visible = false;
      layer.removeAll();
      return;
    }
    layer.visible = true;
    renderLiveVessels2d(layer, liveVessels);
  }, [liveActive, liveVessels]);

  // Apply layer visibility toggles.
  //
  // The assets layer holds two different things, so it is driven per-graphic:
  // port infrastructure (cranes, yard stacks, gates, gate trucks) follows the
  // "Port Assets" checkbox, while the decorative hulls inside it (berthed hero
  // ships, harbour tug) follow "Vessel Tracks" — unchecking Port Assets is about
  // the port, and must not take the vessels with it.
  //
  // Every VESSEL — simulated fleet and decorative hulls alike — stays hidden
  // while the live overlay is on, so no checkbox can put invented ships back
  // among real AIS positions. Infrastructure is unaffected by the overlay: it is
  // the port, not traffic.
  useEffect(() => {
    const showDummyVessels = visible.vessels && !liveActive;
    if (vesselLayerRef.current) vesselLayerRef.current.visible = showDummyVessels;
    if (berthLayerRef.current) berthLayerRef.current.visible = visible.berths;
    if (assetLayerRef.current) {
      setPortAssets2dVisible(assetLayerRef.current, {
        infrastructure: visible.assets,
        vessels: showDummyVessels,
      });
    }
  }, [visible, liveActive]);

  // The tide raster field's visibility is shared (store-driven) so the map, the
  // legend/colorbar, and the 3D scene stay in lockstep.
  useEffect(() => {
    if (tideLayerRef.current) tideLayerRef.current.visible = tideVisible;
  }, [tideVisible, ready]);

  const toggle = (k: LayerKey) => setVisible((v) => ({ ...v, [k]: !v[k] }));

  // Counts for the legend footer.
  const hiddenUnknown = vessels.filter((v) => isUnknownType(v.VESSEL_TYPE)).length;
  const shownCount = showUnknown ? vessels.length : vessels.length - hiddenUnknown;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 320 }}>
      {/* Programmatic MapView mounts here (see the init effect). A WebMap binds
          when configured & loadable; on failure the effect re-runs with a public
          basemap so the map + live vessels always render. */}
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />

      {/* WebMap load warning + sign-in prompt (e.g. private item, no auth). */}
      {mapWarning && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            bottom: 8,
            left: 8,
            maxWidth: 360,
            background: tokens.panel,
            color: tokens.text,
            border: `1px solid ${tokens.warn}`,
            borderRadius: 4,
            padding: '8px 10px',
            fontSize: 11,
            lineHeight: 1.4,
            boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
          }}
        >
          <div>{mapWarning}</div>
        </div>
      )}

      {/* Coverage stand-in banner — only when the live region isn't JNPA. */}
      {/* {env.dataMode === 'live' && env.liveRegion.isStandIn && (
        <div
          role="note"
          style={{
            position: 'absolute',
            top: 8,
            left: 8,
            maxWidth: 320,
            background: tokens.warn,
            color: '#1a1a1a',
            border: `1px solid ${tokens.border}`,
            borderRadius: 4,
            padding: '6px 10px',
            fontSize: 11,
            lineHeight: 1.35,
            boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
          }}
        >
          <strong>Live AIS — {env.liveRegion.label}.</strong> Free public AIS has no
          coverage over JNPA/Indian waters, so real-time vessels are shown here as a
          coverage demo. Switch to JNPA geography once a Velocity/licensed feed is configured.
        </div>
      )} */}

      {/* Layer toggles + legend overlay. Offset down-left so it clears the
          map-mode control bar that floats at the map's top-right (see App.tsx). */}
      <div
        style={{
          position: 'absolute',
          top: 58,
          right: 8,
          background: tokens.panel,
          border: `1px solid ${tokens.border}`,
          borderRadius: 4,
          padding: 8,
          fontSize: 11,
          maxWidth: 200,
          maxHeight: 'calc(100% - 70px)',
          overflowY: 'auto',
          zIndex: 4,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4, color: tokens.text }}>Layers</div>
        {(
          [
            ['vessels', 'Vessel Tracks'],
            ['assets', 'Port Assets'],
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
        {/* Store-driven so it stays in lockstep with the 3D scene + the colorbar. */}
        <CalciteLabel layout="inline" scale="s" style={{ marginBottom: 2 }}>
          <CalciteCheckbox checked={tideVisible || undefined} onCalciteCheckboxChange={() => toggleTideVisible()} />
          Tide &amp; Sea State
        </CalciteLabel>
        <CalciteLabel layout="inline" scale="s" style={{ marginBottom: 2 }}>
          <CalciteCheckbox
            checked={showUnknown || undefined}
            onCalciteCheckboxChange={() => setShowUnknown((s) => !s)}
          />
          Unknown-type vessels
        </CalciteLabel>
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
          {liveActive ? (
            <>
              {liveVessels.length} live AIS vessels (simulated fleet hidden) · {istTime(Date.now())} IST
            </>
          ) : (
            <>
              {shownCount} vessels
              {!showUnknown && hiddenUnknown > 0 ? ` · ${hiddenUnknown} unknown hidden` : ''} ·{' '}
              {istTime(Date.now())} IST
            </>
          )}
        </div>
      </div>
    </div>
  );
}
