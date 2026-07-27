/**
 * UC-3 Shipping Lines — cargo DOCUMENT connectors: IAL/EAL advance-list container
 * line items, EDO/CODECO delivery orders, and the import ledger (upload history).
 *
 * Sibling of shippingLines.ts, which owns the carrier REGISTRY + summary + upload
 * write. Split by entity, exactly like pilotage.ts / portCraft.ts / seaChannels.ts:
 * endpoint constants, typed *wire* interfaces kept separate from the domain types,
 * exported PURE mappers, I/O last — unit-testable with no network. `toEpochMs` is
 * reused from shippingLines.ts rather than re-implemented.
 *
 * NO new endpoint and NO change to any existing one: every route below already
 * existed on the gateway and is called with its documented parameters.
 *
 * FILTERABILITY — the gateway is authoritative, and it is frozen. What each list
 * can actually resolve SERVER-side (everything else must be refined client-side by
 * the caller, which then has to state the scope it is refining):
 *
 *  • advance lists   `list_type` (IAL|EAL only — 400 otherwise), `terminal`,
 *                    `category`, `freight_kind`, `shipping_line`, `container`
 *                    (EXACT), `bl` (EXACT), `q` (ILIKE over container_no,
 *                    bill_of_lading, shipping_line_code).
 *                    NOT filterable: pod, voyage, vessel_visit, any date.
 *  • delivery orders `container` (EXACT) and `vehicle` (EXACT) — nothing else.
 *                    The projection carries NO bill-of-lading and NO terminal, so
 *                    those cannot be shown OR filtered at all.
 *  • uploads         `list_type`, `status`, `source`.
 *                    NOT filterable: source_file, any date.
 *  • NONE of the three accepts a `sort` param — every list is ORDER BY id DESC.
 */

import type { AdvanceListItem, DeliveryOrder, ShippingUploadFile } from '@/types/domain';
import { http } from './client';
import { toEpochMs } from './shippingLines';

export const ADVANCE_LIST_PATH = '/shipping-lines';
export const DELIVERY_ORDERS_PATH = '/shipping-lines/delivery-orders';
export const SHIPPING_UPLOADS_PATH = '/shipping-lines/uploads';

/** The gateway caps advance lists and delivery orders at 1000 rows per request. */
export const SHIPPING_DOC_PAGE_LIMIT = 1000;
/** The gateway caps the upload ledger at 200. */
export const SHIPPING_UPLOADS_PAGE_LIMIT = 200;

/* ── shared coercion (same posture as the sibling connectors) ─────────────── */

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
function bool(v: boolean | null | undefined): boolean {
  return v === true;
}

/** A mapped window plus the envelope's `total`, so a table can state its scope. */
export interface DocPage<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  /**
   * Rows present in the payload that could not be mapped at all (not objects).
   * Surfaced so a shape mismatch can never masquerade as an empty result set —
   * see the identity note below.
   */
  skipped: number;
}

/**
 * Stable row identity that does NOT depend on the server supplying an `id`.
 *
 * These mappers used to return null whenever `id` was absent, and the page mapper
 * filtered those out — so a payload of thousands of valid rows without that one key
 * rendered as an empty table with "0 of 0" and no error anywhere. Row identity is a
 * RENDERING concern (a React list key); it must never decide whether business data is
 * shown. So: prefer the server's `id`, otherwise fall back to the row's natural
 * business key plus its position, and always keep the row.
 *
 * Returned as a string because the fallback is composite; nothing sorts or looks up
 * by this value.
 */
function rowId(
  id: number | string | null | undefined,
  index: number,
  ...hints: (string | null | undefined)[]
): string {
  if (id !== null && id !== undefined && `${id}`.trim() !== '') return `${id}`;
  const hint = hints.map((h) => (h ?? '').trim()).filter(Boolean).join('|');
  return hint ? `${hint}#${index}` : `row#${index}`;
}

/**
 * Map an envelope, preserving server order. Pure and tolerant.
 *
 * Only a row that is not an object at all is skipped, and the count is reported
 * rather than swallowed. Everything else is mapped and rendered, with missing fields
 * coerced to ''/null/0 by the per-entity mappers.
 */
function docPage<W, T>(raw: unknown, map: (w: W, index: number) => T, limit: number): DocPage<T> {
  const page = raw as { items?: W[]; total?: number; limit?: number; offset?: number } | null;
  const rows = Array.isArray(page?.items) ? (page as { items: W[] }).items : [];
  const items: T[] = [];
  let skipped = 0;
  rows.forEach((w, index) => {
    if (w === null || typeof w !== 'object') {
      skipped += 1;
      return;
    }
    items.push(map(w, index));
  });
  return {
    items,
    total: num(page?.total),
    limit: num(page?.limit) || limit,
    offset: num(page?.offset),
    skipped,
  };
}

/** Append only non-blank values, so an unset filter never reaches the gateway. */
function putAll(q: URLSearchParams, pairs: [string, string | undefined][]): void {
  for (const [k, v] of pairs) {
    if (v !== undefined && v !== null && `${v}`.trim() !== '') q.set(k, `${v}`.trim());
  }
}

/* ── advance lists (IAL / EAL) ────────────────────────────────────────────── */

/** One advance-list row exactly as the gateway returns it. Snake_case wire shape. */
export interface AdvanceListWire {
  id: number | string | null;
  import_file_id: number | null;
  list_type: string | null;
  terminal: string | null;
  container_no: string | null;
  iso_code: string | null;
  container_valid_iso: boolean | null;
  freight_kind: string | null;
  category: string | null;
  gross_weight_kg: number | null;
  weight_source_uom: string | null;
  pol: string | null;
  pod: string | null;
  destination: string | null;
  shipping_line_code: string | null;
  vessel_visit: string | null;
  voyage: string | null;
  bill_of_lading: string | null;
  seal_no: string | null;
  reefer_status: string | null;
  reefer_temp: number | null;
  imdg_code: string | null;
  un_number: string | null;
  departure_mode: string | null;
  nominated_cfs: string | null;
  created_at: string | null;
}

/** Server-side advance-list filters — only what the gateway actually accepts. */
export interface AdvanceListFilters {
  /** 'IAL' | 'EAL'. Anything else is rejected by the gateway with HTTP 400. */
  listType?: string;
  terminal?: string;
  category?: string;
  freightKind?: string;
  shippingLine?: string;
  /** EXACT match, not a substring — use `q` for substring search. */
  container?: string;
  /** EXACT match. */
  bl?: string;
  /** Substring over container_no OR bill_of_lading OR shipping_line_code. */
  q?: string;
}

/** Map one advance-list wire row onto the domain type. Pure. Never drops a row. */
export function mapAdvanceList(w: AdvanceListWire, index = 0): AdvanceListItem {
  return {
    id: rowId(w?.id, index, w?.container_no, w?.bill_of_lading),
    importFileId: nullableNum(w.import_file_id),
    listType: str(w.list_type),
    terminal: str(w.terminal),
    containerNo: str(w.container_no),
    isoCode: str(w.iso_code),
    containerValidIso: bool(w.container_valid_iso),
    freightKind: str(w.freight_kind),
    category: str(w.category),
    grossWeightKg: nullableNum(w.gross_weight_kg),
    weightSourceUom: str(w.weight_source_uom),
    pol: str(w.pol),
    pod: str(w.pod),
    destination: str(w.destination),
    shippingLineCode: str(w.shipping_line_code),
    vesselVisit: str(w.vessel_visit),
    voyage: str(w.voyage),
    billOfLading: str(w.bill_of_lading),
    sealNo: str(w.seal_no),
    reeferStatus: str(w.reefer_status),
    reeferTemp: nullableNum(w.reefer_temp),
    imdgCode: str(w.imdg_code),
    unNumber: str(w.un_number),
    departureMode: str(w.departure_mode),
    nominatedCfs: str(w.nominated_cfs),
    createdAt: toEpochMs(w.created_at),
  };
}

/** Build the advance-list query string. Pure. */
export function advanceListQuery(
  filters: AdvanceListFilters = {},
  limit = SHIPPING_DOC_PAGE_LIMIT,
  offset = 0,
): string {
  const q = new URLSearchParams();
  putAll(q, [
    ['list_type', filters.listType],
    ['terminal', filters.terminal],
    ['category', filters.category],
    ['freight_kind', filters.freightKind],
    ['shipping_line', filters.shippingLine],
    ['container', filters.container],
    ['bl', filters.bl],
    ['q', filters.q],
  ]);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${ADVANCE_LIST_PATH}?${q.toString()}`;
}

/** Map a whole advance-list envelope. Pure and tolerant — malformed payload → []. */
export function parseAdvanceListPage(
  raw: unknown,
  limit = SHIPPING_DOC_PAGE_LIMIT,
): DocPage<AdvanceListItem> {
  return docPage<AdvanceListWire, AdvanceListItem>(raw, mapAdvanceList, limit);
}

/** Fetch one window of advance-list line items. Rejects on transport failure. */
export async function fetchAdvanceListPage(
  filters: AdvanceListFilters = {},
  limit = SHIPPING_DOC_PAGE_LIMIT,
  offset = 0,
): Promise<DocPage<AdvanceListItem>> {
  return parseAdvanceListPage(await http(advanceListQuery(filters, limit, offset)), limit);
}

/* ── delivery orders (EDO / CODECO) ───────────────────────────────────────── */

/**
 * One delivery-order row exactly as the gateway returns it.
 *
 * NOTE the two absences, both structural: the gateway's projection carries NO
 * bill-of-lading and NO terminal. A BL or terminal column/filter on this table is
 * therefore impossible without a backend change, and must not be faked.
 */
export interface DeliveryOrderWire {
  id: number | string | null;
  common_ref_number: string | null;
  container_no: string | null;
  iso_code: string | null;
  container_valid_iso: boolean | null;
  equipment_status: string | null;
  shipping_agent_code: string | null;
  vcn: string | null;
  imo_number: string | null;
  loading_port: string | null;
  dest_port: string | null;
  final_pod: string | null;
  delivery_mode: string | null;
  gate_pass_no: string | null;
  vehicle_no: string | null;
  gate_number: string | null;
  arrival_ts: string | null;
  receipt_date: string | null;
  gate_pass_ts: string | null;
  issued_ts: string | null;
  created_at: string | null;
}

/** Server-side delivery-order filters — the gateway accepts these TWO only. */
export interface DeliveryOrderFilters {
  /** EXACT container number. */
  container?: string;
  /** EXACT vehicle number. */
  vehicle?: string;
}

/** Map one delivery-order wire row. Pure. Never drops a row. */
export function mapDeliveryOrder(w: DeliveryOrderWire, index = 0): DeliveryOrder {
  return {
    id: rowId(w?.id, index, w?.common_ref_number, w?.container_no),
    commonRefNumber: str(w.common_ref_number),
    containerNo: str(w.container_no),
    isoCode: str(w.iso_code),
    containerValidIso: bool(w.container_valid_iso),
    equipmentStatus: str(w.equipment_status),
    shippingAgentCode: str(w.shipping_agent_code),
    vcn: str(w.vcn),
    imoNumber: str(w.imo_number),
    loadingPort: str(w.loading_port),
    destPort: str(w.dest_port),
    finalPod: str(w.final_pod),
    deliveryMode: str(w.delivery_mode),
    gatePassNo: str(w.gate_pass_no),
    vehicleNo: str(w.vehicle_no),
    gateNumber: str(w.gate_number),
    arrivalTs: toEpochMs(w.arrival_ts),
    receiptDate: toEpochMs(w.receipt_date),
    gatePassTs: toEpochMs(w.gate_pass_ts),
    issuedTs: toEpochMs(w.issued_ts),
    createdAt: toEpochMs(w.created_at),
  };
}

/** Build the delivery-order query string. Pure. */
export function deliveryOrderQuery(
  filters: DeliveryOrderFilters = {},
  limit = SHIPPING_DOC_PAGE_LIMIT,
  offset = 0,
): string {
  const q = new URLSearchParams();
  putAll(q, [
    ['container', filters.container],
    ['vehicle', filters.vehicle],
  ]);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${DELIVERY_ORDERS_PATH}?${q.toString()}`;
}

/** Map a whole delivery-order envelope. Pure and tolerant. */
export function parseDeliveryOrderPage(
  raw: unknown,
  limit = SHIPPING_DOC_PAGE_LIMIT,
): DocPage<DeliveryOrder> {
  return docPage<DeliveryOrderWire, DeliveryOrder>(raw, mapDeliveryOrder, limit);
}

/** Fetch one window of EDO / CODECO delivery orders. */
export async function fetchDeliveryOrderPage(
  filters: DeliveryOrderFilters = {},
  limit = SHIPPING_DOC_PAGE_LIMIT,
  offset = 0,
): Promise<DocPage<DeliveryOrder>> {
  return parseDeliveryOrderPage(await http(deliveryOrderQuery(filters, limit, offset)), limit);
}

/* ── import ledger (upload history) ───────────────────────────────────────── */

/** One import-ledger row exactly as the gateway returns it. */
export interface ShippingUploadWire {
  id: number | string | null;
  source_file: string | null;
  list_type: string | null;
  terminal: string | null;
  physical_format: string | null;
  record_count: number | null;
  imported_count: number | null;
  error_count: number | null;
  import_status: string | null;
  error_detail: string | null;
  uploaded_by: string | null;
  source: string | null;
  created_at: string | null;
}

/** Server-side upload-history filters. */
export interface ShippingUploadFilters {
  listType?: string;
  /** 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED_DUPLICATE' | 'PENDING'. */
  status?: string;
  /** 'UPLOAD' (UI) | 'DIRECTORY' (bulk importer). Gateway defaults to 'UPLOAD'. */
  source?: string;
}

/** Map one import-ledger wire row. Pure. Never drops a row. */
export function mapShippingUpload(w: ShippingUploadWire, index = 0): ShippingUploadFile {
  return {
    id: rowId(w?.id, index, w?.source_file),
    sourceFile: str(w.source_file),
    listType: str(w.list_type),
    terminal: str(w.terminal),
    physicalFormat: str(w.physical_format),
    recordCount: num(w.record_count),
    importedCount: num(w.imported_count),
    errorCount: num(w.error_count),
    importStatus: str(w.import_status),
    errorDetail: str(w.error_detail),
    uploadedBy: str(w.uploaded_by),
    source: str(w.source),
    createdAt: toEpochMs(w.created_at),
  };
}

/** Build the upload-history query string. Pure. */
export function shippingUploadsQuery(
  filters: ShippingUploadFilters = {},
  limit = SHIPPING_UPLOADS_PAGE_LIMIT,
  offset = 0,
): string {
  const q = new URLSearchParams();
  putAll(q, [
    ['list_type', filters.listType],
    ['status', filters.status],
    ['source', filters.source],
  ]);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${SHIPPING_UPLOADS_PATH}?${q.toString()}`;
}

/** Map a whole upload-history envelope. Pure and tolerant. */
export function parseShippingUploadsPage(
  raw: unknown,
  limit = SHIPPING_UPLOADS_PAGE_LIMIT,
): DocPage<ShippingUploadFile> {
  return docPage<ShippingUploadWire, ShippingUploadFile>(raw, mapShippingUpload, limit);
}

/** Fetch the shipping-lines upload history (import ledger). */
export async function fetchShippingUploadsPage(
  filters: ShippingUploadFilters = {},
  limit = SHIPPING_UPLOADS_PAGE_LIMIT,
  offset = 0,
): Promise<DocPage<ShippingUploadFile>> {
  return parseShippingUploadsPage(await http(shippingUploadsQuery(filters, limit, offset)), limit);
}
