/**
 * App shell — Calcite light theme. Wires the store lifecycle (vessel stream +
 * KPI refresh) and lays out the full dashboard: header, KPI strip, live AIS map
 * + vessel feed, the marine KPI report widgets, and the weather/what-if panel.
 */

import { useEffect } from 'react';
import { CalciteShell } from '@esri/calcite-components-react';
import { HeaderBar } from '@/components/HeaderBar';
import { KpiStrip } from '@/components/KpiStrip';
import { AISMap } from '@/components/AISMap';
import { VesselFeed } from '@/components/VesselFeed';
import { WeatherPanel } from '@/components/WeatherPanel';
import { Panel } from '@/components/common/Panel';
import { BerthingPlanGantt } from '@/components/reports/BerthingPlanGantt';
import { ArrivalsDepartures } from '@/components/reports/ArrivalsDepartures';
import { DelayTrend } from '@/components/reports/DelayTrend';
import { JustInTime } from '@/components/reports/JustInTime';
import { PortCraftPerformance } from '@/components/reports/PortCraftPerformance';
import { PredictionAccuracy } from '@/components/reports/PredictionAccuracy';
import { KPI_TARGETS } from '@/config/targets';
import { useAppStore } from '@/store/useAppStore';
import { tokens } from '@/theme/tokens';

export function App() {
  useEffect(() => useAppStore.getState().start(), []);

  return (
    <CalciteShell style={{ height: '100vh' }}>
      <div slot="header">
        <HeaderBar />
      </div>

      <main
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          padding: 12,
          height: '100%',
          background: tokens.bg,
          overflow: 'auto',
        }}
      >
        {/* KPI strip — full width */}
        <KpiStrip />

        {/* Map (wide) + vessel feed (rail) */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 12 }}>
          <Panel title="Live AIS Map — Nhava Sheva approaches" minHeight={420}>
            <AISMap />
          </Panel>
          <Panel title="Vessel Feed (priority order)" minHeight={420}>
            <VesselFeed />
          </Panel>
        </div>

        {/* Marine KPI reports grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
            gap: 12,
          }}
        >
          <div style={{ gridColumn: '1 / -1' }}>
            <Panel title="Berthing Plan — 24h" minHeight={220}>
              <BerthingPlanGantt />
            </Panel>
          </div>

          <Panel title="Arrivals & Departures (4h blocks)" minHeight={240}>
            <ArrivalsDepartures />
          </Panel>

          <Panel title="Just-In-Time Arrivals" minHeight={240}>
            <JustInTime />
          </Panel>

          <Panel title="Pre-Berthing Delay vs target" minHeight={240}>
            <DelayTrend field="PRE_BERTH_DELAY" target={KPI_TARGETS.preBerthingDelay.target} unit="h" label="Pre-berthing delay" />
          </Panel>

          <Panel title="Pre-Sailing Delay vs target" minHeight={240}>
            <DelayTrend field="PRE_SAIL_DELAY" target={KPI_TARGETS.preSailingDelay.target} unit="h" label="Pre-sailing delay" />
          </Panel>

          <Panel title="Average Vessel TAT vs target" minHeight={240}>
            <DelayTrend field="AVG_TAT" target={KPI_TARGETS.avgTat.target} unit="h" label="Avg TAT" />
          </Panel>

          <Panel title="Port Craft Performance" minHeight={240}>
            <PortCraftPerformance />
          </Panel>

          <Panel title="Prediction Accuracy — ETA vs ATA" minHeight={240}>
            <PredictionAccuracy />
          </Panel>

          <Panel title="Weather & What-If" minHeight={240}>
            <WeatherPanel />
          </Panel>
        </div>
      </main>
    </CalciteShell>
  );
}
