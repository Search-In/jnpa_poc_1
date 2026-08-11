/**
 * Live world state — how the SCENE ITSELF looks under the active what-if
 * scenario, as opposed to what the labels say about it.
 *
 * Everything here is a pure, deterministic function of the impact model plus an
 * elapsed-seconds clock, so the animation reproduces exactly on a rehearsed run
 * (no `Date.now`, no `Math.random`) and every visual claim is unit-testable.
 *
 * The rule this module exists to enforce: **an asset only changes appearance
 * because the engine says its state changed.** Cranes stop because a berth is
 * out of service; ships hold because `pilotageSuspended` is true; the water
 * drops because the tide fell. Nothing is animated for decoration.
 */
import type { Berth } from '@/types/domain';
import { placementStore } from '@/map/placementStore';
import { TERMINAL_QUAYS, offsetMeters } from '@/map/portGeometry';
import type { AssetImpact, VrEnvironment } from './impactModel';

/**
 * Mean tide on the sim curve (`dukc/ukc.tideAt` default). The basemap's sea
 * surface sits at elevation 0, so the animated water plane is drawn at
 * `tideM - MEAN_TIDE_M`: mean water lines up with the basemap and the surface
 * visibly rises and falls either side of it as the tide runs.
 */
export const MEAN_TIDE_M = 2.6;

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

/** A SceneView `environment.weather` autocast, chosen from the twin's state. */
export type WeatherVisual =
  | { type: 'sunny'; cloudCover: number }
  | { type: 'cloudy'; cloudCover: number }
  | { type: 'rainy'; cloudCover: number; precipitation: number }
  | { type: 'foggy'; fogStrength: number };

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Map the twin's weather reading onto the scene's real weather renderer.
 *
 * Precedence is operational, not aesthetic: visibility is what actually stops
 * pilot transfer, so a sub-1.5 nm reading renders as fog even when it is also
 * raining — the evaluator asking "why is pilotage suspended?" must be able to
 * SEE the reason, and fog and rain look nothing alike.
 */
export function weatherVisual(env: VrEnvironment): WeatherVisual {
  const vis = env.visibilityNm;
  if (vis < 1.5) {
    // 1.5 nm → light haze, 0.2 nm → almost total whiteout.
    return { type: 'foggy', fogStrength: clamp01((1.5 - vis) / 1.3) };
  }
  const rain = env.rainMmHr;
  const rough = env.seaStateM;
  if (rain > 0.5 || rough >= 2.5) {
    return {
      type: 'rainy',
      // A storm sea implies an overcast sky even when rain is not reported.
      //
      // Capped at 0.75: the renderer draws near-total cover as a BRIGHT overcast
      // dome, so pushing toward 1.0 whites the sky out and reads as a broken
      // view rather than a monsoon. 0.75 is heavy, grey and still legible.
      cloudCover: Math.min(0.75, clamp01(0.45 + rain / 60 + (rough - 1) / 6)),
      precipitation: clamp01(rain > 0.5 ? rain / 45 : (rough - 2) / 3),
    };
  }
  const cover = clamp01((rough - 0.6) / 3 + (env.windKt - 8) / 60);
  return cover > 0.25 ? { type: 'cloudy', cloudCover: cover } : { type: 'sunny', cloudCover: cover };
}

/** Water-surface elevation, metres above the basemap's sea level. */
export function waterSurfaceZ(env: VrEnvironment): number {
  return Number((env.tideM - MEAN_TIDE_M).toFixed(3));
}

// ---------------------------------------------------------------------------
// Movement hold
// ---------------------------------------------------------------------------

export interface HoldState {
  /** True when inbound traffic must stop where it is. */
  holding: boolean;
  /** Operator-facing reason, or null when traffic is running. */
  reason: string | null;
}

/**
 * Whether vessel movements are held. Delegates entirely to the flags the
 * engine already computed — this adds no new rule, it only decides what the
 * ships on screen do about them.
 */
export function holdState(env: VrEnvironment): HoldState {
  if (env.pilotageSuspended) return { holding: true, reason: 'Pilotage suspended' };
  if (env.movementsSuspended) return { holding: true, reason: 'Movements suspended' };
  return { holding: false, reason: null };
}

// ---------------------------------------------------------------------------
// Cranes
// ---------------------------------------------------------------------------

/** What an STS crane is doing, and therefore how it is drawn. */
export type CraneState =
  /** Gantry-travelling along the quay working a ship. */
  | 'working'
  /** Powered but nothing alongside. */
  | 'idle'
  /** Its berth is out of service — stopped, and flagged. */
  | 'blocked';

export interface CraneVisual {
  key: string;
  terminalId: string;
  longitude: number;
  latitude: number;
  heading: number;
  state: CraneState;
}

/** Deterministic 0..1 from a key — mirrors `portAssets3d`'s stable hash. */
export function hash01(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** Metres a working crane gantries either side of its home position. */
export const CRANE_TRAVEL_M = 26;
/** Seconds for one full out-and-back gantry cycle. */
export const CRANE_CYCLE_S = 22;

/**
 * Per-crane visual state.
 *
 * A crane is `blocked` when its terminal carries a critical impact (its berth
 * is out of service), `working` when its terminal has a vessel alongside, and
 * `idle` otherwise. Working cranes gantry along the quay's own fitted axis, each
 * with a stable phase offset so the row moves like a working quay rather than a
 * chorus line. Under `prefers-reduced-motion` every crane holds its home
 * position — the state colouring still reads, only the motion stops.
 */
export function craneVisuals(
  berths: Berth[],
  impacts: AssetImpact[],
  elapsedS: number,
  reducedMotion = false
): CraneVisual[] {
  const blockedTerminals = new Set<string>();
  for (const i of impacts) {
    if (i.severity !== 'critical') continue;
    const terminal = i.kind === 'terminal' ? i.assetId : i.berthId?.split('-')[0];
    if (terminal) blockedTerminals.add(terminal);
  }
  const busyTerminals = new Set(
    berths.filter((b) => b.STATUS === 'occupied').map((b) => b.TERMINAL)
  );

  const out: CraneVisual[] = [];
  for (const key of placementStore.keysOfKind('crane')) {
    const p = placementStore.get(key);
    if (!p) continue;
    const terminalId = key.split(':')[1];
    const state: CraneState = blockedTerminals.has(terminalId)
      ? 'blocked'
      : busyTerminals.has(terminalId)
        ? 'working'
        : 'idle';

    let longitude = p.lng;
    let latitude = p.lat;
    if (state === 'working' && !reducedMotion) {
      const quay = TERMINAL_QUAYS[terminalId];
      if (quay) {
        const phase = hash01(key) * Math.PI * 2;
        const travel = Math.sin((elapsedS / CRANE_CYCLE_S) * Math.PI * 2 + phase) * CRANE_TRAVEL_M;
        const moved = offsetMeters([p.lng, p.lat], quay.along, travel);
        longitude = moved[0];
        latitude = moved[1];
      }
    }

    out.push({
      key,
      terminalId,
      longitude,
      latitude,
      heading: p.heading ?? 0,
      state,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Vessel motion
// ---------------------------------------------------------------------------

/** A hull the walkthrough is integrating between adapter updates. */
export interface MovingVessel {
  mmsi: string;
  name: string;
  longitude: number;
  latitude: number;
  /** Degrees true. */
  heading: number;
  /** Knots. */
  sog: number;
  navStatus: string;
  /** True when this hull is stopped by the hold. */
  held: boolean;
}

/** Knots → metres per second. */
export const KN_TO_MS = 0.514_444;

// ---------------------------------------------------------------------------
// Seakeeping
// ---------------------------------------------------------------------------

/** How a hull responds to the sea running under it. */
export interface SeaMotion {
  /** Vertical displacement, metres. */
  heaveM: number;
  /** Roll about the fore-aft axis, degrees. */
  rollDeg: number;
  /** Pitch about the athwartships axis, degrees. */
  pitchDeg: number;
}

/**
 * Quantised sea state, used as a cache key for hull attitude.
 *
 * Roll and pitch live on the SYMBOL, and swapping the symbol of a glTF graphic
 * is expensive — doing it per frame is what turns a walkthrough into a 2.5 GB
 * crash. Banding the sea state to 0.5 m means attitude is only re-applied when
 * the sea meaningfully changes (every few seconds of sim time), while heave
 * stays continuous because it rides on the geometry, which is cheap.
 */
export function seaBand(seaStateM: number): number {
  return Math.round(Math.min(8, Math.max(0, seaStateM)) * 2) / 2;
}

/**
 * The attitude a hull sits at for a given sea band — a stable heel and trim per
 * vessel rather than a per-frame oscillation.
 *
 * In a calm sea every hull sits upright. As the sea builds, hulls take up
 * varied angles (each one's own, from its MMSI hash) so the anchorage reads as
 * a fleet being worked by weather instead of a row of identical models. Pure.
 */
export function staticHeel(
  seaStateM: number,
  phase: number
): { rollDeg: number; pitchDeg: number } {
  const hs = seaBand(seaStateM);
  if (hs <= 0.6) return { rollDeg: 0, pitchDeg: 0 };
  const spread = (phase - 0.5) * 2; // -1..1, stable per hull
  return {
    rollDeg: Number((spread * Math.min(9, hs * 2.2)).toFixed(2)),
    pitchDeg: Number((Math.sin(phase * 6.283) * Math.min(3.5, hs * 0.9)).toFixed(2)),
  };
}

/**
 * First-order seakeeping response.
 *
 * A real hull heaves with roughly the wave amplitude, rolls hardest (beam seas
 * excite it most) and pitches least, with roll and pitch at different natural
 * periods so the two never stay in phase — which is what stops the motion
 * looking like a metronome. Amplitudes scale with significant wave height and
 * are capped at values a laden container ship would actually see, so a storm
 * looks violent without the hull ending up on its beam ends.
 *
 * `phase` de-synchronises the fleet (pass a stable per-hull hash) so ships do
 * not roll in unison. Pure.
 */
export function seaMotion(
  seaStateM: number,
  elapsedS: number,
  phase: number,
  reducedMotion = false
): SeaMotion {
  if (reducedMotion) return { heaveM: 0, rollDeg: 0, pitchDeg: 0 };
  const hs = Math.max(0, seaStateM);
  const p = phase * Math.PI * 2;
  // Roll period ~11 s, pitch ~7 s, heave ~9 s — close to a laden box boat.
  return {
    heaveM: Number((Math.sin((elapsedS / 9) * Math.PI * 2 + p) * Math.min(2.2, hs * 0.5)).toFixed(3)),
    rollDeg: Number((Math.sin((elapsedS / 11) * Math.PI * 2 + p) * Math.min(11, hs * 2.6)).toFixed(2)),
    pitchDeg: Number(
      (Math.sin((elapsedS / 7) * Math.PI * 2 + p * 1.7) * Math.min(4.5, hs * 1.1)).toFixed(2)
    ),
  };
}

/** Statuses that represent a hull under way inbound, i.e. gated by the hold. */
const INBOUND = new Set(['underway', 'approaching']);

/**
 * Advance one hull by `dtS` seconds.
 *
 * Under way it runs at its own SOG along its own COG — the walkthrough
 * integrates position between the adapter's 3-second pushes so hulls glide
 * instead of teleporting (QA §4.4: "smooth vessel movement, not teleport").
 *
 * When the twin is holding movements, an inbound hull stops making way and
 * swings slowly about its anchor instead. That swing is the visible answer to
 * "what does a pilotage suspension actually look like?" — a line of ships
 * stopped short of the boarding ground.
 *
 * Pure: the caller supplies both the elapsed step and the absolute clock used
 * for the swing phase.
 */
export function advanceVessel(
  v: MovingVessel,
  dtS: number,
  elapsedS: number,
  holding: boolean,
  reducedMotion = false
): MovingVessel {
  const inbound = INBOUND.has(v.navStatus);
  const held = holding && inbound;

  if (reducedMotion) return { ...v, held };

  if (held || v.sog <= 0.1) {
    // Swinging at anchor: ±12° about the last heading, ~40 s period. No way is
    // made good, so the position is untouched.
    const swing = Math.sin((elapsedS / 40) * Math.PI * 2 + hash01(v.mmsi) * 6.28) * 12;
    return { ...v, heading: (((v.heading + swing) % 360) + 360) % 360, held };
  }

  const metres = v.sog * KN_TO_MS * dtS;
  const rad = (v.heading * Math.PI) / 180;
  const M_PER_DEG_LAT = 110_574;
  const mPerDegLon = 111_320 * Math.cos((v.latitude * Math.PI) / 180);
  return {
    ...v,
    longitude: v.longitude + (Math.sin(rad) * metres) / mPerDegLon,
    latitude: v.latitude + (Math.cos(rad) * metres) / M_PER_DEG_LAT,
    held,
  };
}
