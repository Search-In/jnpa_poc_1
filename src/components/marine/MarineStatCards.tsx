/**
 * <MarineStatCards> — the vessel-call KPI row for the Vessels ▸ Vessel Calls
 * sub-tab. Reads `/api/marine/calls/stats` via the Phase-1 connector and renders
 * the KpiStrip card-grid idiom (auto-fit minmax cards on tokens.panelAlt).
 *
 * These are UC-3-backed CALL aggregates (turnaround, pre-berthing delay), NOT the
 * live-AIS KPI wall — a different dataset on a different tab. Averages stay nullable:
 * "no completed call yet" renders '—', never a misleading 0. Against an empty
 * backend (before any CSV upload) every count is 0 by design.
 */

import { useSyncExternalStore } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchMarineStats } from '@/data/uc3/marineCalls';
import { getAsOfDate, getAsOfDayRange, subscribeAsOfDate } from '@/data/asOfDate';
import type { MarineCallStats } from '@/types/domain';
import { PanelError, PanelLoading } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';

/** One KPI card — same look as the KpiStrip loading tiles. */
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

/** Nullable hours → a signed, 1-dp string, or '—' when unknown. */
function hours(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)} h`;
}

export function MarineStatCards() {
  // Header date-pin (UC1-004): re-anchors these cards to the picked corpus day's
  // ETA window instead of every call ever recorded.
  const asOfDate = useSyncExternalStore(subscribeAsOfDate, getAsOfDate, getAsOfDate);
  const q = useAdapterQuery<MarineCallStats>(
    () => fetchMarineStats(getAsOfDayRange() ?? {}),
    [asOfDate],
  );

  if (q.loading && !q.data) return <PanelLoading label="Loading vessel-call KPIs…" />;
  if (q.error) return <PanelError message={q.error} />;
  const s = q.data;
  if (!s) return null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
      <StatCard label="Total calls" value={String(s.total)} hint={`${s.withVcn} with VCN · ${s.withoutVcn} pre-VCN`} />
      <StatCard label="In port" value={String(s.inPort)} hint="arrived, not yet sailed" />
      <StatCard label="Arrived" value={String(s.arrived)} />
      <StatCard label="Ops completed" value={String(s.opsCompleted)} />
      <StatCard label="Departed" value={String(s.departed)} />
      <StatCard label="Avg turnaround" value={hours(s.avgTurnaroundHours)} hint="ATD − ATA" />
      <StatCard label="Avg pre-berth delay" value={hours(s.avgPreBerthDelayHours)} hint="ATA − ETA (negative = early)" />
    </div>
  );
}
