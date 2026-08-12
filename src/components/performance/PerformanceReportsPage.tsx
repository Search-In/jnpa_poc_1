/**
 * <PerformanceReportsPage> — the Performance & Reports tab.
 *
 *   Performance & Reports          (top-level tab id stays 'reports')
 *     ├── Overview        headline KPIs from /api/performance/kpi
 *     ├── Daily Traffic   /api/performance/daily/traffic
 *     └── Operational     the ORIGINAL Reports content, moved verbatim
 *              ▲ Overview is the default
 *
 * The top-level tab id is deliberately unchanged. Nothing in sim/scenarios.ts targets
 * `tab: 'reports'` (its steps address craft / dukc / gantt / kpis / scenarios / tide /
 * workflows), and `onTourStep` no-ops silently on an unknown id — so inventing a new id
 * would be the risky move, not keeping this one.
 *
 * Two data worlds sit side by side here, and the split is intentional:
 *   · Performance sub-tabs read the UC-3 gateway (`core.perf_*`) — reported actuals,
 *     READ-ONLY, through the uc3/performance connector. No DataAdapter involvement.
 *   · Operational keeps the DataAdapter chain (live/simulated feed) untouched.
 * They are never merged, because a reported daily total and a modelled live figure are
 * not the same measurement.
 *
 * State follows the App shell's existing sub-tab pattern exactly — plain useState in
 * the screen's parent, as in Vessels ▸ …, Port Craft and Shipping Lines.
 */

import { useState } from 'react';
import {
  CalciteTabs,
  CalciteTabNav,
  CalciteTabTitle,
  CalciteTab,
} from '@esri/calcite-components-react';
import { Panel } from '@/components/common/Panel';
import { PerformanceOverview } from '@/components/performance/PerformanceOverview';
import { PerformanceTrafficTable } from '@/components/performance/PerformanceTrafficTable';
import { PerformanceUploadPanel } from '@/components/performance/PerformanceUploadPanel';
import { ReportsOperational } from '@/components/performance/ReportsOperational';

export type PerformanceSubTab = 'overview' | 'traffic' | 'upload' | 'operational';

const TABS: { id: PerformanceSubTab; tab: string; label: string }[] = [
  { id: 'overview', tab: 'pr-overview', label: 'Overview' },
  { id: 'traffic', tab: 'pr-traffic', label: 'Daily Traffic' },
  { id: 'upload', tab: 'pr-upload', label: 'Data Upload' },
  { id: 'operational', tab: 'pr-operational', label: 'Operational' },
];

export function PerformanceReportsPage() {
  const [subTab, setSubTab] = useState<PerformanceSubTab>('overview');
  const [overviewKey, setOverviewKey] = useState(0);

  return (
    <CalciteTabs layout="inline">
      <CalciteTabNav slot="title-group">
        {TABS.map((t) => (
          <CalciteTabTitle
            key={t.id}
            tab={t.tab}
            selected={subTab === t.id}
            onCalciteTabsActivate={() => setSubTab(t.id)}
          >
            {t.label}
          </CalciteTabTitle>
        ))}
      </CalciteTabNav>

      {/* Reported daily actuals — UC-3 backend, read-only. */}
      <CalciteTab tab="pr-overview" selected={subTab === 'overview'}>
        <Panel title="Performance — daily report headline (UC-3 backend, core.perf_*)" minHeight={220}>
          <PerformanceOverview key={overviewKey} />
        </Panel>
      </CalciteTab>

      <CalciteTab tab="pr-traffic" selected={subTab === 'traffic'}>
        <Panel title="Daily traffic — container TEUs + rail (core.perf_daily_traffic)" height={560}>
          <PerformanceTrafficTable key={overviewKey} />
        </Panel>
      </CalciteTab>

      <CalciteTab tab="pr-upload" selected={subTab === 'upload'}>
        <PerformanceUploadPanel onImported={() => setOverviewKey((k) => k + 1)} />
      </CalciteTab>

      {/* The original Reports tab content, unchanged. */}
      <CalciteTab tab="pr-operational" selected={subTab === 'operational'}>
        <ReportsOperational />
      </CalciteTab>
    </CalciteTabs>
  );
}
