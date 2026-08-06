/**
 * <PortCraftDataUpload> — the Port Craft ▸ Data Upload tab.
 *
 * A presentation-only wrapper that pins the port-craft configuration onto the shared
 * <MarineUploadPanel>. The upload transport, payload, validation, import, history and
 * success/error handling all stay inside MarineUploadPanel and its uc3/marineUpload
 * connector — nothing is reimplemented here, and no endpoint is added: the port-craft
 * PDF continues to go through the SHARED `/api/marine/upload` flow.
 *
 * The props below are exactly the ones the App shell used to pass inline, moved
 * verbatim so behaviour is identical.
 */

import { MarineUploadPanel } from '@/components/marine/MarineUploadPanel';
import type { MarineImportResult } from '@/data/uc3/marineUpload';

export interface PortCraftDataUploadProps {
  /** Called after a successful import so the Fleet Register tab can refetch. */
  onImported?: (result: MarineImportResult) => void;
}

export function PortCraftDataUpload({ onImported }: PortCraftDataUploadProps) {
  return (
    <MarineUploadPanel
      title="Port-craft data upload — validate → import (UC-3 backend)"
      accept=".pdf,application/pdf"
      showTemplate={false}
      helpText="Accepts the port-craft register PDF (e.g. Details_of_Port_Crafts.pdf). The backend detects the format by content."
      onImported={onImported}
    />
  );
}
