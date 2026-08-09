/**
 * UC-3 Marine vessel-master connector — the port-approved hull registry.
 *
 * Reads `/api/marine/vessels*` and maps the gateway's wire rows onto the UC-1 domain
 * type. Structured like portCraft.ts / pilotage.ts: endpoint constants, a typed *wire*
 * interface, exported PURE mappers, I/O last — unit-testable with no network.
 *
 * Backing store: `core.vessel`, populated by the SHARED marine upload endpoints
 * (`/api/marine/upload`) when a VESPRO XML is uploaded. This is the static HULL registry
 * (particulars: LOA / draft / GRT / TEU), distinct from:
 *   • the live-ops `Vessel` telemetry served by the mock/AIS adapters (keyed on MMSI), and
 *   • `VesselCall` (keyed on VCN) served by marineCalls.ts — a hull has many calls.
 * The three must not be merged.
 *
 * VESPRO is sparse by nature, so `nullableNum` is used for every particular: an absent
 * TEU stays null rather than becoming 0.
 */

import type { VesselMaster } from '@/types/domain';
import { http } from './client';

export const VESSELS_PATH = '/marine/vessels';
export const VESSELS_PAGE_LIMIT = 100;

/** One P&I cover block exactly as the gateway returns it. */
export interface VesselInsuranceWire {
  pi_club: string | null;
  valid_until: string | null;
}

/** One vessel row exactly as the gateway returns it. Snake_case wire shape. */
export interface VesselWire {
  imo_no: string | null;
  vessel_name: string | null;
  call_sign: string | null;
  flag: string | null;
  vessel_type: string | null;
  mtmv: string | null;
  loa_m: number | null;
  beam_m: number | null;
  lbp_m: number | null;
  max_draft_m: number | null;
  grt: number | null;
  nrt: number | null;
  dwt: number | null;
  teu_capacity: number | null;
  mmsi: string | null;
  engine_type: string | null;
  num_engines: number | null;
  propulsion_type: string | null;
  num_propellers: number | null;
  max_speed_kn: number | null;
  bow_thruster: boolean | null;
  stern_thruster: boolean | null;
  built_date: string | null;
  reg_port: string | null;
  owner_name: string | null;
  email: string | null;
  vespro_ref: string | null;
  updated_at: string | null;
  insurance?: VesselInsuranceWire[] | null;
}

export interface VesselPage {
  items: VesselWire[];
  total: number;
  limit: number;
  offset: number;
  count: number;
}

export interface VesselStatsWire {
  total: number | null;
  with_dimensions: number | null;
  with_teu: number | null;
  with_mmsi: number | null;
  avg_loa_m: number | null;
  max_draft_m: number | null;
  by_flag: { flag: string | null; count: number | null }[] | null;
}

/** Registry completeness — `withDimensions` is the berth-fit readiness signal. */
export interface VesselStats {
  total: number;
  withDimensions: number;
  withTeu: number;
  withMmsi: number;
  avgLoaM: number | null;
  maxDraftM: number | null;
  byFlag: { flag: string; count: number }[];
}

export interface VesselFilters {
  flag?: string;
  vesselType?: string;
  name?: string;
  imo?: string;
  owner?: string;
  callSign?: string;
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
/** Tri-state passthrough — `false` must survive, so this is not a truthiness check. */
function triBool(v: boolean | null | undefined): boolean | null {
  return v === null || v === undefined ? null : Boolean(v);
}

/** Map one wire row onto the domain type. Pure. Drops a row with no `imo_no` (the key). */
export function mapVessel(w: VesselWire): VesselMaster | null {
  const imoNo = str(w?.imo_no);
  if (!imoNo) return null;
  return {
    imoNo,
    vesselName: str(w.vessel_name),
    callSign: str(w.call_sign),
    flag: str(w.flag),
    vesselType: str(w.vessel_type),
    loaM: nullableNum(w.loa_m),
    beamM: nullableNum(w.beam_m),
    lbpM: nullableNum(w.lbp_m),
    maxDraftM: nullableNum(w.max_draft_m),
    grt: nullableNum(w.grt),
    nrt: nullableNum(w.nrt),
    dwt: nullableNum(w.dwt),
    teuCapacity: nullableNum(w.teu_capacity),
    mmsi: str(w.mmsi),
    engineType: str(w.engine_type),
    propulsionType: str(w.propulsion_type),
    maxSpeedKn: nullableNum(w.max_speed_kn),
    bowThruster: triBool(w.bow_thruster),
    sternThruster: triBool(w.stern_thruster),
    builtDate: str(w.built_date),
    regPort: str(w.reg_port),
    ownerName: str(w.owner_name),
    insurance: (w.insurance ?? [])
      .filter((i) => str(i?.pi_club) !== '')
      .map((i) => ({ piClub: str(i.pi_club), validUntil: str(i.valid_until) })),
  };
}

/** Map a whole page, dropping unusable rows, preserving server order. Pure, tolerant. */
export function parseVesselPage(raw: unknown): VesselMaster[] {
  const items = (raw as VesselPage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(mapVessel).filter((v): v is VesselMaster => v !== null);
}

/** Map the stats envelope. Pure, tolerant of a partial payload. */
export function mapVesselStats(raw: unknown): VesselStats {
  const w = (raw ?? {}) as VesselStatsWire;
  return {
    total: num(w.total),
    withDimensions: num(w.with_dimensions),
    withTeu: num(w.with_teu),
    withMmsi: num(w.with_mmsi),
    avgLoaM: nullableNum(w.avg_loa_m),
    maxDraftM: nullableNum(w.max_draft_m),
    byFlag: (w.by_flag ?? [])
      .filter((f) => str(f?.flag) !== '')
      .map((f) => ({ flag: str(f.flag), count: num(f.count) })),
  };
}

/** Build the list query string. Pure. */
export function vesselsQuery(
  filters: VesselFilters = {},
  limit = VESSELS_PAGE_LIMIT,
  offset = 0,
): string {
  const q = new URLSearchParams();
  const put = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== null && `${v}`.trim() !== '') q.set(k, `${v}`);
  };
  put('flag', filters.flag);
  put('vessel_type', filters.vesselType);
  put('name', filters.name);
  put('imo', filters.imo);
  put('owner', filters.owner);
  put('call_sign', filters.callSign);
  put('sort', filters.sort);
  put('direction', filters.direction);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${VESSELS_PATH}?${q.toString()}`;
}

/**
 * Fetch the registry WITH its envelope, for a table that needs `total`.
 * Rejects (never throws synchronously) so a caller can surface the error state.
 */
export async function fetchVesselsPage(
  filters: VesselFilters = {},
  limit = VESSELS_PAGE_LIMIT,
  offset = 0,
): Promise<{ items: VesselMaster[]; total: number; limit: number; offset: number }> {
  const page = await http<VesselPage>(vesselsQuery(filters, limit, offset));
  return {
    items: parseVesselPage(page),
    total: num(page?.total),
    limit: num(page?.limit) || limit,
    offset: num(page?.offset),
  };
}

/** Registry completeness counters for the summary cards. */
export async function fetchVesselStats(): Promise<VesselStats> {
  return mapVesselStats(await http<VesselStatsWire>(`${VESSELS_PATH}/stats`));
}

/** One hull + its P&I cover. Resolves to null when the IMO is unknown (404). */
export async function fetchVessel(imoNo: string): Promise<VesselMaster | null> {
  const w = await http<VesselWire>(`${VESSELS_PATH}/${encodeURIComponent(imoNo)}`);
  return mapVessel(w);
}
