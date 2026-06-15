/**
 * KPI targets + display metadata. Single place to tune what "good" looks like.
 * No colour literals here — colours live in `src/theme/tokens.ts`.
 */

import type { KpiKey } from '@/types/kpi';

export interface KpiTarget {
  label: string;
  unit: string;
  target: number;
  /**
   * When true, a value below target is good (e.g. delays, TAT). When false,
   * a value above target is good (e.g. JIT %, forecast accuracy). Drives the
   * ▲/▼ colour on the card.
   */
  lowerIsBetter: boolean;
}

export const KPI_TARGETS: Record<KpiKey, KpiTarget> = {
  preBerthingDelay: { label: 'Pre-Berthing Delay', unit: 'h', target: 2, lowerIsBetter: true },
  preSailingDelay: { label: 'Pre-Sailing Delay', unit: 'h', target: 2, lowerIsBetter: true },
  avgTat: { label: 'Avg Vessel TAT', unit: 'h', target: 24, lowerIsBetter: true },
  jitPct: { label: 'Just-In-Time', unit: '%', target: 80, lowerIsBetter: false },
  forecastAccuracy: { label: 'Forecast Accuracy', unit: '%', target: 90, lowerIsBetter: false },
  berthOccupancy: { label: 'Berth Occupancy', unit: '%', target: 75, lowerIsBetter: false },
  anchored: { label: 'Anchored Vessels', unit: '', target: 5, lowerIsBetter: true },
  approaching: { label: 'Approaching Vessels', unit: '', target: 8, lowerIsBetter: false },
};

/**
 * Just-In-Time tolerance: a vessel is "on time" if |ATA − recommended slot|
 * is within this many minutes.
 */
export const JIT_TOLERANCE_MIN = 60;

/** Standard pilotage lead time used in the pre-berthing delay formula (hours). */
export const STANDARD_PILOTAGE_LEAD_H = 1.5;

/** Standard post-cargo clearance time used in pre-sailing delay (hours). */
export const STANDARD_CLEARANCE_H = 2;
