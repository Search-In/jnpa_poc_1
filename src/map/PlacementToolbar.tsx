/**
 * PlacementToolbar — Export / Import / Reset for the 3D asset placements (ported
 * from the UC-2 editing workflow). The scene is seeded from the committed
 * `data/positions.json` (shared JNPA geography); this toolbar lets an operator
 * export the current placements, preview an imported file live, or reset to the
 * seed. To make an edit permanent, commit the exported file to data/positions.json.
 */
import { useState, useSyncExternalStore } from 'react';
import { CalciteButton } from '@esri/calcite-components-react';
import { placementStore, downloadPlacements, importPlacements } from './placementStore';
import { tokens } from '@/theme/tokens';

export function PlacementToolbar({ onChanged }: { onChanged?: () => void }) {
  // Re-render on any placement change so the count stays live.
  const count = useSyncExternalStore(
    (cb) => placementStore.subscribe(cb),
    () => placementStore.count(),
  );
  const [importError, setImportError] = useState<string | null>(null);

  return (
    <div style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
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
          setImportError(null);
          void importPlacements()
            .then(() => {
              onChanged?.();
              // Geometry (terminals/berths/channel) is derived from the store at
              // load; a reload re-derives it from the imported placements.
              window.location.reload();
            })
            .catch((e: unknown) => {
              // Cancelled pickers leave the promise pending in some browsers;
              // real failures (invalid JSON / empty placements) land here.
              const msg = e instanceof Error ? e.message : String(e);
              if (/no file selected/i.test(msg)) return;
              setImportError(msg || 'Import failed');
            });
        }}
        title="Load a positions.json (version 1) and re-derive the JNPA geography from it"
      >
        Import
      </CalciteButton>
      <CalciteButton
        scale="s"
        appearance="outline"
        iconStart="reset"
        onClick={() => {
          setImportError(null);
          placementStore.clear();
          onChanged?.();
        }}
        title="Revert to the seeded placements (data/positions.json)"
      >
        Reset
      </CalciteButton>
      {importError && (
        <span
          role="alert"
          style={{
            fontSize: 11,
            color: tokens.bad,
            maxWidth: 280,
            lineHeight: 1.3,
          }}
          title={importError}
        >
          Import failed: {importError}
        </span>
      )}
    </div>
  );
}
