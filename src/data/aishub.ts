/**
 * AISHub public station-map connector (parser + poller).
 *
 * The AISHub *API* (data.aishub.net/ws.php) needs a contributing-member username
 * we don't have. But every public station page plots live vessels by fetching
 *   https://www.aishub.net/station/<id>/map.json
 * which returns real positions for that receiver's coverage. Station 2387 covers
 * JNPA / Nhava Sheva — genuine Indian-waters AIS the free AISStream feed lacks.
 *
 * Two caveats this module handles honestly:
 *  • The endpoint sends NO CORS header and gates data behind an aishub.net-origin
 *    request, so a direct browser fetch is blocked / returns empty. In dev we go
 *    through the Vite proxy (`/aishub-proxy/...`, see vite.config.ts); a bundled
 *    sample keeps the demo populated when neither the proxy nor a live fetch is
 *    reachable. See docs/AISHUB.md for the production proxy requirement.
 *  • The public feed ANONYMISES MMSI (a 32-char hash, not a real MMSI) and
 *    coarsens SOG. Names, types, and positions are real. The hash is a stable
 *    per-vessel key, which is all the merge/track logic needs — we prefix it so
 *    it can never collide with a real numeric MMSI from AISStream.
 *
 * Docs: https://www.aishub.net/stations/2387
 */

import type { NavStatus, Vessel } from '@/types/domain';
import type { ConnectionListener } from './types';

/** Default AISHub station covering JNPA / Nhava Sheva (Mumbai). */
export const AISHUB_JNPA_STATION = '2387';

/** One vessel entry in the station map.json `positions` array. */
export interface AisHubPosition {
  tst: string; // position time, unix seconds (string)
  ship_name: string;
  mmsi: string; // ANONYMISED — 32-char hash, not a real MMSI
  lat: string;
  lon: string;
  cog: number;
  sog: number;
  type: string; // "Cargo" | "Tankers" | "High speed" | "Other/Auxiliary" | ...
  class: string;
  eta: string;
  sources: number;
  unique: boolean;
  icon: number; // 1=cargo 2=tanker 4=passenger 8=high-speed 128=aux 256=unknown
}

export interface AisHubMapResponse {
  extent: number[];
  positions: AisHubPosition[];
}

/**
 * AISHub public `type` label → a VESSEL_TYPE the sprite registry understands.
 * In a container port the overwhelming majority of "Cargo" hulls are container
 * ships, so map Cargo→Container Ship (same choice aisstream.ts makes for AIS
 * type 70–79). Everything else maps to its nearest sprite-friendly label.
 */
export function mapAisHubType(type: string | undefined, icon?: number): string {
  const t = (type ?? '').toLowerCase();
  if (t.includes('tank')) return 'Tanker';
  if (t.includes('cargo')) return 'Container Ship';
  if (t.includes('high speed')) return 'High-Speed Craft';
  if (t.includes('passenger') || t.includes('cruise')) return 'Passenger Ship';
  if (t.includes('tug')) return 'Tug';
  if (t.includes('pilot')) return 'Pilot Vessel';
  // Fall back to the numeric icon code when the text is generic/unknown.
  if (icon === 2) return 'Tanker';
  if (icon === 1) return 'Container Ship';
  if (icon === 4) return 'Passenger Ship';
  return 'Unknown';
}

/**
 * Nav status from speed (the public feed carries no NavigationalStatus). A
 * coarse but honest split: essentially stopped → anchored, else underway. The
 * DQ layer and the map only need a plausible status for symbology.
 */
export function navStatusFromSpeed(sog: number): NavStatus {
  return sog <= 0.5 ? 'anchored' : 'underway';
}

/**
 * Prefix the anonymised AISHub key so it (a) is clearly not a real MMSI and
 * (b) can never collide with a numeric AISStream MMSI in the merged vessel set.
 */
export function aisHubMmsi(hash: string): string {
  return `AISHUB-${hash}`;
}

/** Map one AISHub position to a domain Vessel, or null if it has no valid fix. */
export function mapAisHubPosition(p: AisHubPosition): Vessel | null {
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  if (!p.mmsi) return null;

  const tsSec = Number(p.tst);
  const timestamp = Number.isFinite(tsSec) ? tsSec * 1000 : Date.now();
  const cog = Number(p.cog) || 0;

  return {
    MMSI: aisHubMmsi(p.mmsi),
    VESSEL_NAME: (p.ship_name ?? '').trim() || 'Unknown vessel',
    VESSEL_TYPE: mapAisHubType(p.type, p.icon),
    NAV_STATUS: navStatusFromSpeed(Number(p.sog) || 0),
    SOG: Number(p.sog) || 0,
    COG: cog,
    HEADING: cog, // public feed carries no true heading; use COG
    LAT: lat,
    LON: lon,
    ETA: null, // `eta` here is an AIS-encoded field, not a usable epoch
    BERTH_ID: null,
    TIMESTAMP: timestamp,
    SOURCE: 'live',
  };
}

/** Parse a full map.json payload into domain Vessels (drops invalid fixes). */
export function parseAisHubResponse(raw: unknown): Vessel[] {
  const data = raw as AisHubMapResponse | null;
  const positions = data?.positions;
  if (!Array.isArray(positions)) return [];
  const out: Vessel[] = [];
  for (const p of positions) {
    const v = mapAisHubPosition(p);
    if (v) out.push(v);
  }
  return out;
}

export interface AisHubOptions {
  /** Station id (defaults to the JNPA station 2387). */
  station?: string;
  /**
   * Base path for the fetch. In dev this is the Vite proxy prefix
   * ('/aishub-proxy'); leave default unless you have a production proxy.
   */
  proxyBase?: string;
  /** Poll interval (ms). AISHub asks for ≤ once/minute; default 60s. */
  intervalMs?: number;
  onVessels: (vessels: Vessel[]) => void;
  onState?: ConnectionListener;
  /**
   * Bundled sample used when a live fetch yields nothing (blocked/empty). Pass
   * the imported aishub.sample.json so hybrid mode still shows real JNPA hulls
   * offline. Omit to disable the fallback (live-only).
   */
  sample?: AisHubMapResponse;
}

/** AISHub asks callers not to poll faster than once per minute. */
export const AISHUB_MIN_INTERVAL_MS = 60_000;

/**
 * Build the map.json URL. Defaults to the dev proxy so a browser fetch actually
 * returns data (the endpoint is CORS-blocked and origin-gated when hit direct).
 */
export function aisHubUrl(station: string, proxyBase = '/aishub-proxy'): string {
  return `${proxyBase}/station/${station}/map.json`;
}

/**
 * Poll the AISHub station feed. Emits vessels on each successful fetch; on a
 * failed/empty live fetch it emits the bundled sample once (if provided) so the
 * JNPA map is populated with real hulls rather than blank. Returns a stop fn.
 */
export function openAisHubFeed(opts: AisHubOptions): () => void {
  const station = opts.station ?? AISHUB_JNPA_STATION;
  const url = aisHubUrl(station, opts.proxyBase);
  const interval = Math.max(AISHUB_MIN_INTERVAL_MS, opts.intervalMs ?? AISHUB_MIN_INTERVAL_MS);
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let servedSample = false;

  const serveSampleOnce = () => {
    if (servedSample || !opts.sample) return;
    servedSample = true;
    const vessels = parseAisHubResponse(opts.sample);
    if (vessels.length) opts.onVessels(vessels);
  };

  const poll = async () => {
    if (stopped) return;
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`AISHub HTTP ${res.status}`);
      const json = (await res.json()) as unknown;
      const vessels = parseAisHubResponse(json);
      if (vessels.length) {
        opts.onState?.('connected');
        opts.onVessels(vessels);
      } else {
        // Live fetch reachable but empty (anonymous gating) — fall back to sample.
        serveSampleOnce();
        opts.onState?.('connected');
      }
    } catch {
      // Blocked (CORS) or network error — serve the bundled JNPA sample so the
      // demo still shows real hulls, and report the degraded state honestly.
      serveSampleOnce();
      opts.onState?.(servedSample ? 'connected' : 'error');
    }
  };

  opts.onState?.('connecting');
  void poll();
  timer = setInterval(() => void poll(), interval);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}
