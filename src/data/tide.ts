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

const num = (v: unknown, fallback = 0) => (typeof v === 'number' ? v : fallback);

/** Classify tide trend from the MSL height's own reading vs the value 1h ago. */
function tideTrend(now: number, prev: number | null): TideStation['tideTrend'] {
  if (prev == null) return 'slack';
  const d = now - prev;
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
    hourly?: { time?: string[]; sea_level_height_msl?: number[] };
  }) : {};
  const f = fRes && fRes.ok ? ((await fRes.json()) as OpenMeteoCurrent) : {};
  const mc = m.current ?? {};
  const fc = f.current ?? {};

  const tideM = Number(num(mc.sea_level_height_msl).toFixed(2));
  // Trend: compare the current MSL against the hourly series' previous sample.
  const series = m.hourly?.sea_level_height_msl ?? [];
  const prev = series.length >= 2 ? series[series.length - 2] : null;

  return {
    STATION_ID: s.STATION_ID,
    NAME: s.NAME,
    LAT: s.LAT,
    LON: s.LON,
    tideM,
    tideTrend: tideTrend(tideM, prev),
    seaStateM: Number(num(mc.wave_height).toFixed(1)),
    swellM: Number(num(mc.swell_wave_height).toFixed(1)),
    windKt: Number(num(fc.wind_speed_10m).toFixed(1)),
    windDir: Math.round(num(fc.wind_direction_10m)),
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
