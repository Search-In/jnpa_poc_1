/**
 * <PilotageDataUpload> — the Pilotage ▸ Data Upload tab.
 *
 * A presentation-only wrapper that pins the pilotage configuration onto the shared
 * <MarineUploadPanel>. Transport, validation, import, history and error handling all
 * stay inside MarineUploadPanel and the uc3/marineUpload connector — nothing is
 * reimplemented and no endpoint is added: pilot data continues to go through the SHARED
 * `/api/marine/upload` flow, which detects the format by content.
 */

import { MarineUploadPanel } from '@/components/marine/MarineUploadPanel';
import type { MarineImportResult } from '@/data/uc3/marineUpload';

export interface PilotageDataUploadProps {
  /** Called after a successful import so the pilot panes can refetch. */
  onImported?: (result: MarineImportResult) => void;
}

export function PilotageDataUpload({ onImported }: PilotageDataUploadProps) {
  return (
    <MarineUploadPanel
      title="Pilot data upload — validate → import (UC-3 backend)"
      accept=".xlsx,.xls,.csv,.xml"
      showTemplate={false}
      helpText="Accepts the pilot card workbook (Pilot_card_data.xlsx) and PCS pilot-memo messages (ACKPLM). The backend detects the format by content."
      onImported={onImported}
    />
  );
}
