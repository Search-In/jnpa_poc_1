/**
 * <ShippingLinesAdvanceListsTab> — the Advance Lists tab.
 *
 * Previously this wrapped a nested All / Import (IAL) / Export (EAL) tab strip. That
 * put a FILTER inside navigation: three tabs that differed only by the `list_type`
 * sent to the gateway, while every other filter sat in the toolbar below. It also
 * mounted three independent tables, so opening the tab fired three requests for the
 * same endpoint.
 *
 * List type is now a dropdown alongside Terminal in the table's own toolbar, so all
 * filtering lives in one place and the tab issues ONE request. The module's five
 * top-level tabs are unchanged.
 */

import { Panel } from '@/components/common/Panel';
import { ShippingLinesAdvanceLists } from '@/components/shipping/ShippingLinesAdvanceLists';

export function ShippingLinesAdvanceListsTab() {
  return (
    <Panel title="Advance Lists — IAL / EAL containers (core.advance_list_container)" height={560}>
      <ShippingLinesAdvanceLists />
    </Panel>
  );
}
