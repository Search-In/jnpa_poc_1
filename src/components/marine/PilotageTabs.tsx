/**
 * <PilotageTabs> — the internal [ Active Pilot Operations ] [ Pilot Register ]
 * [ Pilot Memo / Acknowledgements ] [ Data Upload ] strip for the Pilotage screen.
 *
 * Controlled (active + onActivate) in exactly the same style as <PortCraftTabs> and
 * every other nested Calcite tab group in the App shell, so the layout system and
 * design language are unchanged. Panes stay MOUNTED while hidden, which is what makes
 * the `registerKey` remount-on-import refresh work across tabs.
 */

import {
  CalciteTabs,
  CalciteTabNav,
  CalciteTabTitle,
  CalciteTab,
} from '@esri/calcite-components-react';
import { Panel } from '@/components/common/Panel';
import { PilotageTable } from '@/components/marine/PilotageTable';
import { PilotRegisterTable } from '@/components/marine/PilotRegisterTable';
import { PilotMemoTable } from '@/components/marine/PilotMemoTable';
import { PilotAssignmentsTab } from '@/components/marine/PilotAssignmentsTab';
import { PilotageDataUpload } from '@/components/marine/PilotageDataUpload';
import type { MarineImportResult } from '@/data/uc3/marineUpload';

/** Active operations is the default — the screen opens on the live picture. */
export type PilotageSubTab = 'operations' | 'register' | 'memos' | 'assignments' | 'upload';

export interface PilotageTabsProps {
  active: PilotageSubTab;
  onActivate: (tab: PilotageSubTab) => void;
  /** Bumped after a successful import so the data panes remount and refetch. */
  registerKey: number;
  onImported?: (result: MarineImportResult) => void;
}

export function PilotageTabs({ active, onActivate, registerKey, onImported }: PilotageTabsProps) {
  return (
    <CalciteTabs layout="inline">
      <CalciteTabNav slot="title-group">
        <CalciteTabTitle
          tab="pl-operations"
          selected={active === 'operations'}
          onCalciteTabsActivate={() => onActivate('operations')}
        >
          Active Pilot Operations
        </CalciteTabTitle>
        <CalciteTabTitle
          tab="pl-register"
          selected={active === 'register'}
          onCalciteTabsActivate={() => onActivate('register')}
        >
          Pilot Register
        </CalciteTabTitle>
        <CalciteTabTitle
          tab="pl-memos"
          selected={active === 'memos'}
          onCalciteTabsActivate={() => onActivate('memos')}
        >
          Pilot Memo / Acknowledgements
        </CalciteTabTitle>
        <CalciteTabTitle
          tab="pl-assignments"
          selected={active === 'assignments'}
          onCalciteTabsActivate={() => onActivate('assignments')}
        >
          Pilot Assignments
        </CalciteTabTitle>
        <CalciteTabTitle
          tab="pl-upload"
          selected={active === 'upload'}
          onCalciteTabsActivate={() => onActivate('upload')}
        >
          Data Upload
        </CalciteTabTitle>
      </CalciteTabNav>

      {/* Every pilot movement with its backend-derived workflow position. */}
      <CalciteTab tab="pl-operations" selected={active === 'operations'}>
        <Panel title="Pilot movements — who is handling which vessel" height={640}>
          <PilotageTable key={registerKey} />
        </Panel>
      </CalciteTab>

      {/* One row per pilot, folded from those same movements. */}
      <CalciteTab tab="pl-register" selected={active === 'register'}>
        <Panel title="Pilot register — who is working and who is free" height={640}>
          <PilotRegisterTable key={registerKey} />
        </Panel>
      </CalciteTab>

      {/* PCS pilot memos (ACKPLM) and their acknowledgement state. */}
      <CalciteTab tab="pl-memos" selected={active === 'memos'}>
        <Panel title="Pilot memos — requested, ready and acknowledged" height={640}>
          <PilotMemoTable key={registerKey} />
        </Panel>
      </CalciteTab>

      {/* Fallback workflow for vessels with no imported pilot data. Demo-only. */}
      <CalciteTab tab="pl-assignments" selected={active === 'assignments'}>
        <Panel title="Pilot assignments — manual fallback when no pilot data was imported" height={640}>
          <PilotAssignmentsTab />
        </Panel>
      </CalciteTab>

      {/* Pilot-card / pilot-memo upload — the shared marine upload flow. */}
      <CalciteTab tab="pl-upload" selected={active === 'upload'}>
        <PilotageDataUpload onImported={onImported} />
      </CalciteTab>
    </CalciteTabs>
  );
}
