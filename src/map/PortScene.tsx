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
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
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
import { portAssetLayers } from './portAssets3d';
import { PORT_CENTER, PILOT_STATION, ANCHORAGES } from './portGeometry';
import { tokens } from '../theme/tokens';
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

export const PortScene = forwardRef<PortSceneHandle, PortSceneProps>(function PortScene(props, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<SceneView | null>(null);
  const layersRef = useRef<{
    channel: FeatureLayer;
    anchorages: FeatureLayer;
    decks: FeatureLayer;
    berths: FeatureLayer;
    vessels: FeatureLayer;
    vesselStatus: FeatureLayer;
  } | null>(null);
  const selectionRef = useRef<GraphicsLayer | null>(null);
  /** Id of the asset the popup is currently anchored to (for popup actions). */
  const lastSelectedRef = useRef<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

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
      .goTo({ target: { type: 'point', longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } }, tilt: 62, zoom: 16 } as never, {
        duration: 900,
        easing: 'ease-in-out',
      })
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
    const POSES: Record<CameraPreset, { lng: number; lat: number; z: number; heading: number; tilt: number }> = {
      overview: { lng: cx - 0.03, lat: cy - 0.028, z: 3200, heading: 45, tilt: 66 },
      anchorage: { lng: ancx - 0.012, lat: ancy - 0.012, z: 1400, heading: 40, tilt: 72 },
      channel: { lng: 72.918, lat: 18.926, z: 900, heading: 40, tilt: 80 }, // low, looking up-channel
      berths: { lng: cx - 0.008, lat: cy - 0.006, z: 700, heading: 42, tilt: 78 },
      pilot: { lng: PILOT_STATION.lng - 0.006, lat: PILOT_STATION.lat - 0.006, z: 700, heading: 40, tilt: 76 },
    };
    const p = POSES[preset];
    void view
      .goTo({ position: { longitude: p.lng, latitude: p.lat, z: p.z }, heading: p.heading, tilt: p.tilt } as never, {
        duration: 1200,
        easing: 'ease-in-out',
      })
      .catch(() => {});
  }

  function setLighting(mode: Lighting) {
    const view = viewRef.current;
    if (!view) return;
    const env = view.environment as unknown as {
      lighting?: { type?: string; date?: Date; directShadowsEnabled?: boolean };
    };
    const when = mode === 'dusk' ? new Date('2026-06-16T12:45:00Z') : new Date('2026-06-16T06:30:00Z');
    if (env.lighting) {
      env.lighting.type = 'sun';
      env.lighting.date = when;
      env.lighting.directShadowsEnabled = true;
    }
  }

  useImperativeHandle(
    ref,
    () => ({ focus: focusAsset, clearSelection: () => selectionRef.current?.removeAll(), goToPreset, setLighting }),
    [],
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
      anchorages: anchorageLayer(),
      decks: terminalDeckLayer(),
      berths: berthLayer(p0.berths),
      vessels: vesselLayer(p0.vessels),
      vesselStatus: vesselStatusLayer(p0.vessels),
    };
    layersRef.current = layers;
    const pilot = pilotStationLayer();
    // Real glTF port infrastructure (cranes, yard stacks, gates, trucks, tug,
    // berthed ships) placed from positions.json — vendored from UC-2 so UC-1
    // renders on the same surveyed JNPA geography with the same 3D assets.
    const assets = portAssetLayers();
    // Draw order: channel + anchorages (ground washes) under decks/berths, then
    // the static port models, with the pilot marker + live AIS vessels on top.
    map.addMany([layers.channel, layers.anchorages, layers.decks, layers.berths, ...assets, pilot, layers.vessels, layers.vesselStatus]);

    const selection = selectionLayer();
    selectionRef.current = selection;
    map.add(selection);

    const view = new SceneView({
      container: containerRef.current,
      map,
      camera: { position: { longitude: PORT_CENTER[0] - 0.03, latitude: PORT_CENTER[1] - 0.028, z: 3200 }, tilt: 66, heading: 45 },
      qualityProfile: 'high',
      environment: {
        atmosphereEnabled: true,
        lighting: { type: 'sun', date: new Date('2026-06-16T06:30:00Z'), directShadowsEnabled: true },
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

    const teardownFallback = installBasemapFallback(view, { onFallback: () => propsRef.current.onOfflineBasemap?.() });

    view.when(() => {
      // Legend + Layers stack at bottom-left; top-right is left clear for the
      // React map-mode control overlay (2D/3D, token-expiry, placement editor).
      view.ui.add(new Expand({ view, content: new Legend({ view }), expanded: false, expandTooltip: 'Legend' }), 'bottom-left');
      view.ui.add(new Expand({ view, content: new LayerList({ view }), expanded: false, expandTooltip: 'Layers' }), 'bottom-left');
    });

    // Popup actions (buttons inside the native Esri detail popup). The per-layer
    // popupTemplates declare `focus-asset` / `clear-selection`; handle them
    // centrally here. In ArcGIS 4.34 `view.popup` is created lazily (it isn't the
    // Popup widget yet when this effect runs — `view.popup.on` would throw), so
    // we bind via reactiveUtils.on(() => view.popup, ...), which waits for the
    // widget to exist and (re)binds if it's recreated. The clicked feature's own
    // id is read from its attributes so "Focus camera" flies to exactly the asset
    // the popup is describing.
    const idOf = (g: { attributes?: Record<string, unknown> } | null | undefined): string | null => {
      const a = (g?.attributes ?? {}) as Record<string, unknown>;
      return (
        (a.vesselId as string) ?? (a.berthId as string) ?? (a.terminalId as string) ??
        (a.anchId as string) ?? (a.segId as string) ?? (a.assetId as string) ??
        (a.craneId as string) ?? (a.gateId as string) ?? (a.blockId as string) ?? null
      );
    };
    const actionHandle = reactiveUtils.on(
      () => view.popup,
      'trigger-action',
      (e: { action?: { id?: string } }) => {
        const actionId = e.action?.id;
        const popup = view.popup as unknown as { selectedFeature?: { attributes?: Record<string, unknown> }; close: () => void };
        const featId = idOf(popup.selectedFeature) ?? lastSelectedRef.current;
        if (actionId === 'focus-asset' && featId) {
          focusAsset(featId);
        } else if (actionId === 'clear-selection') {
          lastSelectedRef.current = null;
          selectionRef.current?.removeAll();
          popup.close();
          propsRef.current.onSelect?.(null);
        }
      },
    );

    const clickHandle = view.on('click', (event) => {
      void view.hitTest(event).then((res) => {
        const id = resolveHit(res);
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
        if (containerRef.current) containerRef.current.style.cursor = resolveHit(res) ? 'pointer' : 'default';
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
    };
     
  }, []);

  // ---- edit vessel + berth layers in place on data change ----
  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    void applyGraphics(layers.vessels, graphicsFor3d.vessels(props.vessels));
    void applyGraphics(layers.vesselStatus, graphicsFor3d.vesselStatus(props.vessels));
    void applyGraphics(layers.berths, graphicsFor3d.berths(props.berths));
  }, [props.vessels, props.berths]);

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
        .goTo({ target: targets.map(([lng, lat]) => ({ type: 'point', longitude: lng, latitude: lat, spatialReference: { wkid: 4326 } })), tilt: 60 } as never, { duration: 800 })
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
});
