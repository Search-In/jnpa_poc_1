/**
 * <BathymetryDataUpload> — the Bathymetry ▸ Data Upload tab.
 *
 * A presentation-only wrapper that pins the bathymetry configuration onto the shared
 * <MarineUploadPanel>, exactly as <PortCraftDataUpload> does for the craft register.
 * The upload transport, payload, validation, import, history and success/error handling
 * all stay inside MarineUploadPanel and its uc3/marineUpload connector — nothing is
 * reimplemented here, and NO endpoint is added: a bathymetry chart goes through the
 * SHARED `/api/marine/upload` flow.
 *
 * `accept` covers BOTH ingestion arms deliberately. The gateway routes a PDF and the
 * canonical bathymetry JSON under the same `document_type=BATHYMETRY`, and both land in
 * the same canonical model, so the JSON API arm needs no separate upload surface — it is
 * already supported here.
 */

import { MarineUploadPanel } from '@/components/marine/MarineUploadPanel';
import type { MarineImportResult } from '@/data/uc3/marineUpload';

export interface BathymetryDataUploadProps {
  /** Called after a successful import so the Overview / Surveys tabs can refetch. */
  onImported?: (result: MarineImportResult) => void;
}

export function BathymetryDataUpload({ onImported }: BathymetryDataUploadProps) {
  return (
    <MarineUploadPanel
      title="Bathymetry chart upload — validate → import (UC-3 backend)"
      accept=".pdf,application/pdf,.json,application/json"
      showTemplate={false}
      helpText={
        'Accepts a multibeam bathymetry chart PDF (e.g. 6148-24-SUR-PO-111-EF.pdf) or the ' +
        'canonical bathymetry JSON. The backend detects the format by content and extracts ' +
        'the soundings — depth, above-design flag and UTM 43N coordinates where the chart ' +
        'carries a grid. The survey header is created from the drawing number on first import.'
      }
      onImported={onImported}
    />
  );
}
