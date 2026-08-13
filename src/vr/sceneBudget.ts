/**
 * One place that decides how expensive the walkthrough is allowed to be.
 *
 * The scene has two independent bottlenecks and they need different levers:
 *
 *  - **The GPU / frame budget.** Stereo renders the whole port twice, so a
 *    handset is doing two full passes over ~300 glTF instances at
 *    devicePixelRatio 3. Levers: render scale, quality profile, shadows,
 *    instance count, animation rate.
 *  - **The network.** On 3G a phone gets roughly 40–60 KB/s with a 200 ms
 *    round trip, and the scene wants ~1.2 MB of glTF plus a few hundred KB of
 *    tiles BEFORE it looks like a port at all. Levers: how many distinct model
 *    files, how many tile services, whether the two views fetch in parallel or
 *    one after the other, and whether anything is prefetched.
 *
 * Those are different axes: a flagship phone on 3G is fast but starved, and a
 * cheap phone on office Wi-Fi is the opposite. Deciding them separately — and in
 * ONE pure function of a measured profile — is what makes the behaviour
 * testable, which is the whole point of this module existing rather than the
 * decisions being scattered through `VrScene`.
 *
 * `device.ts` keeps the thin capability probes; everything that turns a probe
 * into a decision lives here.
 */

/** How much bandwidth the link looks like it has. */
export type NetworkClass =
  /** 4g/wifi, or nothing reported — assume the demo venue is fine. */
  | 'fast'
  /** 3g. Enough to stream the scene, but not twice and not eagerly. */
  | 'moderate'
  /** 2g, slow-2g, or Data Saver on. Every byte has to earn its place. */
  | 'slow';

/** What the device told us about itself. */
export interface DeviceProfile {
  coarsePointer: boolean;
  cores: number;
  /** GB, as `navigator.deviceMemory` reports it (a coarse power-of-two bucket). */
  memory: number;
  network: NetworkClass;
  devicePixelRatio: number;
}

/**
 * `navigator.connection.effectiveType` → our three buckets. Chrome on Android
 * reports this; Safari does not, and an absent value must never be read as
 * "slow" (that would ship the degraded scene to every iPhone on Wi-Fi).
 */
export function classifyNetwork(effectiveType?: string, saveData?: boolean): NetworkClass {
  // Data Saver is an explicit user instruction to spend less, whatever the link
  // actually is — honour it over the measurement.
  if (saveData) return 'slow';
  switch (effectiveType) {
    case 'slow-2g':
    case '2g':
      return 'slow';
    case '3g':
      return 'moderate';
    default:
      return 'fast';
  }
}

/** Read the live device profile. Safe on a server / in jsdom. */
export function readDeviceProfile(): DeviceProfile {
  if (typeof window === 'undefined') {
    return {
      coarsePointer: false,
      cores: 8,
      memory: 8,
      network: 'fast',
      devicePixelRatio: 1,
    };
  }
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; saveData?: boolean };
  };
  const coarsePointer =
    typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return {
    coarsePointer,
    cores: navigator.hardwareConcurrency ?? 8,
    memory: nav.deviceMemory ?? 8,
    network: classifyNetwork(nav.connection?.effectiveType, nav.connection?.saveData),
    devicePixelRatio: window.devicePixelRatio ?? 1,
  };
}

/**
 * A weak device: touch-first AND short on cores or memory. A fine pointer is
 * taken as proof of a real machine — the cardboard path is not even reachable
 * there, so a laptop reporting two cores must not be degraded.
 */
export function isLowPowerProfile(p: DeviceProfile): boolean {
  if (!p.coarsePointer) return false;
  return p.cores <= 8 || p.memory <= 8;
}

// ---------------------------------------------------------------------------
// Field of view
// ---------------------------------------------------------------------------

/**
 * ArcGIS `Camera.fov` is the **diagonal** field of view and defaults to **55°**.
 *
 * 55° diagonal is a mild telephoto — it is the right default for a map you are
 * looking AT, and completely wrong for a scene you are looking THROUGH. In a
 * cardboard viewer the lens presents roughly 80° of horizontal field to each
 * eye; feeding it a 55°-diagonal render means the world arrives magnified by
 * about 2×, with none of the peripheral context the brain uses to accept a
 * stereo pair as a place. That mismatch is felt as "everything is zoomed in",
 * and it is also a documented cause of viewer discomfort.
 *
 * So the FOV is computed from the optics instead of left at the default.
 */

/** Half-angle of the horizontal field a cardboard lens presents, degrees. */
export const CARDBOARD_HALF_FOV_X_DEG = 40;

/** Diagonal FOV that fills an eye box of aspect `a` with `halfX` of horizontal field. */
export function diagonalFovDeg(halfXDeg: number, aspect: number): number {
  const tanX = Math.tan((halfXDeg * Math.PI) / 180);
  const tanY = tanX / Math.max(0.05, aspect);
  return (2 * Math.atan(Math.hypot(tanX, tanY)) * 180) / Math.PI;
}

/**
 * The FOV to render each eye at, given the eye box's aspect ratio.
 *
 * A 20:9 handset (iQOO Neo 7, 2400×1080) held landscape gives each eye a
 * 1200×1080 box — aspect 1.111 — and this returns ~97°, which is what the lens
 * is actually showing. A 16:9 phone gives ~99°. Both are close to the Google
 * Cardboard v2 viewer profile's 80×80 field, as they should be.
 */
export function stereoFovDeg(eyeAspect: number): number {
  return round1(diagonalFovDeg(CARDBOARD_HALF_FOV_X_DEG, eyeAspect));
}

/**
 * Mono walkthrough FOV. Wider than the ArcGIS default — a first-person view
 * needs the peripheral cues — but not cardboard-wide, because a flat screen at
 * desk distance subtends far less than a lens 40 mm from your eye, and pushing
 * past ~85° on a monitor just distorts the edges.
 */
export const MONO_FOV_DEG = 80;

/** Legal range for the viewer's own FOV adjustment. */
export const FOV_MIN_DEG = 55;
export const FOV_MAX_DEG = 120;

export function clampFov(deg: number): number {
  if (!Number.isFinite(deg)) return MONO_FOV_DEG;
  return Math.min(FOV_MAX_DEG, Math.max(FOV_MIN_DEG, deg));
}

/**
 * FOV for a mode, given the size of one eye box in CSS pixels. Falls back to a
 * 20:9 handset in landscape when the box has not been laid out yet.
 */
export function defaultFovDeg(stereo: boolean, eyeBox?: { width: number; height: number }): number {
  if (!stereo) return MONO_FOV_DEG;
  const w = eyeBox && eyeBox.width > 0 ? eyeBox.width : 1200;
  const h = eyeBox && eyeBox.height > 0 ? eyeBox.height : 1080;
  return stereoFovDeg(w / h);
}

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

export interface SceneBudget {
  lowPower: boolean;
  network: NetworkClass;

  // --- renderer ---
  quality: 'low' | 'medium' | 'high';
  /** Fraction of the eye box's pixels actually rasterised (CSS-upscaled). */
  renderScale: number;
  shadows: boolean;
  /** World-update rate for the scene animator, Hz. */
  animationHz: number;
  /** Camera-write rate for the auto-tour, Hz. */
  tourHz: number;

  // --- what is in the scene ---
  /** `definitionExpression` for the yard layer, or null to keep every tier. */
  yardFilter: string | null;
  includeTrucks: boolean;
  includeTug: boolean;
  includeBerthedVessels: boolean;

  // --- network ---
  /** Terrain3D is a second tile service for ~0 m of relief at JNPA. */
  useTerrain: boolean;
  /** Paint a bundled sea-tone ground under the imagery so nothing is ever white. */
  groundUnderlay: boolean;
  /** Build the second eye only once the first has drawn, so they share a warm cache. */
  sequentialViewInit: boolean;
  /** Give up waiting for both eyes and reveal the scene anyway after this long. */
  readyTimeoutMs: number;
  /** Fetch the glTF models up front, from the setup screen. */
  prefetchModels: boolean;
  /** How many model fetches may be in flight at once. */
  prefetchConcurrency: number;

  // --- camera ---
  /** Diagonal field of view, degrees. */
  fovDeg: number;
  /** How high the auto-tour arcs over the port between beats, metres. */
  tourArcM: number;
}

/**
 * Turn a measured profile into a budget.
 *
 * @param stereo     two SceneViews rather than one
 * @param headTracked the viewer's head owns the look direction (cardboard). Large
 *   camera moves are far more provocative when the head is tracked, so the tour
 *   flies flatter.
 * @param eyeBox     one eye box in CSS pixels, for the FOV's aspect ratio
 */
export function sceneBudget(
  profile: DeviceProfile,
  stereo: boolean,
  opts: { headTracked?: boolean; eyeBox?: { width: number; height: number } } = {}
): SceneBudget {
  const lowPower = isLowPowerProfile(profile);
  const net = profile.network;
  const constrained = net !== 'fast';
  const headTracked = opts.headTracked ?? false;

  // Two views on a phone is the case the whole module exists for.
  const quality: SceneBudget['quality'] = lowPower ? 'low' : stereo ? 'medium' : 'high';

  // Render scale. A phone at devicePixelRatio 3 asks for nine device pixels per
  // CSS pixel and stereo asks for two of those buffers; 0.62 linear is 38% of
  // the pixels. Through a cardboard lens — itself soft and magnified — the
  // softening does not read, and it is the single biggest frame-rate lever
  // available. Widening the FOV to match the optics puts MORE world in each
  // frame, so this matters more now, not less.
  let scale = 1;
  if (lowPower) scale = stereo ? 0.6 : 0.8;
  // Even a strong phone is doing two passes; take a little off rather than
  // shipping desktop settings to a handset.
  else if (stereo && profile.coarsePointer) scale = 0.8;

  return {
    lowPower,
    network: net,

    quality,
    renderScale: scale,
    shadows: !stereo && !lowPower,
    animationHz: profile.coarsePointer ? (stereo ? 20 : 24) : 30,
    tourHz: profile.coarsePointer ? (stereo ? 20 : 24) : 30,

    // The yard is 60 blocks stacked 2–5 containers high — ~210 glTF instances,
    // drawn twice in stereo. Its bottom tier alone (60) still reads as a
    // container yard from any distance a viewer stands at, and none of it
    // carries what-if state: the impacted assets are the cranes, berths,
    // channel and hulls.
    yardFilter: lowPower || constrained ? 'tier <= 0' : null,
    includeTrucks: !lowPower && net === 'fast',
    // Decorative hulls. Worth their bytes on a normal link; the first thing to
    // go when every byte is a second of waiting.
    includeTug: net !== 'slow',
    includeBerthedVessels: net !== 'slow',

    // Terrain3D is a whole tile service, fetched per view, for a place with
    // essentially no relief: JNPA is tidal flats. (The place-label overlay is
    // the other service the dashboard pulls; the walkthrough never asks for it
    // at all — see `vrBasemap`.)
    useTerrain: !lowPower && !constrained,
    // Costs nothing (one bundled polygon, no request) and it is what stops the
    // "white ground" while imagery streams in over a slow link.
    groundUnderlay: true,
    // Two views starting together on one thin pipe both wait on the same bytes
    // and neither finishes — which is exactly the reported symptom of one eye
    // rendering long after the other. Starting the second once the first has
    // drawn makes almost all of its fetches cache hits.
    sequentialViewInit: stereo && (constrained || lowPower),
    // How long the reveal gate waits before showing a still-streaming scene.
    //
    // Asymmetric on purpose. The gate reads the asset layer views' `updating`
    // flags, and if that signal ever misbehaves the timeout is the ONLY thing
    // that opens it — so on a fast link, where the scene should be up in two or
    // three seconds anyway, the ceiling is kept low: revealing a half-built port
    // is a much smaller failure than making someone stare at a loading screen
    // for twelve seconds. On a thin link the wait is real and worth taking,
    // because the alternative is the viewer watching the port assemble itself.
    readyTimeoutMs: net === 'slow' ? 25_000 : net === 'moderate' ? 18_000 : 9_000,
    prefetchModels: true,
    // Concurrency is a bandwidth question, not a CPU one, and on a thin pipe it
    // is worse than useless: everything in flight shares the same bytes per
    // second, so N parallel fetches all finish at the same LATE moment instead
    // of one finishing early.
    //
    // That defeats the priority order outright. Measured on the 3G model, at two
    // in flight the 542 KB crane — first in the queue, and the asset a what-if
    // scenario actually changes — still arrived AFTER the 26 KB gate mesh, at
    // 21 s against 18 s. Serialised, it arrives at 11 s. The cost is one extra
    // round trip per asset, about 1.2 s across the whole set: 5% slower overall
    // to halve the wait for the thing the viewer is there to see.
    //
    // (Parallelism would not buy extra sockets in any case — these are same-
    // origin requests over one HTTP/2 connection, so "concurrency" means
    // interleaved streams, which is precisely the fair sharing that hurts.)
    prefetchConcurrency: constrained ? 1 : 4,

    fovDeg: defaultFovDeg(stereo, opts.eyeBox),
    // A 90 m swoop reads as cinematic on a monitor and as a lurch inside a
    // viewer, where the inner ear disagrees with it.
    tourArcM: headTracked ? 22 : lowPower ? 45 : 90,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
