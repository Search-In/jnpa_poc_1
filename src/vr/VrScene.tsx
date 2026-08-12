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
import { useEsriViewStylesheet } from '@/map/useEsriViewStylesheet';
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
import { isLowPowerDevice, renderScale } from './device';
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
    const lowPower = isLowPowerDevice();

    // Tile budget on a handset. Three separate tile services normally feed this
    // scene — imagery, the reference/label overlay that 'hybrid' adds on top,
    // and Terrain3D for the ground — and in stereo two views request from all
    // three. That is what makes tiles crawl in or never arrive on mobile data.
    //
    //  • 'satellite' instead of 'hybrid' drops the label overlay: one tile
    //    service gone, and place labels are unreadable through a cardboard lens
    //    anyway.
    //  • Flat ground drops Terrain3D entirely. JNPA is tidal flats with ~0 m
    //    relief, so the terrain was buying almost nothing visually.
    //
    // Desktop keeps the full setup, identical to `PortScene`.
    const map = new Map({
      basemap: offline ? initialBasemap() : lowPower ? 'satellite' : initialBasemap(),
      ...(offline || lowPower ? {} : { ground: 'world-elevation' }),
    });

    const d0 = dataRef.current;
    const berthsL = berthLayer(d0.berths);
    const impact = createImpactLayers();
    const anim = createAnimLayers();

    // The static crane layer and the simulated-fleet layers are replaced by the
    // animated ones: cranes gantry-travel and stop, hulls make way and hold.
    // Drawing both would double every hull and every crane.
    const staticAssets = portAssetLayers().filter((l) => !/STS cranes/i.test(l.title ?? ''));

    // Scenery budget. The yard is 60 blocks stacked 2–5 containers high — about
    // 210 glTF instances — and the truck queues add more. In stereo EVERY one of
    // them is loaded and drawn twice, once per view, which is what makes a phone
    // crawl and what makes one eye finish before the other.
    //
    // None of it carries what-if state: the impacted assets are the cranes,
    // berths, channel and hulls. So on a low-power device the yard is thinned to
    // its bottom tier (60 instances instead of ~210 — it still reads as a
    // container yard from any distance a viewer stands at) and the truck queues
    // are dropped. Nothing that answers WHICH/WHERE/HOW is touched.
    const scenery = lowPower
      ? staticAssets.filter((l) => !/Trucks/i.test(l.title ?? ''))
      : staticAssets;
    if (lowPower) {
      for (const l of scenery) {
        if (/Yard stacks/i.test(l.title ?? '')) {
          (l as unknown as { definitionExpression: string }).definitionExpression = 'tier <= 0';
        }
      }
    }

    map.addMany([
      channelLayer(),
      anchorageLayer(),
      anim.water,
      terminalDeckLayer(),
      berthsL,
      ...scenery,
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

    // Budget by device, not by hope. Stereo renders the whole port twice, so on
    // a phone the desktop settings are what "lags a lot" actually means.
    const quality: 'low' | 'medium' | 'high' = lowPower ? 'low' : stereo ? 'medium' : 'high';

    const makeView = (container: HTMLDivElement): SceneView =>
      new SceneView({
        container,
        map,
        // Immersive chrome: no zoom/compass/attribution widgets inside the
        // eye boxes. Attribution is shown once in the page footer instead.
        ui: { components: [] },
        qualityProfile: quality,
        environment: {
          // ALWAYS on. In a global scene the atmosphere IS the sky — switching
          // it off to save a draw call does not give you a cheaper sky, it gives
          // you the black of space, which is what turned the walkthrough into
          // night on mobile. Savings come from the tile budget and the quality
          // profile instead, never from this.
          atmosphereEnabled: true,
          // No starfield: this is a daytime port, and a star layer over a black
          // void was the other half of the "sky is night" impression.
          starsEnabled: false,
          // Shadows are the single most expensive lighting option and are the
          // first thing to go once a second view is on screen.
          lighting: { type: 'sun', date: SUN_DATE, directShadowsEnabled: !stereo && !lowPower },
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
        gap: stereo ? LENS_GUTTER_PX : 0,
        background: '#000',
      }}
    >
      <Eye viewRef={leftRef} stereo={stereo} />
      {stereo ? <Eye viewRef={rightRef} stereo /> : null}
    </div>
  );
}

/** Corner rounding of a lens box, as a share of its own size. */
const LENS_RADIUS = '22%';
/** Black bar between the two lenses. */
const LENS_GUTTER_PX = 6;

/**
 * One eye box.
 *
 * In stereo it is masked into a rounded "lens" with a black surround and a soft
 * vignette, which is what a cardboard viewer actually shows you: the plastic
 * lens is round, so the corners of a full rectangle are never visible anyway and
 * only serve to leak light between the eyes. Masking them matches the YouTube
 * cardboard presentation and makes the two images read as one scene.
 *
 * This is a MASK, not optical barrel-distortion pre-warp — correcting for lens
 * pincushion would need a post-process shader over the SceneView's own canvas,
 * which the Esri renderer does not expose.
 */
function Eye({
  viewRef,
  stereo,
}: {
  viewRef: React.MutableRefObject<HTMLDivElement | null>;
  stereo: boolean;
}) {
  // Render scale: hand the SceneView a SMALLER box so it rasterises fewer
  // pixels, then blow it back up with a CSS transform. At 0.62 that is 38% of
  // the pixels per eye — the biggest single win available on a phone at
  // devicePixelRatio 3, and through a cardboard lens the softening does not read.
  const s = renderScale(stereo);
  const box: React.CSSProperties =
    s < 1
      ? {
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${100 * s}%`,
          height: `${100 * s}%`,
          transform: `scale(${1 / s})`,
          transformOrigin: 'top left',
        }
      : { position: 'absolute', inset: 0 };

  if (!stereo) {
    return (
      <div style={{ flex: 1, height: '100%', position: 'relative', overflow: 'hidden' }}>
        <div ref={viewRef} style={box} />
      </div>
    );
  }

  return (
    <div style={{ flex: 1, height: '100%', position: 'relative', overflow: 'hidden' }}>
      {/* The lens mask sits on a WRAPPER, so the rounding is not part of the
          scaled subtree — inside it, the transform would magnify the mask itself
          and the two eyes would stop matching. */}
      <div
        style={{ position: 'absolute', inset: 0, borderRadius: LENS_RADIUS, overflow: 'hidden' }}
      >
        <div ref={viewRef} style={box} />
      </div>
      {/* Vignette: darkens toward the rim the way a real lens does, and hides the
          hard mask edge. Non-interactive so it never eats a tap. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          borderRadius: LENS_RADIUS,
          // Enough to soften the mask edge and suggest the lens rim, but not so
          // much that it eats usable field of view — the port has to stay
          // visible right out to the edges of the eye box.
          boxShadow: 'inset 0 0 9vmin 1.5vmin rgba(0,0,0,0.72)',
        }}
      />
    </div>
  );
}
