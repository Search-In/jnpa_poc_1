/**
 * KPI formulas for the JNPA VTMS dashboard. Every function here is pure: it
 * takes plain data in and returns a number, with no I/O and no clock reads.
 * The "now" reference, where one is needed, is passed in explicitly so tests
 * are deterministic and the same code runs in mock and live modes.
 *
 * Formula definitions (from the PoC brief):
 *   Pre-Berthing Delay = ATB − (ATA at anchorage + standard pilotage lead)
 *   Pre-Sailing Delay  = ATD − (cargo-complete + clearance)
 *   Average Vessel TAT = ATD − ATA, rolling mean
 *   Just-In-Time %     = arrivals with |ATA − recommended slot| ≤ tolerance, %
 *   Forecast Accuracy  = 1 − MAPE(predicted ETA lead vs actual ATA lead)
 *   Berth Occupancy    = occupied-berth-hours / available-berth-hours
 */

import { hoursBetween, mean, mape, clamp, MS_PER_MIN, MS_PER_HOUR } from './helpers';
import {
  JIT_TOLERANCE_MIN,
  STANDARD_PILOTAGE_LEAD_H,
  STANDARD_CLEARANCE_H,
} from '@/config/targets';

// ── Pre-Berthing Delay ───────────────────────────────────────────────────────

export interface BerthingEvent {
  /** Actual time of arrival at anchorage (epoch ms). */
  ata: number;
  /** Actual time berthed / ATB (epoch ms). */
  atb: number;
}

/**
 * Delay (hours) between expected and actual berthing for one vessel.
 * Expected berthing = ATA + standard pilotage lead. A negative result means
 * the vessel berthed faster than the standard lead (clamped to 0 — you can't
 * have "negative delay").
 */
export function preBerthingDelay(
  ev: BerthingEvent,
  pilotageLeadH = STANDARD_PILOTAGE_LEAD_H
): number {
  const expectedBerth = ev.ata + pilotageLeadH * MS_PER_HOUR;
  return Math.max(0, hoursBetween(expectedBerth, ev.atb));
}

/** Rolling mean pre-berthing delay across vessels (hours). */
export function avgPreBerthingDelay(
  events: BerthingEvent[],
  pilotageLeadH = STANDARD_PILOTAGE_LEAD_H
): number {
  return mean(events.map((e) => preBerthingDelay(e, pilotageLeadH)));
}

// ── Pre-Sailing Delay ────────────────────────────────────────────────────────

export interface SailingEvent {
  /** Cargo-complete time (epoch ms). */
  cargoComplete: number;
  /** Actual time of departure / ATD (epoch ms). */
  atd: number;
}

/**
 * Delay (hours) between expected and actual sailing for one vessel.
 * Expected sailing = cargo-complete + standard clearance. Clamped to 0.
 */
export function preSailingDelay(
  ev: SailingEvent,
  clearanceH = STANDARD_CLEARANCE_H
): number {
  const expectedSail = ev.cargoComplete + clearanceH * MS_PER_HOUR;
  return Math.max(0, hoursBetween(expectedSail, ev.atd));
}

/** Rolling mean pre-sailing delay across vessels (hours). */
export function avgPreSailingDelay(
  events: SailingEvent[],
  clearanceH = STANDARD_CLEARANCE_H
): number {
  return mean(events.map((e) => preSailingDelay(e, clearanceH)));
}

// ── Average Vessel TAT ───────────────────────────────────────────────────────

export interface PortCall {
  /** Actual time of arrival (epoch ms). */
  ata: number;
  /** Actual time of departure (epoch ms); null if still in port. */
  atd: number | null;
}

/**
 * Average turnaround time (hours) = mean(ATD − ATA) over completed port calls.
 * Calls still in port (atd null) are excluded.
 */
export function avgVesselTAT(calls: PortCall[]): number {
  const completed = calls.filter((c): c is { ata: number; atd: number } => c.atd !== null);
  return mean(completed.map((c) => hoursBetween(c.ata, c.atd)));
}

// ── Just-In-Time % ───────────────────────────────────────────────────────────

export interface JitArrival {
  /** Actual time of arrival (epoch ms). */
  ata: number;
  /** Recommended arrival slot (epoch ms). */
  recommendedSlot: number;
}

/**
 * % of arrivals whose ATA is within `toleranceMin` of the recommended slot.
 * Returns 0 for no arrivals.
 */
export function justInTimePct(
  arrivals: JitArrival[],
  toleranceMin = JIT_TOLERANCE_MIN
): number {
  if (arrivals.length === 0) return 0;
  const tol = toleranceMin * MS_PER_MIN;
  const onTime = arrivals.filter((a) => Math.abs(a.ata - a.recommendedSlot) <= tol).length;
  return (onTime / arrivals.length) * 100;
}

// ── Forecast / Prediction Accuracy ───────────────────────────────────────────

export interface EtaPrediction {
  /** Reference time the prediction was anchored from, e.g. detection (epoch ms). */
  reference: number;
  /** Predicted ETA (epoch ms). */
  predictedEta: number;
  /** Actual time of arrival (epoch ms); null if not yet arrived. */
  actualAta: number | null;
}

/**
 * Forecast accuracy as a percentage = (1 − MAPE) * 100, where MAPE is computed
 * over the *lead time* (eta − reference) so the metric reflects how well we
 * predict remaining time-to-arrival rather than absolute epoch values.
 * Capped at [0, 100]. Returns 0 when there are no resolved predictions.
 */
export function forecastAccuracyPct(predictions: EtaPrediction[]): number {
  const pairs = predictions.map((p) => ({
    predicted: hoursBetween(p.reference, p.predictedEta),
    actual: p.actualAta === null ? null : hoursBetween(p.reference, p.actualAta),
  }));
  // With no resolved predictions there is nothing to score — report 0%, not the
  // 100% that (1 − MAPE) would yield from an empty MAPE.
  const resolved = pairs.some((p) => p.actual !== null && p.actual !== 0);
  if (!resolved) return 0;
  const m = mape(pairs);
  return clamp((1 - m) * 100, 0, 100);
}

// ── Berth Occupancy ──────────────────────────────────────────────────────────

export interface BerthInterval {
  /** Occupied-from (epoch ms). */
  start: number;
  /** Occupied-until (epoch ms); null = still occupied at window end. */
  end: number | null;
}

/**
 * Berth occupancy % = occupied-berth-hours / available-berth-hours over a
 * window. Available = berthCount * windowHours. Intervals are clipped to the
 * window so occupancy never exceeds 100%. Returns 0 if window/berths are 0.
 */
export function berthOccupancyPct(
  intervals: BerthInterval[],
  berthCount: number,
  windowStart: number,
  windowEnd: number
): number {
  const windowHours = hoursBetween(windowStart, windowEnd);
  const available = berthCount * windowHours;
  if (available <= 0) return 0;
  const occupiedHours = intervals.reduce((sum, iv) => {
    const start = Math.max(iv.start, windowStart);
    const end = Math.min(iv.end ?? windowEnd, windowEnd);
    return sum + Math.max(0, hoursBetween(start, end));
  }, 0);
  return clamp((occupiedHours / available) * 100, 0, 100);
}

// ── Port craft utilisation / response ────────────────────────────────────────

export interface CraftJob {
  type: 'pilot' | 'tug' | 'mooring';
  /** Whether the craft is currently deployed. */
  deployed: boolean;
  /** Response time for the job (minutes); null if not applicable. */
  responseMin: number | null;
}

export interface CraftStats {
  type: 'pilot' | 'tug' | 'mooring';
  /** % of units of this type currently deployed. */
  utilisationPct: number;
  /** Mean response time (minutes) over jobs with a response. */
  avgResponseMin: number;
  count: number;
}

/** Utilisation + average response per craft type. */
export function craftPerformance(jobs: CraftJob[]): CraftStats[] {
  const types: CraftJob['type'][] = ['pilot', 'tug', 'mooring'];
  return types.map((type) => {
    const group = jobs.filter((j) => j.type === type);
    const deployed = group.filter((j) => j.deployed).length;
    const responses = group
      .map((j) => j.responseMin)
      .filter((r): r is number => r !== null);
    return {
      type,
      count: group.length,
      utilisationPct: group.length === 0 ? 0 : (deployed / group.length) * 100,
      avgResponseMin: mean(responses),
    };
  });
}
