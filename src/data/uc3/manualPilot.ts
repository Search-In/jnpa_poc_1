/**
 * UC-3 Marine manual-pilot-assignment connector — the operator fallback path.
 *
 * Reads and writes `/api/marine/manual-pilot-assignment*`. Structured like pilotage.ts:
 * endpoint constants, a typed *wire* interface separate from the domain type, an
 * exported PURE mapper, and the I/O functions last.
 *
 * These records are BACKEND state, not browser state. That is the whole point of this
 * module: before it existed the assignment lived in a zustand store, so Vessel Calls,
 * Port Craft, Marine State and the Timeline — which all read the backend — still showed
 * `Pilot = Pending` after an operator had assigned someone. There were two sources of
 * truth; now there is one.
 *
 * PRECEDENCE. The backend refuses (409) an assignment onto a call that already has
 * IMPORTED pilotage, and deactivates a manual record as soon as a pilot memo lands for
 * that call. Nothing here needs to re-implement that rule — it only surfaces it.
 */

import { http } from './client';
import { toEpochMs } from './shippingLines';

export const MANUAL_PILOT_PATH = '/marine/manual-pilot-assignment';

/** One assignment exactly as the gateway returns it. Snake_case wire shape. */
export interface ManualPilotWire {
  id: number | null;
  call_id: number | null;
  vcn: string | null;
  via_no: string | null;
  imo_no: string | null;
  vessel_name: string | null;
  pilot_code: string | null;
  pilot_name: string | null;
  status: string | null;
  /** INWARD | OUTWARD | SHIFTING. Null on assignments predating gateway migration 0054. */
  movement_type: string | null;
  /** Destination berth declared at assignment. Null for OUTWARD and pre-0055 rows. */
  berth_id: number | null;
  assigned_at: string | null;
  boarded_at: string | null;
  released_at: string | null;
  created_by: string | null;
  active: boolean | null;
  superseded_at: string | null;
}

/** camelCase + epoch ms (0 = unknown), matching every other UC-3 connector. */
export interface ManualPilotAssignment {
  id: number;
  callId: number;
  vcn: string;
  viaNo: string;
  imoNo: string;
  vesselName: string;
  pilotCode: string;
  pilotName: string;
  /** Assigned | Onboard | Released. */
  status: string;
  /**
   * The leg this pilot ran: INWARD | OUTWARD | SHIFTING, '' when never declared.
   *
   * It is what lets Release advance the VISIT, not just the pilot: the gateway records
   * BERTHED for an inward or shifting movement and SAILED for an outward one. Without it
   * a release wrote PILOT_DISEMBARKED alone, which the status ladder does not read, so
   * the call stuck at 'Pilot Boarded' with the pilot showing Completed beside it.
   */
  movementType: string;
  /**
   * Destination berth the operator declared, null when none applies.
   *
   * A SHIFTING movement is DEFINED by this: without it the release recorded 'she is fast
   * alongside' while the call still named the berth she had just left. Null for OUTWARD
   * (she is leaving) and for assignments made before the field existed.
   */
  berthId: number | null;
  assignedAt: number;
  boardedAt: number;
  releasedAt: number;
  createdBy: string;
  /** False once imported pilotage arrived for this call. The row is kept for audit. */
  active: boolean;
  supersededAt: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Wire → domain. Pure; exported so it can be unit-tested with no network. */
export function mapManualPilot(w: Partial<ManualPilotWire> | null | undefined): ManualPilotAssignment | null {
  const id = w?.id;
  const callId = w?.call_id;
  if (typeof id !== 'number' || typeof callId !== 'number') return null;
  return {
    id,
    callId,
    vcn: str(w?.vcn),
    viaNo: str(w?.via_no),
    imoNo: str(w?.imo_no),
    vesselName: str(w?.vessel_name),
    pilotCode: str(w?.pilot_code),
    pilotName: str(w?.pilot_name),
    status: str(w?.status) || 'Assigned',
    movementType: str(w?.movement_type).toUpperCase(),
    berthId: typeof w?.berth_id === 'number' ? w.berth_id : null,
    assignedAt: toEpochMs(w?.assigned_at),
    boardedAt: toEpochMs(w?.boarded_at),
    releasedAt: toEpochMs(w?.released_at),
    createdBy: str(w?.created_by),
    // Absent `active` means an older gateway that predates the field; treating it as
    // live matches how the record behaved before the flag existed.
    active: w?.active !== false,
    supersededAt: toEpochMs(w?.superseded_at),
  };
}

export interface ManualPilotPage {
  items: ManualPilotAssignment[];
  total: number;
}

/** Payload for a new assignment. Identity is snapshotted from the call the operator saw. */
export interface AssignPilotInput {
  callId: number;
  pilotCode: string;
  pilotName?: string;
  vcn?: string;
  viaNo?: string;
  imoNo?: string;
  vesselName?: string;
  createdBy?: string;
  /** INWARD | OUTWARD | SHIFTING. Omit to record no visit milestone on release. */
  movementType?: string;
  /** Destination berth. Required for SHIFTING; ignored by the gateway for OUTWARD. */
  berthId?: number | null;
}

/* ----------------------------------------------------------------------- I/O */

export async function fetchManualPilotAssignments(
  opts: { active?: boolean; limit?: number; offset?: number } = {},
): Promise<ManualPilotPage> {
  const q = new URLSearchParams();
  if (opts.active !== undefined) q.set('active', String(opts.active));
  q.set('limit', String(opts.limit ?? 200));
  q.set('offset', String(opts.offset ?? 0));
  const raw = await http<{ items?: ManualPilotWire[]; total?: number }>(
    `${MANUAL_PILOT_PATH}?${q.toString()}`,
  );
  const items = (raw?.items ?? [])
    .map(mapManualPilot)
    .filter((r): r is ManualPilotAssignment => r !== null);
  return { items, total: typeof raw?.total === 'number' ? raw.total : items.length };
}

export async function assignPilot(input: AssignPilotInput): Promise<ManualPilotAssignment | null> {
  const body = {
    call_id: input.callId,
    pilot_code: input.pilotCode,
    pilot_name: input.pilotName || null,
    vcn: input.vcn || null,
    via_no: input.viaNo || null,
    imo_no: input.imoNo || null,
    vessel_name: input.vesselName || null,
    created_by: input.createdBy || null,
    movement_type: input.movementType || null,
    berth_id: input.berthId ?? null,
  };
  return mapManualPilot(await http<ManualPilotWire>(MANUAL_PILOT_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

export async function boardPilot(id: number): Promise<ManualPilotAssignment | null> {
  return mapManualPilot(await http<ManualPilotWire>(`${MANUAL_PILOT_PATH}/${id}/board`, {
    method: 'PATCH',
  }));
}

export async function releasePilot(id: number): Promise<ManualPilotAssignment | null> {
  return mapManualPilot(await http<ManualPilotWire>(`${MANUAL_PILOT_PATH}/${id}/release`, {
    method: 'PATCH',
  }));
}
