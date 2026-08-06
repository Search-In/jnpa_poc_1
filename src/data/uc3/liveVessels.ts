/**
 * Live AIS connector — real vessel positions from the shared JNPA gateway.
 *
 * `GET /api/marine/vessels/live` is a pure pass-through: the gateway scrapes a
 * 3×2 grid of MarineTraffic z=12 tiles centred on JNPA (X=1438, Y=913), dedupes
 * on SHIP_ID, normalises the rows and caches them in-process for 60 s. Nothing
 * is persisted, there is no pagination and there are no query parameters — the
 * response is everything inside that tile window.
 *
 * Structured like seaChannels.ts / pilotage.ts: endpoint constant, a typed *wire*
 * interface, exported PURE mappers, I/O last — unit-testable with no network.
 * Auth (bearer + the one-shot 401 re-login) is handled by `client.http()`; this
 * module adds nothing on top of it except in-flight de-duplication.
 *
 * ⚠ Two shapes worth knowing before reading the mapper (both cost real debugging
 * time in the reference implementation):
 *   • `mmsi` is MarineTraffic's SHIP_ID, not an MMSI — see `LiveVessel`.
 *   • the endpoint returns a BARE ARRAY, not an `{items:[…]}` envelope like every
 *     other UC-3 list route. `parseLiveVessels` tolerates both.
 */

import type { LiveVessel } from '@/types/domain';
import { http } from './client';

/** Path suffix, relative to `env.uc3.apiBase` (so '/api' is NOT repeated here). */
export const LIVE_VESSELS_PATH = '/marine/vessels/live';

/** One position exactly as the gateway returns it. Snake_case wire shape. */
export interface LiveVesselWire {
  mmsi: string | null;
  vessel_name: string | null;
  imo_no: string | null;
  lat: number | null;
  lon: number | null;
  speed_knots: number | null;
  course: number | null;
  heading: number | null;
  ship_type_code: number | null;
  ship_type_label: string | null;
  destination: string | null;
  flag: string | null;
  length: number | null;
  elapsed_seconds: number | null;
}

function str(v: string | null | undefined): string {
  return (v ?? '').trim();
}

function nullableStr(v: string | null | undefined): string | null {
  const s = str(v);
  // The feed sends '--' for "flag unknown"; that is not a country code.
  return s === '' || s === '--' ? null : s;
}

function nullableNum(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function num(v: number | null | undefined, fallback = 0): number {
  return nullableNum(v) ?? fallback;
}

/**
 * Map one wire row onto the domain type. Pure.
 *
 * Drops the row when it has no usable identity or position — a graphic with a
 * NaN coordinate throws inside ArcGIS rather than simply not drawing, so the
 * guard belongs here rather than in the map layer.
 */
export function mapLiveVessel(w: LiveVesselWire): LiveVessel | null {
  const mmsi = str(w?.mmsi);
  const lat = nullableNum(w?.lat);
  const lon = nullableNum(w?.lon);
  if (!mmsi || lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const course = num(w.course);
  return {
    mmsi,
    // The gateway already substitutes 'UNKNOWN' for an empty SHIPNAME; keep a
    // second guard so a null name can never render as an empty popup title.
    vesselName: str(w.vessel_name) || 'UNKNOWN',
    imoNo: nullableStr(w.imo_no),
    lat,
    lon,
    speedKnots: num(w.speed_knots),
    course,
    // Upstream HEADING is frequently null (Class B / SAT-AIS rows). Falling back
    // to course means the ship model still points somewhere sensible instead of
    // due north.
    heading: nullableNum(w.heading) ?? course,
    shipTypeCode: num(w.ship_type_code),
    shipTypeLabel: str(w.ship_type_label) || 'Other',
    destination: nullableStr(w.destination),
    flag: nullableStr(w.flag),
    length: nullableNum(w.length),
    elapsedSeconds: nullableNum(w.elapsed_seconds),
  };
}

/**
 * Map a whole response, dropping unusable rows and preserving server order.
 * Pure and tolerant: accepts the bare array the endpoint actually returns, an
 * `{items:[…]}` envelope (in case the route is ever normalised to match its
 * siblings), and anything else as empty.
 */
export function parseLiveVessels(raw: unknown): LiveVessel[] {
  const rows = Array.isArray(raw)
    ? raw
    : ((raw as { items?: unknown } | null)?.items ?? null);
  if (!Array.isArray(rows)) return [];
  return (rows as LiveVesselWire[])
    .map(mapLiveVessel)
    .filter((v): v is LiveVessel => v !== null);
}

/**
 * In-flight de-duplication: two callers asking for live vessels before the first
 * response lands share ONE request. React 18 StrictMode deliberately mounts →
 * unmounts → remounts every effect in development, so without this each poll
 * fires twice; the 2D and 3D maps mounting together would double it again.
 *
 * Only the *pending* promise is shared — there is no result cache here, because
 * the gateway already caches for 60 s and a client-side cache would just add a
 * second, invisible staleness window on top of it.
 */
let inflight: Promise<LiveVessel[]> | null = null;

/**
 * Fetch the current live AIS picture for the JNPA tile window.
 *
 * @throws when UC-3 is disabled, the login fails, or the gateway is non-2xx
 *         (401 after a re-login, or 502 `marinetraffic_fetch_failed` when the
 *         upstream scrape fails).
 */
export function fetchLiveVessels(): Promise<LiveVessel[]> {
  if (inflight) return inflight;
  inflight = http<unknown>(LIVE_VESSELS_PATH)
    .then(parseLiveVessels)
    .finally(() => {
      // Cleared whether the fetch resolved or rejected, so one failure never
      // wedges every later caller onto the same rejected promise.
      inflight = null;
    });
  return inflight;
}

/** Drop the shared in-flight promise. Test seam only. */
export function resetLiveVesselsInflight(): void {
  inflight = null;
}
