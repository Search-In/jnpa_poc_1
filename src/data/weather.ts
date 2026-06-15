/**
 * Open-Meteo weather connector — free, no-API-key live met/marine data.
 *
 * Two public endpoints (no auth):
 *   • Forecast API → wind speed/direction, visibility
 *   • Marine API   → significant wave height (sea state), sea level / tide
 *
 * Used as the live weather source when VITE_WEATHER_FEED_URL is not set, so the
 * Weather panel shows genuine data instead of erroring. Docs: open-meteo.com.
 */

import type { WeatherReading } from '@/types/domain';

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const MARINE = 'https://marine-api.open-meteo.com/v1/marine';

interface OpenMeteoCurrent {
  current?: Record<string, number | string | undefined>;
}

/** Parse "lon,lat" (the app's map-center format) → {lat, lon}. */
export function parseLonLat(center: string): { lat: number; lon: number } {
  const [lon, lat] = center.split(',').map(Number);
  return { lat: Number.isFinite(lat) ? lat : 0, lon: Number.isFinite(lon) ? lon : 0 };
}

const M_TO_NM = 1 / 1852;

/**
 * Fetch live weather for a point. Marine API can be absent for inland points;
 * wave/tide then fall back to 0 rather than failing the whole reading.
 */
export async function fetchOpenMeteoWeather(lat: number, lon: number): Promise<WeatherReading> {
  const forecastUrl =
    `${FORECAST}?latitude=${lat}&longitude=${lon}` +
    `&current=wind_speed_10m,wind_direction_10m,visibility&wind_speed_unit=kn`;
  const marineUrl =
    `${MARINE}?latitude=${lat}&longitude=${lon}&current=wave_height,sea_level_height_msl`;

  const [fRes, mRes] = await Promise.all([
    fetch(forecastUrl),
    fetch(marineUrl).catch(() => null),
  ]);
  if (!fRes.ok) throw new Error(`Open-Meteo forecast HTTP ${fRes.status}`);

  const f = (await fRes.json()) as OpenMeteoCurrent;
  const m = mRes && mRes.ok ? ((await mRes.json()) as OpenMeteoCurrent) : { current: {} };
  const fc = f.current ?? {};
  const mc = m.current ?? {};

  const num = (v: unknown, fallback = 0) => (typeof v === 'number' ? v : fallback);

  return {
    TS: Date.now(),
    windKt: Number(num(fc.wind_speed_10m).toFixed(1)),
    windDir: Math.round(num(fc.wind_direction_10m)),
    seaStateM: Number(num(mc.wave_height).toFixed(1)),
    // Open-Meteo visibility is in metres → nautical miles.
    visibilityNm: Number((num(fc.visibility) * M_TO_NM).toFixed(1)),
    // Sea-level height MSL stands in for tide; clamp the typical range.
    tideM: Number(num(mc.sea_level_height_msl).toFixed(2)),
  };
}
