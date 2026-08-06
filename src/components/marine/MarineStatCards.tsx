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

import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchMarineKpis } from '@/data/uc3/marineKpis';
import { useMarineStateVersion } from '@/data/uc3/marineStateBus';
import { fetchMarineStats } from '@/data/uc3/marineCalls';
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
  const q = useAdapterQuery<MarineCallStats>(() => fetchMarineStats(), []);
  // OPERATIONAL KPIs, every figure a tally of the Marine Projection's own verdicts.
  // Kept alongside the factual /calls/stats cards rather than replacing them: the two
  // answer different questions, and the stats contract stays untouched.
  const marineVersion = useMarineStateVersion();
  const k = useAdapterQuery(() => fetchMarineKpis(), [marineVersion]);

  if (q.loading && !q.data) return <PanelLoading label="Loading vessel-call KPIs…" />;
  if (q.error) return <PanelError message={q.error} />;
  const s = q.data;
  if (!s) return null;
  const ops = k.data;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
      <StatCard label="Total calls" value={String(s.total)} hint={`${s.withVcn} with VCN · ${s.withoutVcn} pre-VCN`} />
      <StatCard label="In port" value={String(s.inPort)} hint="arrived, not yet sailed" />
      <StatCard label="Arrived" value={String(s.arrived)} />
      <StatCard label="Ops completed" value={String(s.opsCompleted)} />
      <StatCard label="Departed" value={String(s.departed)} />
      <StatCard label="Avg turnaround" value={hours(s.avgTurnaroundHours)} hint="ATD − ATA" />
      <StatCard label="Avg pre-berth delay" value={hours(s.avgPreBerthDelayHours)} hint="ATA − ETA (negative = early)" />

      {/* Projection-driven. Rendered only once the KPI call answers, so a gateway that
          predates the endpoint simply shows the factual cards above — no error, no gap. */}
      {ops && (
        <>
          <StatCard label="Pilots busy" value={`${ops.pilot.busy} / ${ops.pilot.known}`}
                    hint={`${ops.pilot.utilisationPct}% utilised · ${ops.pilot.available} free`} />
          <StatCard label="Awaiting pilot" value={String(ops.pilot.waitingAssignment)}
                    hint="active calls with no pilot assigned" />
          <StatCard label="Under pilotage" value={String(ops.pilot.underPilotage)} />
          <StatCard label="Craft busy" value={`${ops.craft.busy} / ${ops.craft.fleetTotal}`}
                    hint={`${ops.craft.utilisationPct}% utilised · ${ops.craft.available} free`} />
          <StatCard label="Awaiting craft" value={String(ops.craft.waitingAssignment)}
                    hint="needs craft, none committed" />
          <StatCard label="Marine support required" value={String(ops.operations.marineSupportRequired)}
                    hint="movements the board lists" />
          <StatCard label="At berth" value={String(ops.operations.atBerth)} />
          <StatCard label="Awaiting berthing" value={String(ops.operations.awaitingBerthing)} />
          <StatCard label="Completed today" value={String(ops.operations.completedToday)}
                    hint="departures since midnight" />
        </>
      )}
    </div>
  );
}
