/**
 * Competitive analytics (spec C-4 ETA-with-uncertainty, C-7 historical views).
 *
 *  - `etaDistribution()` — turns a point ETA + a horizon into a p10/p50/p90
 *    band whose width grows with the forecast horizon and with AIS staleness
 *    (degradation behaviour), i.e. distributions not point estimates.
 *  - `occupancyCalendar()` — per-berth, per-day occupied fraction (heat calendar).
 *  - `waitingTimeDistribution()` — histogram + percentiles of pre-berth waits.
 *  - `terminalTat()` — mean turnaround time per terminal (comparison view).
 *
 * Pure/deterministic. Uncertainty is a documented, simulated model — not a JNPA
 * baseline.
 */

import type { BerthingPlanEntry, Berth } from '@/types/domain';
import { MS_PER_HOUR, percentile, mean } from './helpers';

const DAY_MS = 86_400_000;

export interface EtaBand {
  p10Ms: number;
  p50Ms: number;
  p90Ms: number;
  /** ± hours at p10/p90 relative to the point estimate. */
  spreadH: number;
}

/**
 * ETA distribution around a point estimate. `horizonH` is how far ahead we are
 * predicting (more hours → wider band); `stalenessMin` widens it further when the
 * last AIS fix is old. Coefficients are nominal and documented.
 */
export function etaDistribution(pointMs: number, horizonH: number, stalenessMin = 0): EtaBand {
  // Base uncertainty ~ 6% of the horizon, plus growth with staleness.
  const baseH = Math.max(0.25, 0.06 * horizonH);
  const staleH = 0.05 * stalenessMin;
  const spreadH = Math.round((baseH + staleH) * 10) / 10;
  const d = spreadH * MS_PER_HOUR;
  return { p10Ms: pointMs - d, p50Ms: pointMs, p90Ms: pointMs + d, spreadH };
}

export interface OccupancyCell {
  berthId: string;
  dayStartMs: number;
  /** Fraction of the day the berth is occupied (0..1). */
  fraction: number;
}

/**
 * Per-berth per-day occupancy fraction over [fromMs, fromMs + days·24h).
 * Overlapping-day windows are clipped to each day. Foundation for a heat calendar.
 */
export function occupancyCalendar(
  plan: BerthingPlanEntry[],
  berths: Berth[],
  fromMs: number,
  days: number
): OccupancyCell[] {
  const dayStart = Math.floor(fromMs / DAY_MS) * DAY_MS;
  const cells: OccupancyCell[] = [];
  for (const b of berths) {
    const entries = plan.filter((p) => p.BERTH_ID === b.BERTH_ID);
    for (let d = 0; d < days; d++) {
      const ds = dayStart + d * DAY_MS;
      const de = ds + DAY_MS;
      let occ = 0;
      for (const e of entries) {
        const s = Math.max(ds, e.PLANNED_START);
        const en = Math.min(de, e.PLANNED_END);
        if (en > s) occ += en - s;
      }
      cells.push({ berthId: b.BERTH_ID, dayStartMs: ds, fraction: Math.min(1, occ / DAY_MS) });
    }
  }
  return cells;
}

export interface WaitingDistribution {
  /** Histogram buckets (hours) and their counts. */
  buckets: { label: string; loH: number; hiH: number; count: number }[];
  p50H: number;
  p90H: number;
  meanH: number;
  n: number;
}

/**
 * Pre-berthing waiting-time distribution: wait = ACTUAL_START − PLANNED_START
 * (hours), over completed/active calls. Buckets at 0-2/2-4/4-8/8-12/12+ h.
 */
export function waitingTimeDistribution(plan: BerthingPlanEntry[]): WaitingDistribution {
  const waitsH = plan
    .filter((e) => e.ACTUAL_START != null)
    .map((e) => Math.max(0, (e.ACTUAL_START! - e.PLANNED_START) / MS_PER_HOUR));

  const edges = [0, 2, 4, 8, 12, Infinity];
  const buckets = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    return {
      label: hi === Infinity ? `${lo}h+` : `${lo}–${hi}h`,
      loH: lo,
      hiH: hi,
      count: waitsH.filter((w) => w >= lo && w < hi).length,
    };
  });

  return {
    buckets,
    p50H: Math.round(percentile(waitsH, 50) * 10) / 10,
    p90H: Math.round(percentile(waitsH, 90) * 10) / 10,
    meanH: Math.round(mean(waitsH) * 10) / 10,
    n: waitsH.length,
  };
}

export interface TerminalTat {
  terminal: string;
  meanTatH: number;
  calls: number;
}

/**
 * Mean turnaround (ATD − ATA, hours) per terminal — a weekly comparison view.
 * Uses ACTUAL_START→ACTUAL_END as the alongside proxy where cargo times absent.
 */
export function terminalTat(plan: BerthingPlanEntry[], berths: Berth[]): TerminalTat[] {
  const terminalOf = new Map(berths.map((b) => [b.BERTH_ID, b.TERMINAL]));
  const byTerminal = new Map<string, number[]>();
  for (const e of plan) {
    if (e.ACTUAL_START == null || e.ACTUAL_END == null) continue;
    const term = terminalOf.get(e.BERTH_ID) ?? 'Unknown';
    const tatH = (e.ACTUAL_END - e.ACTUAL_START) / MS_PER_HOUR;
    if (!byTerminal.has(term)) byTerminal.set(term, []);
    byTerminal.get(term)!.push(tatH);
  }
  return [...byTerminal.entries()]
    .map(([terminal, xs]) => ({
      terminal,
      meanTatH: Math.round(mean(xs) * 10) / 10,
      calls: xs.length,
    }))
    .sort((a, b) => a.terminal.localeCompare(b.terminal));
}
