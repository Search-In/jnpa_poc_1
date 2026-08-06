/**
 * UC-3 Port-Craft DEMAND connector — fleet capacity + live craft demand.
 *
 * Reads `GET /api/marine/state/port-craft`, which the backend already derives from the
 * shared Marine Projection: every call whose engine `portcraft_state` is Busy, split into
 * the phase the engine's own fields put it in (sailing → outbound, at berth → alongside,
 * pilot active → inbound). This module maps wire → domain and derives NOTHING.
 *
 * WHAT THIS IS NOT
 * ----------------
 * It is DEMAND, never utilisation. `core.port_craft` holds no operational state and no
 * column links a craft to a call, so "which tug is on which job" — and any utilisation
 * ratio — is not in the data. The backend refuses to publish one (state_service.py) and
 * this connector adds no such field, so a caller cannot render one by accident.
 *
 * Every value here is traceable to a backend field. Each demand row also carries the
 * call's OWN lifecycle (status, arrival/pilot/berth/departure state, movement phase),
 * copied by the gateway from the same projection that put the row in its phase — so a
 * consumer can show WHY a call counts toward demand without deriving anything.
 */

import { http } from './client';
// Same ISO->epoch, fallback-to-0 posture every other UC-3 connector uses.
import { toEpochMs } from './shippingLines';

/** One craft-type row of the fleet register. */
export interface CraftTypeCountWire {
  craft_type: string | null;
  count: number | null;
}

export interface FleetWire {
  total: number | null;
  by_type: CraftTypeCountWire[] | null;
}

/** Phase counts. Backend computes these as len() of the arrays below — they cannot drift. */
export interface CraftDemandCountsWire {
  total: number | null;
  inbound_movement: number | null;
  alongside: number | null;
  outbound_movement: number | null;
}

/**
 * One CALL that requires craft. Note the axis: this is the VESSEL needing craft, not a
 * craft serving a vessel — the latter does not exist in the schema.
 */
export interface CraftMovementWire {
  call_id: number | null;
  vcn: string | null;
  via_no: string | null;
  vessel_name: string | null;
  berth_id: number | null;
  latest_event: string | null;
  /**
   * ADDITIVE and optional — the call's own lifecycle, copied by the gateway from the
   * same CallProjection this row was built from. Absent on a gateway predating it.
   */
  imo_no?: string | null;
  status?: string | null;
  arrival_state?: string | null;
  pilot_state?: string | null;
  berth_state?: string | null;
  departure_state?: string | null;
  shipping_state?: string | null;
  portcraft_state?: string | null;
  latest_event_time?: string | null;
  /** Inbound | Alongside | Outbound — the bucket the backend already sorted this into. */
  movement_phase?: string | null;
}

export interface PortCraftDemandWire {
  fleet: FleetWire | null;
  demand: CraftDemandCountsWire | null;
  inbound_movement: CraftMovementWire[] | null;
  alongside: CraftMovementWire[] | null;
  outbound_movement: CraftMovementWire[] | null;
  active_calls: number | null;
}

/** The three phases, in the order the backend evaluates them. */
export type CraftPhase = 'inbound' | 'alongside' | 'outbound';

export interface CraftMovement {
  callId: number | null;
  vcn: string;
  viaNo: string;
  vesselName: string;
  /**
   * Numeric berth key as the backend sends it. Deliberately NOT resolved to a berth code
   * here — that would need a second endpoint, and an unresolved id must not be rendered
   * as if it were a berth name.
   */
  berthId: number | null;
  /** Highest-RANK milestone the projection reported. */
  latestEvent: string;
  /**
   * The call's lifecycle, as the backend projection reported it. These explain WHY the
   * call counts toward demand; nothing here is computed client-side.
   */
  imoNo: string;
  status: string;
  arrivalState: string;
  pilotState: string;
  berthState: string;
  departureState: string;
  shippingState: string;
  portcraftState: string;
  /** Epoch ms; 0 when the projection reported none. */
  latestEventTime: number;
  /** Inbound | Alongside | Outbound. */
  movementPhase: string;
}

export interface CraftTypeCount {
  craftType: string;
  count: number;
}

export interface PortCraftDemand {
  fleetTotal: number;
  fleetByType: CraftTypeCount[];
  /** Counts as the backend reported them. */
  totalDemand: number;
  inboundCount: number;
  alongsideCount: number;
  outboundCount: number;
  /** The calls behind each count. */
  inbound: CraftMovement[];
  alongside: CraftMovement[];
  outbound: CraftMovement[];
  activeCalls: number;
}

export const PORT_CRAFT_STATE_PATH = '/marine/state/port-craft';

function str(v: string | null | undefined): string {
  return typeof v === 'string' ? v : '';
}

function num(v: number | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nullableNum(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map one demand row. Pure. */
export function mapCraftMovement(w: CraftMovementWire): CraftMovement {
  return {
    callId: nullableNum(w?.call_id),
    vcn: str(w?.vcn),
    viaNo: str(w?.via_no),
    vesselName: str(w?.vessel_name),
    berthId: nullableNum(w?.berth_id),
    latestEvent: str(w?.latest_event),
    imoNo: str(w?.imo_no),
    status: str(w?.status),
    arrivalState: str(w?.arrival_state),
    pilotState: str(w?.pilot_state),
    berthState: str(w?.berth_state),
    departureState: str(w?.departure_state),
    shippingState: str(w?.shipping_state),
    portcraftState: str(w?.portcraft_state),
    latestEventTime: toEpochMs(w?.latest_event_time),
    movementPhase: str(w?.movement_phase),
  };
}

function mapMovements(rows: CraftMovementWire[] | null | undefined): CraftMovement[] {
  return Array.isArray(rows) ? rows.map(mapCraftMovement) : [];
}

/**
 * Map the whole envelope. Pure and tolerant — a malformed payload yields an empty
 * dashboard rather than throwing, so the Port Craft tab can never be broken by it.
 */
export function parsePortCraftDemand(raw: unknown): PortCraftDemand {
  const w = (raw ?? {}) as PortCraftDemandWire;
  const byType = Array.isArray(w.fleet?.by_type) ? w.fleet!.by_type! : [];
  return {
    fleetTotal: num(w.fleet?.total),
    fleetByType: byType
      .map((t) => ({ craftType: str(t?.craft_type), count: num(t?.count) }))
      .filter((t) => t.craftType !== ''),
    totalDemand: num(w.demand?.total),
    inboundCount: num(w.demand?.inbound_movement),
    alongsideCount: num(w.demand?.alongside),
    outboundCount: num(w.demand?.outbound_movement),
    inbound: mapMovements(w.inbound_movement),
    alongside: mapMovements(w.alongside),
    outbound: mapMovements(w.outbound_movement),
    activeCalls: num(w.active_calls),
  };
}

/**
 * Fetch the demand board. Resolves to null on ANY failure so the caller degrades to the
 * page it already rendered — a gateway outage must not break the Port Craft tab.
 */
export async function fetchPortCraftDemand(): Promise<PortCraftDemand | null> {
  try {
    return parsePortCraftDemand(await http<PortCraftDemandWire>(PORT_CRAFT_STATE_PATH));
  } catch {
    return null;
  }
}

/** `/marine/state/berths` — the same endpoint the dashboard KPI overlay already reads. */
export const BERTH_STATE_PATH = '/marine/state/berths';

interface BerthRowWire {
  berth_id: number | null;
  code: string | null;
}

/**
 * berth_id → berth code, so a demand row can name the berth instead of showing the raw
 * numeric key. Pure mapping over an EXISTING endpoint — no new API, no backend change.
 */
export function parseBerthCodes(raw: unknown): Map<number, string> {
  const rows = (raw as { berths?: BerthRowWire[] } | null)?.berths;
  const out = new Map<number, string>();
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const id = nullableNum(r?.berth_id);
    const code = str(r?.code);
    if (id !== null && code) out.set(id, code);
  }
  return out;
}

/**
 * Resolves to an EMPTY map on any failure — never null. The caller then falls back to the
 * berth STATE it already has, so the column degrades from 'CB02' to 'Currently Berthed'
 * rather than breaking the table.
 */
export async function fetchBerthCodes(): Promise<Map<number, string>> {
  try {
    return parseBerthCodes(await http<unknown>(BERTH_STATE_PATH));
  } catch {
    return new Map();
  }
}
