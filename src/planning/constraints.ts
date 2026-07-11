/**
 * Berth-planning constraint engine (spec §5.3, W-4, C-3).
 *
 * Pure, deterministic validators over the berthing plan and its resources. Each
 * returns a list of named `PlanViolation`s so the UI can (a) surface conflicts on
 * the Gantt and (b) *reject an invalid drag-to-replan with the violated
 * constraint named* — never silently accept an infeasible move.
 *
 * Vessel LOA/beam are not in the live AIS `Vessel` record, so we derive plausible
 * dimensions from vessel type (documented in the assumptions register). Real
 * deployment reads LOA/beam from the port-call / ship-particulars feed.
 */

import type { BerthingPlanEntry, Berth, PortCraftUnit, Vessel } from '@/types/domain';

/** Derived vessel dimensions (metres) — from type when AIS omits them. */
export interface VesselDims {
  loaM: number;
  beamM: number;
  draftM: number;
}

/**
 * Nominal LOA / beam / draft by vessel type. Mid-range values for a JNPA call;
 * used only when the live feed does not carry ship particulars. Sourced in the
 * assumptions register.
 */
const DIMS_BY_TYPE: Record<string, VesselDims> = {
  'Container Ship': { loaM: 300, beamM: 45, draftM: 13.5 },
  Tanker: { loaM: 250, beamM: 44, draftM: 14.5 },
  'Passenger Ship': { loaM: 260, beamM: 32, draftM: 8.5 },
  'High-Speed Craft': { loaM: 90, beamM: 20, draftM: 4.0 },
  Tug: { loaM: 32, beamM: 11, draftM: 5.0 },
  'Pilot Vessel': { loaM: 20, beamM: 6, draftM: 2.5 },
  Fishing: { loaM: 30, beamM: 8, draftM: 3.5 },
  Unknown: { loaM: 200, beamM: 32, draftM: 11.0 },
};

export function vesselDims(v: Pick<Vessel, 'VESSEL_TYPE'>): VesselDims {
  return DIMS_BY_TYPE[v.VESSEL_TYPE] ?? DIMS_BY_TYPE.Unknown;
}

/** Nominal berth pocket beam allowance = berth length × this fraction. */
export const BERTH_BEAM_FRACTION = 0.18;

export type ViolationCode =
  | 'LOA_EXCEEDS_BERTH'
  | 'BEAM_EXCEEDS_POCKET'
  | 'DRAFT_EXCEEDS_BERTH'
  | 'BERTH_TIME_OVERLAP'
  | 'BERTH_MAINTENANCE'
  | 'UNKNOWN_VESSEL'
  | 'PILOT_DOUBLE_BOOKED'
  | 'TIDAL_WINDOW_TOO_SHORT';

export interface PlanViolation {
  code: ViolationCode;
  /** Plan entry (or resource) the violation attaches to. */
  planId: string;
  berthId?: string;
  /** Human-readable, names the problem AND the remedy where useful. */
  message: string;
}

/** Two [start,end) intervals overlap (touching endpoints do not). */
export function intervalsOverlap(aS: number, aE: number, bS: number, bE: number): boolean {
  return aS < bE && bS < aE;
}

/**
 * Validate a single plan entry against the berth it targets: LOA vs berth
 * length, beam vs pocket, draft vs berth depth, and berth maintenance state.
 * `dims` lets the caller pass real ship particulars; falls back to type-derived.
 */
export function validateBerthFit(
  entry: BerthingPlanEntry,
  berth: Berth | undefined,
  dims: VesselDims
): PlanViolation[] {
  const out: PlanViolation[] = [];
  if (!berth) return out;

  if (dims.loaM > berth.LENGTH_M) {
    out.push({
      code: 'LOA_EXCEEDS_BERTH',
      planId: entry.PLAN_ID,
      berthId: berth.BERTH_ID,
      message: `LOA ${dims.loaM} m exceeds berth ${berth.BERTH_NAME} length ${berth.LENGTH_M} m — assign a longer berth.`,
    });
  }
  const pocketBeam = berth.LENGTH_M * BERTH_BEAM_FRACTION;
  if (dims.beamM > pocketBeam) {
    out.push({
      code: 'BEAM_EXCEEDS_POCKET',
      planId: entry.PLAN_ID,
      berthId: berth.BERTH_ID,
      message: `Beam ${dims.beamM} m exceeds ${berth.BERTH_NAME} pocket ≈ ${pocketBeam.toFixed(0)} m.`,
    });
  }
  if (dims.draftM > berth.DRAFT_M) {
    out.push({
      code: 'DRAFT_EXCEEDS_BERTH',
      planId: entry.PLAN_ID,
      berthId: berth.BERTH_ID,
      message: `Draft ${dims.draftM} m exceeds ${berth.BERTH_NAME} depth ${berth.DRAFT_M} m — deepen dredge or re-berth.`,
    });
  }
  if (berth.STATUS === 'maintenance') {
    out.push({
      code: 'BERTH_MAINTENANCE',
      planId: entry.PLAN_ID,
      berthId: berth.BERTH_ID,
      message: `Berth ${berth.BERTH_NAME} is under maintenance for this window.`,
    });
  }
  return out;
}

/**
 * Detect two plan entries occupying the same berth at overlapping times. Returns
 * one violation per conflicting (later) entry, naming the incumbent.
 */
export function detectBerthTimeConflicts(plan: BerthingPlanEntry[]): PlanViolation[] {
  const out: PlanViolation[] = [];
  const byBerth = new Map<string, BerthingPlanEntry[]>();
  for (const e of plan) {
    if (!byBerth.has(e.BERTH_ID)) byBerth.set(e.BERTH_ID, []);
    byBerth.get(e.BERTH_ID)!.push(e);
  }
  for (const [berthId, entries] of byBerth) {
    const sorted = [...entries].sort((a, b) => a.PLANNED_START - b.PLANNED_START);
    for (let i = 1; i < sorted.length; i++) {
      for (let j = 0; j < i; j++) {
        if (
          intervalsOverlap(
            sorted[j].PLANNED_START,
            sorted[j].PLANNED_END,
            sorted[i].PLANNED_START,
            sorted[i].PLANNED_END
          )
        ) {
          out.push({
            code: 'BERTH_TIME_OVERLAP',
            planId: sorted[i].PLAN_ID,
            berthId,
            message: `${sorted[i].VESSEL_NAME} overlaps ${sorted[j].VESSEL_NAME} at berth ${berthId} — shift the window or re-berth.`,
          });
          break;
        }
      }
    }
  }
  return out;
}

/**
 * A plan entry whose MMSI is not in the known vessel set → provisional record,
 * flagged for confirmation (not dropped: JNPA may plan ahead of AIS acquisition).
 */
export function detectUnknownVessels(
  plan: BerthingPlanEntry[],
  knownMmsi: Set<string>
): PlanViolation[] {
  return plan
    .filter((e) => e.MMSI && !knownMmsi.has(e.MMSI))
    .map((e) => ({
      code: 'UNKNOWN_VESSEL' as const,
      planId: e.PLAN_ID,
      berthId: e.BERTH_ID,
      message: `${e.VESSEL_NAME} (MMSI ${e.MMSI}) not yet acquired on AIS — provisional, confirm on arrival.`,
    }));
}

/**
 * A pilot (or any craft) assigned to two vessels whose service windows overlap.
 * We approximate a craft's service window as the plan window of its assigned
 * vessel. Returns one violation per double-booked craft.
 */
export function detectPilotDoubleBooking(
  craft: PortCraftUnit[],
  plan: BerthingPlanEntry[]
): PlanViolation[] {
  const out: PlanViolation[] = [];
  const planByMmsi = new Map<string, BerthingPlanEntry>();
  for (const e of plan) if (e.MMSI) planByMmsi.set(e.MMSI, e);

  // Group craft by assigned MMSI is the wrong axis; we need craft serving >1
  // vessel. Since a unit has a single ASSIGNED_MMSI, "double booking" surfaces
  // when two UNITS with the SAME CRAFT_ID would be needed — model it as: the
  // same craft id appearing against overlapping vessel windows.
  const byCraft = new Map<string, PortCraftUnit[]>();
  for (const c of craft) {
    if (!c.ASSIGNED_MMSI) continue;
    if (!byCraft.has(c.CRAFT_ID)) byCraft.set(c.CRAFT_ID, []);
    byCraft.get(c.CRAFT_ID)!.push(c);
  }
  for (const [craftId, units] of byCraft) {
    const windows = units
      .map((u) => planByMmsi.get(u.ASSIGNED_MMSI!))
      .filter((e): e is BerthingPlanEntry => !!e);
    for (let i = 1; i < windows.length; i++) {
      for (let j = 0; j < i; j++) {
        if (
          intervalsOverlap(
            windows[j].PLANNED_START,
            windows[j].PLANNED_END,
            windows[i].PLANNED_START,
            windows[i].PLANNED_END
          )
        ) {
          out.push({
            code: 'PILOT_DOUBLE_BOOKED',
            planId: windows[i].PLAN_ID,
            message: `Craft ${craftId} is booked for ${windows[i].VESSEL_NAME} and ${windows[j].VESSEL_NAME} at once — assign another unit.`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Tidal window shorter than the transit time it must contain. `windowH` is the
 * available go window length; `transitH` the passage duration.
 */
export function checkTidalWindowFits(
  planId: string,
  windowH: number,
  transitH: number
): PlanViolation | null {
  if (windowH >= transitH) return null;
  return {
    code: 'TIDAL_WINDOW_TOO_SHORT',
    planId,
    message: `Tidal go-window ${windowH.toFixed(1)} h is shorter than the ${transitH.toFixed(
      1
    )} h transit — wait for the next window.`,
  };
}

export interface PlanValidationInput {
  plan: BerthingPlanEntry[];
  berths: Berth[];
  craft: PortCraftUnit[];
  vessels: Vessel[];
  /** Optional real ship particulars keyed by MMSI. */
  dimsByMmsi?: Map<string, VesselDims>;
}

/**
 * Full plan validation: aggregates every check into one violation list keyed by
 * plan id. This is the single entry point the Gantt and the plan-import UI use.
 */
export function validatePlan(input: PlanValidationInput): PlanViolation[] {
  const { plan, berths, craft, vessels, dimsByMmsi } = input;
  const berthById = new Map(berths.map((b) => [b.BERTH_ID, b]));
  const vesselByMmsi = new Map(vessels.map((v) => [v.MMSI, v]));
  const knownMmsi = new Set(vessels.map((v) => v.MMSI));

  const out: PlanViolation[] = [];
  for (const e of plan) {
    const dims =
      dimsByMmsi?.get(e.MMSI) ??
      (vesselByMmsi.get(e.MMSI) ? vesselDims(vesselByMmsi.get(e.MMSI)!) : DIMS_BY_TYPE.Unknown);
    out.push(...validateBerthFit(e, berthById.get(e.BERTH_ID), dims));
  }
  out.push(...detectBerthTimeConflicts(plan));
  out.push(...detectUnknownVessels(plan, knownMmsi));
  out.push(...detectPilotDoubleBooking(craft, plan));
  return out;
}
