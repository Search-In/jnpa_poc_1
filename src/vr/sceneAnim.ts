/**
 * Per-frame animator for the walkthrough — the module that makes the 3D OBJECTS
 * change, not just the labels above them.
 *
 * Five animated GraphicsLayers, driven by one `requestAnimationFrame` loop:
 *
 *  | layer  | what it shows                                                    |
 *  | ------ | ---------------------------------------------------------------- |
 *  | water  | the sea at the live tide, drawn over the channel and anchorages   |
 *  | cranes | STS cranes gantry-travelling when working, stopped and red when   |
 *  |        | their berth is out of service                                     |
 *  | wakes  | a widening wake astern of every hull making way                   |
 *  | fleet  | hulls floating at the tide, heaving/rolling/pitching with the sea, |
 *  |        | making way at their own SOG or stopped and swinging at anchor      |
 *  | glyphs | activity icons where the physics would be a research project      |
 *
 * Physics vs. glyphs. Motion that is cheap and honest to integrate is
 * integrated: hulls make way at their reported SOG, float on the live tide, and
 * respond to the sea state through a first-order seakeeping model
 * (`liveWorld.seaMotion`). Motion that would need a real simulation — a crane
 * hoist cycle, a mooring gang, a pilot transfer — is represented by a labelled
 * icon at the right place on the map instead of being faked in 3D.
 *
 * Everything is a deterministic function of an elapsed-time clock and freezes
 * under `prefers-reduced-motion`, matching the house rule recorded in
 * `public/models/CREDITS.md`.
 *
 * This REPLACES the static crane and simulated-fleet layers inside the
 * walkthrough only — the dashboard's `PortScene` keeps its own untouched copies.
 */
import Graphic from '@arcgis/core/Graphic';
import GraphicsLayer from '@arcgis/core/layers/GraphicsLayer';
import Point from '@arcgis/core/geometry/Point';
import Polygon from '@arcgis/core/geometry/Polygon';
import type SceneView from '@arcgis/core/views/SceneView';
import type { Berth, Vessel } from '@/types/domain';
import { ANCHORAGES, CHANNEL } from '@/map/portGeometry';
import { tokens } from '@/theme/tokens';
import type { VrImpactModel } from './impactModel';
import {
  advanceVessel,
  craneVisuals,
  hash01,
  holdState,
  seaBand,
  seaMotion,
  staticHeel,
  waterSurfaceZ,
  weatherVisual,
  type CraneState,
  type MovingVessel,
  type WeatherVisual,
} from './liveWorld';
import { bearingTo, normalizeHeading } from './stereo';
import { currentBudget } from './device';
import type { SceneBudget } from './sceneBudget';

/** Matches `portAssets3d` — the glTF assets are served from the site root. */
const MODELS = '/models';

export const ANIM_CRANE_TITLE = 'VR · Cranes (live)';
export const ANIM_FLEET_TITLE = 'VR · Fleet (live)';
export const ANIM_WATER_TITLE = 'VR · Water surface';
export const ANIM_WAKE_TITLE = 'VR · Wakes';
export const ANIM_GLYPH_TITLE = 'VR · Activity';

/** Crane state → glTF tint. `null` leaves the model's own materials alone. */
const CRANE_TINT: Record<CraneState, string | null> = {
  working: null,
  idle: null,
  blocked: tokens.bad,
};

function craneGraphic(
  longitude: number,
  latitude: number,
  heading: number,
  state: CraneState
): Graphic {
  const tint = CRANE_TINT[state];
  return new Graphic({
    geometry: new Point({ longitude, latitude }),
    attributes: { state },
    symbol: {
      type: 'point-3d',
      symbolLayers: [
        {
          type: 'object',
          resource: { href: `${MODELS}/sts-crane.glb` },
          height: 68,
          anchor: 'bottom',
          heading,
          ...(tint ? { material: { color: tint } } : {}),
        },
      ],
    } as never,
  });
}

/**
 * A hull, floating at the tide and moving with the sea.
 *
 * Drawn at absolute height rather than on the ground so it rides the water
 * surface: as the tide falls, every ship in the port visibly drops with it.
 */
function vesselGraphic(v: MovingVessel, z: number, seaStateM: number, phase: number): Graphic {
  // Attitude comes from the sea BAND, not the instantaneous wave phase, so this
  // symbol only has to be rebuilt when the sea meaningfully changes. Continuous
  // motion is carried by the geometry (`z`), which costs nothing to update.
  const heel = staticHeel(seaStateM, phase);
  return new Graphic({
    geometry: new Point({ longitude: v.longitude, latitude: v.latitude, z }),
    attributes: { mmsi: v.mmsi, name: v.name, held: v.held ? 1 : 0 },
    symbol: {
      type: 'point-3d',
      symbolLayers: [
        {
          type: 'object',
          resource: { href: `${MODELS}/container-ship.glb` },
          height: 26,
          anchor: 'bottom',
          heading: v.heading,
          tilt: heel.pitchDeg,
          roll: heel.rollDeg,
          // A held hull is tinted amber: the fleet visibly splits into "running"
          // and "stopped" without the viewer reading a single label.
          ...(v.held ? { material: { color: tokens.warn } } : {}),
        },
      ],
    } as never,
  });
}

/**
 * Wake astern of a hull making way — a tapering wedge whose length scales with
 * speed. Cheap, and it is the cue that tells you at a glance which ships are
 * running and which are stopped, from any distance.
 */
function wakeRings(v: MovingVessel, waterZ: number): number[][][] {
  const astern = normalizeHeading(v.heading + 180);
  const lengthM = Math.min(420, 34 * v.sog);
  const halfWidth = Math.min(70, 6 + v.sog * 3.4);
  const origin: [number, number] = [v.longitude, v.latitude];
  const tail = offsetByBearingPair(origin, astern, lengthM);
  const left = offsetByBearingPair(tail, normalizeHeading(astern - 90), halfWidth);
  const right = offsetByBearingPair(tail, normalizeHeading(astern + 90), halfWidth);
  const z = waterZ + 0.15;
  return [
    [
      [origin[0], origin[1], z],
      [left[0], left[1], z],
      [right[0], right[1], z],
      [origin[0], origin[1], z],
    ],
  ];
}

/** The wake fill — one shared symbol object, never re-created per frame. */
const WAKE_SYMBOL = {
  type: 'polygon-3d',
  symbolLayers: [
    { type: 'fill', material: { color: [255, 255, 255, 0.4] }, outline: { size: 0 } },
  ],
} as never;

/** True when this hull is making enough way to leave a wake. */
function hasWake(v: MovingVessel): boolean {
  return !v.held && v.sog >= 1.5;
}

/**
 * Cap weather intensity on a weak device without changing what it depicts.
 *
 * Precipitation density and fog thickness are the expensive dials; the weather
 * TYPE is what carries the meaning (fog is why pilotage stopped), so it is left
 * exactly as the engine chose it.
 */
export function softenWeather(w: WeatherVisual, soften: boolean): WeatherVisual {
  if (!soften) return w;
  if (w.type === 'rainy') {
    return {
      type: 'rainy',
      cloudCover: Math.min(w.cloudCover, 0.7),
      precipitation: Math.min(w.precipitation, 0.35),
    };
  }
  if (w.type === 'foggy') return { type: 'foggy', fogStrength: Math.min(w.fogStrength, 0.5) };
  return w;
}

/** `offsetMeters` works in degrees-per-metre units; this takes a bearing. */
function offsetByBearingPair(
  p: [number, number],
  bearingDeg: number,
  meters: number
): [number, number] {
  const M_PER_DEG_LAT = 110_574;
  const mPerDegLon = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const rad = (bearingDeg * Math.PI) / 180;
  return [
    p[0] + (Math.sin(rad) * meters) / mPerDegLon,
    p[1] + (Math.cos(rad) * meters) / M_PER_DEG_LAT,
  ];
}

/**
 * The sea surface at the live tide.
 *
 * Confined to water the port actually has geometry for — the charted channel
 * reaches and the two anchorages — rather than a bounding rectangle. A rectangle
 * is simpler but it floats over the terminals and hides the quays, cranes and
 * yard behind a sheet of blue, which is the opposite of showing the impact.
 */
function waterGraphics(z: number): Graphic[] {
  const fill = {
    type: 'polygon-3d',
    symbolLayers: [
      { type: 'fill', material: { color: [28, 92, 148, 0.42] }, outline: { size: 0 } },
    ],
  };
  const out: Graphic[] = [];

  // Anchorages are already polygons.
  for (const a of ANCHORAGES) {
    out.push(
      new Graphic({
        geometry: new Polygon({
          rings: [a.ring.map(([x, y]) => [x, y, z])],
          hasZ: true,
        }),
        symbol: fill as never,
      })
    );
  }

  // Each channel reach becomes a ribbon: one quad per leg, offset either side of
  // the centreline. Per-leg quads (rather than one long ring) keep the ribbon
  // from self-intersecting where the channel turns.
  // Must stay well inside the channel's own setback from the quay face
  // (`CH_SETBACK_M` = 260 m in portGeometry): a wider ribbon rides up over the
  // wharf and hides the berths and cranes behind a sheet of blue.
  const HALF_W = 140;
  for (const seg of CHANNEL) {
    for (let i = 0; i < seg.path.length - 1; i++) {
      const a = seg.path[i];
      const b = seg.path[i + 1];
      const brg = bearingTo(a[0], a[1], b[0], b[1]);
      const l = normalizeHeading(brg - 90);
      const r = normalizeHeading(brg + 90);
      const a1 = offsetByBearingPair(a, l, HALF_W);
      const a2 = offsetByBearingPair(a, r, HALF_W);
      const b1 = offsetByBearingPair(b, l, HALF_W);
      const b2 = offsetByBearingPair(b, r, HALF_W);
      out.push(
        new Graphic({
          geometry: new Polygon({
            rings: [
              [
                [a1[0], a1[1], z],
                [b1[0], b1[1], z],
                [b2[0], b2[1], z],
                [a2[0], a2[1], z],
                [a1[0], a1[1], z],
              ],
            ],
            hasZ: true,
          }),
          symbol: fill as never,
        })
      );
    }
  }
  return out;
}

/**
 * Activity icons — the user-visible answer to "what is happening HERE?" for the
 * things a browser scene cannot honestly simulate.
 *
 * Deliberately glyphs, not fake 3D: a container swinging on a wire would need a
 * hoist model, a spreader and a cycle time we do not have, and inventing one
 * would be exactly the kind of unsourced detail the integrity rules forbid.
 */
function glyphGraphic(
  longitude: number,
  latitude: number,
  z: number,
  glyph: string,
  color: string
): Graphic {
  return new Graphic({
    geometry: new Point({ longitude, latitude, z }),
    symbol: {
      type: 'point-3d',
      symbolLayers: [
        {
          type: 'text',
          text: glyph,
          material: { color },
          halo: { color: [255, 255, 255, 0.95], size: 2 },
          size: 17,
        },
      ],
      verticalOffset: { screenLength: 26, maxWorldLength: 400, minWorldLength: 10 },
    } as never,
  });
}

export interface AnimLayers {
  water: GraphicsLayer;
  cranes: GraphicsLayer;
  wakes: GraphicsLayer;
  fleet: GraphicsLayer;
  glyphs: GraphicsLayer;
}

export function createAnimLayers(): AnimLayers {
  const absolute = { mode: 'absolute-height' } as never;
  return {
    water: new GraphicsLayer({ title: ANIM_WATER_TITLE, listMode: 'hide', elevationInfo: absolute }),
    cranes: new GraphicsLayer({
      title: ANIM_CRANE_TITLE,
      listMode: 'hide',
      elevationInfo: { mode: 'on-the-ground' } as never,
    }),
    wakes: new GraphicsLayer({ title: ANIM_WAKE_TITLE, listMode: 'hide', elevationInfo: absolute }),
    fleet: new GraphicsLayer({ title: ANIM_FLEET_TITLE, listMode: 'hide', elevationInfo: absolute }),
    glyphs: new GraphicsLayer({
      title: ANIM_GLYPH_TITLE,
      listMode: 'hide',
      elevationInfo: absolute,
    }),
  };
}

/** What the loop needs each frame. Read through a getter so it stays current. */
export interface AnimInput {
  model: VrImpactModel;
  berths: Berth[];
  vessels: Vessel[];
}

/**
 * Start the animation loop.
 *
 * @param layers the animated layers, already added to the map
 * @param get    supplies the latest model/berths/vessels each frame
 * @param views  every SceneView to apply weather to (two in stereo)
 * @param budget the scene's budget. Passed in rather than re-probed here because
 *   the loop starts BEFORE the views exist (they are created asynchronously so
 *   the second eye can wait for the first), so `views().length` cannot be used
 *   to work out whether this is a stereo run — it is zero at that moment.
 * @returns a teardown that cancels the frame loop
 */
export function startSceneAnimation(
  layers: AnimLayers,
  get: () => AnimInput,
  views: () => SceneView[],
  budget: SceneBudget = currentBudget(false)
): () => void {
  const lowPower = budget.lowPower;
  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let raf = 0;
  let startTs = 0;
  let lastTs = 0;
  /** Locally integrated hull state, keyed by MMSI. */
  const fleet = new Map<string, MovingVessel>();
  let lastWeatherKey = '';
  let weatherApplied = false;
  let lastWaterZ = Number.NaN;
  /**
   * Persistent graphics, mutated per frame rather than rebuilt. Every map here
   * is bounded by the number of cranes (~22) and hulls (~10) — nothing in the
   * loop allocates a graphic that outlives the frame.
   */
  const craneGraphics = new Map<string, Graphic>();
  const craneStates = new Map<string, CraneState>();
  const hullGraphics = new Map<string, Graphic>();
  /** `held|seaBand` — when this changes, and only then, the symbol is rebuilt. */
  const hullSymbolKey = new Map<string, string>();
  const wakeGraphics = new Map<string, Graphic>();
  const glyphGraphics = new Map<string, Graphic>();
  /** The sea-surface polygons, built once and re-levelled with the tide. */
  const waterGraphics_: Graphic[] = [];

  /**
   * Adopt the adapter's roster. Positions are seeded ONCE per hull so the local
   * integration is not reset every time the mock stream re-emits (which would
   * make hulls stutter); a hull that disappears from the roster is dropped.
   */
  function syncRoster(vessels: Vessel[]): void {
    const live = new Set<string>();
    for (const v of vessels) {
      live.add(v.MMSI);
      const cur = fleet.get(v.MMSI);
      if (!cur) {
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
        // Keep identity/speed/status current without clobbering the integrated
        // position — that is what makes the motion continuous.
        cur.sog = v.SOG;
        cur.navStatus = v.NAV_STATUS;
        cur.name = v.VESSEL_NAME;
      }
    }
    for (const mmsi of [...fleet.keys()]) if (!live.has(mmsi)) fleet.delete(mmsi);
  }

  /**
   * Render one frame at absolute timestamp `ts`.
   *
   * Split out from the rAF callback so it can be stepped deterministically. The
   * browser pauses `requestAnimationFrame` entirely in a hidden tab — the
   * behaviour we want in production (an unattended walkthrough must not burn a
   * core), but it makes the animation impossible to drive from an automated
   * browser session, where the tab is never foregrounded.
   */
  const renderFrame = (ts: number): void => {
    if (!startTs) {
      startTs = ts;
      lastTs = ts;
    }
    const elapsedS = (ts - startTs) / 1000;
    // Clamp the step so a backgrounded tab does not teleport the fleet on return.
    const dtS = Math.min(0.25, Math.max(0, (ts - lastTs) / 1000));
    lastTs = ts;

    const { model, berths, vessels } = get();
    const env = model.environment;
    const hold = holdState(env);

    // --- weather ---------------------------------------------------------
    // Rain and fog are full-screen particle/volumetric effects billed per view.
    // On a handset in stereo that is two of them, and they are the difference
    // between a scene that flies and one that stutters — so the intensity is
    // capped there. The weather TYPE is never changed: a monsoon still renders
    // as rain, because that is the evidence for the suspension being shown.
    const w = softenWeather(weatherVisual(env), lowPower && views().length > 1);
    const wKey = JSON.stringify(w);
    const vs = views();
    // `weatherApplied` matters because the first frames can run before the
    // views exist; without it the key would latch and the weather would never
    // reach the scene.
    if (vs.length && (!weatherApplied || wKey !== lastWeatherKey)) {
      lastWeatherKey = wKey;
      weatherApplied = true;
      for (const v of vs) {
        // Autocast: assigning the plain object builds the right weather class.
        (v.environment as unknown as { weather: unknown }).weather = w;
      }
    }

    // --- water -----------------------------------------------------------
    // The sea surface is nine polygons that only ever change ELEVATION, so they
    // are built once and then re-levelled. This used to `removeAll` + `addMany`
    // whenever the level moved 2 cm — and with the sim clock running the tide
    // crosses 2 cm about twenty times a second, so it was discarding and
    // rebuilding nine polygons ~20×/s for the whole session.
    const waterZ = waterSurfaceZ(env);
    if (!waterGraphics_.length) {
      waterGraphics_.push(...waterGraphics(waterZ));
      layers.water.addMany(waterGraphics_);
      lastWaterZ = waterZ;
    } else if (Math.abs(waterZ - lastWaterZ) > 0.05) {
      lastWaterZ = waterZ;
      for (const g of waterGraphics_) {
        const poly = g.geometry as Polygon;
        // Re-level in place: same rings, new z. Cheaper than new geometry, and
        // it keeps the renderer's existing buffers.
        g.geometry = new Polygon({
          rings: poly.rings.map((ring) => ring.map(([x, y]) => [x, y, waterZ])),
          hasZ: true,
        });
      }
    }

    // --- cranes ----------------------------------------------------------
    // Graphics are created ONCE and then mutated. Removing and re-adding a glTF
    // graphic makes the renderer re-resolve the model resource, which at 60 Hz
    // across 22 cranes is both a frame-budget disaster and enough to stop the
    // models ever finishing their load. Moving a graphic = assign `.geometry`;
    // the loaded mesh is retained.
    const cranes = craneVisuals(berths, model.impacts, elapsedS, reducedMotion);
    for (const c of cranes) {
      let g = craneGraphics.get(c.key);
      if (!g) {
        g = craneGraphic(c.longitude, c.latitude, c.heading, c.state);
        craneGraphics.set(c.key, g);
        craneStates.set(c.key, c.state);
        layers.cranes.add(g);
      } else {
        g.geometry = new Point({ longitude: c.longitude, latitude: c.latitude });
        // The symbol only changes when the crane's STATE changes (tint), which
        // is rare — so the expensive path runs on a scenario change, not a frame.
        if (craneStates.get(c.key) !== c.state) {
          craneStates.set(c.key, c.state);
          g.symbol = craneGraphic(c.longitude, c.latitude, c.heading, c.state).symbol;
        }
      }
    }

    // --- fleet, wakes, glyphs ---------------------------------------------
    // EVERY graphic here is created once and then mutated. The previous version
    // rebuilt the wake and glyph layers (`removeAll` + `addMany`) on every frame
    // and re-assigned each hull's glTF symbol eight times a second; that churned
    // thousands of Graphic, geometry, symbol and text-texture objects per second
    // and grew the tab to ~2.5 GB before it crashed.
    //
    // The rule now: geometry is written per frame (cheap, and it is what moves),
    // visibility is toggled per frame (free), and a SYMBOL is only touched when
    // a discrete state changes — held/running, crane state, or the sea band.
    syncRoster(vessels);
    const band = seaBand(env.seaStateM);

    for (const [mmsi, v] of fleet) {
      const moved = advanceVessel(v, dtS, elapsedS, hold.holding, reducedMotion);
      fleet.set(mmsi, moved);
      const phase = hash01(mmsi);
      const heave = seaMotion(env.seaStateM, elapsedS, phase, reducedMotion).heaveM;
      const z = waterZ + heave;

      // Hull.
      let g = hullGraphics.get(mmsi);
      if (!g) {
        g = vesselGraphic(moved, z, env.seaStateM, phase);
        hullGraphics.set(mmsi, g);
        hullSymbolKey.set(mmsi, `${moved.held}|${band}`);
        layers.fleet.add(g);
      } else {
        g.geometry = new Point({ longitude: moved.longitude, latitude: moved.latitude, z });
        const key = `${moved.held}|${band}`;
        if (hullSymbolKey.get(mmsi) !== key) {
          hullSymbolKey.set(mmsi, key);
          g.symbol = vesselGraphic(moved, z, env.seaStateM, phase).symbol;
        }
      }

      // Wake — one persistent polygon per hull, hidden when not making way.
      let w = wakeGraphics.get(mmsi);
      if (!w) {
        w = new Graphic({ geometry: new Polygon({ rings: wakeRings(moved, waterZ), hasZ: true }), symbol: WAKE_SYMBOL });
        wakeGraphics.set(mmsi, w);
        layers.wakes.add(w);
      }
      const show = hasWake(moved);
      w.visible = show;
      if (show) w.geometry = new Polygon({ rings: wakeRings(moved, waterZ), hasZ: true });

      // Anchor glyph — the reason a stopped ship is stopped, on the ship itself.
      const gk = `ship:${mmsi}`;
      let sg = glyphGraphics.get(gk);
      if (!sg) {
        sg = glyphGraphic(moved.longitude, moved.latitude, z, '⚓', tokens.warn);
        glyphGraphics.set(gk, sg);
        layers.glyphs.add(sg);
      }
      sg.visible = moved.held;
      if (moved.held) {
        sg.geometry = new Point({ longitude: moved.longitude, latitude: moved.latitude, z });
      }
    }

    // Drop anything whose hull has left the roster.
    for (const mmsi of [...hullGraphics.keys()]) {
      if (fleet.has(mmsi)) continue;
      const g = hullGraphics.get(mmsi);
      if (g) layers.fleet.remove(g);
      hullGraphics.delete(mmsi);
      hullSymbolKey.delete(mmsi);
      const w = wakeGraphics.get(mmsi);
      if (w) layers.wakes.remove(w);
      wakeGraphics.delete(mmsi);
      const sg = glyphGraphics.get(`ship:${mmsi}`);
      if (sg) layers.glyphs.remove(sg);
      glyphGraphics.delete(`ship:${mmsi}`);
    }

    // Crane glyphs: `⬍` while working, `⚠` when blocked, hidden when idle. The
    // text never changes for a given crane, so the symbol is built once.
    for (const c of cranes) {
      const wantWorking = c.state === 'working';
      const wantBlocked = c.state === 'blocked';
      for (const [suffix, want, glyph, colour] of [
        ['work', wantWorking, '⬍', tokens.accent],
        ['warn', wantBlocked, '⚠', tokens.bad],
      ] as const) {
        const key = `crane:${c.key}:${suffix}`;
        let cg = glyphGraphics.get(key);
        if (!cg) {
          if (!want) continue; // never needed → never allocated
          cg = glyphGraphic(c.longitude, c.latitude, 68, glyph, colour);
          glyphGraphics.set(key, cg);
          layers.glyphs.add(cg);
        }
        cg.visible = want;
        if (want) cg.geometry = new Point({ longitude: c.longitude, latitude: c.latitude, z: 68 });
      }
    }
  };

  /**
   * Animation runs well below display rate — 30 Hz on a desktop, 20 Hz for
   * stereo on a handset. Nothing in this scene (a gantry crane at walking pace,
   * a hull at 9 knots, a tide) moves fast enough to need 60 updates a second,
   * and every frame not spent here is a frame the renderer keeps — which is what
   * the 45+ fps target is actually measuring.
   */
  const MIN_STEP_MS = 1000 / budget.animationHz;
  let lastRenderTs = -Infinity;

  const frame = (ts: number): void => {
    raf = requestAnimationFrame(frame);
    if (ts - lastRenderTs < MIN_STEP_MS) return;
    lastRenderTs = ts;
    renderFrame(ts);
  };

  // Dev-only manual stepper, so the animation can be verified in an automated
  // browser session (where the tab stays hidden and rAF never fires).
  if (import.meta.env.DEV) {
    (window as unknown as { __vrAnim?: unknown }).__vrAnim = {
      step: (ts: number) => renderFrame(ts),
      counts: () => ({
        water: layers.water.graphics.length,
        cranes: layers.cranes.graphics.length,
        wakes: layers.wakes.graphics.length,
        fleet: layers.fleet.graphics.length,
        glyphs: layers.glyphs.graphics.length,
      }),
    };
  }

  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
