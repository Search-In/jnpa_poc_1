/**
 * <PortCraftOverview> — the Overview tab of the Port Craft screen: the current
 * OPERATIONAL STATE of the craft fleet, and the default tab.
 *
 * "Overview" rather than "Analysis" because the content is the live operating
 * picture, not a study: the craft source badge, the optimisation recommendation,
 * the scheduling-conflict list and the Pilots / Tugs / Mooring-gang availability
 * cards.
 *
 * Presentation only. Every one of those surfaces is produced by the existing
 * <PortCraftBoard> (spec §B2.8), rendered here UNCHANGED — same labels, same
 * calculations, same adapter query (`getAdapter().getPortCraft()`), same 30 s
 * refresh, same status colours, same sim-lever reactivity and what-if highlight
 * wiring. No logic is duplicated and no data is re-derived.
 *
 * Overview is KPI-only: fleet summary, live demand, recommendation and resource
 * utilisation. The per-vessel operational table lives on its own tab
 * (<PortCraftOperationsTab>) so this pane stays scannable.
 *
 * ADDED ABOVE THE BOARD: <PortCraftDemandStrip>, the fleet register and live craft DEMAND
 * straight from /api/marine/state/port-craft. It is purely additive — it renders null
 * when that endpoint does not answer, so this tab degrades to the board alone, exactly
 * as it behaved before. The board itself is untouched.
 */

import { PortCraftBoard } from '@/components/reports/PortCraftBoard';
import { PortCraftDemandStrip } from '@/components/marine/PortCraftDemandStrip';
import { tokens } from '@/theme/tokens';

export function PortCraftOverview() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
      <PortCraftDemandStrip />
      <PortCraftBoard />
    </div>
  );
}
