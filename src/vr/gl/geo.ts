/**
 * Geodetic → local scene coordinates for the WebGL walkthrough.
 *
 * WHY A LOCAL FRAME AT ALL. The Esri renderer draws the port on a globe: every
 * position is an ECEF coordinate somewhere on a 6,371 km sphere, and the engine
 * carries a whole tile pyramid, an elevation service and double-precision
 * origin-rebasing to make that work. All of it is machinery for a scene that
 * spans about 12 km and never leaves Nhava Sheva.
 *
 * Dropping to a flat local frame centred on the port removes that entire class
 * of work. It is also *more* accurate at this scale, not less: over ±6 km the
 * flat-earth error is under a metre, well below the survey precision of the
 * placements themselves.
 *
 * CONVENTIONS. three.js is Y-up and looks down −Z, so:
 *
 *     x = metres EAST of the port centre
 *     y = metres UP from chart datum
 *     z = metres SOUTH  (i.e. −north), so that −z is north
 *
 * A compass heading (degrees clockwise from north) therefore points along
 * `(sin θ, 0, −cos θ)`, which is what `headingToDirection` returns. Every angle
 * that crosses this boundary is a compass bearing, never a maths angle — the
 * rest of the app speaks bearings and converting in one place is what stops the
 * two conventions leaking into each other.
 */
import { PORT_CENTER } from '@/map/portGeometry';

/** Metres per degree of latitude (WGS84 mean) — constant enough at port scale. */
export const M_PER_DEG_LAT = 110_574;

/** Metres per degree of longitude at a given latitude. */
export function mPerDegLon(latDeg: number): number {
  return 111_320 * Math.cos((latDeg * Math.PI) / 180);
}

/** The origin of the local frame: the port centroid. */
export const ORIGIN: readonly [number, number] = PORT_CENTER;

const M_PER_DEG_LON_AT_PORT = mPerDegLon(PORT_CENTER[1]);

/** A point in the local scene frame, metres. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Geodetic → local metres. `z` is metres above chart datum. */
export function toLocal(longitude: number, latitude: number, z = 0): Vec3 {
  return {
    x: (longitude - ORIGIN[0]) * M_PER_DEG_LON_AT_PORT,
    y: z,
    z: -(latitude - ORIGIN[1]) * M_PER_DEG_LAT,
  };
}

/** Local metres → geodetic. The exact inverse of `toLocal`. */
export function toGeodetic(x: number, z: number): { longitude: number; latitude: number } {
  return {
    longitude: ORIGIN[0] + x / M_PER_DEG_LON_AT_PORT,
    latitude: ORIGIN[1] - z / M_PER_DEG_LAT,
  };
}

/**
 * A compass heading as a unit direction in the local frame.
 * North (0°) → (0, 0, −1); east (90°) → (1, 0, 0).
 */
export function headingToDirection(headingDeg: number): Vec3 {
  const r = (headingDeg * Math.PI) / 180;
  return { x: Math.sin(r), y: 0, z: -Math.cos(r) };
}

/**
 * Y-axis rotation, radians, that turns a model's +Z axis to face `headingDeg`.
 *
 * glTF assets here are authored facing −Z (three.js "forward"), so a heading of
 * 0 is no rotation and the rotation runs anticlockwise about +Y as the bearing
 * increases clockwise on the compass.
 */
export function headingToYaw(headingDeg: number): number {
  return -(headingDeg * Math.PI) / 180;
}

/**
 * Y-axis rotation for a shape whose LONG AXIS IS +X — a `BoxGeometry` built as
 * `(length, height, depth)`, which is how a quay or a deck is described.
 *
 * This is NOT `headingToYaw`, and the difference is a quarter turn. Rotating by
 * θ maps +X to `(cos θ, 0, −sin θ)`, and a bearing β points along
 * `(sin β, 0, −cos β)`, so θ = 90° − β. Feeding a box the model-forward
 * rotation instead lays every quay across the water at right angles to where it
 * belongs, which is exactly the bug this replaced.
 */
export function headingToYawAlongX(headingDeg: number): number {
  return Math.PI / 2 - (headingDeg * Math.PI) / 180;
}

/** Ground distance between two local points, metres. */
export function distanceM(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * The scene's working radius, metres. Everything the walkthrough can look at —
 * the outer anchorage, the channel approaches — is inside this, and it sets the
 * camera's far plane and the size of the ground plane.
 */
export const SCENE_RADIUS_M = 16_000;
