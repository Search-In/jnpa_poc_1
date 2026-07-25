/**
 * UC-3 Marine port-craft register connector — the tug/launch fleet particulars.
 *
 * Reads `/api/marine/port-craft*` and maps the gateway's wire rows onto the UC-1 domain
 * type. Structured like pilotage.ts / marineCalls.ts: endpoint constants, a typed *wire*
 * interface, exported PURE mappers, I/O last — unit-testable with no network.
 *
 * Backing store: `core.port_craft`, populated by the SHARED marine upload endpoints
 * (`/api/marine/upload`) when Details_of_Port_Crafts.pdf is uploaded. This is the STATIC
 * fleet REGISTER (particulars: LOA / bollard pull / owner), distinct from the live-ops
 * PortCraftUnit telemetry (status / assigned MMSI / response time) served by the mock
 * adapter — the two must not be merged.
 */

import type { PortCraft } from '@/types/domain';
import { http } from './client';

export const PORT_CRAFT_PATH = '/marine/port-craft';
export const PORT_CRAFT_PAGE_LIMIT = 100;

/** One craft row exactly as the gateway returns it. Snake_case wire shape. */
export interface PortCraftWire {
  craft_id: number | null;
  name: string | null;
  craft_type: string | null;
  owned_or_hired: string | null;
  owner_name: string | null;
  year_built: string | null;
  loa_m: number | null;
  breadth_m: number | null;
  draft_m: number | null;
  main_engines: string | null;
  bollard_pull_t: number | null;
  design_speed_kn: number | null;
  import_file_id: number | null;
  extras: Record<string, unknown> | null;
}

export interface PortCraftPage {
  items: PortCraftWire[];
  total: number;
  limit: number;
  offset: number;
  count: number;
}

export interface PortCraftFilters {
  craftType?: string;
  ownedOrHired?: string;
  name?: string;
  owner?: string;
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

/** Map one wire row onto the domain type. Pure. Drops a row with no `craft_id`. */
export function mapPortCraft(w: PortCraftWire): PortCraft | null {
  const craftId = nullableNum(w?.craft_id);
  if (craftId === null) return null;
  return {
    craftId,
    name: str(w.name),
    craftType: str(w.craft_type),
    ownedOrHired: str(w.owned_or_hired),
    ownerName: str(w.owner_name),
    yearBuilt: str(w.year_built),
    loaM: nullableNum(w.loa_m),
    breadthM: nullableNum(w.breadth_m),
    draftM: nullableNum(w.draft_m),
    mainEngines: str(w.main_engines),
    bollardPullT: nullableNum(w.bollard_pull_t),
    designSpeedKn: nullableNum(w.design_speed_kn),
    extras: (w.extras && typeof w.extras === 'object') ? w.extras : {},
  };
}

/** Map a whole page, dropping unusable rows, preserving server order. Pure, tolerant. */
export function parsePortCraftPage(raw: unknown): PortCraft[] {
  const items = (raw as PortCraftPage | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.map(mapPortCraft).filter((c): c is PortCraft => c !== null);
}

/** Build the query string. Pure. */
export function portCraftQuery(
  filters: PortCraftFilters = {},
  limit = PORT_CRAFT_PAGE_LIMIT,
  offset = 0,
): string {
  const q = new URLSearchParams();
  const put = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== null && `${v}`.trim() !== '') q.set(k, `${v}`);
  };
  put('craft_type', filters.craftType);
  put('owned_or_hired', filters.ownedOrHired);
  put('name', filters.name);
  put('owner', filters.owner);
  put('sort', filters.sort);
  put('direction', filters.direction);
  q.set('limit', String(limit));
  q.set('offset', String(offset));
  return `${PORT_CRAFT_PATH}?${q.toString()}`;
}

/**
 * Fetch the register (the roster is small — ~18 crafts — so one page suffices).
 * Rejects (never throws synchronously) so a caller can surface the error state.
 */
export async function fetchPortCraft(
  filters: PortCraftFilters = {},
  limit = PORT_CRAFT_PAGE_LIMIT,
  offset = 0,
): Promise<PortCraft[]> {
  const page = await http<PortCraftPage>(portCraftQuery(filters, limit, offset));
  return parsePortCraftPage(page);
}

/** Fetch the register WITH its envelope, for a table that needs `total`. */
export async function fetchPortCraftPage(
  filters: PortCraftFilters = {},
  limit = PORT_CRAFT_PAGE_LIMIT,
  offset = 0,
): Promise<{ items: PortCraft[]; total: number; limit: number; offset: number }> {
  const page = await http<PortCraftPage>(portCraftQuery(filters, limit, offset));
  return {
    items: parsePortCraftPage(page),
    total: num(page?.total),
    limit: num(page?.limit) || limit,
    offset: num(page?.offset),
  };
}
