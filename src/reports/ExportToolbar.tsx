/**
 * ExportToolbar — one-click printable exports of the marine KPI reports (spec
 * §B3.14): Berthing Plan and Arrivals & Departures. Fetches through the adapter
 * and hands off to exportReports (a self-contained, offline print view). Every
 * export carries a SIMULATED provenance line.
 */
import { CalciteButton } from '@esri/calcite-components-react';
import { getAdapter } from '@/data';
import { env } from '@/data/config';
import { exportBerthingPlan, exportArrivalsDepartures } from './exportReports';
import { tokens } from '@/theme/tokens';

export function ExportToolbar() {
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
      <span style={{ fontSize: 12, color: tokens.textMuted }}>Export marine KPI report:</span>
      <CalciteButton
        scale="s"
        appearance="outline"
        iconStart="print"
        onClick={() => {
          void getAdapter()
            .getBerthPlan({ lastHours: env.historyHours })
            .then(exportBerthingPlan)
            .catch(() => {});
        }}
      >
        Berthing Plan
      </CalciteButton>
      <CalciteButton
        scale="s"
        appearance="outline"
        iconStart="print"
        onClick={() => {
          void getAdapter()
            .getArrivalsDepartures({ lastHours: env.historyHours })
            .then(exportArrivalsDepartures)
            .catch(() => {});
        }}
      >
        Arrivals &amp; Departures
      </CalciteButton>
    </div>
  );
}
