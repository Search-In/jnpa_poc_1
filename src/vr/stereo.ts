/**
 * Stereoscopic camera maths for the immersive walkthrough — pure, deterministic,
 * and framework-free so it is unit-testable without a WebGL context.
 *
 * WHY THIS SHAPE. ArcGIS `SceneView` owns its own WebGL context and render loop
 * and exposes no hook to render into a WebXR `XRWebGLLayer`, so a true
 * `immersive-vr` session cannot drive a SceneView. Requirement R-8 also forbids
 * "bolt-on canvases beside the map" — the scene must stay on the Esri stack.
 *
 * The resolution is side-by-side stereo: TWO SceneViews of the same scene, their
 * cameras separated by the interpupillary distance, driven by `deviceorientation`.
 * That is exactly the phone-cardboard mode ("YouTube VR") — it also works inside
 * a headset's own browser in fullscreen — while every pixel is still rendered by
 * the Esri engine from the real port geometry.
 *
 * Coordinate conventions used throughout:
 *  - World frame is East / North / Up (the W3C DeviceOrientation frame).
 *  - `heading` is compass degrees clockwise from true north (ArcGIS convention).
 *  - `tilt` is ArcGIS camera tilt: 0 = straight down, 90 = horizon, 180 = straight up.
 */

/** Mean interpupillary distance, metres — the stereo baseline. */
export const DEFAULT_IPD_M = 0.064;

/** Standing eye height above ground, metres. */
export const DEFAULT_EYE_HEIGHT_M = 1.7;

/** Where the viewer stands and which way they look. */
export interface ViewerPose {
  longitude: number;
  latitude: number;
  /** Eye altitude, metres above the scene's ground. */
  z: number;
  /** Compass degrees clockwise from north. */
  heading: number;
  /** ArcGIS tilt: 0 = down, 90 = horizon, 180 = up. */
  tilt: number;
}

/** An ArcGIS camera spec (the subset `SceneView.camera` needs). */
export interface EyeCamera {
  position: { longitude: number; latitude: number; z: number };
  heading: number;
  tilt: number;
}

/** Metres per degree of latitude (WGS84 mean) — constant enough at port scale. */
const M_PER_DEG_LAT = 110_574;

/** Metres per degree of longitude at a given latitude. */
function mPerDegLon(latDeg: number): number {
  return 111_320 * Math.cos((latDeg * Math.PI) / 180);
}

const toRad = (d: number): number => (d * Math.PI) / 180;
const toDeg = (r: number): number => (r * 180) / Math.PI;

/** Normalise any angle into [0, 360). */
export function normalizeHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Clamp ArcGIS tilt into the legal [0, 180] range. */
export function clampTilt(deg: number): number {
  return Math.min(180, Math.max(0, deg));
}

/**
 * Offset a geodetic point by a metric displacement along a compass bearing.
 * Flat-earth approximation — exact to well under a millimetre at IPD scale.
 */
export function offsetByBearing(
  longitude: number,
  latitude: number,
  bearingDeg: number,
  meters: number
): { longitude: number; latitude: number } {
  const b = toRad(bearingDeg);
  const east = Math.sin(b) * meters;
  const north = Math.cos(b) * meters;
  return {
    longitude: longitude + east / mPerDegLon(latitude),
    latitude: latitude + north / M_PER_DEG_LAT,
  };
}

/**
 * Split a single viewer pose into left/right eye cameras.
 *
 * The eyes separate along the viewer's RIGHT vector — the horizontal
 * perpendicular to the look direction, i.e. bearing `heading + 90°`. Both eyes
 * keep the same heading/tilt: parallel (not toed-in) projection, which is what
 * cardboard-style viewers expect and what avoids the eye strain that
 * convergence-angle stereo introduces at long focal distances like a port.
 */
export function eyeCameras(pose: ViewerPose, ipdM: number = DEFAULT_IPD_M): {
  left: EyeCamera;
  right: EyeCamera;
} {
  const half = ipdM / 2;
  const rightBearing = normalizeHeading(pose.heading + 90);
  const heading = normalizeHeading(pose.heading);
  const tilt = clampTilt(pose.tilt);

  const l = offsetByBearing(pose.longitude, pose.latitude, rightBearing, -half);
  const r = offsetByBearing(pose.longitude, pose.latitude, rightBearing, half);

  return {
    left: { position: { longitude: l.longitude, latitude: l.latitude, z: pose.z }, heading, tilt },
    right: { position: { longitude: r.longitude, latitude: r.latitude, z: pose.z }, heading, tilt },
  };
}

/**
 * Convert a `deviceorientation` reading into a look direction.
 *
 * The W3C frame composes intrinsic Z-X'-Y'' rotations, so the world-space view
 * vector is `Rz(alpha)·Rx(beta)·Ry(gamma)` applied to the device's forward axis
 * (0, 0, -1) — the direction you look THROUGH the screen.
 *
 * Screen orientation is deliberately ignored: rotating the phone about its own
 * Z axis (portrait ↔ landscape) leaves the (0,0,-1) forward axis unchanged and
 * only affects roll, which `SceneView.camera` cannot express anyway.
 *
 * Returns null when the reading is incomplete (iOS emits nulls before the user
 * grants motion permission), so callers can keep the last good pose.
 */
export function orientationToLook(
  alpha: number | null,
  beta: number | null,
  gamma: number | null
): { heading: number; tilt: number } | null {
  if (alpha == null || beta == null || gamma == null) return null;
  if (!Number.isFinite(alpha) || !Number.isFinite(beta) || !Number.isFinite(gamma)) return null;

  const a = toRad(alpha);
  const b = toRad(beta);
  const g = toRad(gamma);

  const sa = Math.sin(a);
  const ca = Math.cos(a);
  const sb = Math.sin(b);
  const cb = Math.cos(b);
  const sg = Math.sin(g);
  const cg = Math.cos(g);

  // Ry(gamma) · (0,0,-1)
  const x1 = -sg;
  const y1 = 0;
  const z1 = -cg;

  // Rx(beta)
  const x2 = x1;
  const y2 = y1 * cb - z1 * sb;
  const z2 = y1 * sb + z1 * cb;

  // Rz(alpha) → world (east, north, up)
  const east = x2 * ca - y2 * sa;
  const north = x2 * sa + y2 * ca;
  const up = z2;

  // Degenerate: looking exactly along the vertical leaves heading undefined.
  const horiz = Math.hypot(east, north);
  const heading = horiz < 1e-9 ? 0 : normalizeHeading(toDeg(Math.atan2(east, north)));
  const tilt = clampTilt(90 + toDeg(Math.asin(Math.max(-1, Math.min(1, up)))));

  return { heading, tilt };
}

/**
 * Blend the previous look toward a new one. `deviceorientation` is noisy at rest
 * and a raw feed makes the horizon jitter; a light exponential filter removes
 * that without adding perceptible lag. Heading is blended the short way around
 * the circle so 359° → 1° does not spin the world.
 */
export function smoothLook(
  prev: { heading: number; tilt: number } | null,
  next: { heading: number; tilt: number },
  alpha = 0.25
): { heading: number; tilt: number } {
  if (!prev) return next;
  let delta = normalizeHeading(next.heading - prev.heading);
  if (delta > 180) delta -= 360;
  return {
    heading: normalizeHeading(prev.heading + delta * alpha),
    tilt: clampTilt(prev.tilt + (next.tilt - prev.tilt) * alpha),
  };
}

/**
 * Walk the viewer forward/strafe across the ground, in metres, relative to the
 * current heading. Used by the desktop keyboard walk controls.
 */
export function walk(
  pose: ViewerPose,
  forwardM: number,
  strafeM: number
): { longitude: number; latitude: number } {
  const fwd = offsetByBearing(pose.longitude, pose.latitude, pose.heading, forwardM);
  return offsetByBearing(fwd.longitude, fwd.latitude, normalizeHeading(pose.heading + 90), strafeM);
}

/**
 * Great-circle-free ground distance between two geodetic points, metres.
 * Used to label how far an impacted asset is from the viewer.
 */
export function groundDistanceM(
  aLng: number,
  aLat: number,
  bLng: number,
  bLat: number
): number {
  const mLon = mPerDegLon((aLat + bLat) / 2);
  const dx = (bLng - aLng) * mLon;
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

/** Compass bearing from A to B, degrees clockwise from north. */
export function bearingTo(aLng: number, aLat: number, bLng: number, bLat: number): number {
  const mLon = mPerDegLon((aLat + bLat) / 2);
  const dx = (bLng - aLng) * mLon;
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  if (Math.hypot(dx, dy) < 1e-9) return 0;
  return normalizeHeading(toDeg(Math.atan2(dx, dy)));
}
