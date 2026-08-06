/**
 * PortScene — the 3D sea-port view (ArcGIS SceneView / WebGL). This is the
 * mandated "living 3D scene as the default first-load view" (spec §A6): a
 * georeferenced JNPA approach with a depth-graded navigation channel, anchorages,
 * the pilot boarding ground, extruded terminal quays, status-coloured berths, and
 * heading-rotated vessels driven by the live (simulated) AIS stream.
 *
 * Built once; the data effect edits each layer's features in place (applyGraphics
 * + stableOid) so a sim tick tweens the moving vessels rather than blinking the
 * whole layer. Camera presets fly to framed demo viewpoints computed from real
 * terminal / channel geography. Survives ArcGIS token death via basemapFallback.
 */
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import Map from '@arcgis/core/Map';
import SceneView from '@arcgis/core/views/SceneView';
import type FeatureLayer from '@arcgis/core/layers/FeatureLayer';
import type GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import LayerList from '@arcgis/core/widgets/LayerList';
import Legend from '@arcgis/core/widgets/Legend';
import Expand from '@arcgis/core/widgets/Expand';
import * as reactiveUtils from '@arcgis/core/core/reactiveUtils';
import { initialBasemap, installBasemapFallback, isOfflineRequested } from './basemapFallback';
import { applyGraphics } from './applyGraphics';
import {
  channelLayer,
  seaChannelLayer,
  seaChannelGraphics,
  anchorageLayer,
  pilotStationLayer,
  terminalDeckLayer,
  berthLayer,
  vesselLayer,
  vesselStatusLayer,
  graphicsFor3d,
  asset3dPosition,
  selectionLayer,
  selectionRing,
} from './scene3d';
import { fetchSeaChannelGeojson } from '@/data/uc3/seaChannels';
import { fetchBathymetryOverlaySoundings } from '@/data/uc3/bathymetry';
import { isLiveVesselId, liveVesselLayer3d, renderLiveVessels3d } from './liveVesselLayer';
import { useLiveVessels } from './useLiveVessels';
import { isDummyVesselLayer, portAssetLayers } from './portAssets3d';
import { PORT_CENTER, PILOT_STATION, ANCHORAGES } from './portGeometry';
import { tokens } from '../theme/tokens';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { useSimStore } from '@/sim/simStore';
import { getAdapter } from '@/data';
import { tideFieldLayer, updateTideField } from './tideFieldLayer';
import { useTideFieldStore } from './tideFieldStore';
import { bathymetryLayer, bathymetryGraphics } from './bathymetryLayer';
import type MediaLayer from '@arcgis/core/layers/MediaLayer';
import type { Vessel, Berth } from '@/types/domain';

/** Respect the OS "reduce motion" setting. */
const REDUCED_MOTION =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Named cinematic viewpoints — the demo beats from spec §A6. */
export type CameraPreset = 'overview' | 'anchorage' | 'channel' | 'berths' | 'pilot';

export type Lighting = 'day' | 'dusk';

export interface PortSceneHandle {
  focus: (assetId: string) => void;
  clearSelection: () => void;
  goToPreset: (preset: CameraPreset) => void;
  setLighting: (mode: Lighting) => void;
}

interface PortSceneProps {
  vessels: Vessel[];
  berths: Berth[];
  /** Asset ids the simulator is driving — drawn with a selection ring. */
  highlights?: string[];
  onSelect?: (assetId: string | null) => void;
  /** Notified once if the offline basemap engages (token death). */
  onOfflineBasemap?: () => void;
}

/**
 * Resolve the id of the top-most clicked/hovered asset. Ordered most-specific
 * first (a vessel/berth/crane/gate on top of a terminal deck should win over the
 * deck) so a click on a discrete asset selects that asset, not the polygon under
 * it. Covers every layer that carries an identifying attribute — the operational
 * FeatureLayers (vessel/berth/terminal/anchorage/channel/pilot) and the static
 * glTF port assets (cranes/gates/yard stacks/trucks/tug/berthed hero ships).
 */
function resolveHit(res: { results: Array<unknown> }): string | null {
  for (const r of res.results) {
    const graphic = (r as { graphic?: { attributes?: Record<string, unknown> } }).graphic;
    if (!graphic) continue;
    const a = (graphic.attributes ?? {}) as Record<string, unknown>;
    const id =
      (a.vesselId as string) ??
      (a.berthId as string) ??
      (a.craneId as string) ??
      (a.gateId as string) ??
      (a.blockId as string) ??
      (a.routeKey as string) ??
      (a.anchId as string) ??
      (a.segId as string) ??
      (a.assetId as string) ??
      (a.pkey as string) ??
      (a.terminalId as string) ??
      null;
    if (id) return id;
  }
  return null;
}

export const PortScene = forwardRef<PortSceneHandle, PortSceneProps>(
  function PortScene(props, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<SceneView | null>(null);
    const layersRef = useRef<{
      channel: FeatureLayer;
      seaChannels: FeatureLayer;
      bathymetry: FeatureLayer;
      anchorages: FeatureLayer;
      decks: FeatureLayer;
      berths: FeatureLayer;
      vessels: FeatureLayer;
      vesselStatus: FeatureLayer;
    } | null>(null);
    const selectionRef = useRef<GraphicsLayer | null>(null);
    const liveVesselRef = useRef<GraphicsLayer | null>(null);
    /** Berthed hero ships + harbour tug — decorative hulls, hidden while live AIS is on. */
    const dummyVesselLayersRef = useRef<FeatureLayer[]>([]);
    const tideFieldRef = useRef<MediaLayer | null>(null);
    /** Id of the asset the popup is currently anchored to (for popup actions). */
    const lastSelectedRef = useRef<string | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;

    // Tide & sea-state raster field (same feed the Tide tab + 2D map use, so all
    // three stay consistent). Rendered as an INCOIS-style interpolated heatmap;
    // toggled via the scene Layers list. `variable` picks which field is shown.
    const simVersion = useSimStore((s) => s.version);
    const { data: tideData } = useAdapterQuery(
      () => getAdapter().getTideStations(),
      [simVersion],
      60_000
    );
    // Memoised on purpose, not to quieten a lint rule. `tideData?.stations ?? []`
    // is a NEW array identity on every render, and it is a dependency of the tide
    // effect below — which rebuilds the MediaLayer raster and writes `setRange`
    // into a store that has no equality guard. Unmemoised, that whole cycle ran on
    // every render of the component that also drives the 3D SceneView.
    const tideStations = useMemo(() => tideData?.stations ?? [], [tideData]);
    const fieldVar = useTideFieldStore((s) => s.variable);
    const setFieldRange = useTideFieldStore((s) => s.setRange);
    const tideVisible = useTideFieldStore((s) => s.visible);

    // Real AIS traffic from the shared gateway. Polls only while the operator has
    // the overlay on; see the render effect below for the layer swap.
    const { vessels: liveVessels, active: liveActive } = useLiveVessels();

    // ---- selection ring (no camera move) ----
    // Drop the amber selection ring on an asset without flying the camera. A plain
    // click just selects + rings + opens the anchored popup; the camera only moves
    // when the operator asks (the popup's "Focus camera" action, or focusAsset).
    function ringAsset(assetId: string): boolean {
      const sel = selectionRef.current;
      const pos = asset3dPosition().get(assetId);
      if (!sel || !pos) return false;
      sel.removeAll();
      sel.add(selectionRing(pos[0], pos[1]));
      return true;
    }

    // ---- imperative camera focus (rings + flies) ----
    function focusAsset(assetId: string) {
      const view = viewRef.current;
      if (!view) return;
      const pos = asset3dPosition().get(assetId);
      if (!pos) return;
      ringAsset(assetId);
      const [lng, lat] = pos;
      void view
        .goTo(
          {
            target: {
              type: 'point',
              longitude: lng,
              latitude: lat,
              spatialReference: { wkid: 4326 },
            },
            tilt: 62,
            zoom: 16,
          } as never,
          {
            duration: 900,
            easing: 'ease-in-out',
          }
        )
        .catch(() => {});
    }

    // ---- cinematic presets (the demo beats) ----
    function goToPreset(preset: CameraPreset) {
      const view = viewRef.current;
      if (!view) return;
      const [cx, cy] = PORT_CENTER;
      // Poses tuned to the ~208° quay bearing (water SW, land NE).
      const anchC = ANCHORAGES[0].ring;
      const ancx = anchC.reduce((s, p) => s + p[0], 0) / anchC.length;
      const ancy = anchC.reduce((s, p) => s + p[1], 0) / anchC.length;
      const POSES: Record<
        CameraPreset,
        { lng: number; lat: number; z: number; heading: number; tilt: number }
      > = {
        overview: { lng: cx - 0.03, lat: cy - 0.028, z: 3200, heading: 45, tilt: 66 },
        anchorage: { lng: ancx - 0.012, lat: ancy - 0.012, z: 1400, heading: 40, tilt: 72 },
        channel: { lng: 72.918, lat: 18.926, z: 900, heading: 40, tilt: 80 }, // low, looking up-channel
        berths: { lng: cx - 0.008, lat: cy - 0.006, z: 700, heading: 42, tilt: 78 },
        pilot: {
          lng: PILOT_STATION.lng - 0.006,
          lat: PILOT_STATION.lat - 0.006,
          z: 700,
          heading: 40,
          tilt: 76,
        },
      };
      const p = POSES[preset];
      void view
        .goTo(
          {
            position: { longitude: p.lng, latitude: p.lat, z: p.z },
            heading: p.heading,
            tilt: p.tilt,
          } as never,
          {
            duration: 1200,
            easing: 'ease-in-out',
          }
        )
        .catch(() => {});
    }

    function setLighting(mode: Lighting) {
      const view = viewRef.current;
      if (!view) return;
      const env = view.environment as unknown as {
        lighting?: { type?: string; date?: Date; directShadowsEnabled?: boolean };
      };
      const when =
        mode === 'dusk' ? new Date('2026-06-16T12:45:00Z') : new Date('2026-06-16T06:30:00Z');
      if (env.lighting) {
        env.lighting.type = 'sun';
        env.lighting.date = when;
        env.lighting.directShadowsEnabled = true;
      }
    }

    // `[]` is deliberate, and the rule is suppressed rather than satisfied.
    //
    // exhaustive-deps wants `focusAsset` listed (it captures `ringAsset`, a
    // component-scope value, so the rule cannot prove it static). There is no
    // stale-closure hazard to protect against: `focusAsset` reads `viewRef.current`
    // and `selectionRef.current` — mutable refs — and calls `asset3dPosition()`
    // fresh on every invocation, so render-0's closure stays correct for the life
    // of the component. Meanwhile the handle MUST keep a stable identity: App holds
    // it in a ref and DemoPlayer drives the camera choreography through it.
    //
    // TODO(post-demo): wrapping BOTH `ringAsset` and `focusAsset` in useCallback is
    // the "correct" fix, but it also forces `[focusAsset]` onto the scene-init
    // effect below — turning a provably-once effect into one that can re-init the
    // whole SceneView. Not a trade worth making days before a live demo.
    useImperativeHandle(
      ref,
      () => ({
        focus: focusAsset,
        clearSelection: () => selectionRef.current?.removeAll(),
        goToPreset,
        setLighting,
      }),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      []
    );

    // ---- init the scene once ----
    useEffect(() => {
      if (!containerRef.current) return;
      const p0 = propsRef.current;
      const offline = isOfflineRequested();
      const map = new Map({
        basemap: initialBasemap(),
        ...(offline ? {} : { ground: 'world-elevation' }),
      });

      const layers = {
        channel: channelLayer(),
        seaChannels: seaChannelLayer(),
        bathymetry: bathymetryLayer(),
        anchorages: anchorageLayer(),
        decks: terminalDeckLayer(),
        berths: berthLayer(p0.berths),
        vessels: vesselLayer(p0.vessels),
        vesselStatus: vesselStatusLayer(p0.vessels),
      };
      layersRef.current = layers;
      const pilot = pilotStationLayer();
      // Tide & sea-state raster field (off by default; toggled in the Layers list).
      // Seeded empty; the tide data effect renders + refreshes the heatmap.
      const tide = tideFieldLayer();
      tideFieldRef.current = tide;
      // Real glTF port infrastructure (cranes, yard stacks, gates, trucks, tug,
      // berthed ships) placed from positions.json — vendored from UC-2 so UC-1
      // renders on the same surveyed JNPA geography with the same 3D assets.
      const assets = portAssetLayers();
      dummyVesselLayersRef.current = assets.filter(isDummyVesselLayer);
      // Draw order: channel + anchorages (ground washes) under decks/berths, then
      // the static port models, with the pilot marker + live AIS vessels on top.
      // The uploaded sea-channel overlay sits just ABOVE the synthetic depth ribbon
      // (so the DUKC channel stays visible underneath) and still UNDER decks/berths;
      // every existing layer keeps its relative order. Bathymetry soundings sit with
      // the channel overlays (below decks) so shoal dots read against the water.
      // Real AIS hulls — hidden until the operator turns the overlay on, and drawn
      // above the simulated fleet (which is hidden while it is on, so the two data
      // sources are never mixed on screen).
      const live = liveVesselLayer3d();
      liveVesselRef.current = live;
      map.addMany([
        layers.channel,
        layers.seaChannels,
        layers.bathymetry,
        layers.anchorages,
        layers.decks,
        layers.berths,
        ...assets,
        pilot,
        tide,
        layers.vessels,
        layers.vesselStatus,
        live,
      ]);

      const selection = selectionLayer();
      selectionRef.current = selection;
      map.add(selection);

      const view = new SceneView({
        container: containerRef.current,
        map,
        camera: {
          position: { longitude: PORT_CENTER[0] - 0.03, latitude: PORT_CENTER[1] - 0.028, z: 3200 },
          tilt: 66,
          heading: 45,
        },
        qualityProfile: 'high',
        environment: {
          atmosphereEnabled: true,
          lighting: {
            type: 'sun',
            date: new Date('2026-06-16T06:30:00Z'),
            directShadowsEnabled: true,
          },
        } as never,
        ui: { components: ['zoom', 'compass', 'navigation-toggle', 'attribution'] },
        // Asset detail shows in the Esri popup ANCHORED to the clicked feature,
        // inside the map. Docking is disabled so it never floats off to the side of
        // the (narrow) map panel; collision keeps the balloon within the view.
        popupEnabled: true,
        popup: {
          dockEnabled: false,
          dockOptions: { buttonEnabled: false, breakpoint: false },
          collision: 'reposition',
          alignment: 'auto',
          visibleElements: { collapseButton: false },
        } as never,
      });
      viewRef.current = view;

      const teardownFallback = installBasemapFallback(view, {
        onFallback: () => propsRef.current.onOfflineBasemap?.(),
      });

      view.when(() => {
        // Legend + Layers stack at bottom-left; top-right is left clear for the
        // React map-mode control overlay (2D/3D, token-expiry, placement editor).
        view.ui.add(
          new Expand({
            view,
            content: new Legend({ view }),
            expanded: false,
            expandTooltip: 'Legend',
          }),
          'bottom-left'
        );
        view.ui.add(
          new Expand({
            view,
            content: new LayerList({ view }),
            expanded: false,
            expandTooltip: 'Layers',
          }),
          'bottom-left'
        );
      });

      // Popup actions (buttons inside the native Esri detail popup). The per-layer
      // popupTemplates declare `focus-asset` / `clear-selection`; handle them
      // centrally here. In ArcGIS 4.34 `view.popup` is created lazily (it isn't the
      // Popup widget yet when this effect runs — `view.popup.on` would throw), so
      // we bind via reactiveUtils.on(() => view.popup, ...), which waits for the
      // widget to exist and (re)binds if it's recreated. The clicked feature's own
      // id is read from its attributes so "Focus camera" flies to exactly the asset
      // the popup is describing.
      const idOf = (
        g: { attributes?: Record<string, unknown> } | null | undefined
      ): string | null => {
        const a = (g?.attributes ?? {}) as Record<string, unknown>;
        return (
          (a.vesselId as string) ??
          (a.berthId as string) ??
          (a.terminalId as string) ??
          (a.anchId as string) ??
          (a.segId as string) ??
          (a.assetId as string) ??
          (a.craneId as string) ??
          (a.gateId as string) ??
          (a.blockId as string) ??
          null
        );
      };
      const actionHandle = reactiveUtils.on(
        () => view.popup,
        'trigger-action',
        (e: { action?: { id?: string } }) => {
          const actionId = e.action?.id;
          const popup = view.popup as unknown as {
            selectedFeature?: { attributes?: Record<string, unknown> };
            close: () => void;
          };
          const featId = idOf(popup.selectedFeature) ?? lastSelectedRef.current;
          if (actionId === 'focus-asset' && featId) {
            focusAsset(featId);
          } else if (actionId === 'clear-selection') {
            lastSelectedRef.current = null;
            selectionRef.current?.removeAll();
            popup.close();
            propsRef.current.onSelect?.(null);
          }
        }
      );

      const clickHandle = view.on('click', (event) => {
        void view.hitTest(event).then((res) => {
          const id = resolveHit(res);
          // A live-AIS hull is not a placed asset: ringing it (asset3dPosition) and
          // surfacing it to React would route it through the placement store, which
          // opens the "Move & rotate" editor instead of the info popup. The graphic
          // carries its own popupTemplate, so the SceneView opens it unaided.
          if (isLiveVesselId(id)) return;
          if (id) {
            // Select only: ring the asset + surface it to React. The native Esri
            // popup opens anchored to the graphic on its own (popupEnabled). No
            // camera move — that's the "Focus camera" popup action / focus() handle.
            lastSelectedRef.current = id;
            ringAsset(id);
            propsRef.current.onSelect?.(id);
          } else {
            // Click on empty water clears the selection ring.
            lastSelectedRef.current = null;
            selectionRef.current?.removeAll();
            propsRef.current.onSelect?.(null);
          }
        });
      });
      const moveHandle = view.on('pointer-move', (event) => {
        void view.hitTest(event).then((res) => {
          if (containerRef.current)
            containerRef.current.style.cursor = resolveHit(res) ? 'pointer' : 'default';
        });
      });

      void REDUCED_MOTION; // (motion is handled by ArcGIS goTo; flag reserved for future ambient anim)

      return () => {
        teardownFallback();
        clickHandle.remove();
        moveHandle.remove();
        actionHandle.remove();
        view.destroy();
        viewRef.current = null;
        layersRef.current = null;
        selectionRef.current = null;
        liveVesselRef.current = null;
        dummyVesselLayersRef.current = [];
        tideFieldRef.current = null;
      };
      // `[]` is load-bearing: this effect CONSTRUCTS the SceneView and tears it
      // down with `view.destroy()`. Any dependency that ever changes identity
      // re-initialises the whole 3D scene — a black map mid-demo. exhaustive-deps
      // asks for `focusAsset` (reached via the popup `trigger-action` handler);
      // it reads only refs and re-resolves positions on each call, so the render-0
      // closure never goes stale. Same reasoning, and the same post-demo TODO, as
      // the useImperativeHandle above.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ---- edit vessel + berth layers in place on data change ----
    // While the live-AIS overlay is on the simulated fleet is fed EMPTY graphics,
    // not merely hidden: this effect re-runs on every sim tick, so leaving the
    // features in place and trusting the visibility flag alone means one stray
    // write to `visible` puts the whole invented fleet — and its yellow nav-status
    // discs — back on top of real traffic. Berths are unaffected: they are
    // infrastructure, not traffic.
    useEffect(() => {
      const layers = layersRef.current;
      if (!layers) return;
      const simVessels = liveActive ? [] : props.vessels;
      void applyGraphics(layers.vessels, graphicsFor3d.vessels(simVessels));
      void applyGraphics(layers.vesselStatus, graphicsFor3d.vesselStatus(simVessels));
      void applyGraphics(layers.berths, graphicsFor3d.berths(props.berths));
    }, [props.vessels, props.berths, liveActive]);

    // ---- live AIS overlay: replace every dummy hull, don't overlay them ----
    // While the overlay is on, EVERY made-up vessel comes off the scene: the
    // simulated AIS fleet + its status discs, the berthed hero ships and the
    // harbour tug. Otherwise real and invented traffic sit side by side with
    // nothing to tell them apart. Port infrastructure (quays, cranes, yards,
    // gates, trucks) is not traffic and stays. Turning it off restores all of it.
    useEffect(() => {
      const live = liveVesselRef.current;
      const layers = layersRef.current;
      if (!live || !layers) return;
      const showDummies = !liveActive;
      layers.vessels.visible = showDummies;
      layers.vesselStatus.visible = showDummies;
      for (const l of dummyVesselLayersRef.current) l.visible = showDummies;
      if (!liveActive) {
        live.visible = false;
        live.removeAll();
        return;
      }
      live.visible = true;
      renderLiveVessels3d(live, liveVessels);
    }, [liveActive, liveVessels]);

    // ---- populate the uploaded sea-channel overlay once, from the UC-3 backend ----
    // Fetched from GET /api/marine/sea-channels/geojson. If UC-3 is off/unreachable or
    // the backend returns an empty FeatureCollection, the layer stays empty (shows
    // nothing) — the synthetic channel + everything else are unaffected.
    useEffect(() => {
      let alive = true;
      void (async () => {
        try {
          const fc = await fetchSeaChannelGeojson();
          const layers = layersRef.current;
          if (!alive || !layers) return;
          await applyGraphics(layers.seaChannels, seaChannelGraphics(fc.features));
        } catch {
          /* UC-3 disabled / offline / no upload yet → nothing to render */
        }
      })();
      return () => {
        alive = false;
      };
    }, []);

    // ---- populate bathymetry soundings from UC-3 ----
    // Real georeferenced rows from /api/marine/bathymetry/*. Off by default — toggle in
    // the Layers list. Gateway down / empty register → empty layer (same as sea channels).
    useEffect(() => {
      let alive = true;
      void (async () => {
        try {
          const { soundings, surveysById } = await fetchBathymetryOverlaySoundings();
          const layers = layersRef.current;
          if (!alive || !layers) return;
          await applyGraphics(layers.bathymetry, bathymetryGraphics(soundings, surveysById));
        } catch {
          /* UC-3 disabled / offline / no surveys yet → nothing to render */
        }
      })();
      return () => {
        alive = false;
      };
    }, []);

    // ---- re-render the tide/sea-state raster field on reading or variable change ----
    useEffect(() => {
      const layer = tideFieldRef.current;
      if (!layer) return;
      const range = updateTideField(layer, tideStations, fieldVar);
      setFieldRange(range);
    }, [tideStations, fieldVar, setFieldRange]);

    // Field visibility is store-driven (shared with the 2D map + colorbar).
    useEffect(() => {
      if (tideFieldRef.current) tideFieldRef.current.visible = tideVisible;
    }, [tideVisible]);

    // ---- reframe / ring on highlight change ----
    useEffect(() => {
      const sel = selectionRef.current;
      const view = viewRef.current;
      if (!sel || !view) return;
      sel.removeAll();
      const ids = props.highlights ?? [];
      const pos = asset3dPosition();
      const targets: [number, number][] = [];
      for (const id of ids) {
        const p = pos.get(id);
        if (p) {
          sel.add(selectionRing(p[0], p[1]));
          targets.push(p);
        }
      }
      if (targets.length) {
        void view
          .goTo(
            {
              target: targets.map(([lng, lat]) => ({
                type: 'point',
                longitude: lng,
                latitude: lat,
                spatialReference: { wkid: 4326 },
              })),
              tilt: 60,
            } as never,
            { duration: 800 }
          )
          .catch(() => {});
      }
    }, [props.highlights]);

    return (
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', minHeight: 480, background: tokens.bg }}
        aria-label="JNPA 3D sea-port scene"
        role="application"
      />
    );
  }
);
