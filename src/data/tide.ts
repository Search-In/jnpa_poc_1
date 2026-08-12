/**
 * Tide & Sea State connector.
 *
 * Production source is INCOIS Ocean State Forecast (OSF) — the SAMUDRA backend —
 * which serves per-location tide predictions + significant wave height. INCOIS
 * has no free, public, CORS-enabled tide/OSF API today (its open ERDDAP carries
 * only satellite winds/SST and sends no CORS header), so a real INCOIS feed
 * needs a server-side proxy + an INCOIS data agreement — see docs/INCOIS.md and
 * the INCOIS_OSF connector entry in src/data/connectors.ts.
 *
 * INTERIM LIVE SOURCE: Open-Meteo Marine (free, no key) — real wave height +
 * sea-level-MSL (→ tide) per station lat/lon. Honestly labelled "interim —
 * pending INCOIS OSF" via the TIDE SourceBadge. Same pattern as weather.ts.
 */

import type { TideStation, TideStationsReading } from '@/types/domain';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';

/**
 * Fixed tide/sea-state monitoring points around Nhava Sheva / JNPA. Coordinates
 * match the terminals / pilot boarding ground / anchorages the 3D + 2D maps use
 * (src/map/portGeometry.ts), so a station sits where an operator expects one.
 */
export const TIDE_STATIONS: ReadonlyArray<Pick<TideStation, 'STATION_ID' | 'NAME' | 'LAT' | 'LON'>> = [
  { STATION_ID: 'TS-NSICT', NAME: 'NSICT Terminal', LAT: 18.95879, LON: 72.95259 },
  { STATION_ID: 'TS-NSIGT', NAME: 'NSIGT Terminal', LAT: 18.95395, LON: 72.94971 },
  { STATION_ID: 'TS-BMCT', NAME: 'BMCT Terminal', LAT: 18.93839, LON: 72.93892 },
  { STATION_ID: 'TS-PBG', NAME: 'Pilot Boarding Ground', LAT: 18.918, LON: 72.905 },
  { STATION_ID: 'TS-ANCH-OUT', NAME: 'Outer Anchorage', LAT: 18.898, LON: 72.878 },
];

interface OpenMeteoCurrent {
  current?: Record<string, number | string | undefined>;
}

type Measurement = NonNullable<TideStation['missing']>[number];

/**
 * A measurement, or null when the source did not return one. Deliberately NOT
 * `?? 0`: a missing wave height rendered as "0.0 m" is a calm sea the model
 * never reported, and downstream (DUKC, pilotage limits) a fabricated zero is
 * the most dangerous value in the set. Callers record the null in `missing`.
 */
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Round a real reading; keep null as null. */
const fix = (v: number | null, dp: number): number | null =>
  v === null ? null : Number(v.toFixed(dp));

/**
 * Classify tide trend by comparing the current height against the hourly sample
 * ~1 h earlier.
 *
 * The sample must be located by TIME, not by position in the array: the hourly
 * series covers the whole forecast day (00:00–23:00), so `series[length - 2]`
 * is 22:00 — a value hours in the FUTURE for most of the day. Comparing against
 * it made the arrow report "falling" every afternoon regardless of the tide.
 */
export function trendFromSeries(
  nowMs: number,
  times: string[],
  heights: number[],
  current: number | null,
): TideStation['tideTrend'] {
  if (current === null || times.length === 0) return 'slack';
  const target = nowMs - 3_600_000;
  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < times.length && i < heights.length; i++) {
    // Open-Meteo hourly stamps are UTC without a zone suffix.
    const t = Date.parse(`${times[i]}Z`);
    if (!Number.isFinite(t) || t > nowMs) continue;
    const gap = Math.abs(t - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  // No usable past sample (or the nearest one is >2 h off): say nothing rather
  // than invent a direction.
  if (best < 0 || bestGap > 2 * 3_600_000) return 'slack';
  const prev = heights[best];
  if (typeof prev !== 'number' || !Number.isFinite(prev)) return 'slack';
  const d = current - prev;
  if (d > 0.05) return 'rising';
  if (d < -0.05) return 'falling';
  return 'slack';
}

/** Fetch one station's live tide + sea state from Open-Meteo. */
async function fetchStation(
  s: Pick<TideStation, 'STATION_ID' | 'NAME' | 'LAT' | 'LON'>,
  ts: number
): Promise<TideStation> {
  const marineUrl =
    `${MARINE}?latitude=${s.LAT}&longitude=${s.LON}` +
    `&current=wave_height,swell_wave_height,sea_level_height_msl` +
    `&hourly=sea_level_height_msl&forecast_days=1`;
  const forecastUrl =
    `${FORECAST}?latitude=${s.LAT}&longitude=${s.LON}` +
    `&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn`;

  const [mRes, fRes] = await Promise.all([
    fetch(marineUrl).catch(() => null),
    fetch(forecastUrl).catch(() => null),
  ]);

  const m = mRes && mRes.ok ? ((await mRes.json()) as OpenMeteoCurrent & {
    latitude?: number;
    longitude?: number;
    hourly?: { time?: string[]; sea_level_height_msl?: number[] };
  }) : {};
  const f = fRes && fRes.ok ? ((await fRes.json()) as OpenMeteoCurrent) : {};
  const mc = m.current ?? {};
  const fc = f.current ?? {};

  const tideM = fix(num(mc.sea_level_height_msl), 2);
  const seaStateM = fix(num(mc.wave_height), 1);
  const swellM = fix(num(mc.swell_wave_height), 1);
  const windKt = fix(num(fc.wind_speed_10m), 1);
  const windDir = num(fc.wind_direction_10m);

  const missing: Measurement[] = [];
  if (tideM === null) missing.push('tideM');
  if (seaStateM === null) missing.push('seaStateM');
  if (swellM === null) missing.push('swellM');
  if (windKt === null) missing.push('windKt');

  // The grid cell the model resolved, which is generally NOT s.LAT/s.LON — the
  // marine grid has no cell over the terminals, so requests snap to open water
  // several km away and neighbouring stations can land in the SAME cell.
  const cell =
    typeof m.latitude === 'number' && typeof m.longitude === 'number'
      ? { LAT: m.latitude, LON: m.longitude }
      : undefined;

  return {
    STATION_ID: s.STATION_ID,
    NAME: s.NAME,
    LAT: s.LAT,
    LON: s.LON,
    // 0 keeps the field maths total; `missing` is what makes it non-reportable.
    tideM: tideM ?? 0,
    tideTrend: trendFromSeries(
      ts,
      m.hourly?.time ?? [],
      m.hourly?.sea_level_height_msl ?? [],
      tideM,
    ),
    seaStateM: seaStateM ?? 0,
    swellM: swellM ?? 0,
    windKt: windKt ?? 0,
    windDir: windDir === null ? 0 : Math.round(windDir),
    ...(missing.length ? { missing } : {}),
    ...(cell ? { cell } : {}),
    TS: ts,
  };
}

/**
 * Fetch live tide + sea state for every station (interim Open-Meteo source).
 * Stations that fail individually are dropped rather than failing the whole set.
 */
export async function fetchTideStations(ts: number): Promise<TideStationsReading> {
  const results = await Promise.all(
    TIDE_STATIONS.map((s) => fetchStation(s, ts).catch(() => null))
  );
  return { TS: ts, stations: results.filter((r): r is TideStation => r !== null) };
}
