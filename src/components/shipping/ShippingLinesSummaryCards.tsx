/**
 * <ShippingLinesSummaryCards> — the dashboard KPI row for the Vessels ▸ Shipping Lines
 * sub-tab. Reads `/api/shipping-lines/summary` via the UC-3 connector and renders the
 * KpiStrip card-grid idiom (auto-fit minmax cards on tokens.panelAlt).
 *
 * UC-3-backed layer counts (advance-list containers, delivery orders, carriers) over the
 * jnpa.sl_* tables. Against an empty backend every count is 0 by design; the failed-files
 * card is a data-quality signal.
 */

import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchShippingLinesSummary } from '@/data/uc3/shippingLines';
import type { ShippingLinesSummary } from '@/types/domain';
import { PanelError, PanelLoading } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';

/** One KPI card — same look as the KpiStrip / MarineStatCards tiles. */
function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="app-region"
      aria-label={label}
      style={{ padding: 12, minHeight: 84, background: tokens.panelAlt, borderRadius: tokens.radius.sm }}
    >
      <div style={{ fontSize: 11, color: tokens.textMuted, letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tokens.text, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: 10.5, color: tokens.textMuted, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function ShippingLinesSummaryCards() {
  const q = useAdapterQuery<ShippingLinesSummary>(() => fetchShippingLinesSummary(), []);

  if (q.loading && !q.data) return <PanelLoading label="Loading shipping-line summary…" />;
  if (q.error) return <PanelError message={q.error} />;
  const s = q.data;
  if (!s) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
      <StatCard label="Shipping lines" value={String(s.shippingLines)} hint="carrier codes" />
      <StatCard label="Advance containers" value={String(s.advanceContainers)} hint={`${s.distinctContainers} distinct`} />
      <StatCard label="Delivery orders" value={String(s.deliveryOrders)} hint="EDO / CODECO" />
      <StatCard label="With Bill of Lading" value={String(s.withBl)} />
      <StatCard label="Import files" value={String(s.files)} hint={`${s.failedFiles} failed`} />
    </div>
  );
}
