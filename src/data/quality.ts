/**
 * Data-quality firewall for the vessel position feed (spec Part 5 §5.1, Part 3
 * A-6). Every AIS contact crosses this boundary before it reaches the twin.
 *
 * Two layers:
 *  1. `validateVessel(v)` — stateless schema/range/sanity check. Returns the
 *     surviving vessel plus a list of quarantine reason codes for anything that
 *     failed. A record with a FATAL reason is dropped; a record with only
 *     WARN reasons passes through, annotated, so the operator sees degraded data
 *     rather than losing the contact.
 *  2. `TrackQuality` — a small stateful guard keyed by MMSI that needs history:
 *     position teleport (implied speed > threshold), timestamp regression on
 *     reconnect, staleness (no update for N minutes), and per-source dedup.
 *
 * Design: pure/deterministic (no Date.now / Math.random inside — `now` is always
 * passed in), mirroring the KPI and DUKC engines so it is unit-testable and
 * replay-safe. Reason codes are stable strings so the Connector Readiness page
 * and the quarantine bin can group by them.
 */

import type { Vessel } from '@/types/domain';
import { isPlottablePosition } from './aisstream';

/** Nhava Sheva area-of-interest bounding box [[swLat,swLon],[neLat,neLon]]. */
export const AOI_BBOX: number[][] = [
  [18.6, 72.6],
  [19.3, 73.3],
];

/** Max plausible implied speed between two fixes (knots). Above → teleport. */
export const TELEPORT_MAX_KN = 50;
/** A track with no update for longer than this (minutes) is stale. */
export const STALE_AFTER_MIN = 10;
/** Max plausible SOG (knots); above is an absurd/garbage value. */
export const MAX_SOG_KN = 60;
/** Vessel names longer than this are truncated (AIS max is 20; be generous). */
export const MAX_NAME_LEN = 64;

/** Stable quarantine reason codes (grouped on the Connector Readiness page). */
export type DqReasonCode =
  | 'NO_MMSI'
  | 'BAD_POSITION' // null-island / out-of-range / non-finite
  | 'OUT_OF_AOI'
  | 'ABSURD_SOG'
  | 'NEGATIVE_SOG'
  | 'HEADING_COG_CONFLICT'
  | 'NAME_TRUNCATED'
  | 'TELEPORT'
  | 'TIMESTAMP_REGRESSION'
  | 'DUPLICATE';

export type DqSeverity = 'FATAL' | 'WARN';

export interface DqReason {
  code: DqReasonCode;
  severity: DqSeverity;
  detail: string;
}

export interface DqOutcome {
  /** The (possibly sanitised) vessel, or null if it was quarantined. */
  vessel: Vessel | null;
  reasons: DqReason[];
}

function inAoi(lat: number, lon: number, bbox = AOI_BBOX): boolean {
  const [[swLat, swLon], [neLat, neLon]] = bbox;
  return lat >= swLat && lat <= neLat && lon >= swLon && lon <= neLon;
}

/** Great-circle distance between two lat/lon points, nautical miles. */
export function haversineNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R_NM = 3440.065;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Stateless validation + sanitisation. Never throws. A FATAL reason means the
 * caller should quarantine (drop) the record; WARN reasons mean "keep, but flag".
 * `bbox` defaults to the JNPA AoI but is injectable (e.g. for a live coverage
 * region that is elsewhere on the globe).
 */
export function validateVessel(v: Vessel, bbox = AOI_BBOX): DqOutcome {
  const reasons: DqReason[] = [];

  if (!v.MMSI || v.MMSI.trim() === '') {
    reasons.push({ code: 'NO_MMSI', severity: 'FATAL', detail: 'missing MMSI' });
    return { vessel: null, reasons };
  }

  if (!isPlottablePosition(v.LAT, v.LON)) {
    reasons.push({
      code: 'BAD_POSITION',
      severity: 'FATAL',
      detail: `unplottable (${v.LAT}, ${v.LON})`,
    });
    return { vessel: null, reasons };
  }

  if (!inAoi(v.LAT, v.LON, bbox)) {
    // Outside the area of interest (on land / far offshore): drop from the twin
    // — a JNPA contact off Africa is noise, not data.
    reasons.push({
      code: 'OUT_OF_AOI',
      severity: 'FATAL',
      detail: `outside AoI (${v.LAT.toFixed(3)}, ${v.LON.toFixed(3)})`,
    });
    return { vessel: null, reasons };
  }

  // From here on, failures are WARN — we keep the contact but sanitise/flag.
  const clean: Vessel = { ...v };

  if (typeof clean.SOG !== 'number' || !Number.isFinite(clean.SOG)) {
    clean.SOG = 0;
    reasons.push({ code: 'NEGATIVE_SOG', severity: 'WARN', detail: 'non-finite SOG → 0' });
  } else if (clean.SOG < 0) {
    reasons.push({ code: 'NEGATIVE_SOG', severity: 'WARN', detail: `SOG ${clean.SOG} < 0 → 0` });
    clean.SOG = 0;
  } else if (clean.SOG > MAX_SOG_KN) {
    reasons.push({
      code: 'ABSURD_SOG',
      severity: 'WARN',
      detail: `SOG ${clean.SOG} kn implausible → clamped ${MAX_SOG_KN}`,
    });
    clean.SOG = MAX_SOG_KN;
  }

  // Heading vs COG contradiction while making way (>2 kn): flag, don't alter.
  if (
    clean.SOG > 2 &&
    Number.isFinite(clean.HEADING) &&
    Number.isFinite(clean.COG) &&
    angularDelta(clean.HEADING, clean.COG) > 90
  ) {
    reasons.push({
      code: 'HEADING_COG_CONFLICT',
      severity: 'WARN',
      detail: `heading ${clean.HEADING}° vs COG ${clean.COG}° differ >90° while making way`,
    });
  }

  if (typeof clean.VESSEL_NAME === 'string' && clean.VESSEL_NAME.length > MAX_NAME_LEN) {
    clean.VESSEL_NAME = clean.VESSEL_NAME.slice(0, MAX_NAME_LEN);
    reasons.push({
      code: 'NAME_TRUNCATED',
      severity: 'WARN',
      detail: `name > ${MAX_NAME_LEN} chars truncated`,
    });
  }

  return { vessel: clean, reasons };
}

/** Smallest absolute angular difference between two bearings, degrees (0–180). */
export function angularDelta(a: number, b: number): number {
  const d = Math.abs(((a - b) % 360) + 360) % 360;
  return d > 180 ? 360 - d : d;
}

interface TrackState {
  lat: number;
  lon: number;
  ts: number;
  /** Which source last provided this MMSI (for cross-source dedup). */
  source: string;
}

/**
 * Stateful, per-MMSI track guard. Detects teleports (implied speed above
 * `TELEPORT_MAX_KN` → the fix is rejected and the last good position kept),
 * timestamp regression on reconnect (an older fix than we already have → drop),
 * and cross-source duplicates (same MMSI arriving from a different source within
 * a short window → drop the newcomer, keep the incumbent). Also answers
 * `staleTracks(now)` for staleness watermarking.
 *
 * All time is passed in; nothing here reads the wall clock.
 */
export class TrackQuality {
  private tracks = new Map<string, TrackState>();

  /** Reset all history (e.g. on a deterministic-seed rehearsal restart). */
  reset(): void {
    this.tracks.clear();
  }

  /**
   * Vet a positionally-valid vessel against its own history.
   * @param v      a vessel that has already passed `validateVessel`
   * @param source the connector id that produced it (for dedup)
   * @param now    current sim/wall time, epoch ms
   */
  vet(v: Vessel, source: string, now: number): DqOutcome {
    const reasons: DqReason[] = [];
    const prev = this.tracks.get(v.MMSI);
    const ts = Number.isFinite(v.TIMESTAMP) ? v.TIMESTAMP : now;

    if (prev) {
      // Timestamp regression: a fix older than the one we hold (feed replayed
      // stale data after reconnect). Event-time guard.
      if (ts < prev.ts) {
        reasons.push({
          code: 'TIMESTAMP_REGRESSION',
          severity: 'FATAL',
          detail: `fix ts ${ts} older than held ${prev.ts}`,
        });
        return { vessel: null, reasons };
      }

      // Cross-source duplicate: same MMSI, different source, within 60s of the
      // incumbent → keep incumbent, drop the duplicate.
      if (source !== prev.source && ts - prev.ts < 60_000) {
        reasons.push({
          code: 'DUPLICATE',
          severity: 'FATAL',
          detail: `duplicate MMSI from '${source}' (held from '${prev.source}')`,
        });
        return { vessel: null, reasons };
      }

      // Teleport: implied speed between fixes exceeds the plausible max.
      const dtH = (ts - prev.ts) / 3_600_000;
      if (dtH > 0) {
        const distNm = haversineNm(prev.lat, prev.lon, v.LAT, v.LON);
        const impliedKn = distNm / dtH;
        if (impliedKn > TELEPORT_MAX_KN) {
          reasons.push({
            code: 'TELEPORT',
            severity: 'FATAL',
            detail: `implied ${impliedKn.toFixed(0)} kn > ${TELEPORT_MAX_KN}; kept last good`,
          });
          // Do NOT advance the track; keep the last good position.
          return { vessel: null, reasons };
        }
      }
    }

    this.tracks.set(v.MMSI, { lat: v.LAT, lon: v.LON, ts, source });
    return { vessel: v, reasons };
  }

  /** MMSIs whose last fix is older than `STALE_AFTER_MIN` at `now`. */
  staleTracks(now: number): string[] {
    const cutoff = now - STALE_AFTER_MIN * 60_000;
    const out: string[] = [];
    for (const [mmsi, t] of this.tracks) if (t.ts < cutoff) out.push(mmsi);
    return out;
  }

  /** Age of a track in minutes at `now`, or null if unknown. */
  ageMin(mmsi: string, now: number): number | null {
    const t = this.tracks.get(mmsi);
    return t ? (now - t.ts) / 60_000 : null;
  }

  size(): number {
    return this.tracks.size;
  }
}
