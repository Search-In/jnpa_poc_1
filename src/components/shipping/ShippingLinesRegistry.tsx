/**
 * <ShippingLinesRegistry> — the Carrier Registry tab of the Shipping Lines module.
 *
 * Presentation-only wrapper that keeps the Panel framing the registry has always had
 * (same 520px bounded viewport). All behaviour — the `/api/shipping-lines/lines` read
 * through the UC-3 connector, the response mapping, the columns, the server's
 * busiest-first ordering, the client-side code/name filter, the styling and the
 * loading / error / empty states — stays inside <ShippingLinesTable>, untouched.
 *
 * Remounted by the parent (via `key`) after a successful upload, which is how the
 * registry refreshes.
 */

import { Panel } from '@/components/common/Panel';
import { ShippingLinesTable } from '@/components/shipping/ShippingLinesTable';

export function ShippingLinesRegistry() {
  return (
    <Panel title="Shipping Lines — Carrier Registry" height={520}>
      <ShippingLinesTable />
    </Panel>
  );
}
