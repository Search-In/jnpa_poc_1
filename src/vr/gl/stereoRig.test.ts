/**
 * Field-of-view conversion across the renderer boundary.
 *
 * The HUD trims ONE number — a diagonal FOV, because that is what ArcGIS's
 * `Camera.fov` means. three.js `PerspectiveCamera.fov` is the VERTICAL angle.
 * If the conversion is wrong the two renderers frame the port differently at
 * the same setting, and the operator's trim stops meaning anything.
 */
import { describe, expect, it } from 'vitest';
import { diagonalToVerticalFov } from './stereoRig';
import { CARDBOARD_HALF_FOV_X_DEG, diagonalFovDeg, stereoFovDeg } from '../sceneBudget';

/**
 * Esri's own conversions, transcribed from
 * `@arcgis/core/views/3d/webgl-engine/lib/fov.js` (4.34):
 *
 *   fovd2fovy(d, w, h) = 2·atan( h · tan(d/2) / √(w² + h²) )
 *   fovd2fovx(d, w, h) = 2·atan( w · tan(d/2) / √(w² + h²) )
 */
const esriVertical = (d: number, w: number, h: number) =>
  ((2 * Math.atan((h * Math.tan((d * Math.PI) / 360)) / Math.hypot(w, h))) * 180) / Math.PI;
const esriHorizontal = (d: number, w: number, h: number) =>
  ((2 * Math.atan((w * Math.tan((d * Math.PI) / 360)) / Math.hypot(w, h))) * 180) / Math.PI;

describe('diagonalToVerticalFov', () => {
  it('matches the conversion ArcGIS applies to the same number', () => {
    // Same input, same framing, whichever renderer is drawing.
    for (const [w, h] of [
      [1200, 1080],
      [1920, 1080],
      [800, 800],
      [640, 1136],
    ] as const) {
      for (const d of [55, 80, 97, 120]) {
        expect(diagonalToVerticalFov(d, w, h)).toBeCloseTo(esriVertical(d, w, h), 9);
      }
    }
  });

  it('reproduces the cardboard horizontal field the optics actually present', () => {
    // The eye box of a 20:9 handset held landscape.
    const [w, h] = [1200, 1080];
    const diagonal = stereoFovDeg(w / h);
    const vertical = diagonalToVerticalFov(diagonal, w, h);
    // Recover the horizontal from the vertical and the aspect, and it must be
    // the 80° a Cardboard v2 lens shows.
    const horizontal =
      ((2 * Math.atan(Math.tan((vertical * Math.PI) / 360) * (w / h))) * 180) / Math.PI;
    // `stereoFovDeg` rounds the diagonal to one decimal for legibility in the
    // HUD, which costs about 0.03° here — far below anything an eye resolves.
    expect(horizontal).toBeCloseTo(CARDBOARD_HALF_FOV_X_DEG * 2, 1);
    expect(horizontal).toBeCloseTo(esriHorizontal(diagonal, w, h), 6);
  });

  it('is always narrower than the diagonal it came from', () => {
    for (const [w, h] of [[1200, 1080], [1920, 1080]] as const) {
      for (const d of [55, 80, 97, 120]) {
        expect(diagonalToVerticalFov(d, w, h)).toBeLessThan(d);
        expect(diagonalToVerticalFov(d, w, h)).toBeGreaterThan(0);
      }
    }
  });

  it('opens up as the eye box gets taller', () => {
    // A narrower, taller box puts more of the diagonal into the vertical.
    expect(diagonalToVerticalFov(97, 600, 1080)).toBeGreaterThan(
      diagonalToVerticalFov(97, 1920, 1080)
    );
  });

  it('survives a zero-sized viewport instead of producing NaN', () => {
    // The first frame can arrive before layout has settled.
    expect(Number.isFinite(diagonalToVerticalFov(97, 0, 0))).toBe(true);
    expect(diagonalToVerticalFov(97, 0, 0)).toBeGreaterThan(0);
  });

  it('agrees with the budget’s own derivation, so one dial drives both', () => {
    const aspect = 1200 / 1080;
    expect(stereoFovDeg(aspect)).toBeCloseTo(
      diagonalFovDeg(CARDBOARD_HALF_FOV_X_DEG, aspect),
      1
    );
  });
});
