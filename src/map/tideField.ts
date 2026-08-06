/**
 * tideField — turns the sparse tide/sea-state station readings into a continuous
 * gridded raster field, rendered onto a <canvas> the way the INCOIS Ocean State
 * Forecast plots do (viridis colormap + smooth interpolation). The canvas is
 * georeferenced to a WATER-SIDE extent and drawn on the map via a MediaLayer, so
 * it reads as a real field surface rather than point markers — and it is faded
 * out toward the landward (NE) corner so it never paints the port terminals.
 *
 * Pure + framework-free (no ArcGIS import) so it unit-tests and the map layers in
 * both 2D and 3D can share it. Interpolation is inverse-distance weighting (IDW),
 * which is enough for a handful of coastal stations.
 */

import type { TideStation } from '@/types/domain';

/** The three fields the heatmap can display. */
export type FieldVar = 'seaStateM' | 'tideM' | 'windKt';

export const FIELD_META: Record<FieldVar, { label: string; unit: string }> = {
  seaStateM: { label: 'Sea state (SWH)', unit: 'm' },
  tideM: { label: 'Tide height', unit: 'm' },
  windKt: { label: 'Wind speed', unit: 'kn' },
};

/**
 * Water-side render extent for the JNPA approaches, leaning SW (offshore) of the
 * quay line so the field sits on the navigable water. [xmin, ymin, xmax, ymax] in
 * lon/lat. Stations span lon 72.878–72.953 / lat 18.898–18.959; the terminals
 * (land) are at the NE corner, so the extent extends further SW than NE and the
 * landward corner is faded (see landMask below).
 */
export const FIELD_EXTENT = { xmin: 72.76, ymin: 18.82, xmax: 72.965, ymax: 18.965 };

/** Grid resolution of the raster (cells). Kept modest — a handful of stations. */
const GRID_W = 220;
const GRID_H = 160;

/**
 * Viridis colormap as a 32-stop LUT (perceptually-uniform; the INCOIS default).
 * [r,g,b] 0–255 from t=0 (dark purple) to t=1 (yellow).
 */
const VIRIDIS: [number, number, number][] = [
  [68, 1, 84],
  [71, 13, 96],
  [72, 24, 106],
  [72, 35, 116],
  [71, 45, 123],
  [69, 55, 129],
  [66, 64, 134],
  [62, 73, 137],
  [59, 82, 139],
  [55, 91, 141],
  [51, 99, 141],
  [47, 107, 142],
  [44, 114, 142],
  [41, 122, 142],
  [38, 130, 142],
  [35, 137, 142],
  [33, 145, 140],
  [31, 152, 139],
  [31, 160, 136],
  [34, 168, 132],
  [40, 176, 127],
  [51, 183, 122],
  [66, 190, 113],
  [84, 197, 104],
  [104, 203, 92],
  [126, 208, 79],
  [149, 213, 64],
  [173, 217, 48],
  [197, 220, 34],
  [222, 222, 24],
  [246, 224, 34],
  [253, 231, 37],
];

/** Map a normalised t∈[0,1] to a viridis [r,g,b]. */
export function viridis(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[Math.min(VIRIDIS.length - 1, i + 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** Min/max of a field across the stations, padded so a flat field still colours. */
export function fieldRange(stations: TideStation[], v: FieldVar): [number, number] {
  if (!stations.length) return [0, 1];
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of stations) {
    const val = s[v];
    if (val < lo) lo = val;
    if (val > hi) hi = val;
  }
  if (hi - lo < 1e-6) {
    // Flat field — pad symmetrically so it renders as a mid-band, not one colour.
    const pad = Math.max(0.5, Math.abs(hi) * 0.15);
    return [lo - pad, hi + pad];
  }
  return [lo, hi];
}

/**
 * Landward fade: alpha 1 over the water, ramping to 0 as a cell approaches the NE
 * (land) corner of the extent, so the field never paints the terminals. `t` is a
 * 0..1 diagonal position toward the NE corner; anything past `LAND_EDGE` fades.
 */
const LAND_EDGE = 0.72;
function landAlpha(nx: number, ny: number): number {
  // nx,ny are 0..1 across the extent (E and N). NE corner = (1,1) = land.
  const toLand = (nx + ny) / 2; // diagonal position toward NE
  if (toLand <= LAND_EDGE) return 1;
  return Math.max(0, 1 - (toLand - LAND_EDGE) / (1 - LAND_EDGE));
}

/**
 * IDW-interpolate the field value at (lon,lat) from the stations. Power 2, with a
 * small epsilon so a sample exactly on a station returns that station's value.
 */
function idw(lon: number, lat: number, stations: TideStation[], v: FieldVar): number {
  let num = 0;
  let den = 0;
  for (const s of stations) {
    const dx = lon - s.LON;
    const dy = lat - s.LAT;
    const d2 = dx * dx + dy * dy + 1e-9;
    const w = 1 / (d2 * d2 ** 0.5); // ~ 1/d^3 falloff → smooth but station-anchored
    num += w * s[v];
    den += w;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Render the interpolated field to a fresh canvas (GRID_W×GRID_H). Row 0 is the
 * NORTH edge (ymax) so the canvas is image-space-correct for a north-up extent.
 * Returns null when there are no stations to interpolate.
 */
export function renderFieldCanvas(
  stations: TideStation[],
  v: FieldVar
): { canvas: HTMLCanvasElement; range: [number, number] } | null {
  if (!stations.length || typeof document === 'undefined') return null;
  const [lo, hi] = fieldRange(stations, v);
  const span = hi - lo || 1;

  const canvas = document.createElement('canvas');
  canvas.width = GRID_W;
  canvas.height = GRID_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(GRID_W, GRID_H);
  const { xmin, ymin, xmax, ymax } = FIELD_EXTENT;

  for (let py = 0; py < GRID_H; py++) {
    const ny = 1 - py / (GRID_H - 1); // north-up: py=0 → ny=1 (ymax)
    const lat = ymin + ny * (ymax - ymin);
    for (let px = 0; px < GRID_W; px++) {
      const nx = px / (GRID_W - 1);
      const lon = xmin + nx * (xmax - xmin);
      const val = idw(lon, lat, stations, v);
      const [r, g, b] = viridis((val - lo) / span);
      const a = Math.round(255 * 0.82 * landAlpha(nx, ny)); // 0.82 = see basemap through
      const o = (py * GRID_W + px) * 4;
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, range: [lo, hi] };
}
