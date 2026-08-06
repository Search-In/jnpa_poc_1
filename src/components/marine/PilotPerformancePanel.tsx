/**
 * <PilotPerformancePanel> — pilot boarded → all fast, as a DISTRIBUTION
 * (spec UI-039, screen M-07).
 *
 * The tender asks for pilot availability AND performance; a bare average tells a
 * marine department nothing they don't already know, so this renders the median
 * and 90th percentile per pilot (bars scaled to the fleet's worst P90), computed
 * server-side from the ingested pilot cards (`/api/marine/pilotage-performance`).
 * A movement filter switches between INWARD / OUTWARD / all.
 */

import { useState } from 'react';
import { CalciteSegmentedControl, CalciteSegmentedControlItem } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchPilotPerformance } from '@/data/uc3/marineDashboard';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';

const MOVEMENTS = ['ALL', 'INWARD', 'OUTWARD'] as const;

export function PilotPerformancePanel() {
  const [movement, setMovement] = useState<(typeof MOVEMENTS)[number]>('ALL');
  const { data, loading, error } = useAdapterQuery(
    () => fetchPilotPerformance(movement === 'ALL' ? undefined : movement),
    [movement],
  );

  if (loading) return <PanelLoading label="Loading pilot performance…" />;
  if (error) return <PanelError message={error} />;
  if (!data || !data.overall || data.overall.n === 0) {
    return <PanelEmpty message="No pilotage movements with both boarded and all-fast times." />;
  }

  const rows = [...data.perPilot].sort((a, b) => (b.n - a.n) || ((a.medianMin ?? 0) - (b.medianMin ?? 0)));
  const maxP90 = Math.max(...rows.map((r) => r.p90Min ?? 0), data.overall.p90Min ?? 0, 1);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ color: tokens.textMuted }}>
          Pilot boarded → all fast, minutes — median · P90 per pilot ({data.overall.n} movements,
          source: JNPA pilot cards). Distribution, never a single average.
        </div>
        <CalciteSegmentedControl
          scale="s"
          onCalciteSegmentedControlChange={(e) => {
            const v = (e.target as HTMLCalciteSegmentedControlElement).selectedItem?.value;
            if (v === 'ALL' || v === 'INWARD' || v === 'OUTWARD') setMovement(v);
          }}
        >
          {MOVEMENTS.map((m) => (
            <CalciteSegmentedControlItem key={m} value={m} checked={m === movement}>
              {m}
            </CalciteSegmentedControlItem>
          ))}
        </CalciteSegmentedControl>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '72px 1fr 110px',
          gap: '4px 8px',
          alignItems: 'center',
          padding: '6px 8px',
          borderRadius: 6,
          background: tokens.panelAlt,
          border: `1px solid ${tokens.border}`,
          fontWeight: 600,
        }}
      >
        <div>Fleet</div>
        <Bar median={data.overall.medianMin} p90={data.overall.p90Min} max={maxP90} />
        <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {fmt(data.overall.medianMin)} · {fmt(data.overall.p90Min)} (n={data.overall.n})
        </div>
      </div>

      <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.map((r) => (
          <div
            key={r.pilotCode || '(unset)'}
            style={{
              display: 'grid',
              gridTemplateColumns: '72px 1fr 110px',
              gap: '2px 8px',
              alignItems: 'center',
              padding: '2px 8px',
            }}
          >
            <div style={{ whiteSpace: 'nowrap' }}>{r.pilotCode || '(unset)'}</div>
            <Bar median={r.medianMin} p90={r.p90Min} max={maxP90} />
            <div style={{ textAlign: 'right', color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
              {fmt(r.medianMin)} · {fmt(r.p90Min)} (n={r.n})
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function fmt(v: number | null): string {
  return v === null ? '—' : `${Math.round(v)}m`;
}

/** Median (solid) inside the P90 span (tinted) — the shape of the tail at a glance. */
function Bar({ median, p90, max }: { median: number | null; p90: number | null; max: number }) {
  const mPct = median !== null ? Math.min((median / max) * 100, 100) : 0;
  const pPct = p90 !== null ? Math.min((p90 / max) * 100, 100) : 0;
  return (
    <div style={{ position: 'relative', height: 12, background: tokens.bgElevated, borderRadius: 3 }}>
      <div
        style={{
          position: 'absolute', inset: 0, width: `${pPct}%`,
          background: '#cfe3f2', borderRadius: 3,
        }}
      />
      <div
        style={{
          position: 'absolute', inset: 0, width: `${mPct}%`,
          background: tokens.accent, borderRadius: 3,
        }}
      />
    </div>
  );
}
