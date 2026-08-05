/**
 * UC-3 Berthing ↔ PCS lifecycle reconciliation connector.
 *
 * Reads `/api/marine/state/berthing`, which returns each berthing-report row with the PCS
 * call lifecycle state ALONGSIDE its own `report_status` — never merged. The two are
 * independent sources for the same physical call (terminal PDFs vs the PCS message
 * stream), joined on the VIA that both carry.
 *
 * Deliberately a SEPARATE file from berthing.ts: the existing berthing connector, its wire
 * types and `/api/berthing` calls are untouched, so a failure here degrades to "no
 * lifecycle column" rather than breaking the reports table.
 *
 * All lifecycle values are produced by the backend State Engine. This module derives
 * nothing — it maps wire → domain and nothing else.
 */

import { http } from './client';

/** Engine-derived state for the call a berthing report resolved to. */
export interface BerthingLifecycleWire {
  call_id: number | null;
  vcn: string | null;
  via_no: string | null;
  status: string | null;
  arrival_state: string | null;
  berth_state: string | null;
  pilot_state: string | null;
  departure_state: string | null;
  shipping_state: string | null;
  portcraft_state: string | null;
  is_in_port: boolean | null;
  is_at_berth: boolean | null;
  latest_event: string | null;
  latest_event_time: string | null;
}

export interface BerthingReconciledWire {
  record_id: number | null;
  terminal: string | null;
  vessel_name: string | null;
  voyage_number: string | null;
  berth_number: string | null;
  report_status: string | null;
  /** null when the VIA resolved to no call — a real finding, not an error. */
  lifecycle: BerthingLifecycleWire | null;
}

export interface BerthingReconciledPageWire {
  items: BerthingReconciledWire[];
  count: number;
  matched: number;
  unmatched: number;
  limit: number;
  offset: number;
}

/** One report's lifecycle, flattened for the table. */
export interface BerthingLifecycle {
  recordId: number;
  callId: number | null;
  vcn: string;
  /** Engine status, e.g. 'Berth Allotted' | 'At Berth' | 'Departed'. '' when unmatched. */
  status: string;
  /** Pending | Allotted | Occupied | Released. '' when unmatched. */
  berthState: string;
  latestEvent: string;
  isAtBerth: boolean;
}

export const BERTHING_STATE_PATH = '/marine/state/berthing';
export const BERTHING_STATE_LIMIT = 500;

function str(v: string | null | undefined): string {
  return (v ?? '').trim();
}

/** Map one wire row. Pure. Returns null for a row with no usable record id. */
export function mapBerthingLifecycle(w: BerthingReconciledWire): BerthingLifecycle | null {
  const recordId = Number(w?.record_id);
  if (!Number.isFinite(recordId)) return null;
  const lc = w.lifecycle;
  return {
    recordId,
    callId: lc && Number.isFinite(Number(lc.call_id)) ? Number(lc.call_id) : null,
    vcn: str(lc?.vcn),
    status: str(lc?.status),
    berthState: str(lc?.berth_state),
    latestEvent: str(lc?.latest_event),
    isAtBerth: Boolean(lc?.is_at_berth),
  };
}

/**
 * Fetch the reconciliation as a map keyed by berthing-record id, so the reports table can
 * enrich rows it already has without a second render pass. Pure mapping, tolerant of a
 * malformed payload.
 */
export function parseBerthingLifecycleMap(raw: unknown): Map<number, BerthingLifecycle> {
  const items = (raw as BerthingReconciledPageWire | null)?.items;
  const out = new Map<number, BerthingLifecycle>();
  if (!Array.isArray(items)) return out;
  for (const w of items) {
    const m = mapBerthingLifecycle(w);
    if (m) out.set(m.recordId, m);
  }
  return out;
}

/** Build the query string. Pure. */
export function berthingStateQuery(terminal?: string, limit = BERTHING_STATE_LIMIT): string {
  const q = new URLSearchParams();
  if (terminal && terminal.trim()) q.set('terminal', terminal.trim());
  q.set('limit', String(limit));
  q.set('offset', '0');
  return `${BERTHING_STATE_PATH}?${q.toString()}`;
}

/** Fetch the lifecycle map. Rejects on transport error so the caller can degrade. */
export async function fetchBerthingLifecycleMap(
  terminal?: string,
  limit = BERTHING_STATE_LIMIT,
): Promise<Map<number, BerthingLifecycle>> {
  const page = await http<BerthingReconciledPageWire>(berthingStateQuery(terminal, limit));
  return parseBerthingLifecycleMap(page);
}
