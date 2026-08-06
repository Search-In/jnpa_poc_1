/**
 * Open-Meteo wind grid over the JNPA water extent — u/v components for the
 * Zoom Earth–style particle overlay. Pure fetch + math (no ArcGIS).
 *
 * Meteorological wind direction is the direction the wind blows FROM (degrees
 * clockwise from north). Converted to cartesian east/north components (kn):
 *   u = −s · sin(dir°),  v = −s · cos(dir°)
 */

import { FIELD_EXTENT } from '@/map/tideField';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';

/** Sample resolution — coarse enough for one Open-Meteo multi-point call. */
export const WIND_GRID_COLS = 16;
export const WIND_GRID_ROWS = 12;

/** Cache TTL for the live grid (ms). */
const CACHE_MS = 12 * 60_000;

/** Max locations per Open-Meteo request (URL length + API weight). */
const CHUNK = 120;

export interface WindGrid {
  cols: number;
  rows: number;
  /** Eastward wind component, kn — length cols*rows, row-major, south→north. */
  u: Float32Array;
  /** Northward wind component, kn. */
  v: Float32Array;
  /** Peak speed in the grid (kn), for colour scaling. */
  speedMax: number;
  fetchedAt: number;
}

/** Convert meteo “from” direction (°) + speed (kn) → east/north components. */
export function windUv(speedKt: number, dirDeg: number): { u: number; v: number } {
  const rad = (dirDeg * Math.PI) / 180;
  return {
    u: -speedKt * Math.sin(rad),
    v: -speedKt * Math.cos(rad),
  };
}

/** Build lon/lat sample points covering FIELD_EXTENT (row 0 = south). */
export function windSamplePoints(
  cols = WIND_GRID_COLS,
  rows = WIND_GRID_ROWS,
  extent = FIELD_EXTENT
): { lon: number; lat: number }[] {
  const { xmin, ymin, xmax, ymax } = extent;
  const out: { lon: number; lat: number }[] = [];
  for (let r = 0; r < rows; r++) {
    const lat = ymin + (r / Math.max(1, rows - 1)) * (ymax - ymin);
    for (let c = 0; c < cols; c++) {
      const lon = xmin + (c / Math.max(1, cols - 1)) * (xmax - xmin);
      out.push({ lon, lat });
    }
  }
  return out;
}

interface OpenMeteoCurrentBody {
  current?: {
    wind_speed_10m?: number;
    wind_direction_10m?: number;
  };
  latitude?: number;
  longitude?: number;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Fetch one chunk of locations; returns parallel arrays of speed/dir. */
async function fetchChunk(
  points: { lon: number; lat: number }[]
): Promise<{ speed: number; dir: number }[]> {
  const lats = points.map((p) => p.lat.toFixed(4)).join(',');
  const lons = points.map((p) => p.lon.toFixed(4)).join(',');
  const url =
    `${FORECAST}?latitude=${lats}&longitude=${lons}` +
    `&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo wind grid HTTP ${res.status}`);
  const body = (await res.json()) as OpenMeteoCurrentBody | OpenMeteoCurrentBody[];
  const list = Array.isArray(body) ? body : [body];
  return list.map((item) => ({
    speed: num(item.current?.wind_speed_10m),
    dir: num(item.current?.wind_direction_10m),
  }));
}

let cache: WindGrid | null = null;
let inflight: Promise<WindGrid> | null = null;

/**
 * Live wind grid over FIELD_EXTENT. Cached ~12 min; concurrent callers share
 * one in-flight request.
 */
export async function fetchWindGrid(force = false): Promise<WindGrid> {
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_MS) return cache;
  if (!force && inflight) return inflight;

  inflight = (async () => {
    const cols = WIND_GRID_COLS;
    const rows = WIND_GRID_ROWS;
    const points = windSamplePoints(cols, rows);
    const readings: { speed: number; dir: number }[] = [];
    for (let i = 0; i < points.length; i += CHUNK) {
      const chunk = points.slice(i, i + CHUNK);
      readings.push(...(await fetchChunk(chunk)));
    }
    if (readings.length !== points.length) {
      throw new Error(
        `Open-Meteo wind grid size mismatch: got ${readings.length}, expected ${points.length}`
      );
    }
    const u = new Float32Array(points.length);
    const v = new Float32Array(points.length);
    let speedMax = 1;
    for (let i = 0; i < readings.length; i++) {
      const { speed, dir } = readings[i];
      const uv = windUv(speed, dir);
      u[i] = uv.u;
      v[i] = uv.v;
      if (speed > speedMax) speedMax = speed;
    }
    const grid: WindGrid = {
      cols,
      rows,
      u,
      v,
      speedMax,
      fetchedAt: Date.now(),
    };
    cache = grid;
    return grid;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Clear the module cache (tests). */
export function clearWindGridCache(): void {
  cache = null;
  inflight = null;
}

/**
 * Bilinear sample of u/v at normalised grid coords gx∈[0,cols-1], gy∈[0,rows-1]
 * (gy = 0 is south). Returns null if outside the grid.
 */
export function sampleWindUv(
  grid: WindGrid,
  gx: number,
  gy: number
): { u: number; v: number; speed: number } | null {
  const { cols, rows, u, v } = grid;
  if (gx < 0 || gy < 0 || gx > cols - 1 || gy > rows - 1) return null;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const fx = gx - x0;
  const fy = gy - y0;
  const i00 = y0 * cols + x0;
  const i10 = y0 * cols + x1;
  const i01 = y1 * cols + x0;
  const i11 = y1 * cols + x1;
  const uu =
    u[i00] * (1 - fx) * (1 - fy) +
    u[i10] * fx * (1 - fy) +
    u[i01] * (1 - fx) * fy +
    u[i11] * fx * fy;
  const vv =
    v[i00] * (1 - fx) * (1 - fy) +
    v[i10] * fx * (1 - fy) +
    v[i01] * (1 - fx) * fy +
    v[i11] * fx * fy;
  return { u: uu, v: vv, speed: Math.hypot(uu, vv) };
}

/** Map canvas pixel (px,py) with origin top-left / north-up → grid coords. */
export function canvasToGrid(
  px: number,
  py: number,
  canvasW: number,
  canvasH: number,
  cols: number,
  rows: number
): { gx: number; gy: number } {
  const nx = px / Math.max(1, canvasW - 1);
  const ny = 1 - py / Math.max(1, canvasH - 1); // north-up → gy south-based
  return { gx: nx * (cols - 1), gy: ny * (rows - 1) };
}
