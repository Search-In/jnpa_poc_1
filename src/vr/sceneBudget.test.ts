/**
 * The scene budget, exercised across the device × network matrix the demo will
 * actually meet — including the one it is being built for: an iQOO Neo 7 in a
 * Jio VR box, in stereo, on 3G.
 *
 * Two things are being defended here. That the FIELD OF VIEW matches the optics
 * rather than ArcGIS's map-oriented default (the "everything is zoomed in"
 * complaint), and that a constrained link gets a scene that can actually arrive
 * over it — fewer tile services, fewer instances, and the two eyes loading one
 * after the other instead of racing.
 */
import { describe, expect, it } from 'vitest';
import {
  CARDBOARD_HALF_FOV_X_DEG,
  clampFov,
  classifyNetwork,
  defaultFovDeg,
  diagonalFovDeg,
  FOV_MAX_DEG,
  FOV_MIN_DEG,
  isLowPowerProfile,
  MONO_FOV_DEG,
  sceneBudget,
  stereoFovDeg,
  type DeviceProfile,
  type NetworkClass,
} from './sceneBudget';

/** ArcGIS's own default, which is what everything here is arguing with. */
const ARCGIS_DEFAULT_FOV = 55;

const DESKTOP: DeviceProfile = {
  coarsePointer: false,
  cores: 12,
  memory: 16,
  network: 'fast',
  devicePixelRatio: 2,
};

/** The target handset: iQOO Neo 7 — 8 cores, 8 GB, 20:9 screen, dpr 3. */
const HANDSET: DeviceProfile = {
  coarsePointer: true,
  cores: 8,
  memory: 8,
  network: 'fast',
  devicePixelRatio: 3,
};

const on = (p: DeviceProfile, network: NetworkClass): DeviceProfile => ({ ...p, network });

/** One eye of a 2400×1080 phone held landscape. */
const PHONE_EYE = { width: 1200, height: 1080 };

// ---------------------------------------------------------------------------
// Field of view
// ---------------------------------------------------------------------------

/**
 * ArcGIS's own diagonal → horizontal conversion, transcribed from
 * `@arcgis/core/views/3d/webgl-engine/lib/fov.js` (4.34):
 *
 *   fovd2fovx(d, w, h) = 2·atan( w · tan(d/2) / √(w² + h²) )
 *
 * Copied rather than imported: it is an internal module path that a minor
 * upgrade may move, and the point is to pin the CONTRACT — that `Camera.fov` is
 * the diagonal — not to depend on where Esri happens to keep the function. If an
 * upgrade ever changes this, the test below is what will say so.
 */
function arcgisFovToHorizontalDeg(diagonalDeg: number, w: number, h: number): number {
  const rad = (diagonalDeg * Math.PI) / 180;
  return ((2 * Math.atan((w * Math.tan(rad / 2)) / Math.hypot(w, h))) * 180) / Math.PI;
}

describe('field of view', () => {
  it('is the exact inverse of the conversion ArcGIS applies to Camera.fov', () => {
    // The whole fix rests on `Camera.fov` being the DIAGONAL, not the
    // horizontal. If that assumption is wrong the walkthrough is rendered at the
    // wrong magnification and nothing else here matters.
    for (const [w, h] of [
      [1200, 1080],
      [1920, 1080],
      [960, 1080],
      [1080, 1080],
    ] as const) {
      const diagonal = diagonalFovDeg(CARDBOARD_HALF_FOV_X_DEG, w / h);
      // Feed our diagonal through Esri's own formula and we must get back the
      // horizontal field we asked for.
      expect(arcgisFovToHorizontalDeg(diagonal, w, h)).toBeCloseTo(
        CARDBOARD_HALF_FOV_X_DEG * 2,
        6
      );
    }
  });

  it('shows roughly twice the world that the ArcGIS default would', () => {
    const wide = arcgisFovToHorizontalDeg(stereoFovDeg(PHONE_EYE.width / PHONE_EYE.height), 1200, 1080);
    const dflt = arcgisFovToHorizontalDeg(ARCGIS_DEFAULT_FOV, 1200, 1080);
    // Horizontal extent visible at a fixed distance goes as tan(half-angle).
    const ratio = Math.tan((wide / 2) * (Math.PI / 180)) / Math.tan((dflt / 2) * (Math.PI / 180));
    // A berth is ~350 m long and the tour stands 260 m off it: at the default,
    // 232 m of it fits in frame. At this FOV, 432 m does.
    expect(ratio).toBeGreaterThan(1.8);
  });

  it('derives the diagonal from the horizontal field and the box aspect', () => {
    // A square eye box with 40° of horizontal half-angle: the diagonal
    // half-angle is atan(sqrt(2)·tan 40°) = 49.88°, so 99.76° across.
    expect(diagonalFovDeg(40, 1)).toBeCloseTo(99.76, 1);
    // Wider box, same horizontal field → less vertical → smaller diagonal.
    expect(diagonalFovDeg(40, 2)).toBeLessThan(diagonalFovDeg(40, 1));
  });

  it('matches what a cardboard lens presents, not what a map wants', () => {
    const phone = stereoFovDeg(PHONE_EYE.width / PHONE_EYE.height);
    // Google Cardboard v2's viewer profile is 40° of half-field in each
    // direction; on a 20:9 phone that lands at ~97° diagonal.
    expect(phone).toBeGreaterThan(93);
    expect(phone).toBeLessThan(101);
    // The point of the whole exercise: this is nearly twice ArcGIS's default,
    // and rendering at the default is what made the world look magnified.
    expect(phone).toBeGreaterThan(ARCGIS_DEFAULT_FOV * 1.6);
  });

  it('is the same number the cardboard constant implies', () => {
    expect(stereoFovDeg(1.111)).toBeCloseTo(
      diagonalFovDeg(CARDBOARD_HALF_FOV_X_DEG, 1.111),
      1
    );
  });

  it('holds up across the phone shapes a demo might use', () => {
    // 16:9 through 21:9, halved for one eye. Every one of them must land in the
    // range a cardboard viewer is comfortable at — a phone shape must never be
    // able to push the render back to telephoto.
    for (const [w, h] of [
      [1920, 1080],
      [2400, 1080],
      [2560, 1080],
      [2340, 1080],
      [2160, 1620],
    ] as const) {
      const fov = stereoFovDeg(w / 2 / h);
      expect(fov).toBeGreaterThan(85);
      expect(fov).toBeLessThan(115);
    }
  });

  it('gives the mono walkthrough a first-person field, wider than a map’s', () => {
    expect(defaultFovDeg(false)).toBe(MONO_FOV_DEG);
    expect(MONO_FOV_DEG).toBeGreaterThan(ARCGIS_DEFAULT_FOV);
    // But not cardboard-wide: a flat screen at desk distance subtends far less
    // than a lens 40 mm from the eye, and past ~85° the edges just distort.
    expect(MONO_FOV_DEG).toBeLessThan(90);
  });

  it('falls back to a 20:9 handset when the eye box has not been laid out', () => {
    expect(defaultFovDeg(true)).toBeCloseTo(defaultFovDeg(true, PHONE_EYE), 3);
    expect(defaultFovDeg(true, { width: 0, height: 0 })).toBeCloseTo(
      defaultFovDeg(true, PHONE_EYE),
      3
    );
  });

  it('clamps an operator’s trim to a usable range', () => {
    expect(clampFov(10)).toBe(FOV_MIN_DEG);
    expect(clampFov(400)).toBe(FOV_MAX_DEG);
    expect(clampFov(Number.NaN)).toBe(MONO_FOV_DEG);
    expect(clampFov(97)).toBe(97);
  });

  it('lets the operator reach the ArcGIS default if they want it', () => {
    // The trim range has to include 55°, or an operator who prefers the
    // magnified look has no way back to it.
    expect(FOV_MIN_DEG).toBeLessThanOrEqual(ARCGIS_DEFAULT_FOV);
  });
});

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

describe('classifyNetwork', () => {
  it('maps the Network Information API onto the three buckets', () => {
    expect(classifyNetwork('4g')).toBe('fast');
    expect(classifyNetwork('3g')).toBe('moderate');
    expect(classifyNetwork('2g')).toBe('slow');
    expect(classifyNetwork('slow-2g')).toBe('slow');
  });

  it('treats an absent reading as fast, never as slow', () => {
    // Safari reports nothing. Reading that as "slow" would ship the degraded
    // scene to every iPhone in the room, including on venue Wi-Fi.
    expect(classifyNetwork(undefined)).toBe('fast');
    expect(classifyNetwork('')).toBe('fast');
  });

  it('honours Data Saver over the measurement', () => {
    expect(classifyNetwork('4g', true)).toBe('slow');
  });
});

describe('isLowPowerProfile', () => {
  it('never downgrades a machine with a mouse, however few cores it reports', () => {
    expect(isLowPowerProfile({ ...DESKTOP, cores: 2, memory: 2 })).toBe(false);
  });

  it('downgrades a modest phone', () => {
    expect(isLowPowerProfile({ ...HANDSET, cores: 4, memory: 4 })).toBe(true);
  });

  it('does not downgrade a high-end tablet', () => {
    expect(isLowPowerProfile({ ...HANDSET, cores: 12, memory: 16 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The budget
// ---------------------------------------------------------------------------

describe('sceneBudget — the demo device', () => {
  it('renders a handset in stereo at a fraction of the pixels', () => {
    const b = sceneBudget(HANDSET, true);
    expect(b.lowPower).toBe(true);
    expect(b.quality).toBe('low');
    // 0.6 linear is 36% of the pixels. On a dpr-3 phone rendering twice, that
    // is the single biggest lever there is.
    expect(b.renderScale * b.renderScale).toBeLessThan(0.4);
    expect(b.shadows).toBe(false);
  });

  it('keeps the sky, whatever else it gives up', () => {
    // Not a field on the budget, and deliberately so: in a global SceneView the
    // atmosphere IS the sky, and switching it off does not buy a cheaper sky —
    // it buys the black of space. It must not be reachable as a perf dial.
    const keys = Object.keys(sceneBudget(HANDSET, true));
    expect(keys).not.toContain('atmosphere');
    expect(keys).not.toContain('atmosphereEnabled');
  });

  it('always paints a ground under the imagery', () => {
    // Costs one bundled polygon and zero requests, and it is the whole answer to
    // "the map tiles didn't load and everything was white".
    for (const net of ['fast', 'moderate', 'slow'] as const) {
      expect(sceneBudget(on(HANDSET, net), true).groundUnderlay).toBe(true);
      expect(sceneBudget(on(DESKTOP, net), false).groundUnderlay).toBe(true);
    }
  });
});

describe('sceneBudget — 3G', () => {
  const phone3g = on(HANDSET, 'moderate');

  it('drops the terrain tile service', () => {
    // Terrain3D is a whole tile service, fetched by each eye, for a place with
    // essentially no relief: JNPA is tidal flats. (The walkthrough never asks
    // for the place-label service at all — see `vrBasemap`.)
    expect(sceneBudget(phone3g, true).useTerrain).toBe(false);
  });

  it('starts the second eye only after the first has drawn', () => {
    // Two views starting together interleave requests for the SAME tiles and
    // meshes on one thin pipe: both finish late, and they finish at different
    // times. That is the "one side renders later than the other" report.
    expect(sceneBudget(phone3g, true).sequentialViewInit).toBe(true);
  });

  it('thins the yard and drops the truck queues', () => {
    const b = sceneBudget(phone3g, true);
    // 60 blocks × 2–5 tiers ≈ 210 glTF instances, drawn twice in stereo. The
    // bottom tier alone still reads as a container yard, and none of it carries
    // what-if state.
    expect(b.yardFilter).toBe('tier <= 0');
    expect(b.includeTrucks).toBe(false);
  });

  it('fetches models one at a time', () => {
    // Anything in flight shares the same bytes per second, so parallel fetches
    // finish together — late — and the priority order stops meaning anything.
    // Measured on the 3G link model: at two in flight the crane arrived after
    // the gate mesh despite being requested first.
    expect(sceneBudget(phone3g, true).prefetchConcurrency).toBe(1);
    expect(sceneBudget(on(HANDSET, 'slow'), true).prefetchConcurrency).toBe(1);
    // A venue connection is not the constraint, and there the round trips are.
    expect(sceneBudget(HANDSET, true).prefetchConcurrency).toBeGreaterThan(1);
  });

  it('waits longer before giving up on the scene', () => {
    const fast = sceneBudget(HANDSET, true).readyTimeoutMs;
    const slow3g = sceneBudget(phone3g, true).readyTimeoutMs;
    expect(slow3g).toBeGreaterThan(fast);
    // But it always opens: a walkthrough that refuses to start is worse than one
    // that starts half-textured.
    expect(slow3g).toBeLessThanOrEqual(30_000);
  });

  it('keeps the decorative hulls on 3G and drops them only on 2G', () => {
    expect(sceneBudget(phone3g, true).includeBerthedVessels).toBe(true);
    expect(sceneBudget(on(HANDSET, 'slow'), true).includeBerthedVessels).toBe(false);
    expect(sceneBudget(on(HANDSET, 'slow'), true).includeTug).toBe(false);
  });
});

describe('sceneBudget — a fast desktop', () => {
  it('is not degraded by any of the mobile levers', () => {
    const b = sceneBudget(DESKTOP, false);
    expect(b.lowPower).toBe(false);
    expect(b.quality).toBe('high');
    expect(b.renderScale).toBe(1);
    expect(b.shadows).toBe(true);
    expect(b.useTerrain).toBe(true);
    expect(b.yardFilter).toBeNull();
    expect(b.includeTrucks).toBe(true);
    expect(b.sequentialViewInit).toBe(false);
    expect(b.animationHz).toBe(30);
  });

  it('takes shadows off as soon as a second view is on screen', () => {
    expect(sceneBudget(DESKTOP, true).shadows).toBe(false);
    expect(sceneBudget(DESKTOP, true).quality).toBe('medium');
  });

  it('degrades a fast desktop on a throttled link too — the link is the constraint', () => {
    const b = sceneBudget(on(DESKTOP, 'moderate'), false);
    expect(b.useTerrain).toBe(false);
    expect(b.yardFilter).toBe('tier <= 0');
    // …but not its renderer: the GPU is unaffected by the network.
    expect(b.renderScale).toBe(1);
    expect(b.quality).toBe('high');
  });
});

describe('sceneBudget — the auto-tour', () => {
  it('flies flat when the head is tracked', () => {
    const free = sceneBudget(HANDSET, true, { headTracked: false }).tourArcM;
    const tracked = sceneBudget(HANDSET, true, { headTracked: true }).tourArcM;
    // With the head tracked the inner ear reports standing still while the eyes
    // report a climb, and that disagreement is what makes people take the
    // viewer off.
    expect(tracked).toBeLessThan(free / 2);
    expect(tracked).toBeGreaterThan(0);
  });

  it('writes camera poses no faster than the scene animates', () => {
    for (const profile of [DESKTOP, HANDSET]) {
      for (const stereo of [false, true]) {
        const b = sceneBudget(profile, stereo);
        expect(b.tourHz).toBe(b.animationHz);
        expect(b.animationHz).toBeGreaterThanOrEqual(20);
        expect(b.animationHz).toBeLessThanOrEqual(30);
      }
    }
  });
});

describe('sceneBudget — invariants across the whole matrix', () => {
  it('never produces a setting that would break the view', () => {
    for (const profile of [DESKTOP, HANDSET, { ...HANDSET, cores: 4, memory: 4 }]) {
      for (const net of ['fast', 'moderate', 'slow'] as const) {
        for (const stereo of [false, true]) {
          const b = sceneBudget(on(profile, net), stereo);
          expect(b.renderScale).toBeGreaterThanOrEqual(0.5);
          expect(b.renderScale).toBeLessThanOrEqual(1);
          expect(b.fovDeg).toBeGreaterThanOrEqual(FOV_MIN_DEG);
          expect(b.fovDeg).toBeLessThanOrEqual(FOV_MAX_DEG);
          expect(b.readyTimeoutMs).toBeGreaterThan(5_000);
          expect(b.prefetchConcurrency).toBeGreaterThanOrEqual(1);
          expect(b.tourArcM).toBeGreaterThan(0);
          // Sequential startup only ever applies to a pair of views.
          if (!stereo) expect(b.sequentialViewInit).toBe(false);
        }
      }
    }
  });

  it('gets cheaper, never dearer, as the link gets worse', () => {
    const rank = { fast: 0, moderate: 1, slow: 2 } as const;
    const nets = ['fast', 'moderate', 'slow'] as const;
    for (let i = 1; i < nets.length; i++) {
      const better = sceneBudget(on(HANDSET, nets[i - 1]), true);
      const worse = sceneBudget(on(HANDSET, nets[i]), true);
      expect(rank[worse.network]).toBeGreaterThan(rank[better.network]);
      expect(Number(worse.useTerrain)).toBeLessThanOrEqual(Number(better.useTerrain));
      expect(Number(worse.includeTrucks)).toBeLessThanOrEqual(Number(better.includeTrucks));
      expect(Number(worse.includeTug)).toBeLessThanOrEqual(Number(better.includeTug));
      expect(worse.prefetchConcurrency).toBeLessThanOrEqual(better.prefetchConcurrency);
      expect(worse.readyTimeoutMs).toBeGreaterThanOrEqual(better.readyTimeoutMs);
    }
  });
});
