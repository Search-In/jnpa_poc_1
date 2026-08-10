/**
 * UC-3 Performance & Daily Reports connector — READ-ONLY.
 *
 * Reads `/api/performance*`, the official JNPA Daily Status Report / monthly JN Port
 * TEU / NLDS-LDB analytics surface (`core.perf_*`, populated by the gateway's
 * performance importer). Follows the same shape as pilotage.ts / portCraft.ts /
 * shippingDocs.ts: endpoint constants, typed snake_case *wire* interfaces kept
 * separate from the domain types, exported PURE mappers, I/O last — so the mapping is
 * unit-testable with no network.
 *
 * DELIBERATELY NOT THE DataAdapter CHAIN. `MockAdapter`/`SimAdapter` serve simulated
 * vessel telemetry and the client-computed KPI bundle; these are real reported
 * actuals from the shared backend, so they go through `http()` like every other UC-3
 * entity. Nothing here writes, and no existing adapter is touched.
 *
 * WHAT THE GATEWAY ACTUALLY SUPPORTS (verified against gateway/routers/performance.py
 * and services/performance/repository.py — both unchanged by this module):
 *
 *   GET /performance/kpi?date=            headline metrics + day-over-day deltas.
 *                                         404 `no_daily_reports` when none imported.
 *   GET /performance/meta                 available report dates + the latest.
 *   GET /performance/terminals            canonical terminal dimension.
 *   GET /performance/daily/traffic         from · to · terminal · period(DAY|MONTH|YEAR)
 *                                         · sort · direction · limit(≤500) · offset
 *                                         — unlike the shipping-lines lists this one
 *                                         DOES page and sort server-side, so the table
 *                                         built on it needs no client-side window.
 *
 * Every date parameter and every date field is a 'YYYY-MM-DD' calendar string, which
 * is what the gateway emits and expects; see the note on PerformanceMetrics in
 * types/domain.ts for why these are not converted to epoch ms.
 */

import type {
  PerformanceKpi,
  PerformanceMeta,
  PerformanceMetrics,
  PerformanceTerminal,
  PerformanceTraffic,
} from '@/types/domain';
import { http } from './client';

export const PERF_KPI_PATH = '/performance/kpi';
export const PERF_META_PATH = '/performance/meta';
export const PERF_TERMINALS_PATH = '/performance/terminals';
export const PERF_TRAFFIC_PATH = '/performance/daily/traffic';

/** The gateway caps `/daily/traffic` at 500 rows per request. */
export const PERF_TRAFFIC_MAX_LIMIT = 500;
/** Aggregation grains the gateway accepts on `period` (anything else → HTTP 400). */
export const PERF_PERIODS = ['DAY', 'MONTH', 'YEAR'] as const;
/** Sort keys the gateway maps; an unknown key silently falls back to report_date. */
export const PERF_TRAFFIC_SORTS = ['report_date', 'terminal_code', 'total_teus', 'vessels'] as const;

/* ── coercion (same posture as the sibling connectors) ────────────────────── */

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : v === null || v === undefined ? '' : String(v);
}
function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function num(v: unknown): number {
  return nullableNum(v) ?? 0;
}

/** Append only non-blank values, so an unset filter never reaches the gateway. */
function putAll(q: URLSearchParams, pairs: [string, string | undefined][]): void {
  for (const [k, v] of pairs) {
    if (v !== undefined && v !== null && `${v}`.trim() !== '') q.set(k, `${v}`.trim());
  }
}

/* ── headline KPIs ────────────────────────────────────────────────────────── */

/** The metric block as the gateway returns it (snake_case, every field nullable). */
export interface PerformanceMetricsWire {
  total_teus: number | null;
  total_tonnes: number | null;
  vessel_calls: number | null;
  yard_occupancy_pct: number | null;
  gate_total_teus: number | null;
  gate_in_teus: number | null;
  gate_out_teus: number | null;
  total_pendency_teus: number | null;
  reefer_available_slots: number | null;
  reefer_total_slots: number | null;
}

export interface PerformanceKpiWire {
  report_date: string | null;
  prev_report_date: string | null;
  metrics: PerformanceMetricsWire | null;
  /** Only the metrics the gateway could diff appear here — see the domain type. */
  deltas: Partial<Record<keyof PerformanceMetricsWire, number | null>> | null;
}

/** wire key → domain key. The single place the KPI field names are paired. */
const METRIC_KEYS: [keyof PerformanceMetricsWire, keyof PerformanceMetrics][] = [
  ['total_teus', 'totalTeus'],
  ['total_tonnes', 'totalTonnes'],
  ['vessel_calls', 'vesselCalls'],
  ['yard_occupancy_pct', 'yardOccupancyPct'],
  ['gate_total_teus', 'gateTotalTeus'],
  ['gate_in_teus', 'gateInTeus'],
  ['gate_out_teus', 'gateOutTeus'],
  ['total_pendency_teus', 'totalPendencyTeus'],
  ['reefer_available_slots', 'reeferAvailableSlots'],
  ['reefer_total_slots', 'reeferTotalSlots'],
];

/** Map the metric block. Pure. A missing block yields all-null, never zeroes. */
export function mapPerformanceMetrics(w: PerformanceMetricsWire | null | undefined): PerformanceMetrics {
  const out = {} as PerformanceMetrics;
  for (const [wireKey, domainKey] of METRIC_KEYS) {
    out[domainKey] = nullableNum(w?.[wireKey]);
  }
  return out;
}

/**
 * Map the KPI envelope. Pure and tolerant.
 *
 * Deltas are copied only for keys the gateway actually sent. An absent delta stays
 * absent rather than becoming 0 — "no change" and "not computable" must stay
 * distinguishable, otherwise a missing section reads as a flat day.
 */
export function mapPerformanceKpi(raw: unknown): PerformanceKpi {
  const w = (raw ?? null) as PerformanceKpiWire | null;
  const deltas: PerformanceKpi['deltas'] = {};
  for (const [wireKey, domainKey] of METRIC_KEYS) {
    const d = w?.deltas?.[wireKey];
    if (d !== undefined && d !== null) deltas[domainKey] = nullableNum(d);
  }
  return {
    reportDate: str(w?.report_date),
    prevReportDate: str(w?.prev_report_date),
    metrics: mapPerformanceMetrics(w?.metrics),
    deltas,
  };
}

/** Build the KPI query. `date` omitted ⇒ the gateway uses its latest report. Pure. */
export function performanceKpiQuery(date?: string): string {
  const q = new URLSearchParams();
  putAll(q, [['date', date]]);
  const qs = q.toString();
  return qs ? `${PERF_KPI_PATH}?${qs}` : PERF_KPI_PATH;
}

/**
 * Fetch the headline KPIs.
 *
 * Returns `null` when the corpus has no daily reports yet (HTTP 404
 * `no_daily_reports`) so the Overview panel can render an empty state instead
 * of a red "gateway error" banner. Other non-2xx still reject.
 */
export async function fetchPerformanceKpi(date?: string): Promise<PerformanceKpi | null> {
  try {
    return mapPerformanceKpi(await http(performanceKpiQuery(date)));
  } catch (err) {
    if (err instanceof Error && /→ HTTP 404\b/.test(err.message) && /no_daily_reports/.test(err.message)) {
      return null;
    }
    // Older gateways omit the detail blob — still treat bare 404 as empty.
    if (err instanceof Error && /→ HTTP 404\b/.test(err.message)) {
      return null;
    }
    throw err;
  }
}

/* ── meta ─────────────────────────────────────────────────────────────────── */

export interface PerformanceMetaWire {
  report_dates: string[] | null;
  latest_report_date: string | null;
}

/** Map the meta envelope. Pure. Preserves the gateway's newest-first ordering. */
export function mapPerformanceMeta(raw: unknown): PerformanceMeta {
  const w = (raw ?? null) as PerformanceMetaWire | null;
  const dates = Array.isArray(w?.report_dates) ? w!.report_dates.map(str).filter(Boolean) : [];
  return { reportDates: dates, latestReportDate: str(w?.latest_report_date) };
}

/** Fetch the available report dates. */
export async function fetchPerformanceMeta(): Promise<PerformanceMeta> {
  return mapPerformanceMeta(await http(PERF_META_PATH));
}

/* ── terminal dimension ───────────────────────────────────────────────────── */

export interface PerformanceTerminalWire {
  code: string | null;
  full_name: string | null;
  operator: string | null;
  terminal_type: string | null;
  is_container: boolean | null;
  sort_order: number | null;
}

/** Map one terminal row. Pure. Rows with no `code` are unusable as an option value. */
export function mapPerformanceTerminal(w: PerformanceTerminalWire): PerformanceTerminal | null {
  const code = str(w?.code);
  if (!code) return null;
  return {
    code,
    fullName: str(w.full_name) || code,
    operator: str(w.operator),
    terminalType: str(w.terminal_type),
    isContainer: w.is_container === true,
    sortOrder: nullableNum(w.sort_order),
  };
}

/** Map the terminal list envelope. Pure and tolerant. */
export function parsePerformanceTerminals(raw: unknown): PerformanceTerminal[] {
  const items = (raw as { items?: PerformanceTerminalWire[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(mapPerformanceTerminal).filter((t): t is PerformanceTerminal => t !== null);
}

/** Fetch the canonical terminal dimension (used to populate the terminal filter). */
export async function fetchPerformanceTerminals(): Promise<PerformanceTerminal[]> {
  return parsePerformanceTerminals(await http(PERF_TERMINALS_PATH));
}

/* ── daily traffic ────────────────────────────────────────────────────────── */

export interface PerformanceTrafficWire {
  report_date: string | null;
  terminal_code: string | null;
  period: string | null;
  vessels: number | null;
  imp_teus: number | null;
  exp_teus: number | null;
  total_teus: number | null;
  rakes: number | null;
  rail_dis_teus: number | null;
  rail_ldg_teus: number | null;
  rail_total_teus: number | null;
}

/** Server-side traffic filters — only what the gateway accepts. */
export interface PerformanceTrafficFilters {
  /** Inclusive lower bound, 'YYYY-MM-DD' (sent as `from`). */
  dateFrom?: string;
  /** Inclusive upper bound, 'YYYY-MM-DD' (sent as `to`). */
  dateTo?: string;
  terminal?: string;
  /** 'DAY' | 'MONTH' | 'YEAR'. Anything else is rejected with HTTP 400. */
  period?: string;
  sort?: string;
  direction?: 'asc' | 'desc';
}

export interface PerformanceTrafficPage {
  items: PerformanceTraffic[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Map one traffic row. Pure. Never drops a row.
 *
 * `core.perf_daily_traffic` has no surrogate id, so `id` is the natural composite key
 * (date + terminal + grain) with the row position as a tiebreaker. Row identity is a
 * list-key concern and must never decide whether data is displayed.
 */
export function mapPerformanceTraffic(w: PerformanceTrafficWire, index = 0): PerformanceTraffic {
  const reportDate = str(w?.report_date);
  const terminalCode = str(w?.terminal_code);
  const period = str(w?.period);
  return {
    id: [reportDate, terminalCode, period].filter(Boolean).join('|') || `row#${index}`,
    reportDate,
    terminalCode,
    period,
    vessels: nullableNum(w?.vessels),
    impTeus: nullableNum(w?.imp_teus),
    expTeus: nullableNum(w?.exp_teus),
    totalTeus: nullableNum(w?.total_teus),
    rakes: nullableNum(w?.rakes),
    railDisTeus: nullableNum(w?.rail_dis_teus),
    railLdgTeus: nullableNum(w?.rail_ldg_teus),
    railTotalTeus: nullableNum(w?.rail_total_teus),
  };
}

/** Map the traffic envelope, preserving server order. Pure and tolerant. */
export function parsePerformanceTrafficPage(raw: unknown, limit: number): PerformanceTrafficPage {
  const page = raw as
    | { items?: PerformanceTrafficWire[]; total?: number; limit?: number; offset?: number }
    | null;
  const rows = Array.isArray(page?.items) ? (page as { items: PerformanceTrafficWire[] }).items : [];
  return {
    items: rows
      .filter((r) => r !== null && typeof r === 'object')
      .map((r, i) => mapPerformanceTraffic(r, i)),
    total: num(page?.total),
    limit: nullableNum(page?.limit) ?? limit,
    offset: num(page?.offset),
  };
}

/** Build the traffic query. Pure. Note `from`/`to` are the gateway's param aliases. */
export function performanceTrafficQuery(
  filters: PerformanceTrafficFilters = {},
  limit = 50,
  offset = 0,
): string {
  const q = new URLSearchParams();
  putAll(q, [
    ['from', filters.dateFrom],
    ['to', filters.dateTo],
    ['terminal', filters.terminal],
    ['period', filters.period],
    ['sort', filters.sort],
    ['direction', filters.direction],
  ]);
  q.set('limit', String(Math.min(limit, PERF_TRAFFIC_MAX_LIMIT)));
  q.set('offset', String(offset));
  return `${PERF_TRAFFIC_PATH}?${q.toString()}`;
}

/**
 * Fetch one page of daily traffic. Server-paged and server-sorted, so the caller
 * shows exactly what the gateway returned — no client-side window to caveat.
 */
export async function fetchPerformanceTrafficPage(
  filters: PerformanceTrafficFilters = {},
  limit = 50,
  offset = 0,
): Promise<PerformanceTrafficPage> {
  const capped = Math.min(limit, PERF_TRAFFIC_MAX_LIMIT);
  return parsePerformanceTrafficPage(
    await http(performanceTrafficQuery(filters, capped, offset)),
    capped,
  );
}
