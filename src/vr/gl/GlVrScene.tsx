/**
 * GlVrScene — the immersive walkthrough, rendered by one WebGL canvas.
 *
 * A drop-in replacement for `VrScene` with the same props and the same
 * behaviour, differing only in HOW the port is drawn:
 *
 *   VrScene    two Esri SceneViews · two WebGL contexts · two tile pyramids
 *   GlVrScene  one canvas · one scene · two viewport passes
 *
 * Measured on a throttled handset profile, stereo: the Esri path managed
 * **3.9 fps** with 98.6% of frames over 100 ms — the freezing this exists to
 * fix. Numbers for this path are in `docs/VR_WALKTHROUGH.md`.
 *
 * Everything ABOVE the renderer is unchanged and shared: the same
 * `impactModel`, `liveWorld`, `cinematic`, `vrStore`, `useGyro` and
 * `sceneBudget`. This swaps a renderer, not a feature — which is why the
 * walkthrough still cannot contradict the dashboard.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { Berth, Vessel } from '@/types/domain';
import { asset3dPosition } from '@/map/scene3d';
import { currentBudget } from '../device';
import { defaultFovDeg } from '../sceneBudget';
import { useVrStore } from '../vrStore';
import type { ViewerPose } from '../stereo';
import type { VrImpactModel } from '../impactModel';
import {
  advanceVessel,
  craneVisuals,
  hash01,
  holdState,
  seaMotion,
  staticHeel,
  waterSurfaceZ,
  weatherVisual,
  type MovingVessel,
} from '../liveWorld';
import { buildPortWorld, waterY, type PortWorld } from './portWorld';
import { createImpactMarkers, type ImpactMarkers } from './impactGl';
import { StereoRig, LENS_GUTTER_PX } from './stereoRig';
import { toLocal } from './geo';
import { headingToYaw } from './geo';

interface Props {
  berths: Berth[];
  vessels: Vessel[];
  model: VrImpactModel;
  onReadyChange?: (state: { ready: boolean; streaming: boolean }) => void;
}

/** Crane state → tint. `null` leaves the model's own materials alone. */
const CRANE_TINT: Record<string, number | null> = {
  working: null,
  idle: null,
  blocked: 0xd83020,
};

export function GlVrScene({ berths, vessels, model, onReadyChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);

  const mode = useVrStore((s) => s.mode);
  const stereo = mode === 'vr';
  const budget = useMemo(() => currentBudget(stereo), [stereo]);

  // Latest props, read by the frame loop without making it a dependency.
  const dataRef = useRef({ berths, vessels, model });
  dataRef.current = { berths, vessels, model };
  const readyRef = useRef(onReadyChange);
  readyRef.current = onReadyChange;

  const impactSignature = useMemo(
    () =>
      model.impacts.map((i) => `${i.assetId}|${i.severity}|${i.headline}`).join('~') +
      '||' +
      model.edges.map((e) => `${e.fromAssetId}>${e.toAssetId}`).join('~'),
    [model]
  );
  const signatureRef = useRef(impactSignature);
  signatureRef.current = impactSignature;

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    setReady(false);
    readyRef.current?.({ ready: false, streaming: false });

    const rig = new StereoRig({
      canvas,
      renderScale: budget.renderScale,
      // A phone reports devicePixelRatio 3. Through a cardboard lens — itself
      // soft and magnified — anything past 2 is invisible and costs 2.25× the
      // fragments.
      maxPixelRatio: budget.lowPower ? 2 : 3,
      antialias: !budget.lowPower,
    });

    let assetsDone = 0;
    const world: PortWorld = buildPortWorld({
      lowPower: budget.lowPower,
      includeYard: true,
      onProgress: (done, total) => {
        assetsDone = done;
        if (done >= total) {
          setReady(true);
          readyRef.current?.({ ready: true, streaming: false });
        }
      },
    });

    const markers: ImpactMarkers = createImpactMarkers();
    world.scene.add(markers.group);

    // The scene is up as soon as the geometry is; the glTF fills in behind the
    // gate. Never leave the viewer on a loading screen indefinitely.
    const readyFallback = window.setTimeout(() => {
      if (assetsDone === 0) {
        setReady(true);
        readyRef.current?.({ ready: true, streaming: true });
      }
    }, budget.readyTimeoutMs);

    const resize = () => {
      const r = host.getBoundingClientRect();
      rig.setSize(r.width, r.height);
    };
    resize();
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);

    // --- the frame loop -------------------------------------------------------
    const anchors = asset3dPosition();
    const fleet = new Map<string, MovingVessel>();
    const reducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let raf = 0;
    let startTs = 0;
    let lastTs = 0;
    /** World updates run below display rate; rendering does not. */
    const worldStepMs = 1000 / budget.animationHz;
    let lastWorldTs = -Infinity;

    const tmp = new THREE.Vector3();

    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame);
      if (!startTs) {
        startTs = ts;
        lastTs = ts;
      }
      const elapsedS = (ts - startTs) / 1000;
      const dtS = Math.min(0.25, Math.max(0, (ts - lastTs) / 1000));
      lastTs = ts;

      const { model: m, berths: bs, vessels: vs } = dataRef.current;
      const env = m.environment;
      const s = useVrStore.getState();

      // ---- world state, at the budgeted rate ----
      if (ts - lastWorldTs >= worldStepMs) {
        lastWorldTs = ts;
        const hold = holdState(env);
        const surfaceY = waterY(waterSurfaceZ(env));
        world.water.position.y = surfaceY;

        // Weather: fog carries visibility, which is the thing that actually
        // stops pilotage. Cheap, and it reads immediately.
        const w = weatherVisual(env);
        const vis = Math.max(0.05, Math.min(1, env.visibilityNm / 6));
        world.fog.near = w.type === 'foggy' ? 60 : 1_500 * vis;
        world.fog.far = (w.type === 'foggy' ? 1_200 : 14_000) * vis;
        const overcast = w.type === 'rainy' || w.type === 'foggy';
        world.sun.intensity = overcast ? 0.55 : 1.5;
        world.ambient.intensity = overcast ? 0.85 : 1.15;

        // Cranes gantry-travel when working, stop and go red when blocked.
        const visuals = craneVisuals(bs, m.impacts, elapsedS, reducedMotion);
        const byKey = new Map(visuals.map((v) => [v.key, v]));
        for (const crane of world.cranes) {
          const v = byKey.get(crane.key);
          if (!v) continue;
          const p = toLocal(v.longitude, v.latitude);
          crane.instance.setPose(p.x, crane.home.y, p.z, headingToYaw(v.heading));
          crane.setTint(CRANE_TINT[v.state] ?? null);
        }

        // Hulls: local integration so motion is continuous between adapter
        // pushes, seated on the live tide and heaving with the sea state.
        const live = new Set<string>();
        for (const v of vs) {
          live.add(v.MMSI);
          if (!fleet.has(v.MMSI)) {
            fleet.set(v.MMSI, {
              mmsi: v.MMSI,
              name: v.VESSEL_NAME,
              longitude: v.LON,
              latitude: v.LAT,
              heading: Number.isFinite(v.HEADING) ? v.HEADING : v.COG,
              sog: v.SOG,
              navStatus: v.NAV_STATUS,
              held: false,
            });
          } else {
            const cur = fleet.get(v.MMSI)!;
            cur.sog = v.SOG;
            cur.navStatus = v.NAV_STATUS;
          }
        }
        for (const mmsi of [...fleet.keys()]) if (!live.has(mmsi)) fleet.delete(mmsi);

        let slot = 0;
        for (const [mmsi, v] of fleet) {
          if (slot >= world.hullPool.length) break;
          const moved = advanceVessel(v, dtS, elapsedS, hold.holding, reducedMotion);
          fleet.set(mmsi, moved);
          const phase = hash01(mmsi);
          const motion = seaMotion(env.seaStateM, elapsedS, phase, reducedMotion);
          const heel = staticHeel(env.seaStateM, phase);
          const hull = world.hullPool[slot++];
          const p = toLocal(moved.longitude, moved.latitude);
          hull.setVisible(true);
          hull.setPose(
            p.x,
            surfaceY + motion.heaveM,
            p.z,
            headingToYaw(moved.heading),
            (heel.pitchDeg * Math.PI) / 180,
            (heel.rollDeg * Math.PI) / 180
          );
        }
        for (let i = slot; i < world.hullPool.length; i++) world.hullPool[i].setVisible(false);

        markers.update({
          impacts: m.impacts,
          edges: m.edges,
          berths: bs,
          anchors,
          signature: signatureRef.current,
          showLabels: s.showLabels,
          showEdges: s.showEdges,
        });
      }

      // ---- draw, every frame ----
      const pose: ViewerPose = {
        longitude: s.longitude,
        latitude: s.latitude,
        z: s.eyeHeightM,
        heading: s.heading,
        tilt: s.tilt,
      };
      const fov = s.fovDeg ?? defaultFovDeg(stereo);
      // Labels hold a constant angular size, so they need the camera position.
      tmp.copy(
        (() => {
          const l = toLocal(pose.longitude, pose.latitude, pose.z);
          return new THREE.Vector3(l.x, l.y, l.z);
        })()
      );
      markers.faceCamera({ position: tmp } as unknown as THREE.Camera);

      rig.render(world.scene, pose, { stereo, ipdM: s.ipdM, fovDeg: fov });
    };
    raf = requestAnimationFrame(frame);

    if (import.meta.env.DEV) {
      (window as unknown as { __vrGl?: unknown }).__vrGl = {
        info: () => rig.info(),
        world: () => world,
      };
    }

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(readyFallback);
      window.removeEventListener('resize', resize);
      window.removeEventListener('orientationchange', resize);
      markers.dispose();
      world.dispose();
      rig.dispose();
      if (import.meta.env.DEV) {
        delete (window as unknown as { __vrGl?: unknown }).__vrGl;
      }
    };
  }, [mode, stereo, budget]);

  return (
    <div ref={hostRef} style={{ position: 'absolute', inset: 0, background: '#000' }}>
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }}
      />
      {stereo ? <LensMask /> : null}
      {!ready ? <Gate /> : null}
    </div>
  );
}

/**
 * The cardboard lens presentation: a rounded mask and vignette over each eye.
 *
 * Drawn as an overlay rather than in the scene, because a real viewer's lens is
 * round — the corners of a full rectangle are never visible through it and only
 * serve to leak light between the eyes.
 */
function LensMask() {
  const eye: React.CSSProperties = {
    flex: 1,
    height: '100%',
    borderRadius: '22%',
    boxShadow: 'inset 0 0 9vmin 1.5vmin rgba(0,0,0,0.72)',
  };
  return (
    <div
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        gap: LENS_GUTTER_PX,
        pointerEvents: 'none',
      }}
    >
      <div style={eye} />
      <div style={eye} />
    </div>
  );
}

/** Held over both eyes until the port is there — never one eye ahead of the other. */
function Gate() {
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
        background: 'linear-gradient(180deg, #8fa6bd 0%, #5d6f5f 62%, #4a5749 100%)',
        color: '#fff',
        fontFamily: 'Avenir Next, Segoe UI, sans-serif',
        textAlign: 'center',
        padding: 24,
        zIndex: 6,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 700 }}>Building the port…</div>
      <div style={{ fontSize: 12.5, opacity: 0.85, maxWidth: '46ch', lineHeight: 1.5 }}>
        Loading the terminals, cranes and fleet. Both eyes are held back until the scene is complete.
      </div>
    </div>
  );
}
