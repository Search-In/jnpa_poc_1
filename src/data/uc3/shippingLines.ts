/**
 * UC-3 Shipping Lines connector — the shared JNPA carrier registry.
 *
 * Reads `GET /api/shipping-lines/lines` (RBAC: control room + customs) and maps
 * the gateway's wire rows onto the UC-1 domain type. Structured like aishub.ts:
 * endpoint constants, a typed *wire* interface kept separate from the domain
 * type, exported PURE mappers, and the I/O function last — so the mapping is
 * unit-testable with no network and no fetch stub.
 *
 * Backing store: `jnpa.shipping_lines`, populated by the gateway's advance-list
 * (IAL/EAL) importer. Two source-data facts the mapping has to absorb:
 *
 *  • **`line_name` is always null.** The importer upserts `line_code` only, so
 *    the registry has codes and no names. `lineName` therefore falls back to the
 *    code — a UI showing "KMD" where a carrier name is expected is correct, not
 *    a bug. Populating real names needs a source outside UC-3.
 *
 *  • **Rows arrive pre-sorted** (`ORDER BY container_count DESC, line_code`), so
 *    callers need no client-side sort. The order is preserved by the mapper.
 */

import type { ShippingLine, ShippingLinesSummary } from '@/types/domain';
import { http, postForm } from './client';

/** Endpoint suffix, relative to `env.uc3.apiBase`. */
export const SHIPPING_LINES_PATH = '/shipping-lines/lines';
export const SHIPPING_LINES_SUMMARY_PATH = '/shipping-lines/summary';
export const SHIPPING_LINES_VALIDATE_PATH = '/shipping-lines/validate';
export const SHIPPING_LINES_UPLOAD_PATH = '/shipping-lines/upload';

/** The three advance-list / delivery-order document types the upload accepts. */
export const SHIPPING_LINES_LIST_TYPES = ['IAL', 'EAL', 'EDO'] as const;

/** The multipart field name the gateway expects for the file part. */
export const UPLOAD_FIELD = 'file';

/**
 * The registry is small (tens of carriers), and the gateway caps `limit` at
 * 1000 — so one request fetches the whole list and no pagination loop is needed.
 */
export const SHIPPING_LINES_PAGE_LIMIT = 1000;

/** One row exactly as the gateway returns it. Snake_case: this is the wire shape. */
export interface ShippingLineWire {
  line_code: string;
  /** Always null in practice — see the module note. */
  line_name: string | null;
  source: string | null;
  /** ISO-8601 with offset. */
  first_seen: string | null;
  last_seen: string | null;
  container_count: number | null;
}

/** The gateway's standard paged envelope. */
export interface ShippingLinesPage {
  items: ShippingLineWire[];
  /** Full matching count, ignoring limit/offset. */
  total: number;
  limit: number;
  offset: number;
  /** Number of items on THIS page. */
  count: number;
}

/**
 * ISO-8601 → epoch ms. Returns 0 (not NaN) when absent or unparseable, so a bad
 * timestamp can never poison downstream date formatting; consumers treat 0 as
 * "unknown". Same fallback-to-0 posture as `num()` in src/data/config.ts.
 */
export function toEpochMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Map one wire row onto the domain type. Pure.
 *
 * Returns null for a row with no `line_code` — the primary key and the only
 * field the UI can key on — rather than surfacing a blank entry. (Same
 * drop-the-unusable-record posture as `mapAisHubPosition` in aishub.ts.)
 */
export function mapShippingLine(w: ShippingLineWire): ShippingLine | null {
  const lineCode = (w?.line_code ?? '').trim();
  if (!lineCode) return null;
  const name = (w.line_name ?? '').trim();
  return {
    lineCode,
    // Fall back to the code: line_name is null for every row today.
    lineName: name || lineCode,
    source: w.source ?? '',
    firstSeen: toEpochMs(w.first_seen),
    lastSeen: toEpochMs(w.last_seen),
    containerCount: Number(w.container_count ?? 0),
  };
}

/**
 * Map a whole response envelope, dropping unusable rows and preserving the
 * server's ordering. Pure and tolerant: a malformed or empty payload yields [].
 */
export function parseShippingLinesPage(raw: unknown): ShippingLine[] {
  const items = (raw as ShippingLinesPage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items
    .map(mapShippingLine)
    .filter((l): l is ShippingLine => l !== null);
}

/** Build the query string for one page of the registry. Pure. */
export function shippingLinesQuery(limit = SHIPPING_LINES_PAGE_LIMIT, offset = 0): string {
  return `${SHIPPING_LINES_PATH}?limit=${limit}&offset=${offset}`;
}

/**
 * Fetch the shipping-line registry from the UC-3 backend, newest/busiest first.
 * Rejects (never throws synchronously) so a caller can surface the error state.
 */
export async function fetchShippingLines(
  limit = SHIPPING_LINES_PAGE_LIMIT,
  offset = 0,
): Promise<ShippingLine[]> {
  const page = await http<ShippingLinesPage>(shippingLinesQuery(limit, offset));
  return parseShippingLinesPage(page);
}

/* ============================================================ summary (dashboard) */

/** `GET /shipping-lines/summary` — only the `totals` block is consumed for the cards. */
export interface ShippingLinesSummaryWire {
  totals: {
    files: number | null;
    advance_containers: number | null;
    distinct_containers: number | null;
    delivery_orders: number | null;
    shipping_lines: number | null;
    with_bl: number | null;
    failed_files: number | null;
  } | null;
}

function num(v: number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Map the summary envelope's `totals`. Pure and tolerant — a missing payload → zeroes. */
export function parseShippingLinesSummary(raw: unknown): ShippingLinesSummary {
  const t = (raw as ShippingLinesSummaryWire | null)?.totals ?? null;
  return {
    files: num(t?.files),
    advanceContainers: num(t?.advance_containers),
    distinctContainers: num(t?.distinct_containers),
    deliveryOrders: num(t?.delivery_orders),
    shippingLines: num(t?.shipping_lines),
    withBl: num(t?.with_bl),
    failedFiles: num(t?.failed_files),
  };
}

/** Fetch the shipping-line layer dashboard counts. */
export async function fetchShippingLinesSummary(): Promise<ShippingLinesSummary> {
  return parseShippingLinesSummary(await http<ShippingLinesSummaryWire>(SHIPPING_LINES_SUMMARY_PATH));
}

/* ============================================================ Data Upload sub-module */

/** One typed parse/validation error as returned in the validate/import body. */
export interface ShippingLinesParseError {
  row_number: number | null;
  column_name: string | null;
  error_code: string | null;
  error_detail: string | null;
  raw_value: string | null;
}

/** Row-count roll-up returned by both validate and upload. */
export interface ShippingLinesUploadSummary {
  rows: number;
  valid: number;
  invalid: number;
  duplicates: number;
  errors: number;
  warnings: number;
  rejected: boolean;
}

/** `POST /shipping-lines/validate` — dry-run result. No database write occurred. */
export interface ShippingLinesValidateResult {
  list_type: string;
  /** 'VALIDATED' | 'REJECTED'. */
  status: string;
  valid: boolean;
  summary: ShippingLinesUploadSummary;
  preview: Record<string, unknown>[];
  errors: ShippingLinesParseError[];
  warnings: ShippingLinesParseError[];
}

/** `POST /shipping-lines/upload` — import outcome (no `updated`: advance lists are append-only). */
export interface ShippingLinesImportResult {
  file_id: number | null;
  /** 'SUCCESS' | 'PARTIAL' | 'SKIPPED_DUPLICATE' | 'FAILED' | 'REJECTED'. */
  status: string;
  imported: number;
  skipped: number;
  invalid: number;
  duplicate_file: boolean;
  summary: ShippingLinesUploadSummary;
  errors?: ShippingLinesParseError[];
  warnings?: ShippingLinesParseError[];
}

/** Wrap a File + its list_type in the multipart body the gateway expects. */
export function buildShippingUploadForm(file: File, listType: string): FormData {
  const fd = new FormData();
  fd.append(UPLOAD_FIELD, file);
  fd.append('list_type', listType);
  return fd;
}

/**
 * Dry-run an advance-list / delivery-order upload. Writes NOTHING — safe to call as
 * often as the user re-picks a file. A structurally invalid file resolves with
 * `status: 'REJECTED'`; it does NOT reject the promise.
 */
export async function validateShippingLines(file: File, listType: string): Promise<ShippingLinesValidateResult> {
  return postForm<ShippingLinesValidateResult>(SHIPPING_LINES_VALIDATE_PATH, buildShippingUploadForm(file, listType));
}

/**
 * Import an advance-list / delivery-order upload. Idempotent: byte-identical content
 * resolves with `status: 'SKIPPED_DUPLICATE'`; content-hashed rows collapse on re-import.
 */
export async function importShippingLines(file: File, listType: string): Promise<ShippingLinesImportResult> {
  return postForm<ShippingLinesImportResult>(SHIPPING_LINES_UPLOAD_PATH, buildShippingUploadForm(file, listType));
}
