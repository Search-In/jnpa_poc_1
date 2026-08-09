/**
 * UC-3 Marine operational KPI connector — `/api/marine/state/kpis`.
 *
 * The projection-driven counterpart to `marineCalls.fetchMarineStats`. The two answer
 * different questions and both are kept:
 *
 *   /calls/stats  — FACTUAL aggregates over stored columns (how many calls exist, how
 *                   many have an ATA, average turnaround). Correct as it is, untouched.
 *   /state/kpis   — OPERATIONAL state (who is working, what needs a pilot or craft).
 *                   Every figure is a tally of the Marine Projection's own verdicts.
 *
 * Nothing here derives a status. If a number is missing, the backend is the place to add
 * it — computing it in the browser would be the duplicated lifecycle this phase removes.
 */

import { http } from './client';

export const MARINE_KPIS_PATH = '/marine/state/kpis';

/**
 * `GET /marine/state/kpis` wire shape.
 *
 * EVERY field is optional. That is not laxness — it is the mapper's contract: a gateway
 * predating a block, or one that omits it, must yield zeroes rather than throw, and an
 * optional wire type is what lets the compiler enforce that each read is guarded.
 *
 * Mirrors the gateway's MarineKpisOut. Declaring it here rather than reaching for `any`
 * means a backend rename now fails the build instead of silently reading `undefined` and
 * rendering 0 on the dashboard.
 */
export interface MarineKpisWire {
  scope?: { active_calls?: number; basis?: string } | null;
  pilot?: {
    busy?: number; available?: number; known?: number; utilisation_pct?: number;
    demand?: number; waiting_assignment?: number; under_pilotage?: number;
    completed?: number;
  } | null;
  craft?: {
    busy?: number; available?: number; fleet_total?: number; utilisation_pct?: number;
    demand?: number; committed_calls?: number; waiting_assignment?: number;
    demand_unphased?: number;
  } | null;
  operations?: {
    marine_support_required?: number; awaiting_berthing?: number; at_berth?: number;
    under_pilotage?: number; preparing_departure?: number; sailing?: number;
    completed_today?: number;
  } | null;
}

export interface MarineKpis {
  scope: { activeCalls: number; basis: string };
  pilot: {
    busy: number; available: number; known: number; utilisationPct: number;
    demand: number; waitingAssignment: number; underPilotage: number; completed: number;
  };
  craft: {
    busy: number; available: number; fleetTotal: number; utilisationPct: number;
    demand: number; committedCalls: number; waitingAssignment: number;
    /** Busy by the engine's verdict but in no reportable phase. */
    demandUnphased: number;
  };
  operations: {
    marineSupportRequired: number; awaitingBerthing: number; atBerth: number;
    underPilotage: number; preparingDeparture: number; sailing: number;
    completedToday: number;
  };
}

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Wire → domain. Pure and tolerant: a missing block yields zeroes rather than throwing. */
export function mapMarineKpis(raw: unknown): MarineKpis {
  // Narrowed ONCE at the boundary, as mapPerformanceKpi does. `unknown` is what the
  // caller genuinely has — an unvalidated HTTP body — and the optional wire type below
  // forces every read past this line to be guarded.
  const w = (raw ?? null) as MarineKpisWire | null;
  const s = w?.scope ?? {};
  const p = w?.pilot ?? {};
  const c = w?.craft ?? {};
  const o = w?.operations ?? {};
  return {
    scope: { activeCalls: n(s.active_calls), basis: typeof s.basis === 'string' ? s.basis : '' },
    pilot: {
      busy: n(p.busy), available: n(p.available), known: n(p.known),
      utilisationPct: n(p.utilisation_pct), demand: n(p.demand),
      waitingAssignment: n(p.waiting_assignment), underPilotage: n(p.under_pilotage),
      completed: n(p.completed),
    },
    craft: {
      busy: n(c.busy), available: n(c.available), fleetTotal: n(c.fleet_total),
      utilisationPct: n(c.utilisation_pct), demand: n(c.demand),
      committedCalls: n(c.committed_calls), waitingAssignment: n(c.waiting_assignment),
      demandUnphased: n(c.demand_unphased),
    },
    operations: {
      marineSupportRequired: n(o.marine_support_required),
      awaitingBerthing: n(o.awaiting_berthing), atBerth: n(o.at_berth),
      underPilotage: n(o.under_pilotage), preparingDeparture: n(o.preparing_departure),
      sailing: n(o.sailing), completedToday: n(o.completed_today),
    },
  };
}

export async function fetchMarineKpis(): Promise<MarineKpis> {
  return mapMarineKpis(await http<MarineKpisWire>(MARINE_KPIS_PATH));
}
