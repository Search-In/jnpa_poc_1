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
export function mapMarineKpis(raw: Record<string, any> | null | undefined): MarineKpis {
  const s = raw?.scope ?? {};
  const p = raw?.pilot ?? {};
  const c = raw?.craft ?? {};
  const o = raw?.operations ?? {};
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
  return mapMarineKpis(await http<Record<string, any>>(MARINE_KPIS_PATH));
}
