/**
 * <PortCraftTabs> — the internal [ Overview ] [ Active Marine Operations ]
 * [ Fleet Register ] [ Data Upload ] tab strip for the Port Craft screen.
 *
 * Controlled (active + onActivate) in exactly the same style as every other nested
 * Calcite tab group in the App shell (Vessels ▸ …, DUKC ▸ Sea Channels, 5-Day
 * Berthing ▸ …), so the layout system and design language are unchanged.
 *
 * Both data-backed panes stay MOUNTED while hidden — that is what makes the
 * `registerKey` remount-on-import refresh work across tabs, and it is the
 * behaviour the App shell relied on before this screen was extracted.
 */

import {
  CalciteTabs,
  CalciteTabNav,
  CalciteTabTitle,
  CalciteTab,
} from '@esri/calcite-components-react';
import { Panel } from '@/components/common/Panel';
import { PortCraftOverview } from '@/components/marine/PortCraftOverview';
import { PortCraftOperationsTab } from '@/components/marine/PortCraftOperationsTab';
import { PortCraftFleetRegister } from '@/components/marine/PortCraftFleetRegister';
import { CraftAssignmentsTab } from '@/components/marine/CraftAssignmentsTab';
import { PortCraftDataUpload } from '@/components/marine/PortCraftDataUpload';
import type { MarineImportResult } from '@/data/uc3/marineUpload';

/** Overview is the default — the tab opens on the live operational picture. */
export type PortCraftSubTab = 'overview' | 'operations' | 'register' | 'assignments' | 'upload';

export interface PortCraftTabsProps {
  active: PortCraftSubTab;
  onActivate: (tab: PortCraftSubTab) => void;
  /** Bumped after a successful import so the register remounts and refetches. */
  registerKey: number;
  onImported?: (result: MarineImportResult) => void;
}

export function PortCraftTabs({ active, onActivate, registerKey, onImported }: PortCraftTabsProps) {
  return (
    <CalciteTabs layout="inline">
      <CalciteTabNav slot="title-group">
        <CalciteTabTitle
          tab="pc-overview"
          selected={active === 'overview'}
          onCalciteTabsActivate={() => onActivate('overview')}
        >
          Overview
        </CalciteTabTitle>
        <CalciteTabTitle
          tab="pc-operations"
          selected={active === 'operations'}
          onCalciteTabsActivate={() => onActivate('operations')}
        >
          Active Marine Operations
        </CalciteTabTitle>
        <CalciteTabTitle
          tab="pc-register"
          selected={active === 'register'}
          onCalciteTabsActivate={() => onActivate('register')}
        >
          Fleet Register
        </CalciteTabTitle>
        <CalciteTabTitle
          tab="pc-assignments"
          selected={active === 'assignments'}
          onCalciteTabsActivate={() => onActivate('assignments')}
        >
          Craft Assignments
        </CalciteTabTitle>
        <CalciteTabTitle
          tab="pc-upload"
          selected={active === 'upload'}
          onCalciteTabsActivate={() => onActivate('upload')}
        >
          Data Upload
        </CalciteTabTitle>
      </CalciteTabNav>

      {/* Live operational state: source badge, optimisation recommendation,
          scheduling conflicts, Pilots / Tugs / Mooring-gang cards. */}
      <CalciteTab tab="pc-overview" selected={active === 'overview'}>
        <PortCraftOverview />
      </CalciteTab>

      {/* Vessels currently requiring marine support, from the lifecycle projection. */}
      <CalciteTab tab="pc-operations" selected={active === 'operations'}>
        <PortCraftOperationsTab />
      </CalciteTab>

      {/* UC-3 fleet register (core.port_craft). */}
      <CalciteTab tab="pc-register" selected={active === 'register'}>
        <PortCraftFleetRegister registerKey={registerKey} />
      </CalciteTab>

      {/* Launch / tug / mooring commitments against a piloted vessel. Demo-only. */}
      <CalciteTab tab="pc-assignments" selected={active === 'assignments'}>
        <Panel title="Craft assignments — launches, tugs and mooring craft from the Fleet Register" height={640}>
          <CraftAssignmentsTab />
        </Panel>
      </CalciteTab>

      {/* Port-craft Data Upload + history — the shared marine upload flow. */}
      <CalciteTab tab="pc-upload" selected={active === 'upload'}>
        <PortCraftDataUpload onImported={onImported} />
      </CalciteTab>
    </CalciteTabs>
  );
}
