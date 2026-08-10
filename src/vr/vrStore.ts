/**
 * Walkthrough view state — where the viewer stands, how they look and which
 * presentation mode is active. Deliberately SEPARATE from `useSimStore`: this
 * store never writes to the simulator, so entering VR cannot perturb the twin,
 * the dashboard, or the `version` counter that drives adapter refetches.
 *
 * (That one-way rule matters: `simStore.version` bumps cascade a refetch through
 * every panel, so a camera move must never touch it.)
 */
import { create } from 'zustand';
import { PORT_CENTER, TERMINAL_QUAYS, offsetMeters } from '@/map/portGeometry';
import { DEFAULT_IPD_M, bearingTo, clampTilt, normalizeHeading } from './stereo';

/** How the scene is presented. */
export type VrMode =
  /** Single SceneView, first-person, mouse/touch look. */
  | '3d'
  /** Two SceneViews side by side, IPD-separated, gyro look — cardboard stereo. */
  | 'vr';

/** A curated place to stand, for one-tap demo beats. */
export interface Vantage {
  id: string;
  name: string;
  /** What you see from here — shown in the picker. */
  blurb: string;
  longitude: number;
  latitude: number;
  /** Eye altitude above ground, metres. */
  eyeHeightM: number;
  /** Initial look bearing, degrees from north. */
  heading: number;
}

/**
 * Vantage points derived from the SAME surveyed geometry the 3D scene uses, so
 * a preset can never drift from where the assets actually are. Each looks along
 * a bearing that frames the port rather than the empty sea.
 */
export function defaultVantages(): Vantage[] {
  const out: Vantage[] = [];

  // A quay-apron viewpoint per terminal: stand ~40 m seaward of the quay
  // midpoint at deck height, looking landward across the berth.
  for (const [id, q] of Object.entries(TERMINAL_QUAYS)) {
    const seaward: [number, number] = [-q.landward[0], -q.landward[1]];
    // 130 m off the quay face rather than hard against it: at 40 m the 6 m deck
    // wall fills the whole field of view and hides the cranes and the berth
    // behind it. This stands you off far enough to see the quay line, the STS
    // cranes and anything alongside in one frame.
    const p = offsetMeters(q.mid, seaward, 130);
    // `q.landward` is a "1 metre landward" step expressed in DEGREES, so its two
    // components are on different scales (a degree of longitude is ~5% shorter
    // than a degree of latitude at this latitude). Taking atan2 of the raw
    // degree components would skew the bearing by several degrees, so resolve it
    // metrically by asking for the bearing to a point one step landward.
    const landwardBearing = bearingTo(
      q.mid[0],
      q.mid[1],
      q.mid[0] + q.landward[0],
      q.mid[1] + q.landward[1]
    );
    out.push({
      id: `apron:${id}`,
      name: `${id} · berth apron`,
      blurb: 'On the water off the berth, looking across the quay into the terminal.',
      longitude: p[0],
      latitude: p[1],
      // Above the 6 m deck so the quay reads as a surface, not a wall.
      eyeHeightM: 14,
      heading: landwardBearing,
    });
    out.push({
      id: `crane:${id}`,
      name: `${id} · crane cab`,
      blurb: 'Up in the STS crane, looking down the quay line.',
      longitude: q.mid[0],
      latitude: q.mid[1],
      eyeHeightM: 48,
      heading: q.bearingDeg,
    });
  }

  out.push({
    id: 'vts',
    name: 'VTS tower',
    blurb: 'The whole port at once — the controller’s view.',
    longitude: PORT_CENTER[0],
    latitude: PORT_CENTER[1],
    eyeHeightM: 140,
    heading: 225,
  });

  return out;
}

interface VrState {
  mode: VrMode;
  /** True once the viewer has entered the immersive scene. */
  entered: boolean;
  /** Viewer ground position. */
  longitude: number;
  latitude: number;
  eyeHeightM: number;
  heading: number;
  tilt: number;
  /** Stereo baseline, metres — adjustable because phones/viewers differ. */
  ipdM: number;
  /** Gyro look-around is live (VR mode, permission granted). */
  gyroActive: boolean;
  /** Set when the device orientation feed could not be used. */
  gyroError: string | null;
  /** Show the floating impact labels in-scene. */
  showLabels: boolean;
  /** Show the mechanism-labelled causal edges. */
  showEdges: boolean;
  /**
   * Cinematic auto-tour: the camera flies itself to each impacted asset in
   * causal order. Any manual look/walk turns it off, so the operator is never
   * fighting the director for the camera.
   */
  autoTour: boolean;

  place: (longitude: number, latitude: number) => void;
  setEyeHeight: (m: number) => void;
  setLook: (heading: number, tilt: number) => void;
  /**
   * Look direction from the head tracker. Unlike `setLook` this does NOT cancel
   * the tour: in cardboard the tour carries you between vantage points while
   * your head decides where you face, exactly as it does in a real headset.
   */
  setGyroLook: (heading: number, tilt: number) => void;
  setHeading: (heading: number) => void;
  setMode: (mode: VrMode) => void;
  setIpd: (m: number) => void;
  setGyro: (active: boolean, error?: string | null) => void;
  toggleLabels: () => void;
  toggleEdges: () => void;
  setAutoTour: (on: boolean) => void;
  /**
   * Camera pose written by the tour director (does not cancel the tour).
   * `positionOnly` leaves heading/tilt alone so the head tracker keeps the look
   * direction while the tour still moves the viewer between beats.
   */
  setTourPose: (
    p: { longitude: number; latitude: number; z: number; heading: number; tilt: number },
    positionOnly?: boolean
  ) => void;
  enter: (mode: VrMode) => void;
  exit: () => void;
  applyVantage: (v: Vantage) => void;
}

/**
 * Opening position. Standing at eye height on the port centroid would put the
 * viewer in the middle of open water looking at an empty horizon — a bad first
 * frame. Default to a quay apron instead: a real place a person stands, with the
 * terminal filling the view. Falls back to the port centre if the quay geometry
 * is unavailable.
 */
const OPENING: Vantage | undefined =
  defaultVantages().find((v) => v.id === 'apron:GTI') ?? defaultVantages()[0];

export const useVrStore = create<VrState>((set) => ({
  mode: '3d',
  entered: false,
  longitude: OPENING?.longitude ?? PORT_CENTER[0],
  latitude: OPENING?.latitude ?? PORT_CENTER[1],
  eyeHeightM: OPENING?.eyeHeightM ?? 8,
  heading: OPENING?.heading ?? 225,
  tilt: 90,
  ipdM: DEFAULT_IPD_M,
  gyroActive: false,
  gyroError: null,
  showLabels: true,
  showEdges: true,
  autoTour: true,

  // Manual input takes the camera back from the director — a viewer who grabs
  // the view should not be yanked away by the next scheduled beat.
  place: (longitude, latitude) => set({ longitude, latitude, autoTour: false }),
  setEyeHeight: (m) => set({ eyeHeightM: Math.min(400, Math.max(1, m)) }),
  setLook: (heading, tilt) => set({ heading, tilt, autoTour: false }),
  setGyroLook: (heading, tilt) => set({ heading: normalizeHeading(heading), tilt: clampTilt(tilt) }),
  setHeading: (heading) => set({ heading: normalizeHeading(heading) }),
  setMode: (mode) => set({ mode }),
  setIpd: (m) => set({ ipdM: Math.min(0.09, Math.max(0.045, m)) }),
  setGyro: (gyroActive, gyroError = null) => set({ gyroActive, gyroError }),
  toggleLabels: () => set((s) => ({ showLabels: !s.showLabels })),
  toggleEdges: () => set((s) => ({ showEdges: !s.showEdges })),
  setAutoTour: (autoTour) => set({ autoTour }),
  setTourPose: (p, positionOnly = false) =>
    set(
      positionOnly
        ? { longitude: p.longitude, latitude: p.latitude, eyeHeightM: p.z }
        : {
            longitude: p.longitude,
            latitude: p.latitude,
            eyeHeightM: p.z,
            heading: normalizeHeading(p.heading),
            tilt: clampTilt(p.tilt),
          }
    ),
  // Entering starts the tour: the point of the walkthrough is that it shows you
  // the impact without you having to know where to look.
  enter: (mode) => set({ entered: true, mode, autoTour: true }),
  exit: () => set({ entered: false, gyroActive: false, autoTour: false }),
  applyVantage: (v) =>
    set({
      longitude: v.longitude,
      latitude: v.latitude,
      eyeHeightM: v.eyeHeightM,
      heading: normalizeHeading(v.heading),
      tilt: 90,
      // Choosing a vantage is an explicit "put me here" — the director stands down.
      autoTour: false,
    }),
}));
