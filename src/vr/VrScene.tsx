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
 *
 * WHAT COSTS WHAT, because everything below is an answer to one of these:
 *  - GPU: stereo draws the port twice, at devicePixelRatio 3, over ~300 glTF
 *    instances. Levers: render scale, quality profile, shadows, instance count.
 *  - Network: ~1.2 MB of glTF and a few hundred KB of tiles have to arrive
 *    before it looks like a port. Levers: how many tile services, whether the
 *    two eyes fetch in parallel, and whether anything was prefetched.
 * Every one of those decisions is made in `sceneBudget.ts`, not here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { currentBudget } from './device';
import { defaultFovDeg, type SceneBudget } from './sceneBudget';
import { vrBasemap } from './vrBasemap';
import { installBasemapFallback, isOfflineRequested } from '@/map/basemapFallback';
import { whenAssetsDrawn } from './viewReady';
import { bootViews } from './sceneBoot';
import { coalesceToFrame } from './frameCoalesce';
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
  /**
   * Called when the scene may be shown. The page holds the auto-tour until then:
   * a director flying the camera over a port that has not arrived yet is both
   * pointless and the thing that keeps the basemap permanently streaming.
   */
  onReadyChange?: (state: { ready: boolean; streaming: boolean }) => void;
}

/** Lighting date — fixed so a rehearsed run always looks identical. */
const SUN_DATE = new Date('2026-06-16T06:30:00Z');

/** How far the scene has got, for the reveal gate. */
type SceneReadiness = 'building' | 'first-eye' | 'ready';

export function VrScene({ berths, vessels, model, onReadyChange }: VrSceneProps) {
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
  const stereo = mode === 'vr';
  const [readiness, setReadiness] = useState<SceneReadiness>('building');
  const [streaming, setStreaming] = useState(false);

  // The budget is read once per mode. Re-reading it per render would let a
  // transient `effectiveType` flap rebuild the scene mid-demo.
  const budget = useMemo(() => currentBudget(stereo), [stereo]);

  // Latest props, read inside the once-only init effect without making it a dep
  // (re-running init would tear down and rebuild the whole SceneView).
  const dataRef = useRef({ berths, vessels, model });
  dataRef.current = { berths, vessels, model };
  const readyRef = useRef(onReadyChange);
  readyRef.current = onReadyChange;

  /**
   * One eye box's CSS size, measured once per mounted view.
   *
   * Cached rather than read on demand because `applyCurrentPose` needs the
   * aspect ratio for the field of view and runs on every animation frame —
   * reading `clientWidth` there would force a synchronous layout 30 times a
   * second, on the main thread the renderer is already competing for.
   */
  const eyeBoxRef = useRef<{ width: number; height: number } | undefined>(undefined);

  /**
   * Write the store's pose into every live SceneView.
   *
   * Reads everything through refs and `getState()`, so it has no dependencies
   * and a stable identity — which is what lets the init effect and the
   * subscription effect both use it without either rebuilding the scene.
   */
  const applyCurrentPose = useCallback((): void => {
    const views = viewsRef.current;
    if (!views.length) return;
    const s = useVrStore.getState();
    const pose: ViewerPose = {
      longitude: s.longitude,
      latitude: s.latitude,
      // The scene's ground carries real elevation; eye height is relative to it,
      // and the quays sit a few metres above chart datum.
      z: s.eyeHeightM,
      heading: s.heading,
      tilt: s.tilt,
    };
    // The FOV must be written on EVERY camera assignment: `view.camera = {…}`
    // replaces the camera object, so leaving it out silently restores the 55°
    // ArcGIS default and the world snaps back to telephoto on the next head
    // movement. 55° diagonal is right for a map you look at and wrong for a
    // scene you look through — see `sceneBudget.stereoFovDeg`.
    const fov = s.fovDeg ?? defaultFovDeg(s.mode === 'vr', eyeBoxRef.current);

    if (s.mode !== 'vr' || views.length < 2) {
      views[0].camera = {
        position: { longitude: pose.longitude, latitude: pose.latitude, z: pose.z },
        heading: pose.heading,
        tilt: pose.tilt,
        fov,
      } as never;
      return;
    }
    const { left, right } = eyeCameras(pose, s.ipdM, fov);
    views[0].camera = left as never;
    views[1].camera = right as never;
  }, []);

  // ---- build the scene once per mode ----------------------------------------
  // `mode` IS a dependency: stereo needs a second SceneView, which cannot be
  // added to a live view. The parent also keys this component by mode, so a
  // flip produces a clean remount rather than a half-migrated view.
  useEffect(() => {
    if (!leftRef.current) return;
    if (stereo && !rightRef.current) return;
    const left = leftRef.current;
    const right = rightRef.current;

    // Identical geometry and layer builders to `PortScene`, deliberately. What
    // differs is the tile budget, and only when the link or the device says so —
    // see `vrBasemap` and `sceneBudget`.
    //
    // No API key is involved. Esri's World_Imagery tiles and the Terrain3D
    // elevation service both answer anonymously (verified: HTTP 200 with real
    // tile bytes, no token), which is why the dashboard's 3D view has always
    // worked without one. An earlier version of this file gated the basemap on
    // `env.arcgisApiKey` after mistaking a stalled render for an auth failure —
    // that gating was wrong and is gone.
    const map = new Map({
      basemap: vrBasemap({ underlay: budget.groundUnderlay }),
      // Terrain3D is a third tile service, fetched per view, for a place with
      // essentially no relief: JNPA is tidal flats. Off unless the link can
      // afford it.
      ...(budget.useTerrain && !isOfflineRequested() ? { ground: 'world-elevation' } : {}),
    });

    const d0 = dataRef.current;
    const berthsL = berthLayer(d0.berths);
    const impact = createImpactLayers();
    const anim = createAnimLayers();

    // The static crane layer and the simulated-fleet layers are replaced by the
    // animated ones: cranes gantry-travel and stop, hulls make way and hold.
    // Drawing both would double every hull and every crane.
    const staticAssets = portAssetLayers().filter((l) => !/STS cranes/i.test(l.title ?? ''));
    const scenery = staticAssets.filter((l) => keepLayer(l.title ?? '', budget));

    // Scenery budget. The yard is 60 blocks stacked 2–5 containers high — about
    // 210 glTF instances — and in stereo every one is loaded and drawn twice,
    // once per view. That is what makes a phone crawl and what makes one eye
    // finish before the other.
    //
    // None of it carries what-if state: the impacted assets are the cranes,
    // berths, channel and hulls. So the yard is thinned to its bottom tier (60
    // instances — it still reads as a container yard from any distance a viewer
    // stands at). Nothing that answers WHICH/WHERE/HOW is touched.
    if (budget.yardFilter) {
      for (const l of scenery) {
        if (/Yard stacks/i.test(l.title ?? '')) {
          (l as unknown as { definitionExpression: string }).definitionExpression =
            budget.yardFilter;
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
      () => viewsRef.current,
      budget
    );

    const makeView = (container: HTMLDivElement): SceneView =>
      new SceneView({
        container,
        map,
        // Immersive chrome: no zoom/compass/attribution widgets inside the
        // eye boxes. Attribution is shown once in the page footer instead.
        ui: { components: [] },
        qualityProfile: budget.quality,
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
          lighting: { type: 'sun', date: SUN_DATE, directShadowsEnabled: budget.shadows },
        } as never,
        // Popups would open inside an eye box and cannot be dismissed with a
        // headset on; asset detail lives in the HUD list instead.
        popupEnabled: false,
      });

    let cancelled = false;
    const teardownFallback: Array<() => void> = [];
    const pendingWaits: Array<{ cancel: () => void }> = [];

    viewsRef.current = [];
    // A 3D ↔ VR flip rebuilds the scene from scratch, so the page must stop
    // treating it as ready — otherwise the tour keeps flying the camera over a
    // port that is being reassembled behind the gate.
    setReadiness('building');
    setStreaming(false);
    readyRef.current?.({ ready: false, streaming: false });

    void bootViews<SceneView>(
      { stereo, sequential: budget.sequentialViewInit },
      {
        makeView: (slot) => makeView(slot === 'left' ? left : (right as HTMLDivElement)),
        adopt: (view) => {
          teardownFallback.push(installBasemapFallback(view));
          viewsRef.current = [...viewsRef.current, view];
          // Dev-only inspection handle, refreshed as each eye joins. The
          // immersive view has no widgets and no popups, so there is otherwise
          // no way to interrogate the scene from the console. Stripped from
          // production builds by the `DEV` guard.
          if (import.meta.env.DEV) {
            (window as unknown as { __vrViews?: SceneView[] }).__vrViews = viewsRef.current;
          }
          eyeBoxRef.current = eyeBoxOf(view) ?? eyeBoxRef.current;
          // Put the camera where the viewer already is, immediately — otherwise
          // the first frame is drawn from ArcGIS's default globe camera and the
          // scene visibly snaps into place a moment later.
          applyCurrentPose();
          // In stereo the gyro owns the camera; user drag would fight it and
          // break the stereo pair's alignment.
          if (stereo) {
            void view.when(() => {
              view.navigation.mouseWheelZoomEnabled = false;
              view.navigation.browserTouchPanEnabled = false;
            });
          }
        },
        // Waits on the glTF port assets, NOT on `view.updating` — the animator
        // and the auto-tour both keep that permanently true, so a gate hung on
        // it would never open by itself. See `viewReady.ts`.
        //
        // Tracked so teardown can cancel it: otherwise a mode flip leaves a live
        // watch and a timer of up to 25 s holding the layer views of a SceneView
        // that has already been destroyed.
        waitDrawn: (view) => {
          const w = whenAssetsDrawn(view, [berthsL, ...scenery], budget.readyTimeoutMs);
          pendingWaits.push(w);
          return w;
        },
        isCancelled: () => cancelled,
        onFirstEye: () => setReadiness('first-eye'),
        onReady: (outcomes) => {
          const stillStreaming = outcomes.some((o) => o !== 'drawn');
          setStreaming(stillStreaming);
          setReadiness('ready');
          readyRef.current?.({ ready: true, streaming: stillStreaming });
        },
      }
    );

    // The budget the scene was actually built to — the first thing to check when
    // a device behaves differently from the one in front of you.
    if (import.meta.env.DEV) {
      (window as unknown as { __vrBudget?: SceneBudget }).__vrBudget = budget;
    }

    return () => {
      cancelled = true;
      stopAnim();
      for (const w of pendingWaits) w.cancel();
      for (const t of teardownFallback) t();
      for (const v of viewsRef.current) v.destroy();
      viewsRef.current = [];
      layersRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, budget]);

  // ---- drive the camera from the viewer pose --------------------------------
  // Subscribing to the store transiently (outside React render) keeps head
  // movement off the React commit path — at 60 Hz a setState per frame would
  // re-render the HUD continuously and blow the frame budget.
  //
  // The write is then COALESCED to one animation frame. Two independent sources
  // move this camera (the head tracker and the tour director) and each store
  // write used to push a new camera into every SceneView immediately — two or
  // three camera changes per drawn frame, all but the last of them discarded,
  // paid for out of the same main-thread budget the renderer is short of. One
  // write per frame also guarantees both eyes are set from the SAME pose in the
  // SAME task, which is what keeps the stereo pair aligned.
  useEffect(() => {
    const coalescer = coalesceToFrame(applyCurrentPose);

    // Rotating the phone changes the eye box's aspect ratio, and the field of
    // view is derived from it — so a rotation that did not re-measure would
    // leave the world stretched until the next resize.
    const remeasure = () => {
      const v = viewsRef.current[0];
      if (v) eyeBoxRef.current = eyeBoxOf(v) ?? eyeBoxRef.current;
      coalescer.schedule();
    };

    applyCurrentPose();
    const unsubscribe = useVrStore.subscribe(coalescer.schedule);
    window.addEventListener('resize', remeasure);
    window.addEventListener('orientationchange', remeasure);
    return () => {
      coalescer.cancel();
      unsubscribe();
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('orientationchange', remeasure);
    };
  }, [mode, applyCurrentPose]);

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
      <Eye viewRef={leftRef} stereo={stereo} scale={budget.renderScale} />
      {stereo ? <Eye viewRef={rightRef} stereo scale={budget.renderScale} /> : null}
      {readiness !== 'ready' ? <RevealGate readiness={readiness} budget={budget} /> : null}
      {streaming ? <StreamingBadge /> : null}
    </div>
  );
}

/**
 * Which scenery layers survive this budget.
 *
 * Titles rather than instanceof checks because `portAssetLayers()` is a flat
 * list of FeatureLayers that differ only by what they carry; the title is the
 * thing that names the content.
 */
function keepLayer(title: string, budget: SceneBudget): boolean {
  if (/Trucks/i.test(title)) return budget.includeTrucks;
  if (/Harbour tug/i.test(title)) return budget.includeTug;
  if (/Berthed vessels/i.test(title)) return budget.includeBerthedVessels;
  return true;
}

/** One eye box's CSS size, for the FOV's aspect ratio. */
function eyeBoxOf(view: SceneView): { width: number; height: number } | undefined {
  const el = view.container as HTMLElement | null | undefined;
  if (!el || !el.clientWidth || !el.clientHeight) return undefined;
  return { width: el.clientWidth, height: el.clientHeight };
}

/**
 * The reveal gate.
 *
 * Covers BOTH eyes until both have drawn. Without it the viewer watches the port
 * assemble itself — and in stereo watches it assemble at two different rates,
 * which is far worse than a two-second wait: the eyes cannot fuse two different
 * scenes, and the reflex is to pull the headset off.
 *
 * Deliberately opaque rather than a spinner over a half-built scene: the whole
 * value of the gate is that nothing half-built is ever seen.
 */
function RevealGate({ readiness, budget }: { readiness: SceneReadiness; budget: SceneBudget }) {
  const slow = budget.network !== 'fast';
  return (
    <div
      aria-live="polite"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        // Matches the ground underlay, so the gate lifting is a reveal rather
        // than a flash from black.
        background: 'linear-gradient(180deg, #8fa6bd 0%, #5d6f5f 62%, #4a5749 100%)',
        color: '#fff',
        fontFamily: 'Avenir Next, Segoe UI, sans-serif',
        textAlign: 'center',
        padding: 24,
        zIndex: 6,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: 0.3 }}>
        Building the port…
      </div>
      <div style={{ fontSize: 12.5, opacity: 0.85, maxWidth: '46ch', lineHeight: 1.5 }}>
        {readiness === 'first-eye'
          ? 'Loading the terminals, cranes and fleet into the first eye — the second follows from the same cache so both come up together.'
          : slow
            ? 'Streaming imagery and 3D models over a slow connection. Both eyes are held back until the scene is complete.'
            : 'Loading imagery, terrain and the 3D port assets.'}
      </div>
      <div
        aria-hidden
        style={{
          width: 180,
          height: 3,
          borderRadius: 2,
          background: 'rgba(255,255,255,0.25)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: '38%',
            height: '100%',
            background: 'rgba(255,255,255,0.85)',
            animation: 'vr-gate-sweep 1.4s ease-in-out infinite',
          }}
        />
      </div>
      <style>{`@keyframes vr-gate-sweep{0%{transform:translateX(-120%)}100%{transform:translateX(360%)}}`}</style>
    </div>
  );
}

/**
 * Shown when the gate opened on the timeout rather than on a finished scene, so
 * an operator seeing a soft-looking port knows it is still filling in and not
 * broken. Small and out of the way — this is information, not an error.
 */
function StreamingBadge() {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 8,
        right: 8,
        padding: '3px 9px',
        borderRadius: 4,
        background: 'rgba(12,16,22,0.7)',
        color: '#fff',
        fontFamily: 'Avenir Next, Segoe UI, sans-serif',
        fontSize: 11,
        pointerEvents: 'none',
        zIndex: 6,
      }}
    >
      still streaming imagery
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
  scale,
}: {
  viewRef: React.MutableRefObject<HTMLDivElement | null>;
  stereo: boolean;
  scale: number;
}) {
  // Render scale: hand the SceneView a SMALLER box so it rasterises fewer
  // pixels, then blow it back up with a CSS transform. At 0.6 that is 36% of
  // the pixels — the biggest single win available on a phone at
  // devicePixelRatio 3, and through a cardboard lens the softening does not read.
  //
  // The box keeps the eye's ASPECT RATIO (both dimensions scale together), which
  // matters because the field of view is derived from it.
  const box: React.CSSProperties =
    scale < 1
      ? {
          position: 'absolute',
          top: 0,
          left: 0,
          width: `${100 * scale}%`,
          height: `${100 * scale}%`,
          transform: `scale(${1 / scale})`,
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
