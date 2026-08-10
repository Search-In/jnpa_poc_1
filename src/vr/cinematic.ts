/**
 * Cinematic director — the auto-tour that carries the viewer to each impacted
 * asset in the order the disruption actually propagates.
 *
 * The shot list is built from the scenario's causal chain, not from the impact
 * list's own ordering, so the camera tells the story in cause → effect order:
 * you stand at the weather front, then at the boarding ground where pilotage
 * stops, then at the anchorage where the queue forms. That is the spec's WHERE
 * channel ("3D fly-to along the propagation path") played as a sequence rather
 * than a single jump.
 *
 * Everything here is pure and deterministic: given a shot list and an elapsed
 * time it returns a pose. No timers, no view handles, no `Date.now` — so the
 * choreography is unit-testable and reproduces exactly on a rehearsed run.
 */
import type { Berth } from '@/types/domain';
import { asset3dPosition } from '@/map/scene3d';
import { SCENARIO_BY_ID } from '@/sim/scenarios';
import { NODE_BY_ID } from '@/whatif/causalGraph';
import { resolveImpactPosition } from './impactLayers';
import type { AssetImpact, VrImpactModel } from './impactModel';
import { bearingTo, normalizeHeading, offsetByBearing } from './stereo';
import type { ViewerPose } from './stereo';

/** One beat of the tour. */
export interface Shot {
  /** The impact this beat is about. */
  impact: AssetImpact;
  /** Where the camera stands. */
  pose: ViewerPose;
  /** How long to hold here, ms. */
  dwellMs: number;
  /** Caption for the HUD while this shot is on screen. */
  title: string;
  subtitle: string;
}

/** Seconds of travel between two shots. */
export const FLIGHT_MS = 3200;
/** Default hold once a shot arrives. */
export const DWELL_MS = 5200;

/**
 * How far back and how high the camera stands for each kind of asset. A berth
 * is inspected from close and low — you are standing on the apron. A channel
 * reach only makes sense from height, because the thing that changed is a
 * kilometre-long stretch of water.
 */
/**
 * Tilts sit near the horizon (80–88°) rather than looking steeply down. A
 * top-down shot fills the frame with ground and reads as a map, not a place —
 * and it is the framing that makes a missing basemap look like a broken view.
 * Keeping the horizon in shot also keeps the sky, the weather and the vessels'
 * silhouettes visible, which is what makes the scene read as a port.
 */
const FRAMING: Record<AssetImpact['kind'], { standoffM: number; heightM: number; tilt: number }> = {
  berth: { standoffM: 260, heightM: 32, tilt: 85 },
  terminal: { standoffM: 520, heightM: 85, tilt: 83 },
  pilot: { standoffM: 420, heightM: 45, tilt: 87 },
  anchorage: { standoffM: 950, heightM: 150, tilt: 82 },
  channel: { standoffM: 1200, heightM: 190, tilt: 80 },
};

/**
 * Place the camera to look AT a point from a sensible direction.
 *
 * The camera backs off along the bearing from the port's reference point to the
 * subject, so it always looks inward across the port rather than out to the
 * empty sea — the difference between a shot of a berth and a shot of the
 * horizon behind it.
 */
export function frameShot(
  target: [number, number],
  kind: AssetImpact['kind'],
  reference: [number, number]
): ViewerPose {
  const f = FRAMING[kind] ?? FRAMING.terminal;
  // Bearing FROM the reference TO the target; stand beyond the reference side.
  const inward = bearingTo(reference[0], reference[1], target[0], target[1]);
  const behind = normalizeHeading(inward + 180);
  const cam = offsetByBearing(target[0], target[1], behind, f.standoffM);
  return {
    longitude: cam.longitude,
    latitude: cam.latitude,
    z: f.heightM,
    heading: normalizeHeading(inward),
    tilt: f.tilt,
  };
}

/**
 * Order impacts along the scenario's causal chain.
 *
 * Impacts whose asset is named by an earlier chain node come first; anything the
 * chain does not mention keeps its existing (worst-first) order at the end, so a
 * free run still produces a sensible tour.
 */
export function orderByCausalChain(
  impacts: AssetImpact[],
  scenarioId: string | null
): AssetImpact[] {
  const scenario = scenarioId ? SCENARIO_BY_ID[scenarioId] : undefined;
  if (!scenario) return [...impacts];

  // asset id → position in the chain, via each node's `where` anchors.
  const rank = new Map<string, number>();
  scenario.chain.forEach((nodeId, i) => {
    for (const anchor of NODE_BY_ID[nodeId]?.where ?? []) {
      if (!rank.has(anchor)) rank.set(anchor, i);
    }
  });

  const keyOf = (im: AssetImpact): string =>
    im.kind === 'berth' ? (im.berthId?.split('-')[0] ?? im.assetId) : im.assetId;

  return [...impacts]
    .map((im, i) => ({ im, i, r: rank.get(keyOf(im)) ?? rank.get(im.assetId) ?? 999 }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.im);
}

/**
 * Build the tour. Returns an empty list when nothing is impacted — the caller
 * then leaves the viewer where they are rather than flying them to nowhere.
 */
export function buildShots(
  model: VrImpactModel,
  berths: Berth[],
  reference: [number, number]
): Shot[] {
  const anchors = asset3dPosition();
  const ordered = orderByCausalChain(model.impacts, model.scenarioId);
  const shots: Shot[] = [];
  const seen = new Set<string>();

  for (const impact of ordered) {
    const target = resolveImpactPosition(impact, berths, anchors);
    if (!target) continue;
    // One shot per physical place: two impacts on the same quay are one beat,
    // captioned by the worse of them (which sorts first).
    const key = `${target[0].toFixed(5)},${target[1].toFixed(5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    shots.push({
      impact,
      pose: frameShot(target, impact.kind, reference),
      // Critical beats hold longer — they are the ones being explained.
      dwellMs: impact.severity === 'critical' ? DWELL_MS + 1800 : DWELL_MS,
      title: `${impact.label} — ${impact.headline}`,
      subtitle: impact.detail,
    });
  }
  return shots;
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

/** Cubic ease-in-out — no abrupt starts or stops between beats. */
export function easeInOut(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** Interpolate two poses, taking the short way around the compass. */
export function lerpPose(a: ViewerPose, b: ViewerPose, t: number): ViewerPose {
  const k = easeInOut(t);
  let dh = normalizeHeading(b.heading - a.heading);
  if (dh > 180) dh -= 360;
  return {
    longitude: a.longitude + (b.longitude - a.longitude) * k,
    latitude: a.latitude + (b.latitude - a.latitude) * k,
    // Arc upward through the middle of the flight so the camera clears the
    // cranes and container stacks instead of ploughing through them.
    z: a.z + (b.z - a.z) * k + Math.sin(k * Math.PI) * 90,
    heading: normalizeHeading(a.heading + dh * k),
    tilt: a.tilt + (b.tilt - a.tilt) * k,
  };
}

export interface TourFrame {
  pose: ViewerPose;
  /** Index of the shot being flown to / held. */
  index: number;
  /** True while holding on a shot (as opposed to travelling). */
  arrived: boolean;
  /** The shot currently being presented. */
  shot: Shot;
}

/**
 * Where the camera is at `elapsedMs` into the tour.
 *
 * The cycle per shot is FLIGHT_MS of travel then its own dwell; while holding,
 * the camera keeps drifting a few degrees so a held beat still feels alive
 * rather than paused. `from` is the pose the tour started at.
 */
export function tourFrame(
  shots: Shot[],
  from: ViewerPose,
  elapsedMs: number,
  reducedMotion = false
): TourFrame | null {
  if (!shots.length) return null;

  if (reducedMotion) {
    // No flying: cut straight to each beat and hold it.
    const per = FLIGHT_MS + DWELL_MS;
    const i = Math.min(shots.length - 1, Math.floor(Math.max(0, elapsedMs) / per));
    return { pose: shots[i].pose, index: i, arrived: true, shot: shots[i] };
  }

  let t = Math.max(0, elapsedMs);
  for (let i = 0; i < shots.length; i++) {
    const shot = shots[i];
    const start = i === 0 ? from : shots[i - 1].pose;
    if (t < FLIGHT_MS) {
      return { pose: lerpPose(start, shot.pose, t / FLIGHT_MS), index: i, arrived: false, shot };
    }
    t -= FLIGHT_MS;
    if (t < shot.dwellMs) {
      // Slow inward drift while held — a few degrees of heading and a metre or
      // two of height, enough to read as a live camera.
      const k = t / shot.dwellMs;
      return {
        pose: {
          ...shot.pose,
          heading: normalizeHeading(shot.pose.heading + Math.sin(k * Math.PI) * 5),
          z: shot.pose.z - Math.sin(k * Math.PI) * Math.min(12, shot.pose.z * 0.08),
        },
        index: i,
        arrived: true,
        shot,
      };
    }
    t -= shot.dwellMs;
  }

  // Past the end — hold the final beat.
  const last = shots.length - 1;
  return { pose: shots[last].pose, index: last, arrived: true, shot: shots[last] };
}

/** Total run time of a tour, ms. */
export function tourDurationMs(shots: Shot[]): number {
  return shots.reduce((sum, s) => sum + FLIGHT_MS + s.dwellMs, 0);
}
