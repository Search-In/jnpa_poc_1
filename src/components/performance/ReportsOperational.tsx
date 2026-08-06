/**
 * <ReportsOperational> — the Operational sub-tab of Performance & Reports.
 *
 * This is the ORIGINAL Reports tab content, moved verbatim out of the App shell: the
 * print/export toolbar, Arrivals & Departures, Weather & Sea-State and the priority
 * Live Vessel Feed. Same components, same Panel titles, same grid template, same
 * heights — nothing about their data sources or business logic is touched, and all
 * four continue to read the DataAdapter chain exactly as before.
 *
 * It sits beside the new Performance sub-tabs rather than being replaced by them,
 * because these four are live operational views while Performance shows reported
 * daily actuals from the UC-3 backend. Different sources, different questions.
 */

import { Panel } from '@/components/common/Panel';
import { ExportToolbar } from '@/reports/ExportToolbar';
import { ArrivalsDepartures } from '@/components/reports/ArrivalsDepartures';
import { WeatherPanel } from '@/components/WeatherPanel';
import { VesselFeed } from '@/components/VesselFeed';

export function ReportsOperational() {
  return (
    <>
      <ExportToolbar />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 12 }}>
        <Panel title="Arrivals & Departures (4h blocks)" minHeight={260}>
          <ArrivalsDepartures />
        </Panel>
        <Panel title="Weather & Sea-State" minHeight={260}>
          <WeatherPanel />
        </Panel>
        <div style={{ gridColumn: '1 / -1' }}>
          <Panel title="Live Vessel Feed (priority order)" height={360}>
            <VesselFeed />
          </Panel>
        </div>
      </div>
    </>
  );
}
