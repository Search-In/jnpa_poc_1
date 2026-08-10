/**
 * <DataSourceToggle> — a compact LIVE | DEMO segmented control + a small badge
 * showing the active data-SOURCE mode (the provenance of gateway-served rows,
 * NOT the app's SIMULATED/LIVE provenance chip). LIVE surfaces JNPA-API-sourced
 * rows; DEMO (default) the reliable manually-imported rows. The choice is
 * persisted (localStorage) and injected as the `X-Data-Mode` header on every
 * gateway request by data/uc3/client.ts.
 *
 * This app has no TanStack Query, so a change triggers a full reload — every
 * panel then refetches with the new header. Clearly labelled in the title.
 *
 * Simple rule: Data Upload always writes DEMO (MANUAL). LIVE is JNPA-API rows only.
 * Switch to DEMO to see anything imported through the SPA upload panels.
 */
import { useSyncExternalStore } from 'react';
import { CalciteChip, CalciteSegmentedControl, CalciteSegmentedControlItem } from '@esri/calcite-components-react';
import {
  getDataSourceMode,
  setDataSourceMode,
  subscribeDataSourceMode,
  type DataSourceMode,
} from '@/data/dataSourceMode';

export function DataSourceToggle() {
  const mode = useSyncExternalStore(subscribeDataSourceMode, getDataSourceMode, getDataSourceMode);

  const onChange = (next: DataSourceMode) => {
    if (next === mode) return;
    setDataSourceMode(next);
    // No TanStack Query in UC-1 — reload so every panel refetches with the new
    // X-Data-Mode header (rather than leaving stale rows on screen).
    window.location.reload();
  };

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
      title={
        mode === 'LIVE'
          ? 'LIVE — JNPA API corpus only. Data Upload always lands in DEMO — switch to DEMO to see charts you imported.'
          : 'DEMO — pre-loaded + Data Upload corpus. This is where bathymetry charts and other SPA imports appear.'
      }
    >
      <CalciteSegmentedControl
        scale="s"
        width="auto"
        onCalciteSegmentedControlChange={(e) =>
          onChange((e.target as unknown as { value: DataSourceMode }).value)
        }
      >
        <CalciteSegmentedControlItem value="LIVE" checked={mode === 'LIVE'} iconStart="lightning">
          LIVE
        </CalciteSegmentedControlItem>
        <CalciteSegmentedControlItem value="DEMO" checked={mode === 'DEMO'} iconStart="database">
          DEMO
        </CalciteSegmentedControlItem>
      </CalciteSegmentedControl>
      <CalciteChip scale="s" kind={mode === 'LIVE' ? 'brand' : 'neutral'} aria-label={`Data source ${mode}`}>
        {mode === 'LIVE' ? 'LIVE · live data' : 'DEMO · demo data'}
      </CalciteChip>
    </span>
  );
}
