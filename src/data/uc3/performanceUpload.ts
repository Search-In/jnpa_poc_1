/**
 * UC-3 Performance Data Upload connector — Daily Status / monthly TEU / LDB report.
 *
 * Admin-only (`DTCCC_ADMIN`) write surface over:
 *   POST /api/performance/validate
 *   POST /api/performance/upload
 *   GET  /api/performance/uploads
 *   GET  /api/performance/templates/{report_type}
 */

import { env } from '../config';
import { http, postForm } from './client';

export const PERF_VALIDATE_PATH = '/performance/validate';
export const PERF_UPLOAD_PATH = '/performance/upload';
export const PERF_UPLOADS_PATH = '/performance/uploads';
export const PERF_TEMPLATE_BASE = '/performance/templates';

export const PERF_REPORT_TYPES = ['daily_status', 'monthly_teu', 'ldb_report'] as const;
export type PerfReportType = (typeof PERF_REPORT_TYPES)[number];

export const PERF_REPORT_TYPE_LABELS: Record<PerfReportType, string> = {
  daily_status: 'Daily Status Report',
  monthly_teu: 'Monthly TEU',
  ldb_report: 'LDB Analytics Report',
};

export const PERF_UPLOAD_ACCEPT = '.pdf,.csv,.xlsx,.xlsm,.txt,application/pdf,text/csv';

export interface PerfParseError {
  row_number: number | null;
  column_name: string | null;
  error_code: string | null;
  error_detail: string | null;
}

export interface PerfUploadSummary {
  rows?: number;
  errors?: number;
  warnings?: number;
  rejected?: boolean;
  valid?: boolean;
  [k: string]: unknown;
}

export interface PerfValidateResult {
  upload_id?: string | null;
  report_type: string;
  status: string;
  valid?: boolean;
  summary: PerfUploadSummary;
  preview?: Record<string, unknown>[];
  errors: PerfParseError[];
  warnings?: PerfParseError[];
}

export interface PerfImportResult {
  upload_id?: string | null;
  status: string;
  inserted?: number;
  skipped?: number;
  summary?: PerfUploadSummary;
  errors?: PerfParseError[];
}

export interface PerfUploadFile {
  uploadId: string;
  reportType: string;
  filename: string;
  status: string;
  rowCount: number;
  insertedCount: number;
  errorCount: number;
  uploadedBy: string;
  createdAt: number;
  notes: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toMs(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = Date.parse(String(v ?? ''));
  return Number.isFinite(t) ? t : 0;
}

function mapError(raw: unknown): PerfParseError {
  const e = (raw ?? {}) as Record<string, unknown>;
  return {
    row_number: e.row_number == null ? null : num(e.row_number),
    column_name: str(e.column_name) || null,
    error_code: str(e.error_code) || null,
    error_detail: str(e.error_detail || e.message || e.error_message) || null,
  };
}

export function buildPerfUploadForm(file: File, reportType: PerfReportType): FormData {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('report_type', reportType);
  return fd;
}

export function perfTemplateHref(reportType: PerfReportType): string {
  return `${env.uc3.apiBase}${PERF_TEMPLATE_BASE}/${reportType}`;
}

export async function validatePerformanceUpload(
  file: File,
  reportType: PerfReportType,
): Promise<PerfValidateResult> {
  const raw = await postForm<Record<string, unknown>>(
    PERF_VALIDATE_PATH,
    buildPerfUploadForm(file, reportType),
  );
  return {
    upload_id: str(raw.upload_id) || null,
    report_type: str(raw.report_type) || reportType,
    status: str(raw.status) || 'UNKNOWN',
    valid: Boolean(raw.valid),
    summary: (raw.summary as PerfUploadSummary) ?? {},
    preview: Array.isArray(raw.preview) ? (raw.preview as Record<string, unknown>[]) : [],
    errors: Array.isArray(raw.errors) ? raw.errors.map(mapError) : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings.map(mapError) : [],
  };
}

export async function importPerformanceUpload(
  file: File,
  reportType: PerfReportType,
): Promise<PerfImportResult> {
  const raw = await postForm<Record<string, unknown>>(
    PERF_UPLOAD_PATH,
    buildPerfUploadForm(file, reportType),
  );
  return {
    upload_id: str(raw.upload_id) || null,
    status: str(raw.status) || 'UNKNOWN',
    inserted: num(raw.inserted),
    skipped: num(raw.skipped),
    summary: (raw.summary as PerfUploadSummary) ?? {},
    errors: Array.isArray(raw.errors) ? raw.errors.map(mapError) : [],
  };
}

export async function fetchPerformanceUploads(
  reportType?: PerfReportType,
  limit = 25,
  offset = 0,
): Promise<PerfUploadFile[]> {
  const q = new URLSearchParams();
  if (reportType) q.set('report_type', reportType);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  const raw = await http<{ items?: Record<string, unknown>[] } | Record<string, unknown>[]>(
    `${PERF_UPLOADS_PATH}?${q.toString()}`,
  );
  const items = Array.isArray(raw) ? raw : (raw.items ?? []);
  return items.map((w) => ({
    uploadId: str(w.upload_id || w.id),
    reportType: str(w.report_type),
    filename: str(w.original_filename || w.filename),
    status: str(w.status),
    rowCount: num(w.row_count),
    insertedCount: num(w.inserted_count),
    errorCount: num(w.error_count),
    uploadedBy: str(w.uploaded_by),
    createdAt: toMs(w.created_at || w.uploaded_at),
    notes: str(w.notes),
  }));
}
