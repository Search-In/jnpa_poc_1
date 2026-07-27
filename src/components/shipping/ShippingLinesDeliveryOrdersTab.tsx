/**
 * <ShippingLinesDeliveryOrdersTab> — the Delivery Orders (EDO) tab.
 *
 * Presentation-only wrapper that gives the delivery-order table the same Panel
 * framing as the other Shipping Lines tables. All behaviour lives in
 * <ShippingLinesDeliveryOrders>.
 */

import { Panel } from '@/components/common/Panel';
import { ShippingLinesDeliveryOrders } from '@/components/shipping/ShippingLinesDeliveryOrders';

export function ShippingLinesDeliveryOrdersTab() {
  return (
    <Panel title="Delivery Orders — EDO / CODECO (core.delivery_order_line)" height={560}>
      <ShippingLinesDeliveryOrders />
    </Panel>
  );
}
