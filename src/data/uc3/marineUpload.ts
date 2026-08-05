/**
 * UC-3 Marine CSV Data-Upload connector — validate → import → history.
 *
 * Drives `/api/marine/{validate,upload,uploads}` (RBAC: control room + customs).
 * Same shape as marineCalls.ts / shippingLines.ts: endpoint constants, typed
 * *wire* interfaces, exported PURE mappers, I/O last.
 *
 * Flow the backend implements, mirrored here:
 *
 *   validate  → dry run. Parses + validates, writes NOTHING, returns a preview
 *               plus typed row errors. Safe to call repeatedly.
 *   upload    → the same parse, then persists. Idempotent at two levels: a
 *               byte-identical file is SKIPPED_DUPLICATE (sha256 ledger), and a
 *               re-seen VCN upserts (enriches) rather than duplicating.
 *   uploads   → the audit ledger, newest first.
 *
 * Two things a caller must handle:
 *
 *  • **The response shape varies by outcome.** A rejected import carries
 *    `errors`; a successful one carries `warnings`. Both are optional here.
 *
 *  • **A non-2xx is NOT how a rejected file surfaces.** A structurally invalid
 *    CSV still returns HTTP 200 with `status: 'REJECTED'`; only transport/auth
 *    failures throw. Check `status`, never just the absence of an exception.
 *
 * SCOPE: CSV only in this release — the backend rejects other formats.
 */

import type { MarineUploadFile, MarineUploadRowError } from '@/types/domain';
import { http, postForm } from './client';
import { toEpochMs } from './shippingLines';

/** Endpoint suffixes, relative to `env.uc3.apiBase`. */
export const MARINE_VALIDATE_PATH = '/marine/validate';
export const MARINE_UPLOAD_PATH = '/marine/upload';
export const MARINE_UPLOADS_PATH = '/marine/uploads';
export const MARINE_TEMPLATE_PATH = '/marine/templates/vessel-call';

/** The gateway caps upload-history `limit` at 200. */
export const MARINE_UPLOADS_PAGE_LIMIT = 50;

/** The multipart field name the gateway expects. */
export const UPLOAD_FIELD = 'file';

/** Row-count roll-up returned by both validate and upload. */
export interface MarineUploadSummary {
  rows: number;
  valid: number;
  invalid: number;
  duplicates: number;
  importable: number;
  errors: number;
  warnings: number;
  rejected: boolean;
}

/** One typed parse/validation error as returned in the validate/import body. */
export interface MarineParseError {
  row_number: number | null;
  column_name: string | null;
  error_code: string | null;
  error_detail: string | null;
  raw_value: string | null;
}

/** `POST /marine/validate` — dry-run result. No database write occurred. */
export interface MarineValidateResult {
  /** 'VALIDATED' | 'REJECTED'. */
  status: string;
  valid: boolean;
  summary: MarineUploadSummary;
  /** Up to 20 mapped rows for the preview table. */
  preview: Record<string, unknown>[];
  errors: MarineParseError[];
  warnings: MarineParseError[];
}

/** `POST /marine/upload` — import outcome. */
export interface MarineImportResult {
  /** Null when the ledger row itself could not be written. */
  file_id: number | null;
  /** 'SUCCESS' | 'PARTIAL' | 'SKIPPED_DUPLICATE' | 'FAILED' | 'REJECTED'. */
  status: string;
  /** Rows newly inserted. */
  imported: number;
  /** Existing calls enriched by the VCN upsert. */
  updated: number;
  /** Rows skipped as duplicates within the file. */
  skipped: number;
  invalid: number;
  /** True when this exact file was already imported (sha256 match). */
  duplicate_file: boolean;
  summary: MarineUploadSummary;
  errors?: MarineParseError[];
  warnings?: MarineParseError[];
}

/** One ledger row exactly as the gateway returns it. */
export interface MarineUploadFileWire {
  id: number | null;
  filename: string | null;
  file_hash: string | null;
  physical_format: string | null;
  uploaded_by: string | null;
  status: string | null;
  total_rows: number | null;
  success_rows: number | null;
  failed_rows: number | null;
  duplicate_rows: number | null;
  source: string | null;
  error_detail: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** One persisted row error as returned by `GET /marine/uploads/{id}`. */
export interface MarineUploadErrorWire {
  id: number | null;
  row_number: number | null;
  error_message: string | null;
  raw_data: string | null;
  created_at: string | null;
}

/** The gateway's standard paged envelope for the ledger. */
export interface MarineUploadsPage {
  items: MarineUploadFileWire[];
  total: number;
  limit: number;
  offset: number;
  count: number;
}

/** `GET /marine/uploads/{id}` — one ledger row with its errors attached. */
export interface MarineUploadDetailWire extends MarineUploadFileWire {
  errors: MarineUploadErrorWire[];
}

/** Ledger filters accepted by `GET /marine/uploads`. */
export interface MarineUploadFilters {
  /** 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED_DUPLICATE' | 'PENDING'. */
  status?: string;
  /** 'UPLOAD' | 'DIRECTORY'. */
  source?: string;
}

function str(v: string | null | undefined): string {
  return (v ?? '').trim();
}

function num(v: number | null | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Map one ledger row onto the domain type. Pure.
 * Drops a row with no `id` — the key the UI uses to open the detail view.
 */
export function mapUploadFile(w: MarineUploadFileWire): MarineUploadFile | null {
  const id = Number(w?.id ?? NaN);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    filename: str(w.filename),
    fileHash: str(w.file_hash),
    physicalFormat: str(w.physical_format),
    uploadedBy: str(w.uploaded_by),
    status: str(w.status),
    totalRows: num(w.total_rows),
    successRows: num(w.success_rows),
    failedRows: num(w.failed_rows),
    duplicateRows: num(w.duplicate_rows),
    source: str(w.source),
    errorDetail: str(w.error_detail),
    createdAt: toEpochMs(w.created_at),
    updatedAt: toEpochMs(w.updated_at),
  };
}

/**
 * Map one persisted row error. Pure.
 * `rowNumber` stays null for file-level (structural) errors — 0 would falsely
 * read as "row 0".
 */
export function mapUploadError(w: MarineUploadErrorWire): MarineUploadRowError | null {
  const id = Number(w?.id ?? NaN);
  if (!Number.isFinite(id)) return null;
  const rn = w.row_number;
  return {
    id,
    rowNumber: rn === null || rn === undefined || !Number.isFinite(Number(rn)) ? null : Number(rn),
    errorMessage: str(w.error_message),
    rawData: str(w.raw_data),
    createdAt: toEpochMs(w.created_at),
  };
}

/** Map a ledger page, preserving server order (newest first). Pure and tolerant. */
export function parseUploadsPage(raw: unknown): MarineUploadFile[] {
  const items = (raw as MarineUploadsPage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(mapUploadFile).filter((f): f is MarineUploadFile => f !== null);
}

/** Map the upload-detail envelope (ledger row + its errors). Pure. */
export function parseUploadDetail(
  raw: unknown,
): { file: MarineUploadFile | null; errors: MarineUploadRowError[] } {
  const wire = raw as MarineUploadDetailWire | null;
  if (!wire) return { file: null, errors: [] };
  const errors = Array.isArray(wire.errors)
    ? wire.errors.map(mapUploadError).filter((e): e is MarineUploadRowError => e !== null)
    : [];
  return { file: mapUploadFile(wire), errors };
}

/** Build the ledger query string. Pure. */
export function marineUploadsQuery(
  filters: MarineUploadFilters = {},
  limit = MARINE_UPLOADS_PAGE_LIMIT,
  offset = 0,
): string {
  const q = new URLSearchParams();
  if (filters.status) q.set('status', filters.status);
  if (filters.source) q.set('source', filters.source);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${MARINE_UPLOADS_PATH}?${q.toString()}`;
}

/**
 * Wrap a File in the multipart body the gateway expects. Pure.
 *
 * `override` is appended ONLY when true, so a normal import posts exactly the body it
 * always did — the gateway's own default is false.
 */
export function buildUploadForm(file: File, override = false): FormData {
  const fd = new FormData();
  fd.append(UPLOAD_FIELD, file);
  if (override) fd.append('override', 'true');
  return fd;
}

/**
 * Dry-run a Marine CSV. Writes NOTHING — safe to call as often as the user
 * re-picks a file. A structurally invalid file resolves with
 * `status: 'REJECTED'`; it does NOT reject the promise.
 */
export async function validateMarineCsv(file: File): Promise<MarineValidateResult> {
  return postForm<MarineValidateResult>(MARINE_VALIDATE_PATH, buildUploadForm(file));
}

/**
 * Import a Marine CSV. Idempotent: identical bytes resolve with
 * `status: 'SKIPPED_DUPLICATE'` and `duplicate_file: true`; a re-seen VCN
 * enriches the existing call instead of duplicating it.
 */
export async function importMarineCsv(file: File): Promise<MarineImportResult> {
  return postForm<MarineImportResult>(MARINE_UPLOAD_PATH, buildUploadForm(file));
}

/**
 * Re-import a file the ledger has already seen, instead of getting SKIPPED_DUPLICATE.
 *
 * Development / audit affordance. It is NOT a delete: the gateway replays the same
 * records through the same upsert path, so business rows refresh in place, the lifecycle
 * projection re-runs, and the file keeps its original ledger id. Same endpoint, same
 * response shape — only the `override` field differs.
 */
export async function overrideImportMarineCsv(file: File): Promise<MarineImportResult> {
  return postForm<MarineImportResult>(MARINE_UPLOAD_PATH, buildUploadForm(file, true));
}

/** Fetch the import ledger, newest first. */
export async function fetchMarineUploads(
  filters: MarineUploadFilters = {},
  limit = MARINE_UPLOADS_PAGE_LIMIT,
  offset = 0,
): Promise<MarineUploadFile[]> {
  return parseUploadsPage(
    await http<MarineUploadsPage>(marineUploadsQuery(filters, limit, offset)),
  );
}

/** Fetch the ledger WITH its envelope, for a paginated history table. */
export async function fetchMarineUploadsPage(
  filters: MarineUploadFilters = {},
  limit = MARINE_UPLOADS_PAGE_LIMIT,
  offset = 0,
): Promise<{ items: MarineUploadFile[]; total: number; limit: number; offset: number }> {
  const page = await http<MarineUploadsPage>(marineUploadsQuery(filters, limit, offset));
  return {
    items: parseUploadsPage(page),
    total: num(page?.total),
    limit: num(page?.limit) || limit,
    offset: num(page?.offset),
  };
}

/** Fetch one upload with its persisted row errors. */
export async function fetchMarineUpload(
  fileId: number,
): Promise<{ file: MarineUploadFile | null; errors: MarineUploadRowError[] }> {
  return parseUploadDetail(await http<MarineUploadDetailWire>(`${MARINE_UPLOADS_PATH}/${fileId}`));
}
