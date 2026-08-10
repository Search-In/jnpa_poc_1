/**
 * KPI targets + display metadata. Single place to tune what "good" looks like.
 * Labels are tender-exact (UC1-042). No colour literals here — colours live in
 * `src/theme/tokens.ts`.
 */

import type { KpiKey } from '@/types/kpi';
import { KPI_ANATOMY } from './kpiAnatomy';

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
  jitPct: { label: KPI_ANATOMY.jitPct.name, unit: '%', target: 80, lowerIsBetter: false },
  preBerthingDelay: {
    label: KPI_ANATOMY.preBerthingDelay.name,
    unit: 'h',
    target: 2,
    lowerIsBetter: true,
  },
  preSailingDelay: {
    label: KPI_ANATOMY.preSailingDelay.name,
    unit: 'h',
    target: 2,
    lowerIsBetter: true,
  },
  avgTat: { label: KPI_ANATOMY.avgTat.name, unit: 'h', target: 24, lowerIsBetter: true },
  portCraftOptimization: {
    label: KPI_ANATOMY.portCraftOptimization.name,
    unit: '%',
    target: 70,
    lowerIsBetter: false,
  },
  forecastAccuracy: {
    label: KPI_ANATOMY.forecastAccuracy.name,
    unit: '%',
    target: 90,
    lowerIsBetter: false,
  },
  berthOccupancy: {
    label: KPI_ANATOMY.berthOccupancy.name,
    unit: '%',
    target: 75,
    lowerIsBetter: false,
  },
  anchored: {
    label: KPI_ANATOMY.anchored.name,
    unit: 'vessels',
    target: 12,
    lowerIsBetter: true,
  },
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
