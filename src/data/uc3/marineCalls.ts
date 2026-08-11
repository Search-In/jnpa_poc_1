/**
 * UC-3 Marine vessel-CALL connector — the port-visit spine for UC-1.
 *
 * Reads `/api/marine/calls*` (RBAC: control room + customs) and maps the
 * gateway's wire rows onto the UC-1 domain types. Structured like
 * shippingLines.ts: endpoint constants, typed *wire* interfaces kept separate
 * from the domain types, exported PURE mappers, and the I/O functions last — so
 * every mapping is unit-testable with no network and no fetch stub.
 *
 * Backing store: `core.vessel_call` + `core.vessel_call_event`, populated by the
 * Marine CSV Data-Upload (and, later, the NLP-Marine PCS parsers). Facts the
 * mapping has to absorb:
 *
 *  • **This is NOT the AIS/simulated vessel feed.** `Vessel` (telemetry, keyed on
 *    MMSI) drives the 3D scene and the simulator and is untouched by this module.
 *    A `VesselCall` is scheduling/actuals data keyed on VCN/IMO, with no position.
 *    The two cannot be joined today — no source carries both MMSI and VCN.
 *
 *  • **`vcn` may be absent.** A call seeded before berth application (CALINF) has
 *    no VCN yet; it is assigned later (BERMAN) and the row is enriched in place.
 *    So `vcn` is '' rather than null, and callers must not treat it as a key.
 *
 *  • **`via_no` recycles across years** and is deliberately NOT unique — a VIA
 *    lookup can legitimately return several calls.
 *
 *  • **`terminal_id` / `berth_id` are null today.** The reference dimensions exist
 *    but the CSV upload path does not populate them yet, so the UI must render a
 *    placeholder rather than assume a terminal is always known.
 */

import type { VesselCall, VesselCallEvent, CallLifecycle, MarineCallStats } from '@/types/domain';
import { http } from './client';
// Reused rather than duplicated: the same ISO→epoch fallback-to-0 posture the
// shipping-line connector uses, so both UC-3 connectors treat time identically.
import { toEpochMs } from './shippingLines';

/** Endpoint suffixes, relative to `env.uc3.apiBase`. */
export const MARINE_CALLS_PATH = '/marine/calls';
export const MARINE_CALLS_STATS_PATH = '/marine/calls/stats';

/** The gateway caps `limit` at 500; 100 is a sane page for a table view. */
export const MARINE_CALLS_PAGE_LIMIT = 100;

/** One call row exactly as the gateway returns it. Snake_case: this is the wire shape. */
export interface VesselCallWire {
  call_id: number | null;
  vcn: string | null;
  via_no: string | null;
  imo_no: string | null;
  vessel_name: string | null;
  voyage_no: string | null;
  rotation_no: string | null;
  terminal_id: number | null;
  /** Read-only label for `terminal_id` (core.ref_terminal.code, e.g. 'BMCT'). */
  terminal_code?: string | null;
  /** Read-only label for `berth_id` (core.ref_berth.code, e.g. 'CB05'). */
  berth_code?: string | null;
  berth_id: number | null;
  purpose: string | null;
  status: string | null;
  igm_no: number | null;
  source_note: string | null;
  /** ISO-8601 with offset, or null. */
  eta: string | null;
  etb: string | null;
  etd: string | null;
  ata: string | null;
  atc: string | null;
  atd: string | null;
  created_at: string | null;
  updated_at: string | null;
  /**
   * ADDITIVE and optional — the derived operational state, returned by the LIST
   * endpoint beside the stored parser `status`. Absent on a gateway predating it.
   */
  lifecycle?: CallLifecycleWire | null;
}

/** One call actual exactly as the gateway returns it. */
export interface VesselCallEventWire {
  event_id: number | null;
  call_id: number | null;
  event_type: string | null;
  event_ts: string | null;
  berth_id: number | null;
  /** Read-only label for `berth_id` on a milestone that names a berth. */
  berth_code?: string | null;
  source_file: number | null;
  created_at: string | null;
}

/** The gateway's standard paged envelope for the call list. */
export interface VesselCallsPage {
  items: VesselCallWire[];
  total: number;
  limit: number;
  offset: number;
  count: number;
}

/** Business state the gateway derives from this same call + its events. */
export interface CallLifecycleWire {
  status: string | null;
  arrival_state: string | null;
  berth_state: string | null;
  pilot_state: string | null;
  departure_state: string | null;
  shipping_state: string | null;
  portcraft_state: string | null;
  /** ADDITIVE — absent on a gateway predating the craft lifecycle. */
  craft_state?: string | null;
  craft_committed?: number | null;
  is_in_port: boolean | null;
  is_at_berth: boolean | null;
  latest_event: string | null;
  latest_event_time: string | null;
}

/** `GET /marine/calls/{id}/timeline` — one call, its ordered actuals, and its lifecycle. */
export interface VesselCallTimelineWire extends VesselCallWire {
  events: VesselCallEventWire[];
  /** Optional: absent on a gateway predating the additive `lifecycle` field. */
  lifecycle?: CallLifecycleWire | null;
}

/** `GET /marine/calls/stats` wire shape. */
export interface MarineStatsWire {
  total: number | null;
  with_vcn: number | null;
  without_vcn: number | null;
  arrived: number | null;
  in_port: number | null;
  ops_completed: number | null;
  departed: number | null;
  terminals: number | null;
  avg_turnaround_hours: number | null;
  avg_pre_berth_delay_hours: number | null;
  by_status: { status: string | null; count: number | null }[] | null;
  by_terminal: { terminal_id: number | null; count: number | null; in_port: number | null }[] | null;
}

/** Server-side filters accepted by `GET /marine/calls`. All optional. */
export interface VesselCallFilters {
  /** Exact full PCS VCN. */
  vcn?: string;
  /** Short VIA — substring match. */
  via?: string;
  /** Exact IMO number. */
  imoNo?: string;
  /** Vessel name — substring match. */
  vessel?: string;
  voyage?: string;
  rotation?: string;
  terminalId?: number;
  berthId?: number;
  status?: string;
  /** true = VCN assigned, false = still pre-VCN. Omit for no filter. */
  hasVcn?: boolean;
  /** Arrived but not yet sailed. */
  inPort?: boolean;
  /** ETA window, ISO-8601. */
  from?: string;
  to?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
}

/** Trim a nullable wire string to '' — the domain types never carry null text. */
function str(v: string | null | undefined): string {
  return (v ?? '').trim();
}

/** Coerce a nullable wire number to a finite number, defaulting to 0. */
function num(v: number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Nullable FK/measure: preserved as null (absent ≠ zero for a terminal id). */
function nullableNum(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Map one wire call onto the domain type. Pure.
 *
 * Returns null for a row with no `call_id` — the surrogate key the UI keys on —
 * rather than surfacing an unaddressable entry. (Same drop-the-unusable-record
 * posture as `mapShippingLine`.)
 */
export function mapVesselCall(w: VesselCallWire): VesselCall | null {
  const callId = nullableNum(w?.call_id);
  if (callId === null) return null;
  return {
    callId,
    vcn: str(w.vcn),
    viaNo: str(w.via_no),
    imoNo: str(w.imo_no),
    vesselName: str(w.vessel_name),
    voyageNo: str(w.voyage_no),
    rotationNo: str(w.rotation_no),
    terminalId: nullableNum(w.terminal_id),
    terminalCode: str(w.terminal_code),
    berthId: nullableNum(w.berth_id),
    berthCode: str(w.berth_code),
    purpose: str(w.purpose),
    status: str(w.status),
    igmNo: nullableNum(w.igm_no),
    sourceNote: str(w.source_note),
    eta: toEpochMs(w.eta),
    etb: toEpochMs(w.etb),
    etd: toEpochMs(w.etd),
    ata: toEpochMs(w.ata),
    atc: toEpochMs(w.atc),
    atd: toEpochMs(w.atd),
    createdAt: toEpochMs(w.created_at),
    updatedAt: toEpochMs(w.updated_at),
    // Same mapper the timeline uses — one definition, no second interpretation.
    lifecycle: mapCallLifecycle(w.lifecycle),
  };
}

/**
 * Map one wire actual onto the domain type. Pure.
 * Drops a row with no `event_id`.
 */
export function mapVesselCallEvent(w: VesselCallEventWire): VesselCallEvent | null {
  const eventId = nullableNum(w?.event_id);
  if (eventId === null) return null;
  return {
    eventId,
    callId: num(w.call_id),
    eventType: str(w.event_type),
    eventTs: toEpochMs(w.event_ts),
    berthId: nullableNum(w.berth_id),
    berthCode: str(w.berth_code),
    sourceFile: nullableNum(w.source_file),
    createdAt: toEpochMs(w.created_at),
  };
}

/**
 * Map a whole call page, dropping unusable rows and preserving the server's
 * ordering. Pure and tolerant: a malformed or empty payload yields [].
 */
export function parseVesselCallsPage(raw: unknown): VesselCall[] {
  const items = (raw as VesselCallsPage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(mapVesselCall).filter((c): c is VesselCall => c !== null);
}

/**
 * Map the derived lifecycle. Pure and tolerant: a gateway that does not send the field
 * yields null, which callers render as "no lifecycle" rather than as empty strings.
 */
export function mapCallLifecycle(w: CallLifecycleWire | null | undefined): CallLifecycle | null {
  if (!w) return null;
  return {
    status: str(w.status),
    arrivalState: str(w.arrival_state),
    berthState: str(w.berth_state),
    pilotState: str(w.pilot_state),
    departureState: str(w.departure_state),
    shippingState: str(w.shipping_state),
    portcraftState: str(w.portcraft_state),
    craftState: str(w.craft_state) || 'Idle',
    craftCommitted: typeof w.craft_committed === 'number' ? w.craft_committed : 0,
    isInPort: Boolean(w.is_in_port),
    isAtBerth: Boolean(w.is_at_berth),
    latestEvent: str(w.latest_event),
  };
}

/**
 * Map the timeline envelope. Pure. Events are re-sorted by timestamp defensively:
 * the backend already orders them, but repeated event types are permitted, so a
 * stable chronological order is the only sound contract for the UI.
 *
 * The lifecycle rides along in this SAME payload — the detail pane needs no second call.
 */
export function parseVesselCallTimeline(
  raw: unknown,
): { call: VesselCall | null; events: VesselCallEvent[]; lifecycle: CallLifecycle | null } {
  const wire = raw as VesselCallTimelineWire | null;
  if (!wire) return { call: null, events: [], lifecycle: null };
  const call = mapVesselCall(wire);
  const events = Array.isArray(wire.events)
    ? wire.events
        .map(mapVesselCallEvent)
        .filter((e): e is VesselCallEvent => e !== null)
        .sort((a, b) => a.eventTs - b.eventTs || a.eventId - b.eventId)
    : [];
  return { call, events, lifecycle: mapCallLifecycle(wire.lifecycle) };
}

/** Map the stats envelope. Pure and tolerant — a missing payload yields zeroes. */
export function parseMarineStats(raw: unknown): MarineCallStats {
  const w = (raw ?? {}) as MarineStatsWire;
  return {
    total: num(w.total),
    withVcn: num(w.with_vcn),
    withoutVcn: num(w.without_vcn),
    arrived: num(w.arrived),
    inPort: num(w.in_port),
    opsCompleted: num(w.ops_completed),
    departed: num(w.departed),
    terminals: num(w.terminals),
    // Averages stay nullable: "no completed call yet" is not "zero hours".
    avgTurnaroundHours: nullableNum(w.avg_turnaround_hours),
    avgPreBerthDelayHours: nullableNum(w.avg_pre_berth_delay_hours),
    byStatus: Array.isArray(w.by_status)
      ? w.by_status.map((s) => ({ status: str(s?.status), count: num(s?.count) }))
      : [],
    byTerminal: Array.isArray(w.by_terminal)
      ? w.by_terminal.map((t) => ({
          terminalId: nullableNum(t?.terminal_id),
          count: num(t?.count),
          inPort: num(t?.in_port),
        }))
      : [],
  };
}

/**
 * Build the query string for one page of calls. Pure.
 *
 * Only defined filters are emitted, so an empty filter object yields just the
 * page window. Booleans are sent explicitly ('true'/'false') because `hasVcn`
 * is TRI-state on the backend — omitted means "no filter", which is different
 * from `false` ("still pre-VCN").
 */
export function marineCallsQuery(
  filters: VesselCallFilters = {},
  limit = MARINE_CALLS_PAGE_LIMIT,
  offset = 0,
): string {
  const q = new URLSearchParams();
  const put = (k: string, v: string | number | undefined) => {
    if (v !== undefined && v !== null && `${v}` !== '') q.set(k, `${v}`);
  };
  put('vcn', filters.vcn);
  put('via', filters.via);
  put('imo_no', filters.imoNo);
  put('vessel', filters.vessel);
  put('voyage', filters.voyage);
  put('rotation', filters.rotation);
  put('terminal_id', filters.terminalId);
  put('berth_id', filters.berthId);
  put('status', filters.status);
  if (filters.hasVcn !== undefined) q.set('has_vcn', String(filters.hasVcn));
  if (filters.inPort) q.set('in_port', 'true');
  put('from', filters.from);
  put('to', filters.to);
  put('sort', filters.sort);
  put('direction', filters.direction);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${MARINE_CALLS_PATH}?${q.toString()}`;
}

/** Build the stats query string. Pure. Reuses the same filter vocabulary. */
export function marineStatsQuery(filters: VesselCallFilters = {}): string {
  const q = new URLSearchParams();
  if (filters.terminalId !== undefined) q.set('terminal_id', String(filters.terminalId));
  if (filters.status) q.set('status', filters.status);
  if (filters.hasVcn !== undefined) q.set('has_vcn', String(filters.hasVcn));
  if (filters.inPort) q.set('in_port', 'true');
  if (filters.from) q.set('from', filters.from);
  if (filters.to) q.set('to', filters.to);
  const qs = q.toString();
  return qs ? `${MARINE_CALLS_STATS_PATH}?${qs}` : MARINE_CALLS_STATS_PATH;
}

/**
 * Fetch one page of vessel calls from the UC-3 backend.
 * Rejects (never throws synchronously) so a caller can surface the error state.
 */
export async function fetchVesselCalls(
  filters: VesselCallFilters = {},
  limit = MARINE_CALLS_PAGE_LIMIT,
  offset = 0,
): Promise<VesselCall[]> {
  const page = await http<VesselCallsPage>(marineCallsQuery(filters, limit, offset));
  return parseVesselCallsPage(page);
}

/**
 * Fetch one page WITH its envelope, for a paginated table that needs `total`.
 * The items are mapped; the window fields are passed through.
 */
export async function fetchVesselCallsPage(
  filters: VesselCallFilters = {},
  limit = MARINE_CALLS_PAGE_LIMIT,
  offset = 0,
): Promise<{ items: VesselCall[]; total: number; limit: number; offset: number }> {
  const page = await http<VesselCallsPage>(marineCallsQuery(filters, limit, offset));
  return {
    items: parseVesselCallsPage(page),
    total: num(page?.total),
    limit: num(page?.limit) || limit,
    offset: num(page?.offset),
  };
}

/** Fetch the UC-1 vessel-call KPI aggregates. */
export async function fetchMarineStats(
  filters: VesselCallFilters = {},
): Promise<MarineCallStats> {
  return parseMarineStats(await http<MarineStatsWire>(marineStatsQuery(filters)));
}

/** Fetch one call by its surrogate id. Returns null when the row is unusable. */
export async function fetchVesselCall(callId: number): Promise<VesselCall | null> {
  return mapVesselCall(await http<VesselCallWire>(`${MARINE_CALLS_PATH}/${callId}`));
}

/** Fetch one call plus its chronologically ordered actuals. */
export async function fetchVesselCallTimeline(
  callId: number,
): Promise<{ call: VesselCall | null; events: VesselCallEvent[]; lifecycle: CallLifecycle | null }> {
  return parseVesselCallTimeline(
    await http<VesselCallTimelineWire>(`${MARINE_CALLS_PATH}/${callId}/timeline`),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-identifier search
//
// Most calls in the corpus carry NO vessel name (the CALINF that seeds a row
// often has only the VIA), so a name-only search box finds nothing for them.
// Operators work off a manifest and type whatever identifier it shows — VCN,
// VIA or voyage.
//
// The gateway cannot answer that in one request: `_where()` (marine/repository.py)
// AND-s every filter it is given, so `?vessel=X&via=X` means "name contains X AND
// VIA contains X", which is the opposite of what a single box means. There is no
// OR/`q` parameter. So the OR is assembled here, client-side, by asking the
// gateway the same question once per field and merging the answers.
//
// Consequences, all deliberate:
//  • Only while a term is typed. An empty box takes the original single-request
//    server-paginated path untouched.
//  • Paging and sorting of a RESULT SET are client-side, over at most
//    SEARCH_FETCH_LIMIT rows per field. `truncated` says when that cap was hit,
//    so the count is never silently short (same posture as PilotageTable).
//  • `vcn` is an EQUALITY filter on the backend (`_EQ_FILTERS`), not ILIKE, so it
//    only fires on a full pasted VCN. A partial VCN still matches via its VIA
//    tail — 'INNSA1NS0S0814' is found by 'S0814' through the `via` request —
//    but a VCN *prefix* ('INNSA1') is not searchable without a gateway change.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The filter keys the search term is fanned out over, in the order their hits are
 * merged. `vessel`, `via` and `voyage` are backend ILIKE substring filters;
 * `vcn` is exact — see the note above.
 */
export const CALL_SEARCH_FIELDS = ['vessel', 'vcn', 'via', 'voyage'] as const;

/** Per-field ceiling for a search fan-out. The gateway caps `limit` at 500. */
export const SEARCH_FETCH_LIMIT = 500;

/** Comparators for the backend `sort` keys, so a merged set orders as the server would. */
const SORT_ACCESSORS: Record<string, (c: VesselCall) => number | string> = {
  eta: (c) => c.eta,
  etb: (c) => c.etb,
  etd: (c) => c.etd,
  ata: (c) => c.ata,
  atc: (c) => c.atc,
  atd: (c) => c.atd,
  updated_at: (c) => c.updatedAt,
  call_id: (c) => c.callId,
  terminal_id: (c) => c.terminalId ?? 0,
  vessel_name: (c) => c.vesselName,
  vcn: (c) => c.vcn,
  via_no: (c) => c.viaNo,
  status: (c) => c.status,
};

/**
 * Order a merged result set the way `ORDER BY <col> <dir> NULLS LAST, call_id DESC`
 * would. Pure.
 *
 * The NULLS-LAST parity matters: the domain mapper turns an unknown timestamp into
 * 0 and an unresolved name into '', which would otherwise sort to the TOP of an
 * ascending page and put every unparsed row in front of the operator.
 */
export function sortVesselCalls(
  calls: VesselCall[],
  sort = 'updated_at',
  direction: 'asc' | 'desc' = 'desc',
): VesselCall[] {
  const get = SORT_ACCESSORS[sort] ?? SORT_ACCESSORS.updated_at;
  const dir = direction === 'asc' ? 1 : -1;
  return [...calls].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    // Empty/0 is the mapper's "unknown" — always last, whichever way the column runs.
    const xEmpty = x === 0 || x === '';
    const yEmpty = y === 0 || y === '';
    if (xEmpty !== yEmpty) return xEmpty ? 1 : -1;
    if (!xEmpty) {
      const cmp = typeof x === 'string' ? x.localeCompare(String(y)) : Number(x) - Number(y);
      if (cmp !== 0) return cmp * dir;
    }
    return b.callId - a.callId;
  });
}

/**
 * Union of several fetched pages, keyed on `callId`. Pure.
 *
 * A row legitimately appears in more than one response — a search for 'S0814'
 * matches both the VIA and the VCN that embeds it — so the merge dedupes rather
 * than double-counting, which would corrupt the row count under the table.
 */
export function mergeVesselCalls(pages: readonly VesselCall[][]): VesselCall[] {
  const byId = new Map<number, VesselCall>();
  for (const page of pages) {
    for (const call of page) {
      if (!byId.has(call.callId)) byId.set(call.callId, call);
    }
  }
  return [...byId.values()];
}

/**
 * One page of calls matching `term` in ANY of `CALL_SEARCH_FIELDS`, with the rest
 * of `filters` (in-port, status, …) still AND-ed as the caller intended.
 *
 * A field whose request fails is dropped rather than failing the whole search: a
 * partial result with `truncated` set beats an error panel when three of four
 * identifiers answered. If EVERY request fails the rejection is propagated, so a
 * dead gateway still surfaces as an error and not as "no matches".
 */
export async function searchVesselCallsPage(
  term: string,
  filters: VesselCallFilters = {},
  limit = MARINE_CALLS_PAGE_LIMIT,
  offset = 0,
): Promise<{
  items: VesselCall[];
  total: number;
  limit: number;
  offset: number;
  truncated: boolean;
}> {
  const needle = term.trim();
  const settled = await Promise.allSettled(
    CALL_SEARCH_FIELDS.map((field) =>
      fetchVesselCallsPage(
        // The caller's own filters minus every identifier field, so the term owns
        // them outright and a stale `vessel` cannot AND the fan-out down to zero.
        { ...filters, vessel: undefined, vcn: undefined, via: undefined, voyage: undefined,
          [field]: needle },
        SEARCH_FETCH_LIMIT,
        0,
      ),
    ),
  );

  const ok = settled.filter((r) => r.status === 'fulfilled');
  if (ok.length === 0) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
  const pages = ok.map((r) => (r as PromiseFulfilledResult<{ items: VesselCall[] }>).value);

  const merged = mergeVesselCalls(pages.map((p) => p.items));
  const sorted = sortVesselCalls(merged, filters.sort, filters.direction);
  return {
    items: sorted.slice(offset, offset + limit),
    total: sorted.length,
    limit,
    offset,
    // A field that returned exactly its cap has more rows the merge never saw, so
    // the total below the table is a floor, not the count. Also true when a field
    // errored out — that identifier contributed nothing.
    truncated:
      ok.length < CALL_SEARCH_FIELDS.length ||
      pages.some((p) => p.items.length >= SEARCH_FETCH_LIMIT),
  };
}
