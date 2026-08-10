/**
 * <ShowAnomalyToggle> — the "Show ANOMALY Data" control, shared by every imported list.
 *
 * Default ON, so a screen behaves exactly as it did before this feature existed until an
 * operator chooses otherwise. Uses the same CalciteLabel + CalciteCheckbox idiom as the
 * existing "In port only" filter, so it sits in the filter row without new styling.
 */

import { CalciteCheckbox, CalciteLabel } from '@esri/calcite-components-react';

export interface ShowAnomalyToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Anomalies currently hidden, shown when the toggle is off so nothing vanishes silently. */
  hiddenCount?: number;
}

export function ShowAnomalyToggle({ checked, onChange, hiddenCount = 0 }: ShowAnomalyToggleProps) {
  return (
    <CalciteLabel
      layout="inline"
      scale="s"
      style={{ margin: 0 }}
      title="An imported record missing more than two configured business fields is flagged ANOMALY."
    >
      <CalciteCheckbox
        checked={checked || undefined}
        onCalciteCheckboxChange={(e) =>
          onChange((e.target as unknown as { checked: boolean }).checked)}
      />
      Show ANOMALY data
      {/* Never hide rows silently — say how many the filter removed. */}
      {!checked && hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ''}
    </CalciteLabel>
  );
}
