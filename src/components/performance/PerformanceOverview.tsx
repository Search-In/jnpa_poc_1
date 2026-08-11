/**
 * <PerformanceOverview> — headline KPI cards for Performance & Reports ▸ Overview.
 *
 * Reads `GET /api/performance/kpi` (read-only) through the uc3/performance connector.
 * Card grid follows the existing KpiStrip / MarineStatCards / ShippingLinesSummaryCards
 * idiom: auto-fit minmax tiles on tokens.panelAlt, no new design language.
 *
 * These are REPORTED ACTUALS from the JNPA Daily Status Report, which is a different
 * thing from the KPI Wall's figures — those are computed in-browser from the
 * simulated/live adapter feed (src/kpi/formulas.ts). The two are deliberately NOT
 * reconciled here and the panel says which it is showing, so an operator can never
 * mistake a reported daily total for a live modelled one.
 *
 * Delta handling: the gateway omits a delta it could not compute. An absent delta
 * renders as "—", never as 0, so "no change" stays distinguishable from "unknown".
 */

import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchPerformanceKpi } from '@/data/uc3/performance';
import type { PerformanceKpi, PerformanceMetrics } from '@/types/domain';
import { PanelError, PanelLoading, PanelEmpty } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';

/**
 * Which direction is GOOD for each metric — a rising pendency is bad, rising
 * throughput is good. `neutral` metrics are shown without a verdict colour.
 */
const BETTER: Record<keyof PerformanceMetrics, 'up' | 'down' | 'neutral'> = {
  totalTeus: 'up',
  totalTonnes: 'up',
  vesselCalls: 'neutral',
  yardOccupancyPct: 'neutral',
  gateTotalTeus: 'up',
  gateInTeus: 'neutral',
  gateOutTeus: 'neutral',
  totalPendencyTeus: 'down',
  reeferAvailableSlots: 'neutral',
  reeferTotalSlots: 'neutral',
};

const CARDS: { key: keyof PerformanceMetrics; label: string; unit?: string; hint?: string }[] = [
  { key: 'totalTeus', label: 'Total TEUs', hint: 'JN Port, day' },
  { key: 'totalTonnes', label: 'Total tonnage', unit: ' t', hint: 'JNPA total, day' },
  { key: 'vesselCalls', label: 'Vessel calls' },
  { key: 'yardOccupancyPct', label: 'Yard occupancy', unit: '%' },
  { key: 'gateTotalTeus', label: 'Gate throughput', hint: 'in + out TEUs' },
  { key: 'totalPendencyTeus', label: 'Pendency', hint: 'ICD + CFS TEUs' },
  { key: 'reeferAvailableSlots', label: 'Reefer slots free' },
];

function fmt(v: number | null, unit = ''): string {
  if (v === null) return '—';
  const n = Number.isInteger(v) ? v.toLocaleString('en-IN') : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  return `${n}${unit}`;
}

/** Signed delta with a verdict colour, or '—' when the gateway could not compute it. */
function Delta({ value, better }: { value: number | null | undefined; better: 'up' | 'down' | 'neutral' }) {
  if (value === null || value === undefined) {
    return <span style={{ fontSize: 10.5, color: tokens.textMuted }}>— vs prev. report</span>;
  }
  const flat = value === 0;
  const good = better === 'neutral' || flat ? null : better === 'up' ? value > 0 : value < 0;
  const color = good === null ? tokens.kpi.neutral : good ? tokens.kpi.better : tokens.kpi.worse;
  const sign = value > 0 ? '+' : '';
  return (
    <span style={{ fontSize: 10.5, color, marginTop: 4, display: 'block' }}>
      {sign}
      {value.toLocaleString('en-IN', { maximumFractionDigits: 2 })} vs prev. report
    </span>
  );
}

function Card({ kpi, spec }: { kpi: PerformanceKpi; spec: (typeof CARDS)[number] }) {
  return (
    <div
      className="app-region"
      aria-label={spec.label}
      style={{ padding: 12, minHeight: 92, background: tokens.panelAlt, borderRadius: tokens.radius.sm }}
    >
      <div style={{ fontSize: 11, color: tokens.textMuted, letterSpacing: 0.3 }}>{spec.label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tokens.text, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
        {fmt(kpi.metrics[spec.key], spec.unit)}
      </div>
      {spec.hint && <div style={{ fontSize: 10.5, color: tokens.textMuted, marginTop: 2 }}>{spec.hint}</div>}
      <Delta value={kpi.deltas[spec.key]} better={BETTER[spec.key]} />
    </div>
  );
}

export function PerformanceOverview() {
  // No date argument: the gateway resolves its own latest report, so the panel cannot
  // go stale against a hardcoded day.
  const q = useAdapterQuery(() => fetchPerformanceKpi(), []);

  if (q.loading && !q.data) return <PanelLoading label="Loading performance KPIs…" />;
  if (q.error) return <PanelError message={q.error} />;
  if (!q.data || !q.data.reportDate) {
    return (
      <PanelEmpty message="No daily performance report has been imported yet. Use Performance & Reports → Data Upload (admin) to import a Daily Status Report PDF/CSV." />
    );
  }
  const kpi = q.data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
      <p style={{ margin: 0, fontSize: 11.5, color: tokens.textMuted }}>
        Reported actuals from the JNPA Daily Status Report for <strong>{kpi.reportDate}</strong>
        {kpi.prevReportDate ? ` · deltas vs ${kpi.prevReportDate}` : ' · no earlier report to compare'}.
        Distinct from the KPI Wall, which models the live/simulated feed.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        {CARDS.map((spec) => (
          <Card key={spec.key} kpi={kpi} spec={spec} />
        ))}
      </div>
    </div>
  );
}
