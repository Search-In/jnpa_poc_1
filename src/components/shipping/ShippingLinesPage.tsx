/**
 * <ShippingLinesPage> — the whole Shipping Lines module: a top-level UC-1 operational
 * module covering the carrier registry and the cargo-document layer.
 *
 *   Shipping Lines
 *     ├── Overview           layer counts
 *     ├── Carrier Registry   core.ref_shipping_line
 *     ├── Advance Lists      core.advance_list_container — All / Import (IAL) / Export (EAL)
 *     ├── Delivery Orders    core.delivery_order_line (EDO / CODECO)
 *     └── Data Upload        validate → import, plus the import ledger
 *          ▲ Overview is the default
 *
 * Shipping Lines is a cargo / customs capability, not a vessel-traffic one: a carrier
 * intersects vessel calls MANY-to-MANY through the container line item, so it is a
 * peer domain rather than a child of Vessels.
 *
 * State follows the App shell's existing sub-tab pattern exactly — plain useState in
 * the screen's parent, as in Vessels ▸ …, DUKC ▸ Sea Channels and Port Craft.
 *
 * REFRESH-AFTER-UPLOAD. `dataKey` is bumped on a successful import and applied to
 * EVERY read surface, because one import can change all of them: the ledger gains a
 * file, the registry may gain carrier codes, and the advance-list / delivery-order
 * tables gain rows. Overview and Carrier Registry are remounted via `key`; the
 * document tables and the ledger take it as a query dependency so they refetch in
 * place without losing their Panel framing. Keying only some of them would leave the
 * rest silently stale — the failure this indirection exists to prevent.
 */

import { useState } from 'react';
import {
  CalciteTabs,
  CalciteTabNav,
  CalciteTabTitle,
  CalciteTab,
} from '@esri/calcite-components-react';
import { ShippingLinesOverview } from '@/components/shipping/ShippingLinesOverview';
import { ShippingLinesRegistry } from '@/components/shipping/ShippingLinesRegistry';
import { ShippingLinesAdvanceListsTab } from '@/components/shipping/ShippingLinesAdvanceListsTab';
import { ShippingLinesDeliveryOrdersTab } from '@/components/shipping/ShippingLinesDeliveryOrdersTab';
import { ShippingLinesDataUpload } from '@/components/shipping/ShippingLinesDataUpload';

/** Overview is the default — the module opens on the layer counts. */
export type ShippingLinesSubTab = 'overview' | 'registry' | 'advance' | 'delivery' | 'upload';

const TABS: { id: ShippingLinesSubTab; tab: string; label: string }[] = [
  { id: 'overview', tab: 'sl-overview', label: 'Overview' },
  { id: 'registry', tab: 'sl-registry', label: 'Carrier Registry' },
  { id: 'advance', tab: 'sl-advance', label: 'Advance Lists' },
  { id: 'delivery', tab: 'sl-delivery', label: 'Delivery Orders' },
  { id: 'upload', tab: 'sl-upload', label: 'Data Upload' },
];

export function ShippingLinesPage() {
  const [subTab, setSubTab] = useState<ShippingLinesSubTab>('overview');
  // Bumped after a successful advance-list / delivery-order import so every read
  // surface refreshes. Presentation-only — no query logic changes.
  const [dataKey, setDataKey] = useState(0);

  return (
    <CalciteTabs layout="inline">
      <CalciteTabNav slot="title-group">
        {TABS.map((t) => (
          <CalciteTabTitle
            key={t.id}
            tab={t.tab}
            selected={subTab === t.id}
            onCalciteTabsActivate={() => setSubTab(t.id)}
          >
            {t.label}
          </CalciteTabTitle>
        ))}
      </CalciteTabNav>

      {/* Layer counts (carriers · advance containers · delivery orders · files). */}
      <CalciteTab tab="sl-overview" selected={subTab === 'overview'}>
        <ShippingLinesOverview key={dataKey} />
      </CalciteTab>

      {/* Carrier registry (core.ref_shipping_line). */}
      <CalciteTab tab="sl-registry" selected={subTab === 'registry'}>
        <ShippingLinesRegistry key={dataKey} />
      </CalciteTab>

      {/* IAL / EAL advance-list containers, with All / Import / Export views. */}
      <CalciteTab tab="sl-advance" selected={subTab === 'advance'}>
        <ShippingLinesAdvanceListsTab key={dataKey} />
      </CalciteTab>

      {/* EDO / CODECO delivery orders. */}
      <CalciteTab tab="sl-delivery" selected={subTab === 'delivery'}>
        <ShippingLinesDeliveryOrdersTab key={dataKey} />
      </CalciteTab>

      {/* Validate → import, plus the import ledger. On a successful import, bump the
          key so every tab above refetches. */}
      <CalciteTab tab="sl-upload" selected={subTab === 'upload'}>
        <ShippingLinesDataUpload
          refreshKey={dataKey}
          onImported={() => setDataKey((k) => k + 1)}
        />
      </CalciteTab>
    </CalciteTabs>
  );
}
