/**
 * Live Dashboard KPI overlay — corpus-backed values for the KPI Wall.
 *
 * Reads TWO EXISTING endpoints and returns the KPI values they support. No new endpoint,
 * no new DTO, no derivation:
 *
 *   GET /api/marine/calls/stats   avg_turnaround_hours, arrived, in_port, departed
 *   GET /api/marine/state/berths  occupied / total  (already derived by the backend
 *                                 State Engine — this module does NOT recompute it)
 *
 * WHY AN OVERLAY RATHER THAN A NEW ADAPTER
 * ----------------------------------------
 * The KPI Wall renders `KpiBundle`, built by `buildKpiBundle()` inside the Mock/ArcGIS
 * adapters. Only some cards have a corpus source today (Pre-Sailing Delay has no `atc`
 * producer; Approaching has no lifecycle equivalent), so replacing the whole bundle would
 * mean fabricating the rest. Instead the adapter's bundle is kept and ONLY the cards with
 * a real source are overwritten — every other card, the layout and the component tree stay
 * exactly as they were.
 *
 * Degrades safely: if either endpoint fails the bundle passes through untouched, so the
 * Wall behaves exactly as it did before this module existed.
 */

import type { KpiBundle, KpiKey, KpiValue } from '@/types/kpi';
import { deltaPct, round } from '@/kpi/helpers';
import { http } from './client';
import { MARINE_CALLS_STATS_PATH, parseMarineStats } from './marineCalls';

export const BERTH_STATE_PATH = '/marine/state/berths';

/** The berth-occupancy envelope, as the gateway returns it. */
export interface BerthOccupancyWire {
  total: number | null;
  occupied: number | null;
  allotted: number | null;
  free: number | null;
}

/** The KPI cards this overlay can source from real data, and their live values. */
export interface LiveKpis {
  /** Mean ATD − ATA across completed calls (h). Null until one call has both. */
  avgTat: number | null;
  /** Occupied berths as a % of the berth register. Null when the register is empty. */
  berthOccupancy: number | null;
  /** Counts, straight from the stats envelope. */
  arrived: number;
  inPort: number;
  departed: number;
}

/** Cards this overlay replaces. Anything absent keeps the adapter's value. */
export const LIVE_KPI_KEYS: readonly KpiKey[] = ['avgTat', 'berthOccupancy'] as const;

function pct(occupied: number | null, total: number | null): number | null {
  if (occupied === null || total === null || total <= 0) return null;
  return (occupied / total) * 100;
}

/** Map the two wire payloads onto the live KPI set. Pure. */
export function mapLiveKpis(statsRaw: unknown, berthsRaw: unknown): LiveKpis {
  const s = parseMarineStats(statsRaw);
  const b = (berthsRaw ?? {}) as BerthOccupancyWire;
  const num = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
  return {
    avgTat: s.avgTurnaroundHours,
    berthOccupancy: pct(num(b.occupied), num(b.total)),
    arrived: s.arrived,
    inPort: s.inPort,
    departed: s.departed,
  };
}

/**
 * Overwrite one card's value, preserving its label, unit, target and sparkline.
 *
 * `deltaPct` is recomputed against the SAME target the card already carries, so the
 * vs-target arrow stays consistent with every other card on the Wall.
 */
function withValue(existing: KpiValue, value: number): KpiValue {
  const v = round(value, existing.unit === '' ? 0 : 1);
  return { ...existing, value: v, deltaPct: deltaPct(v, existing.target) };
}

/**
 * Apply the live values to a bundle. Pure.
 *
 * A card is replaced ONLY when the live source produced a number — a null means "the
 * corpus cannot answer this yet" (no completed call, no berth register), and in that case
 * the adapter's value is left alone rather than shown as a fabricated zero.
 */
export function applyLiveKpis(bundle: KpiBundle, live: LiveKpis | null): KpiBundle {
  if (!live) return bundle;
  const out: KpiBundle = { ...bundle };
  if (live.avgTat !== null && out.avgTat) out.avgTat = withValue(out.avgTat, live.avgTat);
  if (live.berthOccupancy !== null && out.berthOccupancy) {
    out.berthOccupancy = withValue(out.berthOccupancy, live.berthOccupancy);
  }
  return out;
}

/**
 * Fetch both endpoints. Resolves to null on any failure so the caller can degrade to the
 * adapter's bundle — a Dashboard that still renders beats one that errors.
 */
export async function fetchLiveKpis(): Promise<LiveKpis | null> {
  try {
    const [stats, berths] = await Promise.all([
      http<unknown>(MARINE_CALLS_STATS_PATH),
      http<unknown>(BERTH_STATE_PATH),
    ]);
    return mapLiveKpis(stats, berths);
  } catch {
    return null;
  }
}
