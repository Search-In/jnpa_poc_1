/**
 * <ShippingLinesOverview> — the Overview tab of the Shipping Lines module, and its
 * default tab: the layer counts for the carrier registry and the cargo-document
 * layer (advance-list containers, delivery orders, import files).
 *
 * Presentation-only wrapper. Every count comes from the existing
 * <ShippingLinesSummaryCards>, rendered UNCHANGED — same `/api/shipping-lines/summary`
 * read through the UC-3 connector, same card idiom, same loading and error states.
 * The Panel framing (title + minHeight) is the one the cards have always had; only
 * the stale `jnpa.shipping_lines` reference in the title is gone, since the live
 * backing store is `core.ref_shipping_line`.
 *
 * Remounted by the parent (via `key`) after a successful upload, which is how the
 * counts refresh.
 */

import { Panel } from '@/components/common/Panel';
import { ShippingLinesSummaryCards } from '@/components/shipping/ShippingLinesSummaryCards';

export function ShippingLinesOverview() {
  return (
    <Panel title="Shipping Lines — Overview" minHeight={120}>
      <ShippingLinesSummaryCards />
    </Panel>
  );
}
