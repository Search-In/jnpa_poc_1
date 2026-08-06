/**
 * <BathymetryTabs> — the internal [ Overview ] [ Surveys ] [ Data Upload ] tab strip
 * for the Bathymetry section.
 *
 * Controlled (active + onActivate) in exactly the same style as <PortCraftTabs> and
 * every other nested Calcite tab group in the App shell, so the layout system and
 * design language are unchanged.
 *
 * Both data-backed panes stay MOUNTED while hidden — that is what makes the
 * `registerKey` remount-on-import refresh work across tabs, matching Port Craft.
 */

import {
  CalciteTabs,
  CalciteTabNav,
  CalciteTabTitle,
  CalciteTab,
} from '@esri/calcite-components-react';
import { BathymetryOverview } from '@/components/marine/BathymetryOverview';
import { BathymetrySurveyTable } from '@/components/marine/BathymetrySurveyTable';
import { BathymetryDataUpload } from '@/components/marine/BathymetryDataUpload';
import { Panel } from '@/components/common/Panel';
import type { MarineImportResult } from '@/data/uc3/marineUpload';

/** Overview is the default — the section opens on survey coverage. */
export type BathymetrySubTab = 'overview' | 'surveys' | 'upload';

export interface BathymetryTabsProps {
  active: BathymetrySubTab;
  onActivate: (tab: BathymetrySubTab) => void;
  /** Bumped after a successful import so the data panes remount and refetch. */
  registerKey: number;
  onImported?: (result: MarineImportResult) => void;
}

export function BathymetryTabs({
  active,
  onActivate,
  registerKey,
  onImported,
}: BathymetryTabsProps) {
  return (
    <CalciteTabs layout="inline">
      <CalciteTabNav slot="title-group">
        <CalciteTabTitle
          tab="bt-overview"
          selected={active === 'overview'}
          onCalciteTabsActivate={() => onActivate('overview')}
        >
          Overview
        </CalciteTabTitle>
        <CalciteTabTitle
          tab="bt-surveys"
          selected={active === 'surveys'}
          onCalciteTabsActivate={() => onActivate('surveys')}
        >
          Surveys
        </CalciteTabTitle>
        <CalciteTabTitle
          tab="bt-upload"
          selected={active === 'upload'}
          onCalciteTabsActivate={() => onActivate('upload')}
        >
          Data Upload
        </CalciteTabTitle>
      </CalciteTabNav>

      {/* Coverage picture: how many charts are loaded, how many soundings they carry,
          how much of that is georeferenced, and the shoal (above-design) share.

          `key` AND the prop, deliberately. The key is the Port Craft register pattern —
          an import REMOUNTS the pane, so the refetch cannot depend on any hook honouring
          a dependency array. The prop is kept because Overview also lists it as a query
          dep, which covers the pane if a future refactor drops the key. A remount resets
          the hook, so the two never double-fetch. Overview is the DEFAULT pane and shows
          "charts with soundings" / "soundings stored": a stale card here reads as a failed
          import even when every row was accepted. */}
      <CalciteTab tab="bt-overview" selected={active === 'overview'}>
        <BathymetryOverview key={registerKey} registerKey={registerKey} />
      </CalciteTab>

      {/* UC-3 survey register (core.bathymetry_survey). */}
      <CalciteTab tab="bt-surveys" selected={active === 'surveys'}>
        <Panel
          title="Bathymetry surveys — UC-3 backend (core.bathymetry_survey)"
          height={420}
        >
          <BathymetrySurveyTable key={registerKey} />
        </Panel>
      </CalciteTab>

      {/* Chart Data Upload + history — the shared marine upload flow. */}
      <CalciteTab tab="bt-upload" selected={active === 'upload'}>
        <BathymetryDataUpload onImported={onImported} />
      </CalciteTab>
    </CalciteTabs>
  );
}
