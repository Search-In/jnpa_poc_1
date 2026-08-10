/**
 * Tender-exact KPI card anatomy (UC1-042 / UI-041). Single source for definition,
 * arrival-time basis, and the baseline-source statement so no card ships a bare
 * number or bare percentage.
 */

import type { KpiKey } from '@/types/kpi';

export type KpiProvenance = 'LIVE-CORPUS' | 'LIVE' | 'SIM';

export interface KpiAnatomy {
  /** Tender-exact display name (also mirrored in KPI_TARGETS.label). */
  name: string;
  definition: string;
  /** Which arrival-time (or equivalent) basis the measured value uses. */
  basis: string;
  /**
   * Spec UI-041: JNPA baseline ref, or the honest simulated-delta statement
   * naming the suite assumption (A-nn). Never a bare percentage.
   */
  baselineSource: string;
  /** Optional published figure used when the reference register is empty. */
  publishedBaseline?: { value: number; period: string; unit: string };
}

export const KPI_ANATOMY: Record<KpiKey, KpiAnatomy> = {
  jitPct: {
    name: 'JIT',
    definition: 'Share of arrivals within ±60 min of the recommended berthing slot',
    basis: 'ATA vs recommended slot (berthing-plan PLANNED_START)',
    baselineSource:
      'no published JNPA baseline — figure is a simulated delta under assumption A-01',
  },
  preBerthingDelay: {
    name: 'Pre-Berthing Delay',
    definition: 'Mean hours between declared ETA and actual arrival (ATA − ETA)',
    basis: 'ATA = factual arrival; ETA = declared arrival in the call window',
    baselineSource:
      'no published JNPA baseline — figure is a simulated delta under assumption A-01',
  },
  preSailingDelay: {
    name: 'Pre-Sailing Delay',
    definition: 'Mean hours between cargo-complete + clearance and actual sailing (ATD)',
    basis: 'ATD vs planned sailing / cargo-complete + standard clearance',
    baselineSource:
      'no published JNPA baseline — figure is a simulated delta under assumption A-01',
  },
  avgTat: {
    name: 'Average Vessel TAT',
    definition: 'mean(ATD − ATA) for completed calls',
    basis: 'ATA = factual arrival; ATD = factual departure (pilot-to-pilot corpus window)',
    baselineSource:
      'jnport.gov.in Operating Performance Profile 27.36 h pilot-to-pilot FY 2025-26',
    publishedBaseline: { value: 27.36, period: 'FY 2025-26', unit: 'h' },
  },
  portCraftOptimization: {
    name: 'Port Craft Optimization',
    definition: 'Mean utilisation across pilot, tug and mooring craft (% deployed)',
    basis: 'port-craft register status at the anchor instant',
    baselineSource:
      'no published JNPA baseline — figure is a simulated delta under assumption A-01',
  },
  forecastAccuracy: {
    name: 'Accuracy of Prediction',
    definition: 'Share of arrivals within ±4 h of the declared ETA',
    basis: 'terminal berthing-report ETA vs ATA',
    baselineSource:
      'no published JNPA baseline — figure is a simulated delta under assumption A-01',
  },
  berthOccupancy: {
    name: 'Berth Occupancy',
    definition: 'Occupied share of container-terminal berths at the anchor instant',
    basis: 'berth occupancy derived from the JNPA terminal berthing register',
    baselineSource:
      'no published JNPA baseline — figure is a simulated delta under assumption A-01',
  },
  anchored: {
    name: 'Anchored / Approaching',
    definition:
      'Count of vessels at anchorage plus inbound/expected at the anchor instant',
    basis: 'ledger-derived state (at_anchorage · inbound · expected)',
    baselineSource:
      'no published JNPA baseline — count is ledger-derived at the anchor instant',
  },
};
