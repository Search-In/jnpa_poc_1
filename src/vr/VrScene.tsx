/**
 * VrScene — the immersive first-person view of the JNPA port.
 *
 * Builds its OWN `Map` + `SceneView`(s) from the SAME pure layer builders the
 * dashboard's `PortScene` uses (`scene3d.ts`, `portAssets3d.ts`). Nothing here
 * imports, mutates or reaches into `PortScene`: the two scenes are siblings, so
 * the existing 3D view is untouched and cannot regress.
 *
 * Modes:
 *  - '3d' — one SceneView, first-person camera, mouse/touch look.
 *  - 'vr' — TWO SceneViews side by side sharing one Map, cameras separated by
 *    the interpupillary distance and driven by `deviceorientation`. That is the
 *    phone-cardboard ("YouTube VR") presentation; it also works fullscreen in a
 *    headset's browser.
 *
 * Why not WebXR: `SceneView` owns its WebGL context and exposes no hook to
 * render into an `XRWebGLLayer`, so an `immersive-vr` session cannot drive it.
 * Leaving the Esri stack to gain one would break requirement R-8. `navigator.xr`
 * is still probed so the UI can report the device's real capability honestly
 * rather than implying a session it never opens.
 */
import { useEffect, useMemo, useRef } from 'react';
// The SceneView's own layout CSS (`.esri-view-root` is absolutely positioned by
// it). The rest of the app gets this stylesheet as a side effect of building
// Esri widgets — the dashboard's scene instantiates zoom/Legend/LayerList. This
// view deliberately has NO widgets (`ui.components: []`, so nothing floats
// inside an eye box), so it must ask for the stylesheet itself; without it the
// view collapses to its intrinsic canvas height instead of filling the eye box.
//
// Imported as a URL and injected at mount rather than `import '…css'`, because a
// plain CSS import is GLOBAL: `main.tsx` statically imports this module, so the
// stylesheet would load on the dashboard route too and restyle a scene this
// feature is not supposed to touch.
import esriViewCssUrl from '@arcgis/core/assets/esri/themes/light/main.css?url';
import Map from '@arcgis/core/Map';
import SceneView from '@arcgis/core/views/SceneView';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import type { Berth, Vessel } from '@/types/domain';
import {
  anchorageLayer,
  berthLayer,
  channelLayer,
  pilotStationLayer,
  terminalDeckLayer,
  graphicsFor3d,
} from '@/map/scene3d';
import { portAssetLayers } from '@/map/portAssets3d';
import { createAnimLayers, startSceneAnimation, type AnimInput } from './sceneAnim';
import { initialBasemap, installBasemapFallback, isOfflineRequested } from '@/map/basemapFallback';
import { applyGraphics } from '@/map/applyGraphics';
import { useVrStore } from './vrStore';
import { eyeCameras, type ViewerPose } from './stereo';
import {
  causalEdgeGraphics,
  createImpactLayers,
  impactGraphics,
  terminalModelRings,
} from './impactLayers';
import type { VrImpactModel } from './impactModel';

interface VrSceneProps {
  berths: Berth[];
  vessels: Vessel[];
  model: VrImpactModel;
}

/** Lighting date — fixed so a rehearsed run always looks identical. */
const SUN_DATE = new Date('2026-06-16T06:30:00Z');

const ESRI_CSS_ID = 'vr-esri-view-css';

/**
 * Add the Esri view stylesheet for as long as the walkthrough is mounted, and
 * take it away again on exit — so navigating back to the dashboard leaves its
 * styling exactly as it was. Reference-counted for the stereo case, where two
 * views mount against one document.
 */
function useEsriViewStylesheet(): void {
  useEffect(() => {
    let link = document.getElementById(ESRI_CSS_ID) as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement('link');
      link.id = ESRI_CSS_ID;
      link.rel = 'stylesheet';
      link.href = esriViewCssUrl;
      link.dataset.refs = '0';
      document.head.appendChild(link);
    }
    link.dataset.refs = String(Number(link.dataset.refs ?? '0') + 1);
    return () => {
      const el = document.getElementById(ESRI_CSS_ID) as HTMLLinkElement | null;
      if (!el) return;
      const refs = Number(el.dataset.refs ?? '1') - 1;
      el.dataset.refs = String(refs);
      if (refs <= 0) el.remove();
    };
  }, []);
}

export function VrScene({ berths, vessels, model }: VrSceneProps) {
  useEsriViewStylesheet();
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const viewsRef = useRef<SceneView[]>([]);
  const layersRef = useRef<{
    berths: ReturnType<typeof berthLayer>;
    rings: GraphicsLayer;
    labels: GraphicsLayer;
    edges: GraphicsLayer;
  } | null>(null);

  const mode = useVrStore((s) => s.mode);

  // Latest props, read inside the once-only init effect without making it a dep
  // (re-running init would tear down and rebuild the whole SceneView).
  const dataRef = useRef({ berths, vessels, model });
  dataRef.current = { berths, vessels, model };

  // ---- build the scene once per mode ----------------------------------------
  // `mode` IS a dependency: stereo needs a second SceneView, which cannot be
  // added to a live view. The parent also keys this component by mode, so a
  // flip produces a clean remount rather than a half-migrated view.
  useEffect(() => {
    if (!leftRef.current) return;
    const stereo = mode === 'vr';
    if (stereo && !rightRef.current) return;

    // Identical basemap + ground setup to `PortScene`, deliberately: whatever
    // the dashboard's 3D scene renders, this one renders too.
    //
    // No API key is involved. Esri's World_Imagery tiles and the Terrain3D
    // elevation service both answer anonymously (verified: HTTP 200 with real
    // tile bytes, no token), which is why the dashboard's 3D view has always
    // worked without one. An earlier version of this file gated the basemap on
    // `env.arcgisApiKey` after mistaking a stalled render for an auth failure —
    // that gating was wrong and is gone.
    const offline = isOfflineRequested();
    const map = new Map({
      basemap: initialBasemap(),
      ...(offline ? {} : { ground: 'world-elevation' }),
    });

    const d0 = dataRef.current;
    const berthsL = berthLayer(d0.berths);
    const impact = createImpactLayers();
    const anim = createAnimLayers();

    // The static crane layer and the simulated-fleet layers are replaced by the
    // animated ones: cranes gantry-travel and stop, hulls make way and hold.
    // Drawing both would double every hull and every crane.
    const staticAssets = portAssetLayers().filter((l) => !/STS cranes/i.test(l.title ?? ''));

    map.addMany([
      channelLayer(),
      anchorageLayer(),
      anim.water,
      terminalDeckLayer(),
      berthsL,
      ...staticAssets,
      anim.cranes,
      pilotStationLayer(),
      anim.wakes,
      anim.fleet,
      anim.glyphs,
      impact.rings,
      impact.labels,
      impact.edges,
    ]);

    layersRef.current = { berths: berthsL, ...impact };

    const stopAnim = startSceneAnimation(
      anim,
      (): AnimInput => ({
        model: dataRef.current.model,
        berths: dataRef.current.berths,
        vessels: dataRef.current.vessels,
      }),
      () => viewsRef.current
    );

    const makeView = (container: HTMLDivElement): SceneView =>
      new SceneView({
        container,
        map,
        // Immersive chrome: no zoom/compass/attribution widgets inside the
        // eye boxes. Attribution is shown once in the page footer instead.
        ui: { components: [] },
        // Two simultaneous views double the draw cost; drop a quality tier in
        // stereo so the 45+ fps budget still holds on a demo laptop.
        qualityProfile: stereo ? 'medium' : 'high',
        environment: {
          atmosphereEnabled: true,
          lighting: { type: 'sun', date: SUN_DATE, directShadowsEnabled: !stereo },
        } as never,
        // Popups would open inside an eye box and cannot be dismissed with a
        // headset on; asset detail lives in the HUD list instead.
        popupEnabled: false,
      });

    const views = [makeView(leftRef.current)];
    if (stereo && rightRef.current) views.push(makeView(rightRef.current));
    viewsRef.current = views;

    // Dev-only inspection handle. The immersive view has no widgets and no
    // popups, so there is otherwise no way to interrogate the scene from the
    // console. Stripped from production builds by the `DEV` guard.
    if (import.meta.env.DEV) {
      (window as unknown as { __vrViews?: SceneView[] }).__vrViews = views;
    }

    // Without an ArcGIS API key (or on token death) the online basemap fails to
    // load and the ground renders as blank white — which the auto-tour makes
    // glaring, because its shots tilt DOWN at the assets and so fill the frame
    // with ground, where a level horizon shot was mostly sky. `PortScene` has
    // always installed this fallback; the walkthrough must too, or the same
    // token failure that degrades the dashboard whites this view out entirely.
    const teardownFallback = views.map((v) => installBasemapFallback(v));

    // In stereo the gyro owns the camera — user drag would fight it and break
    // the stereo pair's alignment.
    if (stereo) {
      for (const v of views) {
        v.when(() => {
          v.navigation.mouseWheelZoomEnabled = false;
          v.navigation.browserTouchPanEnabled = false;
        });
      }
    }

    return () => {
      stopAnim();
      for (const t of teardownFallback) t();
      for (const v of viewsRef.current) v.destroy();
      viewsRef.current = [];
      layersRef.current = null;
    };
  }, [mode]);

  // ---- drive the camera from the viewer pose --------------------------------
  // Subscribing to the store transiently (outside React render) keeps head
  // movement off the React commit path — at 60 Hz a setState per frame would
  // re-render the HUD continuously and blow the frame budget.
  useEffect(() => {
    const apply = (pose: ViewerPose, ipdM: number, stereo: boolean) => {
      const views = viewsRef.current;
      if (!views.length) return;
      if (!stereo || views.length < 2) {
        views[0].camera = {
          position: { longitude: pose.longitude, latitude: pose.latitude, z: pose.z },
          heading: pose.heading,
          tilt: pose.tilt,
        } as never;
        return;
      }
      const { left, right } = eyeCameras(pose, ipdM);
      views[0].camera = left as never;
      views[1].camera = right as never;
    };

    const poseOf = (s: ReturnType<typeof useVrStore.getState>): ViewerPose => ({
      longitude: s.longitude,
      latitude: s.latitude,
      // The scene's ground carries real elevation; eye height is relative to it,
      // and the quays sit a few metres above chart datum.
      z: s.eyeHeightM,
      heading: s.heading,
      tilt: s.tilt,
    });

    const s0 = useVrStore.getState();
    apply(poseOf(s0), s0.ipdM, s0.mode === 'vr');

    return useVrStore.subscribe((s) => {
      apply(poseOf(s), s.ipdM, s.mode === 'vr');
    });
  }, [mode]);

  // ---- push lever-driven data into the layers --------------------------------
  // `applyGraphics` reconciles in place (stable object ids), so a scenario change
  // tweens the scene instead of blinking every asset out and back.
  useEffect(() => {
    const l = layersRef.current;
    if (!l) return;
    // Berth status (occupied / out of service) is a lever-driven colour change
    // on the extruded boxes; hulls and cranes are owned by the animator.
    void applyGraphics(l.berths, graphicsFor3d.berths(berths));
  }, [berths]);

  // ---- push the impact model into the ring / label / edge layers -------------
  // `model` is recomputed on every sim tick (~4/s) because the tide moves, but
  // the rings and labels only change when the IMPACT SET does. Rebuilding text
  // symbols four times a second would burn the frame budget and make the labels
  // shimmer, so redraw is gated on a signature of what is actually displayed.
  const impactSignature = useMemo(
    () =>
      model.impacts.map((i) => `${i.assetId}|${i.severity}|${i.headline}|${i.detail}`).join('~') +
      '||' +
      model.edges.map((e) => `${e.fromAssetId}>${e.toAssetId}`).join('~'),
    [model]
  );

  useEffect(() => {
    const l = layersRef.current;
    if (!l) return;
    const { showLabels, showEdges } = useVrStore.getState();
    const { rings, labels } = impactGraphics(model.impacts, berths);

    l.rings.removeAll();
    l.rings.addMany([...rings, ...terminalModelRings(model.impacts)]);

    l.labels.removeAll();
    if (showLabels) l.labels.addMany(labels);

    l.edges.removeAll();
    if (showEdges) l.edges.addMany(causalEdgeGraphics(model.edges));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impactSignature, berths]);

  // Toggling labels/edges must not rebuild the model, so it gets its own effect.
  const showLabels = useVrStore((s) => s.showLabels);
  const showEdges = useVrStore((s) => s.showEdges);
  useEffect(() => {
    const l = layersRef.current;
    if (!l) return;
    l.labels.visible = showLabels;
    l.edges.visible = showEdges;
  }, [showLabels, showEdges]);

  const stereo = mode === 'vr';
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        // A hard black gutter between the eye boxes is what stops the two
        // images bleeding into each other in a cardboard viewer.
        gap: stereo ? 2 : 0,
        background: '#000',
      }}
    >
      <div ref={leftRef} style={{ flex: 1, height: '100%' }} />
      {stereo ? <div ref={rightRef} style={{ flex: 1, height: '100%' }} /> : null}
    </div>
  );
}
