/**
 * <BerthingStats> — the berthing-report KPI row for the 5-Day Berthing ▸ Terminal
 * Reports sub-tab. Reads `/api/berthing/stats` via the Phase-1 connector and renders
 * the KpiStrip card-grid idiom (auto-fit minmax cards on tokens.panelAlt).
 *
 * These are UC-3-backed REPORT aggregates (per-terminal counts, mean berth time) over
 * jnpa.berthing_reports — NOT the 5-Day plan gantt, a different dataset in a sibling
 * sub-tab. The average stays nullable: "no berthed-and-departed call yet" renders '—',
 * never a misleading 0. Against an empty backend every count is 0 by design.
 */

import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchBerthingStats } from '@/data/uc3/berthing';
import type { BerthingStats as BerthingStatsT } from '@/types/domain';
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

/** Nullable hours → a 1-dp string, or '—' when unknown. */
function hours(v: number | null): string {
  return v === null ? '—' : `${v.toFixed(1)} h`;
}

export function BerthingStats() {
  const q = useAdapterQuery<BerthingStatsT>(() => fetchBerthingStats(), []);

  if (q.loading && !q.data) return <PanelLoading label="Loading berthing KPIs…" />;
  if (q.error) return <PanelError message={q.error} />;
  const s = q.data;
  if (!s) return null;

  const perTerminal = s.byTerminal.length
    ? s.byTerminal.map((t) => `${t.terminal} ${t.count}`).join(' · ')
    : 'no terminals yet';

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
      <StatCard label="Total calls" value={String(s.total)} hint={`${s.terminals} terminal${s.terminals === 1 ? '' : 's'}`} />
      <StatCard label="Expected" value={String(s.expected)} hint="not yet arrived" />
      <StatCard label="Arrived" value={String(s.arrived)} />
      <StatCard label="Berthed" value={String(s.berthed)} hint="alongside" />
      <StatCard label="Completed" value={String(s.completed)} />
      <StatCard label="Departed" value={String(s.departed)} />
      <StatCard label="Avg berth time" value={hours(s.avgBerthHours)} hint="departure − ATA" />
      <StatCard label="By terminal" value={String(s.byTerminal.length)} hint={perTerminal} />
    </div>
  );
}
