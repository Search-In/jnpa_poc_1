/**
 * UC-3 Marine manual-craft-assignment connector.
 *
 * Reads and writes `/api/marine/manual-craft-assignment*`. Structured exactly like
 * manualPilot.ts — wire interface separate from the domain type, one pure mapper, I/O
 * last — because the two are the same shape of problem and diverging them would give
 * craft its own idioms for no reason.
 *
 * These are BACKEND records. Before this connector existed, craft commitments lived in a
 * zustand store, so Marine State, Vessel Calls, the Timeline and the Fleet Register could
 * not see them at all: the assignment screen was the only thing that knew a tug was out.
 */

import { http } from './client';
import { toEpochMs } from './shippingLines';

export const MANUAL_CRAFT_PATH = '/marine/manual-craft-assignment';

/** The dispatch ladder, mirroring services/marine/manual_craft.LADDER. */
export type CraftTransition = 'dispatch' | 'arrive' | 'assist' | 'release';

export interface ManualCraftWire {
  id: number | null;
  call_id: number | null;
  craft_id: number | null;
  status: string | null;
  vcn: string | null;
  via_no: string | null;
  vessel_name: string | null;
  craft_name: string | null;
  craft_type: string | null;
  assigned_at: string | null;
  dispatched_at: string | null;
  arrived_at: string | null;
  assisting_at: string | null;
  released_at: string | null;
  created_by: string | null;
  active: boolean | null;
  superseded_at: string | null;
}

/** camelCase + epoch ms (0 = unknown), matching every other UC-3 connector. */
export interface ManualCraftAssignment {
  id: number;
  callId: number;
  craftId: number;
  /** Assigned | Dispatched | On Scene | Assisting | Released. */
  status: string;
  vcn: string;
  viaNo: string;
  vesselName: string;
  craftName: string;
  craftType: string;
  assignedAt: number;
  dispatchedAt: number;
  arrivedAt: number;
  assistingAt: number;
  releasedAt: number;
  createdBy: string;
  active: boolean;
  supersededAt: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Wire → domain. Pure; exported so it can be unit-tested with no network. */
export function mapManualCraft(
  w: Partial<ManualCraftWire> | null | undefined,
): ManualCraftAssignment | null {
  const id = w?.id;
  const callId = w?.call_id;
  const craftId = w?.craft_id;
  if (typeof id !== 'number' || typeof callId !== 'number' || typeof craftId !== 'number') {
    return null;
  }
  return {
    id,
    callId,
    craftId,
    status: str(w?.status) || 'Assigned',
    vcn: str(w?.vcn),
    viaNo: str(w?.via_no),
    vesselName: str(w?.vessel_name),
    craftName: str(w?.craft_name),
    craftType: str(w?.craft_type),
    assignedAt: toEpochMs(w?.assigned_at),
    dispatchedAt: toEpochMs(w?.dispatched_at),
    arrivedAt: toEpochMs(w?.arrived_at),
    assistingAt: toEpochMs(w?.assisting_at),
    releasedAt: toEpochMs(w?.released_at),
    createdBy: str(w?.created_by),
    // Absent `active` means an older gateway; treating it as live matches how the record
    // behaved before the flag existed.
    active: w?.active !== false,
    supersededAt: toEpochMs(w?.superseded_at),
  };
}

export interface ManualCraftPage {
  items: ManualCraftAssignment[];
  total: number;
}

export interface AssignCraftInput {
  callId: number;
  craftId: number;
  craftName?: string;
  craftType?: string;
  vcn?: string;
  viaNo?: string;
  vesselName?: string;
  createdBy?: string;
}

/* ----------------------------------------------------------------------- I/O */

export async function fetchManualCraftAssignments(
  opts: { active?: boolean; limit?: number; offset?: number } = {},
): Promise<ManualCraftPage> {
  const q = new URLSearchParams();
  if (opts.active !== undefined) q.set('active', String(opts.active));
  q.set('limit', String(opts.limit ?? 200));
  q.set('offset', String(opts.offset ?? 0));
  const raw = await http<{ items?: ManualCraftWire[]; total?: number }>(
    `${MANUAL_CRAFT_PATH}?${q.toString()}`,
  );
  const items = (raw?.items ?? [])
    .map(mapManualCraft)
    .filter((r): r is ManualCraftAssignment => r !== null);
  return { items, total: typeof raw?.total === 'number' ? raw.total : items.length };
}

export async function assignCraft(
  input: AssignCraftInput,
): Promise<ManualCraftAssignment | null> {
  const body = {
    call_id: input.callId,
    craft_id: input.craftId,
    craft_name: input.craftName || null,
    craft_type: input.craftType || null,
    vcn: input.vcn || null,
    via_no: input.viaNo || null,
    vessel_name: input.vesselName || null,
    created_by: input.createdBy || null,
  };
  return mapManualCraft(await http<ManualCraftWire>(MANUAL_CRAFT_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

/** Advance one commitment along the ladder. The backend rejects a backwards move. */
export async function advanceCraft(
  id: number,
  transition: CraftTransition,
): Promise<ManualCraftAssignment | null> {
  return mapManualCraft(await http<ManualCraftWire>(
    `${MANUAL_CRAFT_PATH}/${id}/${transition}`, { method: 'PATCH' },
  ));
}

export async function releaseCraft(id: number): Promise<ManualCraftAssignment | null> {
  return advanceCraft(id, 'release');
}
