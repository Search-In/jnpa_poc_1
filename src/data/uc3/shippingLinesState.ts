/**
 * UC-3 Carrier ↔ vessel-lifecycle connector.
 *
 * Reads `GET /api/marine/state/shipping-lines` — an endpoint that ALREADY EXISTS and is
 * already derived from the shared Marine Projection (MarineStateService.shipping_line_
 * progress). No new API, no backend change, and no lifecycle derivation here.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * It COUNTS. Each visit the gateway returns already carries the engine's verdicts
 * (`is_in_port`, `is_at_berth`, `latest_event`, milestone timestamps); this module groups
 * those visits by carrier and tallies them. Grouping and counting an already-derived
 * boolean is presentation aggregation — it is not a second state engine, and it cannot
 * disagree with the projection because it never re-decides anything.
 *
 * A carrier whose visits resolve to no call gets ZERO counts and empty text, which the
 * table renders as '—' — plus an `unmatchedVisits` tally so the registry can mark the
 * correlation failure the gateway reported. Nothing is estimated, inferred or defaulted.
 */

import { http } from './client';
import { toEpochMs } from './shippingLines';

/** The lifecycle block the gateway nests on a resolved visit. */
export interface SlVisitLifecycleWire {
  call_id: number | null;
  via_no: string | null;
  vessel_name: string | null;
  status: string | null;
  is_in_port: boolean | null;
  is_at_berth: boolean | null;
  arrived_at: string | null;
  berthed_at: string | null;
  departed_at: string | null;
  latest_event: string | null;
}

export interface SlVisitWire {
  shipping_line: string | null;
  vessel_visit: string | null;
  containers: number | null;
  match: string | null;
  lifecycle: SlVisitLifecycleWire | null;
}

export interface SlProgressWire {
  items: SlVisitWire[] | null;
}

/** Per-carrier lifecycle tally. Every field is a count or a copy — never a derivation. */
export interface CarrierLifecycle {
  /** Visits whose vessel_visit resolved to a call. '—' in the UI when 0. */
  activeVessels: number;
  /**
   * Visits the gateway returned with `lifecycle: null` — the vessel_visit resolved to no
   * vessel call. A VERIFIED correlation failure reported by the backend, not an inference
   * from an empty field, and the only thing the registry marks with a warning.
   */
  unmatchedVisits: number;
  /**
   * Of the matched visits, those the gateway reported as `match: 'composite'` — resolved
   * by stripping a vessel-code prefix from vessel_visit rather than matching the VIA
   * outright. A weaker but SUCCESSFUL match, so it is context in the tooltip, never a
   * warning of its own.
   */
  compositeMatches: number;
  /** Of those, the engine's `is_in_port`. */
  inPort: number;
  /** Of those, the engine's `is_at_berth`. */
  atBerth: number;
  /** `latest_event` of this carrier's most recently updated visit. '' when unknown. */
  latestActivity: string;
  /** Newest milestone timestamp across the carrier's visits (epoch ms; 0 = unknown). */
  lastUpdated: number;
}

export const SHIPPING_LINES_STATE_PATH = '/marine/state/shipping-lines';

/** The gateway caps this endpoint's page; 500 is its own ceiling. */
export const SHIPPING_LINES_STATE_LIMIT = 500;

const EMPTY: CarrierLifecycle = {
  activeVessels: 0, unmatchedVisits: 0, compositeMatches: 0,
  inPort: 0, atBerth: 0, latestActivity: '', lastUpdated: 0,
};

/** The newest milestone this visit reached. The wire carries no `latest_event_time`, so
 *  the timestamp is the latest of the milestones it does carry — not a new fact. */
function visitUpdatedAt(lc: SlVisitLifecycleWire): number {
  return Math.max(
    toEpochMs(lc.departed_at),
    toEpochMs(lc.berthed_at),
    toEpochMs(lc.arrived_at),
  );
}

/**
 * Group visits by carrier code and tally them. Pure and tolerant — a malformed payload
 * yields an empty map, so the registry renders exactly as it did before.
 */
export function parseCarrierLifecycleMap(raw: unknown): Map<string, CarrierLifecycle> {
  const items = (raw as SlProgressWire | null)?.items;
  const out = new Map<string, CarrierLifecycle>();
  if (!Array.isArray(items)) return out;

  for (const v of items) {
    const code = (v?.shipping_line ?? '').trim();
    if (!code) continue;
    const lc = v?.lifecycle;
    const prev = out.get(code) ?? { ...EMPTY };

    // An UNRESOLVED visit still counts — as a correlation failure, not as a vessel. It
    // adds nothing to activeVessels/inPort/atBerth, so the lifecycle columns keep showing
    // '—' rather than a misleading 0.
    if (!lc) {
      out.set(code, { ...prev, unmatchedVisits: prev.unmatchedVisits + 1 });
      continue;
    }

    const at = visitUpdatedAt(lc);
    out.set(code, {
      ...prev,
      activeVessels: prev.activeVessels + 1,
      compositeMatches: prev.compositeMatches + (v.match === 'composite' ? 1 : 0),
      inPort: prev.inPort + (lc.is_in_port ? 1 : 0),
      atBerth: prev.atBerth + (lc.is_at_berth ? 1 : 0),
      // The most RECENTLY updated visit speaks for the carrier. Ties keep the first seen,
      // so the result is stable across renders.
      latestActivity: at > prev.lastUpdated ? (lc.latest_event ?? '') : prev.latestActivity,
      lastUpdated: Math.max(prev.lastUpdated, at),
    });
  }
  return out;
}

/**
 * Fetch the per-carrier tally. Resolves to an EMPTY map on any failure — never rejects —
 * so the Carrier Registry keeps rendering its existing columns and the lifecycle ones
 * simply show '—'. A gateway outage must not break the registry.
 */
export async function fetchCarrierLifecycleMap(): Promise<Map<string, CarrierLifecycle>> {
  try {
    const q = new URLSearchParams({ limit: String(SHIPPING_LINES_STATE_LIMIT) });
    return parseCarrierLifecycleMap(
      await http<SlProgressWire>(`${SHIPPING_LINES_STATE_PATH}?${q.toString()}`));
  } catch {
    return new Map();
  }
}
