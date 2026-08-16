/**
 * Fallback read models when the UC-1 dashboard routes are absent (HTTP 404).
 *
 * Older gateway builds expose `/marine/calls` (with lifecycle) and
 * `/marine/state/*` but not `/marine/vessel-states`, `/marine/berths`, or
 * `/marine/kpis`. This module synthesises the dashboard wire shapes from those
 * existing endpoints so Uc3Adapter keeps working without schema changes.
 */

import type { VesselCall } from '@/types/domain';
import { http } from './client';
import {
  fetchVesselCallsPage,
  fetchMarineStats,
  MARINE_CALLS_PAGE_LIMIT,
} from './marineCalls';
import { BERTH_STATE_PATH } from './dashboardKpis';
import {
  parseBerths,
  parseKpis,
  parseVesselStates,
  type MarineBerthsResult,
  type MarineKpisResult,
  type MarineVesselStatesResult,
} from './marineDashboard';

const H = 3_600_000;
const H12 = 12 * H;
const D7 = 7 * 24 * H;

const SHIM_SOURCE = 'JNPA marine corpus (shim: /marine/calls + /marine/state/*)';

/** True when `http()` rejected with an HTTP 404 from the UC-3 gateway. */
export function isHttpNotFound(err: unknown): boolean {
  return err instanceof Error && /→ HTTP 404\b/.test(err.message);
}

/** Mirror of backend ``traffic_state()`` — keep in sync with dashboard_boards.py. */
export function trafficStateFromCall(c: VesselCall, atMs: number): string {
  const lc = c.lifecycle;
  const atd = c.atd;
  if (atd > 0 && atd <= atMs && atMs - atd <= H12) return 'departed';
  if (lc?.isAtBerth) return 'alongside';
  if (
    lc &&
    ['Active', 'Onboard', 'Assigned'].includes(lc.pilotState) &&
    !lc.isAtBerth
  ) {
    return 'under_pilotage';
  }
  if (
    lc?.arrivalState.trim().toLowerCase() === 'anchored' ||
    (lc?.isInPort && !lc.isAtBerth)
  ) {
    return 'at_anchorage';
  }
  const eta = c.etb || c.eta;
  if (eta > atMs) return c.ata > 0 ? 'inbound' : 'expected';
  return 'expected';
}

/** Mirror of backend ``_CALLS_FOR_TRAFFIC`` — client-side filter on call rows. */
export function callInTrafficPicture(c: VesselCall, atMs: number): boolean {
  const lo = atMs - D7;
  const hi = atMs + D7;
  const ata = c.ata;
  const atd = c.atd;
  if (ata > 0 && ata <= atMs && (atd === 0 || atd > atMs)) return true;
  if (atd > 0 && atd <= atMs && atd > atMs - H12) return true;
  const et = c.etb || c.eta;
  if (et > 0 && et >= lo && et <= hi && (atd === 0 || atd > atMs)) return true;
  return false;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function envelope(atMs: number): Record<string, string> {
  const anchor = iso(atMs);
  return {
    data_mode: 'CACHED',
    source: SHIM_SOURCE,
    observed_at: anchor,
    as_of: anchor,
  };
}

/** Paginate the full call register — PoC corpus is small enough for this. */
async function fetchAllCalls(): Promise<VesselCall[]> {
  const limit = MARINE_CALLS_PAGE_LIMIT;
  let offset = 0;
  const all: VesselCall[] = [];
  for (;;) {
    const page = await fetchVesselCallsPage({}, limit, offset);
    all.push(...page.items);
    if (all.length >= page.total || page.items.length < limit) break;
    offset += limit;
    if (offset >= 5_000) break;
  }
  return all;
}

function mapCallToVesselState(c: VesselCall, atMs: number): Record<string, unknown> {
  const state = trafficStateFromCall(c, atMs);
  return {
    call_id: c.callId,
    vcn: c.vcn,
    via_no: c.viaNo,
    imo_no: c.imoNo,
    vessel_name: c.vesselName,
    voyage_no: c.voyageNo,
    status: c.lifecycle?.status || c.status,
    state,
    berth_code: c.berthCode,
    terminal: c.terminalCode,
    eta: c.eta > 0 ? iso(c.eta) : null,
    etb: c.etb > 0 ? iso(c.etb) : null,
    etd: c.etd > 0 ? iso(c.etd) : null,
    ata: c.ata > 0 ? iso(c.ata) : null,
    atd: c.atd > 0 ? iso(c.atd) : null,
    anchor_down_at: null,
    pilot_boarded_at: null,
    first_line_at: null,
    movement_type: state === 'inbound' || state === 'expected' ? 'INBOUND' : 'PORT',
  };
}

/** Build ``GET /marine/vessel-states`` from paginated ``/marine/calls``. */
export async function shimVesselStatesFromCalls(atMs?: number): Promise<MarineVesselStatesResult> {
  const anchor = atMs && atMs > 0 ? atMs : Date.now();
  const calls = await fetchAllCalls();
  const items = calls
    .filter((c) => callInTrafficPicture(c, anchor))
    .filter((c) => c.vesselName || c.imoNo)
    .map((c) => mapCallToVesselState(c, anchor));
  return parseVesselStates({ ...envelope(anchor), items });
}

interface BerthStateWire {
  berth_id: number;
  code: string | null;
  terminal_id: number | null;
  state: string;
  occupied_by: {
    call_id?: number;
    vcn?: string;
    via_no?: string;
    vessel_name?: string;
    berth_state?: string;
    is_at_berth?: boolean;
    latest_event?: string;
  } | null;
}

interface BerthOccupancyWire {
  berths: BerthStateWire[];
  total: number;
  occupied: number;
  allotted: number;
  free: number;
}

function mapBerthUiState(engState: string): string {
  const s = engState.trim().toLowerCase();
  if (s === 'free') return 'free';
  if (s === 'occupied' || s === 'allotted') return 'occupied-idle';
  return 'free';
}

/** Build ``GET /marine/berths`` from ``GET /marine/state/berths``. */
export async function shimBerthsFromState(atMs?: number): Promise<MarineBerthsResult> {
  const anchor = atMs && atMs > 0 ? atMs : Date.now();
  const occ = await http<BerthOccupancyWire>(BERTH_STATE_PATH);
  const items = (occ.berths ?? []).map((b) => {
    const occBy = b.occupied_by;
    return {
      berth_id: b.berth_id,
      code: b.code ?? '',
      terminal: '',
      terminal_name: '',
      operator: '',
      length_m: null,
      design_depth_m: null,
      dimensions_assumed: true,
      state: mapBerthUiState(b.state),
      vessel_name: occBy?.vessel_name ?? '',
      voyage_no: '',
      imo_no: '',
      shipping_line: '',
      alongside_since: null,
      ops_start: null,
      ops_end: null,
      record_status: occBy?.berth_state ?? '',
    };
  });
  const occupied = items.filter((i) => i.state !== 'free').length;
  return parseBerths({ ...envelope(anchor), items, occupied });
}

function kpiCard(
  key: string,
  name: string,
  value: number | null,
  unit: string,
  n: number,
  definition: string,
  basis: string,
  note = '',
  baselineSource = 'JNPA baseline',
): Record<string, unknown> {
  return {
    key,
    name,
    value,
    median: null,
    unit,
    n,
    definition,
    basis,
    baseline_source: baselineSource,
    baseline: null,
    vs_baseline_pct: null,
    note,
    series: [],
  };
}

/** Build ``GET /marine/kpis`` from stats + state berths + shim vessel states. */
export async function shimKpisFromCallsAndState(
  atMs?: number,
  windowDays = 30,
): Promise<MarineKpisResult> {
  const anchor = atMs && atMs > 0 ? atMs : Date.now();
  const lo = new Date(anchor - windowDays * 24 * H).toISOString();
  const hi = new Date(anchor + 24 * H).toISOString();

  const [stats, berths, vesselStates] = await Promise.all([
    fetchMarineStats({ from: lo, to: hi }),
    http<BerthOccupancyWire>(BERTH_STATE_PATH),
    shimVesselStatesFromCalls(anchor),
  ]);

  const occTotal = berths.total ?? 0;
  const occN = berths.occupied ?? 0;
  const occPct = occTotal > 0 ? Math.round((100 * occN) / occTotal * 10) / 10 : null;

  const anchored = vesselStates.items.filter((s) => s.state === 'at_anchorage').length;
  const approaching = vesselStates.items.filter(
    (s) => s.state === 'inbound' || s.state === 'expected',
  ).length;

  void anchored;
  void approaching;

  const tat = stats.avgTurnaroundHours;
  const preBerth = stats.avgPreBerthDelayHours;

  const kpis = [
    kpiCard(
      'PRE_BERTH_DELAY',
      'Pre-Berthing Delay',
      preBerth,
      'h',
      stats.total,
      'Mean hours between declared ETA and actual arrival (ATA − ETA)',
      'core.vessel_call factual timestamps',
      preBerth != null ? '' : 'not measurable — no calls with both ETA and ATA in window',
    ),
    kpiCard(
      'PRE_SAIL_DELAY',
      'Pre-Sailing Delay',
      null,
      'h',
      0,
      'Mean hours between planned and actual sailing',
      'requires ATC/ATD pairing — not in corpus at anchor',
      'not measurable — ATC not populated for this corpus slice',
    ),
    kpiCard(
      'AVG_TAT',
      'Average Vessel TAT',
      tat,
      'h',
      stats.departed,
      'mean(ATD − ATA) for completed calls',
      'core.vessel_call factual timestamps (ATA / ATD)',
      tat != null ? '' : 'not measurable — no completed calls with both ATA and ATD',
      'jnport.gov.in Operating Performance Profile 27.36 h pilot-to-pilot FY 2025-26',
    ),
    kpiCard(
      'JIT_PCT',
      'JIT',
      null,
      '%',
      0,
      'Share of arrivals within ±60 min of the recommended slot',
      'requires berthing-plan slot comparison — not computed here',
      'not measurable — JIT needs plan-slot linkage at anchor',
    ),
    kpiCard(
      'FORECAST_ACC',
      'Accuracy of Prediction',
      null,
      '%',
      0,
      'Share of arrivals within ±4 h of declared ETA',
      'berthing-report ETA vs ATA',
      'see Prediction vs Actual panel for rolling MAE',
    ),
    kpiCard(
      'BERTH_OCC',
      'Berth Occupancy',
      occPct,
      '%',
      occTotal,
      'Occupied share of container-terminal berths at the anchor instant',
      'Marine Projection berth occupancy',
      occPct != null ? '' : 'no berths in register',
    ),
  ];

  return parseKpis({
    ...envelope(anchor),
    window: { days: windowDays, anchor: iso(anchor) },
    kpis,
  });
}
