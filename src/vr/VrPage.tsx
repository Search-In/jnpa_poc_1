/**
 * VrPage — the standalone immersive walkthrough (`#/vr`).
 *
 * Two states:
 *  1. SETUP — a top-down map to plant the viewer, vantage presets, eye height,
 *     and the scenario picker. Nothing is immersive yet.
 *  2. ENTERED — the first-person scene fills the screen with a HUD listing the
 *     impacted assets and the live environment readout.
 *
 * Scenario control writes through the SAME `useSimStore.loadScenario` the
 * dashboard uses, so a scenario started here is the identical run — and because
 * the store broadcasts across tabs, a scenario loaded in the dashboard is
 * already live when you walk in here.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSimStore } from '@/sim/simStore';
import { useSimClock } from '@/sim/useSimClock';
import { useSimReactivity } from '@/sim/useSimReactivity';
import { SCENARIOS, scenarioLevers } from '@/sim/scenarios';
import { DOMAIN_COLOR } from '@/whatif/causalGraph';
import { tokens } from '@/theme/tokens';
import { navigate } from '@/sim/useHashRoute';
import { PlacePicker } from './PlacePicker';
import { VrScene } from './VrScene';
import { GlVrScene } from './gl/GlVrScene';
import { useVrData } from './useVrData';
import { defaultVantages, useVrStore, type VrMode } from './vrStore';
import { walk, groundDistanceM, bearingTo, type ViewerPose } from './stereo';
import { overallSeverity } from './impactModel';
import { buildShots, tourDurationMs, tourFrame } from './cinematic';
import { useGyro } from './useGyro';
import { currentBudget } from './device';
import { clampFov, defaultFovDeg, FOV_MAX_DEG, FOV_MIN_DEG } from './sceneBudget';
import { modelsFor, transferSeconds, warmModels, type WarmupProgress } from './warmup';
import { asset3dPosition } from '@/map/scene3d';
import { PORT_CENTER } from '@/map/portGeometry';
import { resolveImpactPosition } from './impactLayers';

const SEVERITY_COLOR: Record<string, string> = {
  critical: tokens.bad,
  warn: tokens.warn,
  info: tokens.accent,
  none: tokens.kpi.neutral,
};

const SEVERITY_GLYPH: Record<string, string> = {
  critical: '▲',
  warn: '●',
  info: '·',
  none: '·',
};

export function VrPage() {
  // The walkthrough runs its own clock + reactivity so it works as a standalone
  // tab; both are idempotent and cross-tab safe.
  useSimClock();
  useSimReactivity();

  const { berths, vessels, model, loading } = useVrData();
  const entered = useVrStore((s) => s.entered);
  const mode = useVrStore((s) => s.mode);

  return entered ? (
    <Immersive berths={berths} vessels={vessels} model={model} mode={mode} />
  ) : (
    <Setup impacts={model.impacts} berths={berths} loading={loading} />
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function Setup({
  impacts,
  berths,
  loading,
}: {
  impacts: ReturnType<typeof useVrData>['model']['impacts'];
  berths: ReturnType<typeof useVrData>['berths'];
  loading: boolean;
}) {
  const vantages = useMemo(() => defaultVantages(), []);
  const scenarioId = useSimStore((s) => s.scenarioId);
  const loadScenario = useSimStore((s) => s.loadScenario);
  const clearScenario = useSimStore((s) => s.clearScenario);
  const setRunning = useSimStore((s) => s.setRunning);
  const running = useSimStore((s) => s.running);

  const longitude = useVrStore((s) => s.longitude);
  const latitude = useVrStore((s) => s.latitude);
  const eyeHeightM = useVrStore((s) => s.eyeHeightM);
  const heading = useVrStore((s) => s.heading);
  const enter = useVrStore((s) => s.enter);
  const setEyeHeight = useVrStore((s) => s.setEyeHeight);
  const setHeading = useVrStore((s) => s.setHeading);
  const applyVantage = useVrStore((s) => s.applyVantage);

  const narrow = useNarrowViewport();
  const [xrSupported, setXrSupported] = useState<boolean | null>(null);
  useEffect(() => {
    const xr = (navigator as unknown as { xr?: { isSessionSupported(m: string): Promise<boolean> } }).xr;
    if (!xr?.isSessionSupported) {
      setXrSupported(false);
      return;
    }
    xr.isSessionSupported('immersive-vr').then(setXrSupported).catch(() => setXrSupported(false));
  }, []);

  /**
   * Pull the port's 3D models down while the operator is still choosing a
   * scenario.
   *
   * This screen is dead time — a dropdown and two buttons — and the scene behind
   * it needs ~1.2 MB of glTF before it reads as JNPA, which on 3G is around
   * twenty seconds of a viewer standing in an empty world. Spending that time
   * here instead means the walkthrough opens onto a finished port, and in stereo
   * it means the second eye's fetches are cache hits rather than a race with the
   * first for the same pipe.
   */
  const budget = useMemo(() => currentBudget(false), []);
  const [warm, setWarm] = useState<WarmupProgress | null>(null);
  useEffect(() => {
    if (!budget.prefetchModels) return;
    const models = modelsFor(budget);
    const handle = warmModels(models, {
      concurrency: budget.prefetchConcurrency,
      onProgress: setWarm,
    });
    return () => handle.cancel();
  }, [budget]);
  const warmSeconds = useMemo(
    () => Math.round(transferSeconds(modelsFor(budget), budget.network)),
    [budget]
  );

  /**
   * Enter the immersive view.
   *
   * Fullscreen is requested HERE, inside the click handler, because it needs a
   * user gesture — asking for it from an effect after mount is outside the
   * gesture and the browser rejects it silently, which is why the view never
   * went fullscreen before. Landscape is then locked for stereo, since a
   * cardboard holder is landscape by construction. Both are best-effort: a
   * rejection is normal on desktop and must not block entry.
   */
  const go = (m: VrMode) => {
    if (!running) setRunning(true);
    void (async () => {
      try {
        if (!document.fullscreenElement) {
          await document.documentElement.requestFullscreen?.();
        }
        if (m === 'vr') {
          const orientation = screen.orientation as ScreenOrientation & {
            lock?: (o: string) => Promise<void>;
          };
          await orientation?.lock?.('landscape');
        }
      } catch {
        /* not permitted here — the view still works, just windowed */
      }
    })();
    enter(m);
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        // The walkthrough is set up ON the phone that is about to go into the
        // holder, so the setup screen has to work at 393 px as well as on a
        // laptop. Side by side, a 320 px minimum sidebar would leave the map
        // 70 px wide and the whole thing unusable; stacked, the controls come
        // first and the place-picker map sits under them.
        ...(narrow
          ? { gridTemplateRows: 'auto minmax(280px, 45vh)', overflowY: 'auto' }
          : { gridTemplateColumns: 'minmax(320px, 380px) 1fr' }),
        background: tokens.bg,
        color: tokens.text,
        fontFamily: 'Avenir Next, Segoe UI, sans-serif',
      }}
    >
      <aside
        style={{
          overflowY: 'auto',
          padding: narrow ? tokens.space.md : tokens.space.lg,
          ...(narrow
            ? { borderBottom: `1px solid ${tokens.border}` }
            : { borderRight: `1px solid ${tokens.border}` }),
          background: tokens.panel,
        }}
      >
        <button
          onClick={() => navigate('/')}
          style={{ ...linkBtn, marginBottom: tokens.space.md }}
        >
          ← Back to dashboard
        </button>

        <h1 style={{ fontSize: 20, margin: `0 0 ${tokens.space.xs}px` }}>
          Port walkthrough — 3D &amp; VR
        </h1>
        <p style={{ margin: 0, color: tokens.textMuted, fontSize: 13, lineHeight: 1.5 }}>
          Stand anywhere in the port and watch a what-if scenario play out around you.
          Impacted assets are ringed and labelled in the scene.
        </p>

        <Section title="1 · Where do you stand?">
          <p style={{ ...hint, marginTop: 0 }}>
            Click the map to drop yourself in, or pick a vantage point.
          </p>
          <div style={{ fontSize: 12, color: tokens.textMuted, marginBottom: tokens.space.sm }}>
            {latitude.toFixed(5)}°N, {longitude.toFixed(5)}°E
          </div>
          <select
            value=""
            onChange={(e) => {
              const v = vantages.find((x) => x.id === e.target.value);
              if (v) applyVantage(v);
            }}
            style={input}
          >
            <option value="">Vantage point…</option>
            {vantages.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>

          <label style={label}>
            Eye height — {eyeHeightM.toFixed(1)} m
            <input
              type="range"
              min={1}
              max={160}
              step={0.5}
              value={eyeHeightM}
              onChange={(e) => setEyeHeight(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </label>
          <label style={label}>
            Facing — {Math.round(heading)}°
            <input
              type="range"
              min={0}
              max={359}
              step={1}
              value={heading}
              onChange={(e) => setHeading(Number(e.target.value))}
              style={{ width: '100%' }}
            />
          </label>
        </Section>

        <Section title="2 · Which scenario?">
          <select
            value={scenarioId ?? ''}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) clearScenario();
              else loadScenario(id, scenarioLevers(id));
            }}
            style={input}
          >
            <option value="">Free run (no scenario)</option>
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.code} — {s.title}
              </option>
            ))}
          </select>
          <p style={hint}>
            {loading
              ? 'Loading port data…'
              : impacts.length
                ? `${impacts.length} asset${impacts.length > 1 ? 's' : ''} impacted — ringed on the map.`
                : 'No assets impacted under the current levers.'}
          </p>
        </Section>

        <Section title="3 · How do you want to see it?">
          <button onClick={() => go('3d')} style={primaryBtn}>
            Enter 3D walkthrough
          </button>
          <button onClick={() => go('vr')} style={{ ...primaryBtn, marginTop: tokens.space.sm }}>
            Enter VR (stereo) mode
          </button>
          <p style={hint}>
            <strong>3D</strong> — full-screen first person, drag or use the arrow keys to look and walk.
            <br />
            <strong>VR</strong> — side-by-side stereo with gyroscope look-around, for a phone in a
            cardboard holder. Works fullscreen in a headset browser too.
          </p>
          <p style={{ ...hint, color: tokens.textMuted }}>
            {xrSupported === null
              ? 'Checking headset support…'
              : xrSupported
                ? 'A WebXR headset is present. This build renders stereo through the ArcGIS scene engine rather than opening an immersive-vr session — see the note below.'
                : 'No WebXR headset detected — stereo mode is the phone/cardboard presentation.'}
          </p>
          <ReadinessLine warm={warm} network={budget.network} estimateS={warmSeconds} />
        </Section>

        <p style={{ ...hint, borderTop: `1px solid ${tokens.border}`, paddingTop: tokens.space.sm }}>
          The scene is rendered by the ArcGIS scene engine from the same surveyed
          geometry as the main 3D view, so what you walk through is the twin — not a
          separate model. Native <code>immersive-vr</code> is not used because the
          scene engine cannot render into a WebXR session; leaving it would break the
          GIS-native requirement.
        </p>
      </aside>

      <main style={{ position: 'relative' }}>
        <PlacePicker impacts={impacts} berths={berths} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Immersive
// ---------------------------------------------------------------------------

function Immersive({
  berths,
  vessels,
  model,
  mode,
}: {
  berths: ReturnType<typeof useVrData>['berths'];
  vessels: ReturnType<typeof useVrData>['vessels'];
  model: ReturnType<typeof useVrData>['model'];
  mode: VrMode;
}) {
  const exit = useVrStore((s) => s.exit);
  const showLabels = useVrStore((s) => s.showLabels);
  const showEdges = useVrStore((s) => s.showEdges);
  const toggleLabels = useVrStore((s) => s.toggleLabels);
  const toggleEdges = useVrStore((s) => s.toggleEdges);
  const [hudOpen, setHudOpen] = useState(true);
  /**
   * The scene holds this back until both eyes have their 3D assets. The tour is
   * gated on it because a director flying the camera over a port that has not
   * arrived is not just pointless — it keeps the basemap permanently streaming
   * tiles for viewpoints it has already left, which is the thing making the
   * arrival slow in the first place.
   */
  const [sceneReady, setSceneReady] = useState(false);

  // ---- desktop look + walk --------------------------------------------------
  useEffect(() => {
    if (mode === 'vr') return;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const s = useVrStore.getState();
      // 0.25°/px is close to a 1:1 feel at a typical 90° horizontal FOV.
      s.setLook(s.heading + (e.clientX - lastX) * 0.25, s.tilt - (e.clientY - lastY) * 0.25);
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = () => {
      dragging = false;
    };
    const onKey = (e: KeyboardEvent) => {
      const s = useVrStore.getState();
      const step = e.shiftKey ? 40 : 12;
      let fwd = 0;
      let strafe = 0;
      if (e.key === 'ArrowUp' || e.key === 'w') fwd = step;
      else if (e.key === 'ArrowDown' || e.key === 's') fwd = -step;
      else if (e.key === 'ArrowLeft' || e.key === 'a') strafe = -step;
      else if (e.key === 'ArrowRight' || e.key === 'd') strafe = step;
      else if (e.key === 'Escape') {
        useVrStore.getState().exit();
        return;
      } else return;
      e.preventDefault();
      const next = walk(
        { longitude: s.longitude, latitude: s.latitude, z: s.eyeHeightM, heading: s.heading, tilt: s.tilt },
        fwd,
        strafe
      );
      s.place(next.longitude, next.latitude);
    };

    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [mode]);

  // ---- gyroscope look (VR mode) ---------------------------------------------
  // Head tracking writes through `setGyroLook`, which does NOT cancel the tour:
  // in cardboard the tour carries you between vantage points while your head
  // decides where you face, exactly as a real headset behaves.
  const gyro = useGyro(mode === 'vr', (heading, tilt) => {
    useVrStore.getState().setGyroLook(heading, tilt);
  });

  // Mirror the sensor state into the store so the scene knows whether the tour
  // may write heading/tilt or only position.
  useEffect(() => {
    useVrStore.getState().setGyro(gyro.live, gyro.message);
  }, [gyro.live, gyro.message]);

  // Fullscreen is ENTERED from the click handler in `Setup.go` (it needs a user
  // gesture); this only undoes it, plus the orientation lock, on the way out.
  useEffect(
    () => () => {
      const orientation = screen.orientation as ScreenOrientation & { unlock?: () => void };
      try {
        orientation?.unlock?.();
      } catch {
        /* not supported — nothing to undo */
      }
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
    },
    []
  );

  /**
   * Keep the screen awake while the walkthrough is on. A phone dimming out
   * mid-demo, inside a cardboard holder where nobody can reach the screen, ends
   * the demo. Best-effort: unsupported browsers just carry on.
   */
  useEffect(() => {
    let sentinel: { release: () => Promise<void> } | null = null;
    const wakeLock = (navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
    }).wakeLock;
    void wakeLock
      ?.request('screen')
      .then((s) => {
        sentinel = s;
      })
      .catch(() => {});
    return () => {
      void sentinel?.release().catch(() => {});
    };
  }, []);

  const severity = overallSeverity(model.impacts);
  const env = model.environment;

  // ---- cinematic auto-tour ---------------------------------------------------
  const autoTour = useVrStore((s) => s.autoTour);
  const [caption, setCaption] = useState<{ title: string; subtitle: string; n: number; of: number } | null>(
    null
  );

  // The shot list only needs rebuilding when the impact SET changes, not on
  // every tide tick — otherwise the tour restarts four times a second.
  const shotSignature = model.impacts
    .map((i) => `${i.assetId}|${i.severity}`)
    .join('~');
  const shots = useMemo(
    () => buildShots(model, berths, PORT_CENTER),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shotSignature, berths]
  );

  // In cardboard the head owns the look direction, so the tour is demoted to
  // moving the viewer between beats.
  const headTracked = mode === 'vr' && gyro.live;

  // Recomputed when head tracking comes up, because that is what decides how
  // far the camera may fling itself: a 90 m arc is cinematic on a monitor and
  // nauseating with your head in a holder.
  const budget = useMemo(
    () => currentBudget(mode === 'vr', { headTracked }),
    [mode, headTracked]
  );

  useEffect(() => {
    if (!autoTour || shots.length === 0 || !sceneReady) {
      setCaption(null);
      return;
    }
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const from: ViewerPose = {
      longitude: useVrStore.getState().longitude,
      latitude: useVrStore.getState().latitude,
      z: useVrStore.getState().eyeHeightM,
      heading: useVrStore.getState().heading,
      tilt: useVrStore.getState().tilt,
    };
    const total = tourDurationMs(shots);
    let raf = 0;
    let t0 = 0;
    let lastIndex = -1;

    // Match the scene animator's rate — 30 Hz on a desktop, 20 in stereo on a
    // handset. Every pose write notifies every store subscriber and marks the
    // camera dirty; running that at display rate is double the work for motion
    // no one can see the difference in.
    const MIN_STEP_MS = 1000 / budget.tourHz;
    let lastStep = -Infinity;

    const step = (ts: number) => {
      raf = requestAnimationFrame(step);
      if (ts - lastStep < MIN_STEP_MS) return;
      lastStep = ts;
      if (!t0) t0 = ts;
      // Loop the tour so an unattended demo keeps cycling the story.
      const elapsed = (ts - t0) % Math.max(1, total);
      const f = tourFrame(shots, from, elapsed, reduced, { arcM: budget.tourArcM });
      if (!f) return;
      // With head tracking live the viewer owns heading/tilt; the tour only
      // carries them to the next vantage point.
      useVrStore.getState().setTourPose(f.pose, headTracked);
      if (f.index !== lastIndex) {
        lastIndex = f.index;
        setCaption({
          title: f.shot.title,
          subtitle: f.shot.subtitle,
          n: f.index + 1,
          of: shots.length,
        });
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [autoTour, shots, headTracked, budget, sceneReady]);

  // Distance/bearing from the viewer to each impacted asset — "which way do I
  // turn to see this" is the first question in a first-person view.
  //
  // Sampled on an interval rather than subscribed: while the tour is flying, the
  // camera moves every frame, and a per-frame re-render of this list would cost
  // more than the scene it is describing.
  const [longitude, setLongitude] = useState(() => useVrStore.getState().longitude);
  const [latitude, setLatitude] = useState(() => useVrStore.getState().latitude);
  useEffect(() => {
    const id = setInterval(() => {
      const s = useVrStore.getState();
      setLongitude(s.longitude);
      setLatitude(s.latitude);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const ranked = useMemo(() => {
    const anchors = asset3dPosition();
    return model.impacts
      .map((i) => {
        const pos = resolveImpactPosition(i, berths, anchors);
        return pos
          ? {
              impact: i,
              distanceM: groundDistanceM(longitude, latitude, pos[0], pos[1]),
              bearing: bearingTo(longitude, latitude, pos[0], pos[1]),
            }
          : null;
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => a.distanceM - b.distanceM);
  }, [model.impacts, berths, longitude, latitude]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#000' }}>
      {useEsriRenderer() ? (
        <VrScene
          key={mode}
          berths={berths}
          vessels={vessels}
          model={model}
          onReadyChange={({ ready }) => setSceneReady(ready)}
        />
      ) : (
        <GlVrScene
          key={mode}
          berths={berths}
          vessels={vessels}
          model={model}
          onReadyChange={({ ready }) => setSceneReady(ready)}
        />
      )}

      {/* Control strip — mirrored into both eye boxes would be unreadable, so it
          sits above the split as a single thin bar. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          gap: tokens.space.sm,
          alignItems: 'center',
          padding: `${tokens.space.xs}px ${tokens.space.sm}px`,
          background: `${tokens.panel}E6`,
          borderBottom: `1px solid ${tokens.border}`,
          fontFamily: 'Avenir Next, Segoe UI, sans-serif',
          fontSize: 12,
          zIndex: 10,
        }}
      >
        <button onClick={exit} style={linkBtn}>
          ✕ Exit
        </button>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: tokens.radius.sm,
            background: SEVERITY_COLOR[severity],
            color: '#fff',
            fontWeight: 700,
          }}
        >
          {SEVERITY_GLYPH[severity]} {model.scenarioTitle ?? 'Free run'}
        </span>
        <span style={{ color: tokens.textMuted }}>
          Tide {env.tideM.toFixed(2)} m · Wind {env.windKt} kt · Sea {env.seaStateM} m · Vis{' '}
          {env.visibilityNm} nm · Depth {env.controllingDepthM} m
        </span>
        {env.pilotageSuspended ? (
          <span style={{ color: tokens.bad, fontWeight: 700 }}>PILOTAGE SUSPENDED</span>
        ) : null}
        {env.movementsSuspended ? (
          <span style={{ color: tokens.bad, fontWeight: 700 }}>MOVEMENTS SUSPENDED</span>
        ) : null}
        <span style={{ flex: 1 }} />
        <button
          onClick={() => useVrStore.getState().setAutoTour(!autoTour)}
          style={autoTour ? primaryBtnSm : linkBtn}
          title="Fly the camera to each impacted asset in the order the disruption propagates"
        >
          {autoTour ? '⏸ Auto-tour' : '▶ Auto-tour'}
        </button>
        <button onClick={toggleLabels} style={linkBtn}>
          {showLabels ? 'Hide' : 'Show'} labels
        </button>
        <button onClick={toggleEdges} style={linkBtn}>
          {showEdges ? 'Hide' : 'Show'} causal edges
        </button>
        <FovControl mode={mode} />
        {mode === 'vr' && !gyro.live ? (
          <button onClick={() => void gyro.request()} style={primaryBtnSm}>
            Enable look-around
          </button>
        ) : null}
        <button onClick={() => setHudOpen((v) => !v)} style={linkBtn}>
          {hudOpen ? 'Hide' : 'Show'} impacts
        </button>
      </div>

      {/* Cinematic caption — the lower-third that names the beat you are watching. */}
      {caption ? (
        <div
          style={{
            position: 'absolute',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            maxWidth: '52ch',
            textAlign: 'center',
            background: 'rgba(12,16,22,0.72)',
            color: '#fff',
            padding: '10px 18px',
            borderRadius: tokens.radius.md,
            fontFamily: 'Avenir Next, Segoe UI, sans-serif',
            pointerEvents: 'none',
            zIndex: 9,
          }}
        >
          <div style={{ fontSize: 10, letterSpacing: 1.2, opacity: 0.7, textTransform: 'uppercase' }}>
            {model.scenarioTitle ?? 'Free run'} · beat {caption.n} of {caption.of}
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>{caption.title}</div>
          <div style={{ fontSize: 12.5, opacity: 0.88, marginTop: 3, lineHeight: 1.45 }}>
            {caption.subtitle}
          </div>
        </div>
      ) : null}

      {gyro.message ? (
        <div
          style={{
            position: 'absolute',
            top: 40,
            left: '50%',
            transform: 'translateX(-50%)',
            background: tokens.bad,
            color: '#fff',
            padding: `${tokens.space.xs}px ${tokens.space.sm}px`,
            borderRadius: tokens.radius.sm,
            fontSize: 12,
            zIndex: 11,
          }}
        >
          {gyro.message}
        </div>
      ) : null}

      {hudOpen ? (
        <div
          style={{
            position: 'absolute',
            bottom: tokens.space.sm,
            left: tokens.space.sm,
            maxWidth: 380,
            maxHeight: '46vh',
            overflowY: 'auto',
            background: `${tokens.panel}F2`,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radius.md,
            padding: tokens.space.sm,
            fontFamily: 'Avenir Next, Segoe UI, sans-serif',
            fontSize: 12,
            color: tokens.text,
            zIndex: 10,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: tokens.space.xs }}>
            Impacted assets ({ranked.length})
          </div>
          {ranked.length === 0 ? (
            <div style={{ color: tokens.textMuted }}>
              {model.scenarioTitle ? (
                <>
                  <strong>{model.scenarioTitle}</strong> is running, but nothing breaches a
                  limit at the moment — the tide is {env.tideM.toFixed(2)} m and the water
                  column still clears every draft. Impacts appear as the tide falls; leave it
                  running or watch the propagation path below.
                </>
              ) : (
                'Nothing impacted — free run. Pick a scenario to see the cascade.'
              )}
            </div>
          ) : (
            ranked.map(({ impact, distanceM, bearing }) => (
              <div
                key={`${impact.assetId}-${impact.headline}`}
                style={{
                  borderLeft: `3px solid ${SEVERITY_COLOR[impact.severity]}`,
                  paddingLeft: tokens.space.sm,
                  marginBottom: tokens.space.sm,
                }}
              >
                <div style={{ fontWeight: 700 }}>
                  {SEVERITY_GLYPH[impact.severity]} {impact.label}
                  <span style={{ fontWeight: 400, color: tokens.textMuted }}>
                    {' '}
                    · {distanceM < 1000
                      ? `${Math.round(distanceM)} m`
                      : `${(distanceM / 1000).toFixed(1)} km`}{' '}
                    at {Math.round(bearing)}°
                  </span>
                </div>
                <div>{impact.headline}</div>
                <div style={{ color: tokens.textMuted }}>{impact.detail}</div>
              </div>
            ))
          )}

          {model.edges.length ? (
            <>
              <div style={{ fontWeight: 700, margin: `${tokens.space.sm}px 0 ${tokens.space.xs}px` }}>
                How it propagates
              </div>
              {model.edges.map((e) => (
                <div key={`${e.fromAssetId}-${e.toAssetId}`} style={{ marginBottom: 2 }}>
                  <span style={{ color: DOMAIN_COLOR[e.domain] }}>■</span> {e.fromAssetId} →{' '}
                  {e.toAssetId}
                  <span style={{ color: tokens.textMuted }}> — {e.mechanism}</span>
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/**
 * Field-of-view trim, in the immersive control strip.
 *
 * The derived default matches what a cardboard lens presents (~97° diagonal for
 * a 20:9 handset held landscape), against ArcGIS's 55° default, which is a mild
 * telephoto and is what made the walkthrough read as "zoomed in". But viewers
 * differ — a Jio VR box, a Cardboard v2 and a headset browser all sit at
 * different distances from the screen — and an operator with the thing on their
 * face is a better judge than any spec sheet, so the trim is live and reversible.
 */
function FovControl({ mode }: { mode: VrMode }) {
  const fovDeg = useVrStore((s) => s.fovDeg);
  const setFov = useVrStore((s) => s.setFov);
  const effective = fovDeg ?? defaultFovDeg(mode === 'vr');
  const nudge = (delta: number) => setFov(clampFov(effective + delta));

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <button
        onClick={() => nudge(-6)}
        disabled={effective <= FOV_MIN_DEG}
        style={linkBtn}
        title="Narrower field of view (more magnified)"
      >
        −
      </button>
      <button
        onClick={() => setFov(null)}
        style={{ ...linkBtn, color: fovDeg == null ? tokens.textMuted : tokens.accent }}
        title={
          fovDeg == null
            ? 'Field of view — matched to the viewer optics. Click to reset once changed.'
            : 'Reset the field of view to the viewer-matched default'
        }
      >
        {Math.round(effective)}° FOV
      </button>
      <button
        onClick={() => nudge(6)}
        disabled={effective >= FOV_MAX_DEG}
        style={linkBtn}
        title="Wider field of view (more of the port in shot)"
      >
        +
      </button>
    </span>
  );
}

/**
 * "Is the port downloaded yet?" on the setup screen.
 *
 * Worth a line of UI because on a slow link it is the difference between an
 * operator hitting Enter into a half-built world and waiting ten more seconds
 * for one that is finished — and they can only make that choice if they can see
 * it happening.
 */
function ReadinessLine({
  warm,
  network,
  estimateS,
}: {
  warm: WarmupProgress | null;
  network: 'fast' | 'moderate' | 'slow';
  estimateS: number;
}) {
  if (!warm) return null;
  const done = warm.done >= warm.total;
  const pct = warm.total ? Math.round((warm.done / warm.total) * 100) : 100;
  const slow = network !== 'fast';
  return (
    <p style={{ ...hint, color: done ? tokens.good : tokens.textMuted }}>
      {done
        ? `Port models ready (${warm.total} assets, ${Math.round(warm.totalBytes / 1024)} KB) — the walkthrough will open on a finished scene.`
        : `Loading port models — ${pct}%${slow ? ` (about ${estimateS}s on this connection)` : ''}. You can enter now; the scene fills in as it arrives.`}
    </p>
  );
}

/**
 * True on a screen too narrow for a sidebar beside the map.
 *
 * Watched rather than read once: the setup screen is where the phone is still
 * in the operator's hand, so it gets rotated, and the immersive view locks
 * landscape on the way in.
 */
function useNarrowViewport(breakpointPx = 760): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.innerWidth < breakpointPx
  );
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < breakpointPx);
    onResize();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, [breakpointPx]);
  return narrow;
}

/**
 * Which renderer draws the immersive scene.
 *
 * The WebGL path is the default: one canvas, one scene, two viewport passes.
 * `?renderer=esri` puts the two-SceneView path back, because when a device
 * misbehaves the fastest way to find out whether the renderer is responsible is
 * to swap it in the URL and look — no rebuild, no redeploy.
 */
function useEsriRenderer(): boolean {
  return useMemo(() => {
    try {
      // Accepted BEFORE the hash (`/?renderer=esri#/vr`) and inside it
      // (`#/vr?renderer=esri`). The app is hash-routed, so the natural thing to
      // type is the second form — and that one never reaches
      // `location.search`, which is exactly the trap this avoids.
      if (new URLSearchParams(window.location.search).get('renderer') === 'esri') return true;
      const q = window.location.hash.indexOf('?');
      if (q < 0) return false;
      return new URLSearchParams(window.location.hash.slice(q + 1)).get('renderer') === 'esri';
    } catch {
      return false;
    }
  }, []);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: tokens.space.lg }}>
      <h2
        style={{
          fontSize: 13,
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          color: tokens.textMuted,
          margin: `0 0 ${tokens.space.sm}px`,
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

const input: React.CSSProperties = {
  width: '100%',
  padding: 6,
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.border}`,
  background: tokens.panel,
  color: tokens.text,
  fontSize: 13,
};

const label: React.CSSProperties = {
  display: 'block',
  marginTop: tokens.space.sm,
  fontSize: 12,
  color: tokens.textMuted,
};

const hint: React.CSSProperties = {
  fontSize: 12,
  color: tokens.textMuted,
  lineHeight: 1.5,
  marginTop: tokens.space.sm,
  marginBottom: 0,
};

const primaryBtn: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: tokens.radius.sm,
  border: 'none',
  background: tokens.accent,
  color: '#fff',
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
};

const primaryBtnSm: React.CSSProperties = {
  padding: '3px 10px',
  borderRadius: tokens.radius.sm,
  border: 'none',
  background: tokens.accent,
  color: '#fff',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
};

const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: tokens.accent,
  cursor: 'pointer',
  fontSize: 12,
  padding: 2,
};
