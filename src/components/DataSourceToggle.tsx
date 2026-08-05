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
          ? 'Data source: LIVE — rows from the JNPA integration APIs. Switch to DEMO for the reliable pre-loaded data.'
          : 'Data source: DEMO — the reliable pre-loaded data. Switch to LIVE for JNPA-API-sourced rows.'
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
        {mode === 'LIVE' ? 'LIVE · JNPA API' : 'DEMO · pre-loaded'}
      </CalciteChip>
    </span>
  );
}
