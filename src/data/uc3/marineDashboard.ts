/**
 * UC-3 Marine dashboard connector — the corpus-backed read models behind the
 * OPERATIONAL screens (map / 5-day Gantt / KPI wall / reports), as opposed to the
 * register tables the other uc3/* connectors serve.
 *
 * Reads the `/api/marine/*` dashboard family added for UC-1:
 *
 *     /marine/berths                        berth register + occupancy state (M-01/M-04)
 *     /marine/berthing-plan                 confirmed vs indicative plan entries (M-03)
 *     /marine/kpis                          the six tender KPIs with definitions (M-09)
 *     /marine/arrivals-departures           bucketed arrival/departure counts (M-10)
 *     /marine/vessel-states                 ledger-derived vessel states (M-01)
 *     /marine/pilotage-performance          board→all-fast distributions (M-07)
 *     /marine/calls/{id}/arrival-times      the six-arrival-times ladder (M-02)
 *     /marine/tides                         typed tide readings from the berthing PDFs (M-05)
 *
 * Same structure as portCraft.ts / marineCalls.ts: endpoint constants, typed *wire*
 * interfaces, exported PURE mappers, I/O last — every mapping unit-testable with no
 * network. Every response carries the additive provenance envelope
 * `{data_mode, source, observed_at}`; mappers surface it so screens can badge
 * CACHED / NO_DATA honestly (spec UI-001: the screen banner is the weakest mode).
 *
 * TIME MODEL: all endpooints accept `at` (ISO datetime) — "the sim clock's now".
 * Omitted, the backend anchors to the latest ACTUAL in the corpus so screens render
 * a populated port out of the box.
 */

import { http } from './client';

// ------------------------------------------------------------------ paths
export const MARINE_BERTHS_PATH = '/marine/berths';
export const MARINE_PLAN_PATH = '/marine/berthing-plan';
export const MARINE_KPIS_PATH = '/marine/kpis';
export const MARINE_ARR_DEP_PATH = '/marine/arrivals-departures';
export const MARINE_VESSEL_STATES_PATH = '/marine/vessel-states';
export const MARINE_PILOT_PERF_PATH = '/marine/pilotage-performance';
export const MARINE_TIDES_PATH = '/marine/tides';
export const marineArrivalTimesPath = (callId: number) =>
  `/marine/calls/${callId}/arrival-times`;

// ------------------------------------------------------------------ envelope
/** The additive provenance envelope every dashboard response carries. */
export interface MarineEnvelope {
  /** 'CACHED' (ingested corpus rows) | 'NO_DATA'. Never 'LIVE' from this family. */
  dataMode: string;
  source: string;
  /** Latest underlying observation (epoch ms; 0 unknown). */
  observedAt: number;
  /** The anchor instant the state was computed for (epoch ms; 0 unknown). */
  asOf: number;
}

function ts(v: unknown): number {
  if (typeof v !== 'string' || !v) return 0;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}
function nullableNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapEnvelope(raw: Record<string, unknown> | null | undefined): MarineEnvelope {
  return {
    dataMode: str(raw?.['data_mode']) || 'NO_DATA',
    source: str(raw?.['source']),
    observedAt: ts(raw?.['observed_at']),
    asOf: ts(raw?.['as_of']),
  };
}

// ------------------------------------------------------------------ berth states
/** Berth register row + occupancy state at the anchor instant. */
export interface MarineBerthState {
  berthId: number;
  code: string;
  terminal: string;
  terminalName: string;
  operator: string;
  lengthM: number | null;
  designDepthM: number | null;
  /** True when length/depth are PoC planning assumptions (A-M1), not surveyed. */
  dimensionsAssumed: boolean;
  /** 'free' | 'occupied-working' | 'occupied-idle' (spec UI-022). */
  state: string;
  vesselName: string;
  voyageNo: string;
  imoNo: string;
  shippingLine: string;
  alongsideSince: number;
  opsStart: number;
  opsEnd: number;
  recordStatus: string;
}

export interface MarineBerthsResult extends MarineEnvelope {
  items: MarineBerthState[];
  occupied: number;
}

export function parseBerths(raw: unknown): MarineBerthsResult {
  const r = raw as Record<string, unknown> | null;
  const items = Array.isArray(r?.['items']) ? (r!['items'] as Record<string, unknown>[]) : [];
  return {
    ...mapEnvelope(r),
    occupied: num(r?.['occupied']),
    items: items
      .filter((w) => nullableNum(w['berth_id']) !== null && str(w['code']) !== '')
      .map((w) => ({
        berthId: num(w['berth_id']),
        code: str(w['code']),
        terminal: str(w['terminal']),
        terminalName: str(w['terminal_name']),
        operator: str(w['operator']),
        lengthM: nullableNum(w['length_m']),
        designDepthM: nullableNum(w['design_depth_m']),
        dimensionsAssumed: w['dimensions_assumed'] === true,
        state: str(w['state']) || 'free',
        vesselName: str(w['vessel_name']),
        voyageNo: str(w['voyage_no']),
        imoNo: str(w['imo_no']),
        shippingLine: str(w['shipping_line']),
        alongsideSince: ts(w['alongside_since']),
        opsStart: ts(w['ops_start']),
        opsEnd: ts(w['ops_end']),
        recordStatus: str(w['record_status']),
      })),
  };
}

// ------------------------------------------------------------------ berthing plan
/** One forward-plan entry: confirmed (JNPA report) or indicative (PCS declaration). */
export interface MarinePlanEntry {
  /** 'confirmed' | 'indicative' — the Gantt must never style the two the same. */
  kind: 'confirmed' | 'indicative';
  source: string;
  /** Canonical berth code ('' when the source row named none — unassigned lane). */
  berthCode: string;
  /** Raw berth text when it did not resolve to a canonical code. */
  berthRaw: string;
  terminal: string;
  vesselName: string;
  voyageNo: string;
  imoNo: string;
  shippingLine: string;
  status: string;
  startTs: number;
  endTs: number;
  /** True when the source carried no end time (the Gantt draws a default span). */
  endEstimated: boolean;
  /** Stable provenance ref, e.g. 'berthing_record:123' / 'vessel_call:45'. */
  ref: string;
  vcn: string;
  viaNo: string;
}

export interface MarinePlanResult extends MarineEnvelope {
  entries: MarinePlanEntry[];
  windowStart: number;
  windowEnd: number;
  anchor: number;
}

export function parsePlan(raw: unknown): MarinePlanResult {
  const r = raw as Record<string, unknown> | null;
  const win = (r?.['window'] ?? null) as Record<string, unknown> | null;
  const entries = Array.isArray(r?.['entries']) ? (r!['entries'] as Record<string, unknown>[]) : [];
  return {
    ...mapEnvelope(r),
    windowStart: ts(win?.['start']),
    windowEnd: ts(win?.['end']),
    anchor: ts(win?.['anchor']),
    entries: entries
      .filter((w) => ts(w['start_ts']) > 0)
      .map((w) => ({
        kind: str(w['kind']) === 'confirmed' ? 'confirmed' as const : 'indicative' as const,
        source: str(w['source']),
        berthCode: str(w['berth_code']),
        berthRaw: str(w['berth_raw']),
        terminal: str(w['terminal']),
        vesselName: str(w['vessel_name']),
        voyageNo: str(w['voyage_no']),
        imoNo: str(w['imo_no']),
        shippingLine: str(w['shipping_line']),
        status: str(w['status']),
        startTs: ts(w['start_ts']),
        endTs: ts(w['end_ts']),
        endEstimated: w['end_estimated'] === true,
        ref: str(w['ref']),
        vcn: str(w['vcn']),
        viaNo: str(w['via_no']),
      })),
  };
}

const H = 3_600_000;

/**
 * Map marine-plan entries onto the Gantt's `BerthingPlanEntry` shape (UI-028).
 * Kept here (not only in Uc3Adapter) so BerthGantt5Day can call the connector
 * directly when VITE_UC3_ENABLED is on.
 *
 * Estimated stays longer than 48 h are clamped so what-if drag (which requires
 * duration ≤ the 5-day horizon) keeps working even if an older API build
 * returns an uncapped end.
 */
export function toBerthingPlanEntries(
  res: MarinePlanResult,
): import('@/types/domain').BerthingPlanEntry[] {
  const MAX_EST_MS = 48 * H;
  return res.entries.map((e, i) => {
    const started = e.kind === 'confirmed' && e.startTs <= res.anchor;
    let endTs = e.endTs || e.startTs + 24 * H;
    if (e.endEstimated && endTs - e.startTs > MAX_EST_MS) {
      endTs = e.startTs + MAX_EST_MS;
    }
    const ended = endTs > 0 && endTs <= res.anchor;
    return {
      PLAN_ID: e.ref || `plan-${i}`,
      BERTH_ID: e.berthCode || e.berthRaw || 'UNASSIGNED',
      MMSI: e.imoNo ? `IMO:${e.imoNo}` : `VIA:${e.viaNo || e.voyageNo || i}`,
      VESSEL_NAME: e.vesselName || '(unnamed)',
      PLANNED_START: e.startTs,
      PLANNED_END: endTs,
      ACTUAL_START: started ? e.startTs : null,
      ACTUAL_END: started && ended ? endTs : null,
      STATUS: ended ? 'completed' : started ? 'active' : 'scheduled',
      KIND: e.kind,
      END_ESTIMATED: e.endEstimated,
      PROVENANCE: e.source,
    };
  });
}

/** Demo/sim pin for marine dashboard reads (`VITE_UC3_AS_OF`), if set. */
export function marineAsOfMs(): number | undefined {
  const pinned = (import.meta.env.VITE_UC3_AS_OF as string | undefined) ?? '';
  const parsed = pinned ? Date.parse(pinned) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

// ------------------------------------------------------------------ KPIs
/** A JNPA-PUBLISHED baseline figure attached to a KPI (jnport.gov.in Reports). */
export interface MarineKpiBaseline {
  /** Published figure; null when JNPA publishes no figure for this exact KPI. */
  value: number | null;
  unit: string;
  period: string;
  previousValue: number | null;
  previousPeriod: string;
  /** The cited document/page. */
  source: string;
  url: string;
  notes: string;
}

/** One tender KPI with its full card anatomy (spec UI-041). */
export interface MarineKpi {
  key: string;
  name: string;
  value: number | null;
  median: number | null;
  unit: string;
  n: number;
  definition: string;
  basis: string;
  baselineSource: string;
  /** The published-baseline record, when the reference table is loaded. */
  baseline: MarineKpiBaseline | null;
  /** Measured value vs the published baseline, signed % (null when either side missing). */
  vsBaselinePct: number | null;
  /** Measurability caveat — rendered INSTEAD of a fabricated value. */
  note: string;
  series: { ts: number; value: number }[];
}

export interface MarineKpisResult extends MarineEnvelope {
  kpis: MarineKpi[];
  windowDays: number;
  anchor: number;
}

export function parseKpis(raw: unknown): MarineKpisResult {
  const r = raw as Record<string, unknown> | null;
  const win = (r?.['window'] ?? null) as Record<string, unknown> | null;
  const rows = Array.isArray(r?.['kpis']) ? (r!['kpis'] as Record<string, unknown>[]) : [];
  return {
    ...mapEnvelope(r),
    windowDays: num(win?.['days']),
    anchor: ts(win?.['anchor']),
    kpis: rows.map((w) => {
      const b = (w['baseline'] ?? null) as Record<string, unknown> | null;
      return {
        key: str(w['key']),
        name: str(w['name']),
        value: nullableNum(w['value']),
        median: nullableNum(w['median']),
        unit: str(w['unit']),
        n: num(w['n']),
        definition: str(w['definition']),
        basis: str(w['basis']),
        baselineSource: str(w['baseline_source']),
        baseline: b
          ? {
              value: nullableNum(b['value']),
              unit: str(b['unit']),
              period: str(b['period']),
              previousValue: nullableNum(b['previous_value']),
              previousPeriod: str(b['previous_period']),
              source: str(b['source']),
              url: str(b['url']),
              notes: str(b['notes']),
            }
          : null,
        vsBaselinePct: nullableNum(w['vs_baseline_pct']),
        note: str(w['note']),
        series: Array.isArray(w['series'])
          ? (w['series'] as Record<string, unknown>[])
              .map((p) => ({ ts: ts(p['t']), value: num(p['v']) }))
              .filter((p) => p.ts > 0)
          : [],
      };
    }),
  };
}

// ------------------------------------------------------------------ arrivals / departures
export interface MarineArrDepBlock {
  bucketStart: number;
  arrivals: number;
  departures: number;
}

export interface MarineArrDepResult extends MarineEnvelope {
  blocks: MarineArrDepBlock[];
  bucketHours: number;
}

export function parseArrDep(raw: unknown): MarineArrDepResult {
  const r = raw as Record<string, unknown> | null;
  const blocks = Array.isArray(r?.['blocks']) ? (r!['blocks'] as Record<string, unknown>[]) : [];
  return {
    ...mapEnvelope(r),
    bucketHours: num(r?.['bucket_hours']) || 4,
    blocks: blocks
      .map((w) => ({
        bucketStart: ts(w['bucket_start']),
        arrivals: num(w['arrivals']),
        departures: num(w['departures']),
      }))
      .filter((b) => b.bucketStart > 0),
  };
}

// ------------------------------------------------------------------ vessel states
/** One ledger-derived vessel state row for the traffic map (spec UI-020). */
export interface MarineVesselState {
  callId: number | null;
  vcn: string;
  viaNo: string;
  imoNo: string;
  vesselName: string;
  voyageNo: string;
  status: string;
  /** inbound | expected | at_anchorage | under_pilotage | alongside | departed. */
  state: string;
  berthCode: string;
  terminal: string;
  eta: number;
  etb: number;
  etd: number;
  ata: number;
  atd: number;
  anchorDownAt: number;
  pilotBoardedAt: number;
  firstLineAt: number;
  movementType: string;
}

export interface MarineVesselStatesResult extends MarineEnvelope {
  items: MarineVesselState[];
}

export function parseVesselStates(raw: unknown): MarineVesselStatesResult {
  const r = raw as Record<string, unknown> | null;
  const items = Array.isArray(r?.['items']) ? (r!['items'] as Record<string, unknown>[]) : [];
  return {
    ...mapEnvelope(r),
    items: items
      .filter((w) => str(w['vessel_name']) !== '' || str(w['imo_no']) !== '')
      .map((w) => ({
        callId: nullableNum(w['call_id']),
        vcn: str(w['vcn']),
        viaNo: str(w['via_no']),
        imoNo: str(w['imo_no']),
        vesselName: str(w['vessel_name']),
        voyageNo: str(w['voyage_no']),
        status: str(w['status']),
        state: str(w['state']) || 'expected',
        berthCode: str(w['berth_code']),
        terminal: str(w['terminal']),
        eta: ts(w['eta']),
        etb: ts(w['etb']),
        etd: ts(w['etd']),
        ata: ts(w['ata']),
        atd: ts(w['atd']),
        anchorDownAt: ts(w['anchor_down_at']),
        pilotBoardedAt: ts(w['pilot_boarded_at']),
        firstLineAt: ts(w['first_line_at']),
        movementType: str(w['movement_type']),
      })),
  };
}

// ------------------------------------------------------------------ pilot performance
export interface PilotPerformanceRow {
  pilotCode: string;
  n: number;
  medianMin: number | null;
  p90Min: number | null;
  minMin: number | null;
  maxMin: number | null;
}

export interface PilotPerformanceResult extends MarineEnvelope {
  overall: PilotPerformanceRow | null;
  perPilot: PilotPerformanceRow[];
  metric: string;
  movement: string;
}

function mapPerfRow(w: Record<string, unknown>): PilotPerformanceRow {
  return {
    pilotCode: str(w['pilot_code']),
    n: num(w['n']),
    medianMin: nullableNum(w['median_min']),
    p90Min: nullableNum(w['p90_min']),
    minMin: nullableNum(w['min_min']),
    maxMin: nullableNum(w['max_min']),
  };
}

export function parsePilotPerformance(raw: unknown): PilotPerformanceResult {
  const r = raw as Record<string, unknown> | null;
  const overall = (r?.['overall'] ?? null) as Record<string, unknown> | null;
  const per = Array.isArray(r?.['per_pilot']) ? (r!['per_pilot'] as Record<string, unknown>[]) : [];
  return {
    ...mapEnvelope(r),
    overall: overall ? mapPerfRow(overall) : null,
    perPilot: per.map(mapPerfRow),
    metric: str(r?.['metric']),
    movement: str(r?.['movement']),
  };
}

// ------------------------------------------------------------------ six arrival times
/** One row of the six-arrival-times ladder (spec UI-025) — value + named source. */
export interface ArrivalTimeRow {
  key: string;
  label: string;
  /** Epoch ms; 0 = this definition has no source in the ingested corpus. */
  value: number;
  source: string;
  /** True when the value is derived (≈ alongside), not directly recorded. */
  derived: boolean;
  note: string;
}

export interface ArrivalAnomaly {
  code: string;
  days: number;
  message: string;
}

export interface ArrivalTimesResult extends MarineEnvelope {
  callId: number;
  vcn: string;
  viaNo: string;
  vesselName: string;
  voyageNo: string;
  rows: ArrivalTimeRow[];
  ata: number;
  atc: number;
  atd: number;
  anomalies: ArrivalAnomaly[];
}

export function parseArrivalTimes(raw: unknown): ArrivalTimesResult {
  const r = raw as Record<string, unknown> | null;
  const rows = Array.isArray(r?.['arrival_times'])
    ? (r!['arrival_times'] as Record<string, unknown>[]) : [];
  const actuals = (r?.['actuals'] ?? null) as Record<string, unknown> | null;
  const anomalies = Array.isArray(r?.['anomalies'])
    ? (r!['anomalies'] as Record<string, unknown>[]) : [];
  return {
    ...mapEnvelope(r),
    callId: num(r?.['call_id']),
    vcn: str(r?.['vcn']),
    viaNo: str(r?.['via_no']),
    vesselName: str(r?.['vessel_name']),
    voyageNo: str(r?.['voyage_no']),
    ata: ts(actuals?.['ata']),
    atc: ts(actuals?.['atc']),
    atd: ts(actuals?.['atd']),
    rows: rows.map((w) => ({
      key: str(w['key']),
      label: str(w['label']),
      value: ts(w['value']),
      source: str(w['source']),
      derived: w['derived'] === true,
      note: str(w['note']),
    })),
    anomalies: anomalies.map((a) => ({
      code: str(a['code']),
      days: num(a['days']),
      message: str(a['message']),
    })),
  };
}

// ------------------------------------------------------------------ tides
export interface TideReadingRow {
  /** Epoch ms. */
  tideTs: number;
  /** Height above chart datum, metres. */
  heightM: number;
  /** Publishing terminal code (APMT/BMCT/NSFT/NSICT/NSIGT). */
  sourceTerminal: string;
}

export interface TidesResult {
  dataMode: string;
  source: string;
  datum: string;
  items: TideReadingRow[];
}

export function parseTides(raw: unknown): TidesResult {
  const r = raw as Record<string, unknown> | null;
  const items = Array.isArray(r?.['items']) ? (r!['items'] as Record<string, unknown>[]) : [];
  return {
    dataMode: str(r?.['data_mode']) || 'NO_DATA',
    source: str(r?.['source']),
    datum: str(r?.['datum']),
    items: items
      .map((w) => ({
        tideTs: ts(w['tide_ts']),
        heightM: num(w['height_m']),
        sourceTerminal: str(w['source_terminal']),
      }))
      .filter((t) => t.tideTs > 0),
  };
}

// ------------------------------------------------------------------ query builders
function withAt(path: string, at?: number, extra?: Record<string, string | number>): string {
  const q = new URLSearchParams();
  if (at && Number.isFinite(at) && at > 0) q.set('at', new Date(at).toISOString());
  for (const [k, v] of Object.entries(extra ?? {})) q.set(k, String(v));
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

// ------------------------------------------------------------------ fetchers (I/O last)
export async function fetchMarineBerths(at?: number): Promise<MarineBerthsResult> {
  return parseBerths(await http<unknown>(withAt(MARINE_BERTHS_PATH, at)));
}

export async function fetchMarinePlan(at?: number, days = 5): Promise<MarinePlanResult> {
  return parsePlan(await http<unknown>(withAt(MARINE_PLAN_PATH, at, { days })));
}

export async function fetchMarineKpis(at?: number, windowDays = 30): Promise<MarineKpisResult> {
  return parseKpis(await http<unknown>(withAt(MARINE_KPIS_PATH, at, { window_days: windowDays })));
}

export async function fetchMarineArrDep(
  at?: number, hours = 48, bucketHours = 4,
): Promise<MarineArrDepResult> {
  return parseArrDep(await http<unknown>(
    withAt(MARINE_ARR_DEP_PATH, at, { hours, bucket_hours: bucketHours })));
}

export async function fetchMarineVesselStates(at?: number): Promise<MarineVesselStatesResult> {
  return parseVesselStates(await http<unknown>(withAt(MARINE_VESSEL_STATES_PATH, at)));
}

export async function fetchPilotPerformance(movement?: string): Promise<PilotPerformanceResult> {
  const path = movement
    ? `${MARINE_PILOT_PERF_PATH}?movement=${encodeURIComponent(movement)}`
    : MARINE_PILOT_PERF_PATH;
  return parsePilotPerformance(await http<unknown>(path));
}

export async function fetchArrivalTimes(callId: number): Promise<ArrivalTimesResult> {
  return parseArrivalTimes(await http<unknown>(marineArrivalTimesPath(callId)));
}

export async function fetchTides(
  fromMs?: number, toMs?: number, terminal?: string,
): Promise<TidesResult> {
  const q = new URLSearchParams();
  if (fromMs && fromMs > 0) q.set('from', new Date(fromMs).toISOString());
  if (toMs && toMs > 0) q.set('to', new Date(toMs).toISOString());
  if (terminal) q.set('terminal', terminal);
  const qs = q.toString();
  return parseTides(await http<unknown>(qs ? `${MARINE_TIDES_PATH}?${qs}` : MARINE_TIDES_PATH));
}

// ------------------------------------------------------------------ published baselines
export const KPI_BASELINES_PATH = '/marine/reference/kpi-baselines';

/** The API-managed published-baseline register, keyed by KPI key. Pure mapper. */
export function parseKpiBaselines(raw: unknown): Map<string, MarineKpiBaseline> {
  const r = raw as Record<string, unknown> | null;
  const items = Array.isArray(r?.['items']) ? (r!['items'] as Record<string, unknown>[]) : [];
  const out = new Map<string, MarineKpiBaseline>();
  for (const w of items) {
    const key = str(w['kpi_key']);
    if (!key) continue;
    out.set(key, {
      value: nullableNum(w['baseline_value']),
      unit: str(w['unit']),
      period: str(w['period']),
      previousValue: nullableNum(w['previous_value']),
      previousPeriod: str(w['previous_period']),
      source: str(w['source_document']),
      url: str(w['source_url']),
      notes: str(w['notes']),
    });
  }
  return out;
}

/** JNPA-published KPI baselines (jnport.gov.in ▸ Reports), API-managed. */
export async function fetchKpiBaselines(): Promise<Map<string, MarineKpiBaseline>> {
  return parseKpiBaselines(await http<unknown>(KPI_BASELINES_PATH));
}
