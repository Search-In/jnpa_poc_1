/**
 * UC-3 Berthing Reports connector — the per-terminal berthing vessel-call model.
 *
 * Reads `/api/berthing*` and maps the gateway's wire rows onto the UC-1 domain types.
 * Structured like marineCalls.ts / portCraft.ts: endpoint constants, typed *wire*
 * interfaces kept separate from the domain types, exported PURE mappers, and the I/O
 * functions last — so every mapping is unit-testable with no network and no fetch stub.
 *
 * Backing store: `jnpa.berthing_reports` + `jnpa.berthing_events` (UC-III module 7),
 * populated by the Berthing Data-Upload endpoints (PDF/CSV/XLS/XLSX terminal reports for
 * APMT / BMCT / NSFT / NSICT / NSIGT). Facts the mapping absorbs:
 *
 *  • **This is the ACTUALS report layer, not the 5-Day berth PLAN.** The plan gantt
 *    (BerthGantt5Day) is a forward-looking, sim/adapter-driven berth-allocation view;
 *    this is the reported per-terminal vessel-call state (EXPECTED → … → DEPARTED),
 *    a distinct dataset that must not be merged with the plan.
 *
 *  • **imo_number is absent from every source file** and NSFT reports carry no berth,
 *    so those fields are nullable/blank rather than assumed present.
 *
 *  • Timestamps are epoch ms (0 = unknown), matching the other UC-3 connectors.
 *
 * RBAC: /api/berthing is gated to CONTROL_ROOM + CUSTOMS (+ admin) on the gateway; the
 * upload endpoints additionally require an uploader role. A 403 surfaces as an error
 * state in the calling component, exactly like any other non-2xx.
 */

import type { BerthingReport, BerthingStats } from '@/types/domain';
import { http, postForm } from './client';
// Reused rather than duplicated: the same ISO→epoch fallback-to-0 posture the other
// UC-3 connectors use, so all of them treat time identically.
import { toEpochMs } from './shippingLines';

/** Endpoint suffixes, relative to `env.uc3.apiBase`. */
export const BERTHING_PATH = '/berthing';
export const BERTHING_STATS_PATH = '/berthing/stats';
export const BERTHING_VALIDATE_PATH = '/berthing/validate';
export const BERTHING_UPLOAD_PATH = '/berthing/upload';
export const BERTHING_UPLOADS_PATH = '/berthing/uploads';

/** The gateway caps `limit` at 500; 50 is a sane page for a table view. */
export const BERTHING_PAGE_LIMIT = 50;

/** The five JNPA container terminals the reports cover. */
export const BERTHING_TERMINALS = ['APMT', 'BMCT', 'NSFT', 'NSICT', 'NSIGT'] as const;

/** The berthing lifecycle statuses, in order. */
export const BERTHING_STATUSES = [
  'EXPECTED', 'ARRIVED', 'BERTH_ASSIGNED', 'BERTHING_STARTED',
  'CARGO_OPERATION', 'COMPLETED', 'DEPARTED',
] as const;

/** The multipart field name the gateway expects for the file part. */
export const UPLOAD_FIELD = 'file';

/** One berthing report row exactly as the gateway returns it. Snake_case wire shape. */
export interface BerthingReportWire {
  id: number | null;
  terminal: string | null;
  vessel_name: string | null;
  imo_number: string | null;
  voyage_number: string | null;
  shipping_line: string | null;
  berth_number: string | null;
  /** ISO-8601 with offset, or null. */
  eta: string | null;
  ata: string | null;
  berthing_time: string | null;
  departure_time: string | null;
  cargo_operation_start: string | null;
  cargo_operation_end: string | null;
  status: string | null;
  source_file: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** The gateway's standard paged envelope for the report list. */
export interface BerthingReportsPage {
  items: BerthingReportWire[];
  total: number;
  limit: number;
  offset: number;
  count: number;
}

/** `GET /berthing/stats` wire shape. */
export interface BerthingStatsWire {
  total: number | null;
  expected: number | null;
  arrived: number | null;
  berthed: number | null;
  completed: number | null;
  departed: number | null;
  terminals: number | null;
  avg_berth_hours: number | null;
  by_terminal: { terminal: string | null; count: number | null; berthed: number | null }[] | null;
}

/** Server-side filters accepted by `GET /berthing`. All optional. */
export interface BerthingReportFilters {
  /** One of BERTHING_TERMINALS. */
  terminal?: string;
  /** One of BERTHING_STATUSES. */
  status?: string;
  /** Vessel name — substring match. */
  vessel?: string;
  /** Voyage / VIA — substring match. */
  voyage?: string;
  /** Arrived and berthed, not yet departed. */
  berthedOnly?: boolean;
  sort?: string;
  direction?: 'asc' | 'desc';
}

/** One typed parse/validation error as returned in the validate/import body. */
export interface BerthingParseError {
  row_number: number | null;
  column_name: string | null;
  error_code: string | null;
  error_detail: string | null;
  raw_value: string | null;
}

/** Row-count roll-up returned by both validate and upload. */
export interface BerthingUploadSummary {
  rows: number;
  valid: number;
  invalid: number;
  duplicates: number;
  errors: number;
  warnings: number;
  rejected: boolean;
}

/** `POST /berthing/validate` — dry-run result. No database write occurred. */
export interface BerthingValidateResult {
  /** Detected/selected terminal (may be null when per-row). */
  terminal: string | null;
  /** 'VALIDATED' | 'REJECTED'. */
  status: string;
  valid: boolean;
  summary: BerthingUploadSummary;
  preview: Record<string, unknown>[];
  errors: BerthingParseError[];
  warnings: BerthingParseError[];
}

/** `POST /berthing/upload` — import outcome. */
export interface BerthingImportResult {
  file_id: number | null;
  /** 'SUCCESS' | 'PARTIAL' | 'SKIPPED_DUPLICATE' | 'FAILED' | 'REJECTED'. */
  status: string;
  imported: number;
  updated: number;
  skipped: number;
  invalid: number;
  duplicate_file: boolean;
  summary: BerthingUploadSummary;
  errors?: BerthingParseError[];
  warnings?: BerthingParseError[];
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
 * Map one wire report onto the domain type. Pure.
 * Returns null for a row with no `id` — the surrogate key the UI keys on — rather than
 * surfacing an unaddressable entry (same drop-the-unusable-record posture as the peers).
 */
export function mapBerthingReport(w: BerthingReportWire): BerthingReport | null {
  const id = nullableNum(w?.id);
  if (id === null) return null;
  return {
    id,
    terminal: str(w.terminal),
    vesselName: str(w.vessel_name),
    imoNumber: str(w.imo_number),
    voyageNumber: str(w.voyage_number),
    shippingLine: str(w.shipping_line),
    berthNumber: str(w.berth_number),
    status: str(w.status),
    sourceFile: str(w.source_file),
    eta: toEpochMs(w.eta),
    ata: toEpochMs(w.ata),
    berthingTime: toEpochMs(w.berthing_time),
    departureTime: toEpochMs(w.departure_time),
    cargoOperationStart: toEpochMs(w.cargo_operation_start),
    cargoOperationEnd: toEpochMs(w.cargo_operation_end),
    createdAt: toEpochMs(w.created_at),
    updatedAt: toEpochMs(w.updated_at),
  };
}

/**
 * Map a whole report page, dropping unusable rows and preserving the server's ordering.
 * Pure and tolerant: a malformed or empty payload yields [].
 */
export function parseBerthingReportsPage(raw: unknown): BerthingReport[] {
  const items = (raw as BerthingReportsPage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(mapBerthingReport).filter((r): r is BerthingReport => r !== null);
}

/** Map the stats envelope. Pure and tolerant — a missing payload yields zeroes. */
export function parseBerthingStats(raw: unknown): BerthingStats {
  const w = (raw ?? {}) as BerthingStatsWire;
  return {
    total: num(w.total),
    expected: num(w.expected),
    arrived: num(w.arrived),
    berthed: num(w.berthed),
    completed: num(w.completed),
    departed: num(w.departed),
    terminals: num(w.terminals),
    // Average stays nullable: "no berthed-and-departed call yet" is not "zero hours".
    avgBerthHours: nullableNum(w.avg_berth_hours),
    byTerminal: Array.isArray(w.by_terminal)
      ? w.by_terminal.map((t) => ({
          terminal: str(t?.terminal),
          count: num(t?.count),
          berthed: num(t?.berthed),
        }))
      : [],
  };
}

/**
 * Build the query string for one page of reports. Pure.
 * Only defined filters are emitted, so an empty filter object yields just the window.
 */
export function berthingQuery(
  filters: BerthingReportFilters = {},
  limit = BERTHING_PAGE_LIMIT,
  offset = 0,
): string {
  const q = new URLSearchParams();
  const put = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== null && `${v}`.trim() !== '') q.set(k, `${v}`);
  };
  put('terminal', filters.terminal);
  put('status', filters.status);
  put('vessel', filters.vessel);
  put('voyage', filters.voyage);
  if (filters.berthedOnly) q.set('berthed_only', 'true');
  put('sort', filters.sort);
  put('direction', filters.direction);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${BERTHING_PATH}?${q.toString()}`;
}

/** Build the stats query string. Pure. Reuses the terminal filter vocabulary. */
export function berthingStatsQuery(filters: BerthingReportFilters = {}): string {
  const q = new URLSearchParams();
  if (filters.terminal) q.set('terminal', filters.terminal);
  const qs = q.toString();
  return qs ? `${BERTHING_STATS_PATH}?${qs}` : BERTHING_STATS_PATH;
}

/** Wrap a File (+ optional terminal selector) in the multipart body the gateway expects. */
export function buildBerthingUploadForm(file: File, terminal?: string): FormData {
  const fd = new FormData();
  fd.append(UPLOAD_FIELD, file);
  // 'ALL' / blank means "read the per-row Terminal column"; the gateway normalises it.
  fd.append('terminal', terminal && terminal.trim() ? terminal.trim() : 'ALL');
  return fd;
}

/**
 * Fetch one page of berthing reports WITH its envelope, for a table that needs `total`.
 * Rejects (never throws synchronously) so a caller can surface the error state.
 */
export async function fetchBerthingReportsPage(
  filters: BerthingReportFilters = {},
  limit = BERTHING_PAGE_LIMIT,
  offset = 0,
): Promise<{ items: BerthingReport[]; total: number; limit: number; offset: number }> {
  const page = await http<BerthingReportsPage>(berthingQuery(filters, limit, offset));
  return {
    items: parseBerthingReportsPage(page),
    total: num(page?.total),
    limit: num(page?.limit) || limit,
    offset: num(page?.offset),
  };
}

/** Fetch the berthing KPI aggregates. */
export async function fetchBerthingStats(
  filters: BerthingReportFilters = {},
): Promise<BerthingStats> {
  return parseBerthingStats(await http<BerthingStatsWire>(berthingStatsQuery(filters)));
}

/**
 * Dry-run a berthing upload (PDF/CSV/XLS/XLSX). Writes NOTHING — safe to call as often
 * as the user re-picks a file. A structurally invalid file resolves with
 * `status: 'REJECTED'`; it does NOT reject the promise.
 */
export async function validateBerthing(file: File, terminal?: string): Promise<BerthingValidateResult> {
  return postForm<BerthingValidateResult>(BERTHING_VALIDATE_PATH, buildBerthingUploadForm(file, terminal));
}

/**
 * Import a berthing upload. Idempotent: identical bytes resolve with
 * `status: 'SKIPPED_DUPLICATE'`; a re-seen (terminal, voyage, vessel) upserts (the
 * status advances / timestamps fill in) rather than duplicating.
 */
export async function importBerthing(file: File, terminal?: string): Promise<BerthingImportResult> {
  return postForm<BerthingImportResult>(BERTHING_UPLOAD_PATH, buildBerthingUploadForm(file, terminal));
}

/** List verbatim berthing-report documents (full-extract ledger). */
export async function fetchBerthingDocuments(limit = 200): Promise<
  { id: number; file_name: string; terminal: string }[]
> {
  const page = await http<{ items?: { id: number; file_name: string; terminal: string }[] }>(
    `/berthing/documents?limit=${limit}`,
  );
  return page.items ?? [];
}

/**
 * Open the original source PDF for a normalised row's `sourceFile`.
 * Looks up the matching verbatim document, then streams `/documents/{id}/pdf`.
 */
export async function openBerthingSourcePdf(sourceFile: string): Promise<void> {
  const docs = await fetchBerthingDocuments();
  const doc = docs.find((d) => d.file_name === sourceFile);
  if (!doc) {
    throw new Error(`No verbatim document for ${sourceFile} — re-import the PDF (extract/import).`);
  }
  const { getAuthToken } = await import('./token');
  const { getDataSourceMode } = await import('../dataSourceMode');
  const { uc3Url } = await import('./client');
  const token = await getAuthToken();
  const res = await fetch(uc3Url(`/berthing/documents/${doc.id}/pdf`), {
    headers: {
      authorization: `Bearer ${token}`,
      'x-data-mode': getDataSourceMode(),
    },
  });
  if (!res.ok) {
    throw new Error(`PDF open failed (${res.status}) for ${sourceFile}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener,noreferrer');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
