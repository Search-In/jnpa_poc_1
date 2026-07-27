/**
 * <ShippingLinesDataUpload> — the Data Upload tab of the Shipping Lines module:
 * the upload workflow, then its searchable/filterable import ledger.
 *
 * The WRITE path is untouched. <ShippingLinesUploadPanel> keeps sole ownership of
 * `POST /api/shipping-lines/validate` and `/upload` — same multipart payload, same
 * IAL/EAL/EDO document-type selector, same validation, same success / error /
 * duplicate handling, and the same RBAC behaviour where a read-only role sees
 * disabled controls with a lock notice rather than a hidden feature.
 *
 * <ShippingLinesUploadHistory> below it is a READ of the existing
 * `GET /api/shipping-lines/uploads` ledger. It is keyed off the same import counter
 * the parent uses, so a successful import refreshes the history in place.
 *
 * `onImported` is forwarded verbatim so the parent can also refresh Overview,
 * Carrier Registry, Advance Lists and Delivery Orders.
 */

import { ShippingLinesUploadPanel } from '@/components/shipping/ShippingLinesUploadPanel';
import { ShippingLinesUploadHistory } from '@/components/shipping/ShippingLinesUploadHistory';
import { Panel } from '@/components/common/Panel';
import type { ShippingLinesImportResult } from '@/data/uc3/shippingLines';
import { tokens } from '@/theme/tokens';

export interface ShippingLinesDataUploadProps {
  /** Called after a successful import so the sibling data tabs can refetch. */
  onImported?: (result: ShippingLinesImportResult) => void;
  /** Bumped by the parent after a successful import; refetches the ledger below. */
  refreshKey?: number;
}

export function ShippingLinesDataUpload({ onImported, refreshKey = 0 }: ShippingLinesDataUploadProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
      <ShippingLinesUploadPanel onImported={onImported} />
      <Panel title="Upload history — import ledger (core.sl_import_file)" height={420}>
        <ShippingLinesUploadHistory refreshKey={refreshKey} />
      </Panel>
    </div>
  );
}
