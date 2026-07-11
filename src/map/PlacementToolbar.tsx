/**
 * PlacementToolbar — Export / Import / Reset for the 3D asset placements (ported
 * from the UC-2 editing workflow). The scene is seeded from the committed
 * `data/positions.json` (shared JNPA geography); this toolbar lets an operator
 * export the current placements, preview an imported file live, or reset to the
 * seed. To make an edit permanent, commit the exported file to data/positions.json.
 */
import { useSyncExternalStore } from 'react';
import { CalciteButton } from '@esri/calcite-components-react';
import { placementStore, downloadPlacements, importPlacements } from './placementStore';

export function PlacementToolbar({ onChanged }: { onChanged?: () => void }) {
  // Re-render on any placement change so the count stays live.
  const count = useSyncExternalStore(
    (cb) => placementStore.subscribe(cb),
    () => placementStore.count(),
  );

  return (
    <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <CalciteButton
        scale="s"
        appearance="outline"
        iconStart="download"
        disabled={count === 0}
        onClick={() => downloadPlacements('JNPA 3D asset placements (UC-1)')}
        title="Download positions.json (commit it to data/positions.json to make it permanent)"
      >
        Export{count ? ` (${count})` : ''}
      </CalciteButton>
      <CalciteButton
        scale="s"
        appearance="outline"
        iconStart="upload"
        onClick={() => {
          void importPlacements()
            .then(() => {
              onChanged?.();
              // Geometry (terminals/berths/channel) is derived from the store at
              // load; a reload re-derives it from the imported placements.
              window.location.reload();
            })
            .catch(() => {
              /* cancelled / invalid — no-op */
            });
        }}
        title="Load a positions.json and re-derive the JNPA geography from it"
      >
        Import
      </CalciteButton>
      <CalciteButton
        scale="s"
        appearance="outline"
        iconStart="reset"
        onClick={() => {
          placementStore.clear();
          onChanged?.();
        }}
        title="Revert to the seeded placements (data/positions.json)"
      >
        Reset
      </CalciteButton>
    </div>
  );
}
