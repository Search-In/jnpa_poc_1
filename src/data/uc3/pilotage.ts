/**
 * UC-3 Marine pilotage connector — pilot-card movements (INWARD/OUTWARD/SHIFTING).
 *
 * Reads `/api/marine/pilotage*` and maps the gateway's wire rows onto the UC-1 domain
 * type. Structured like marineCalls.ts / shippingLines.ts: endpoint constants, a typed
 * *wire* interface kept separate from the domain type, exported PURE mappers, and the
 * I/O functions last — so the mapping is unit-testable with no network.
 *
 * Backing store: `core.pilotage`, populated by the SHARED marine upload endpoints
 * (`/api/marine/validate|upload`) when a Pilot_card_data.xlsx is uploaded — there is no
 * separate pilotage upload path. Timestamps are epoch ms (0 = unknown), matching every
 * other UC-3 connector.
 */

import type { Pilotage, PilotageLifecycle } from '@/types/domain';
import { http } from './client';
import { toEpochMs } from './shippingLines';

export const PILOTAGE_PATH = '/marine/pilotage';
export const PILOTAGE_STATS_PATH = '/marine/pilotage/stats';
export const PILOTAGE_PAGE_LIMIT = 50;

/** One pilotage row exactly as the gateway returns it. Snake_case wire shape. */
export interface PilotageWire {
  pilotage_id: number | null;
  movement_type: string | null;
  call_id: number | null;
  via_no: string | null;
  imo_no: string | null;
  vessel_name: string | null;
  pilot_code: string | null;
  vessel_condition: string | null;
  from_berth_id: number | null;
  to_berth_id: number | null;
  draft_fwd_m: number | null;
  draft_aft_m: number | null;
  pilot_boarded_at: string | null;
  first_line_at: string | null;
  all_fast_at: string | null;
  pilot_disembarked_at: string | null;
  berth_vacated_at: string | null;
  anchor_down_at: string | null;
  anchor_up_at: string | null;
  submitted_at: string | null;
  extras: Record<string, unknown> | null;
  import_file_id: number | null;
}

export interface PilotagePage {
  items: PilotageWire[];
  total: number;
  limit: number;
  offset: number;
  count: number;
}

/** Server-side filters accepted by `GET /marine/pilotage`. */
export interface PilotageFilters {
  /** INWARD | OUTWARD | SHIFTING */
  movement?: string;
  imoNo?: string;
  pilotCode?: string;
  vessel?: string;
  via?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
}

function str(v: string | null | undefined): string {
  return (v ?? '').trim();
}
function num(v: number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function nullableNum(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Lift the backend's derived workflow block out of the open `extras` jsonb.
 *
 * The gateway nests it under `extras.lifecycle` (services/marine/pilot_status.py::apply)
 * rather than as a first-class column, so `PilotageOut` stays unchanged. This reads that
 * value — it computes nothing. Null when the movement has no linked call, which is a real
 * state (a pilot card imported before its PCS call exists), not an error.
 */
export function mapPilotageLifecycle(
  extras: Record<string, unknown> | null | undefined,
): PilotageLifecycle | null {
  const block = (extras as { lifecycle?: unknown } | null | undefined)?.lifecycle;
  if (!block || typeof block !== 'object') return null;
  const b = block as Record<string, unknown>;
  return {
    pilotStatus: str(b.pilot_status as string | null),
    allFastAt: toEpochMs(b.all_fast_at as string | null),
    pilotBoardedAt: toEpochMs(b.pilot_boarded_at as string | null),
    callId: nullableNum(b.call_id as number | null | undefined),
    callStatus: str(b.call_status as string | null),
  };
}

/**
 * Map one wire row onto the domain type. Pure. Drops a row with no `pilotage_id`
 * (the key the UI addresses rows by) — same posture as mapVesselCall.
 */
export function mapPilotage(w: PilotageWire): Pilotage | null {
  const pilotageId = nullableNum(w?.pilotage_id);
  if (pilotageId === null) return null;
  return {
    pilotageId,
    movementType: str(w.movement_type),
    callId: nullableNum(w.call_id),
    viaNo: str(w.via_no),
    imoNo: str(w.imo_no),
    vesselName: str(w.vessel_name),
    pilotCode: str(w.pilot_code),
    vesselCondition: str(w.vessel_condition),
    fromBerthId: nullableNum(w.from_berth_id),
    toBerthId: nullableNum(w.to_berth_id),
    draftFwdM: nullableNum(w.draft_fwd_m),
    draftAftM: nullableNum(w.draft_aft_m),
    pilotBoardedAt: toEpochMs(w.pilot_boarded_at),
    firstLineAt: toEpochMs(w.first_line_at),
    allFastAt: toEpochMs(w.all_fast_at),
    pilotDisembarkedAt: toEpochMs(w.pilot_disembarked_at),
    berthVacatedAt: toEpochMs(w.berth_vacated_at),
    anchorDownAt: toEpochMs(w.anchor_down_at),
    anchorUpAt: toEpochMs(w.anchor_up_at),
    submittedAt: toEpochMs(w.submitted_at),
    extras: (w.extras && typeof w.extras === 'object') ? w.extras : {},
    importFileId: nullableNum(w.import_file_id),
    lifecycle: mapPilotageLifecycle(w.extras),
  };
}

/** Map a whole page, dropping unusable rows, preserving server order. Pure, tolerant. */
export function parsePilotagePage(raw: unknown): Pilotage[] {
  const items = (raw as PilotagePage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(mapPilotage).filter((p): p is Pilotage => p !== null);
}

/** Build the query string for one page. Pure. */
export function pilotageQuery(
  filters: PilotageFilters = {},
  limit = PILOTAGE_PAGE_LIMIT,
  offset = 0,
): string {
  const q = new URLSearchParams();
  const put = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== null && `${v}`.trim() !== '') q.set(k, `${v}`);
  };
  put('movement', filters.movement);
  put('imo_no', filters.imoNo);
  put('pilot_code', filters.pilotCode);
  put('vessel', filters.vessel);
  put('via', filters.via);
  put('sort', filters.sort);
  put('direction', filters.direction);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${PILOTAGE_PATH}?${q.toString()}`;
}

/** Fetch one page WITH its envelope, for a paginated table that needs `total`. */
export async function fetchPilotagePage(
  filters: PilotageFilters = {},
  limit = PILOTAGE_PAGE_LIMIT,
  offset = 0,
): Promise<{ items: Pilotage[]; total: number; limit: number; offset: number }> {
  const page = await http<PilotagePage>(pilotageQuery(filters, limit, offset));
  return {
    items: parsePilotagePage(page),
    total: num(page?.total),
    limit: num(page?.limit) || limit,
    offset: num(page?.offset),
  };
}

/** Fetch one movement by id. Null when unusable. */
export async function fetchPilotage(pilotageId: number): Promise<Pilotage | null> {
  return mapPilotage(await http<PilotageWire>(`${PILOTAGE_PATH}/${pilotageId}`));
}
