/**
 * App shell — Calcite light theme. Wires the store lifecycle (vessel stream +
 * KPI refresh) and lays out the dashboard regions. Widget components are filled
 * in after the "show structure before widgets" review gate; until then each
 * region renders a labelled placeholder so the layout (and live data) is visible.
 */

import { useEffect } from 'react';
import { CalciteShell, CalciteNotice } from '@esri/calcite-components-react';
import { HeaderBar } from '@/components/HeaderBar';
import { useAppStore } from '@/store/useAppStore';
import { tokens } from '@/theme/tokens';

function Region({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <section
      className="app-region"
      aria-label={title}
      style={{ padding: 12, minHeight: 80, display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div style={{ fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: tokens.textMuted }}>
        {title}
      </div>
      {children ?? (
        <div style={{ color: tokens.textMuted, fontSize: 13 }}>
          Widget pending — built after structure review.
        </div>
      )}
    </section>
  );
}

/** Temporary live KPI summary so the data pipeline is visible before widgets. */
function KpiPreview() {
  const kpis = useAppStore((s) => s.kpis);
  const kpiError = useAppStore((s) => s.kpiError);
  const vesselCount = useAppStore((s) => s.vessels.length);

  if (kpiError) {
    return (
      <CalciteNotice open kind="danger" icon="exclamation-mark-triangle">
        <div slot="title">KPI load failed</div>
        <div slot="message">{kpiError}</div>
      </CalciteNotice>
    );
  }
  if (!kpis) return <div style={{ color: tokens.textMuted }}>Loading KPIs…</div>;

  const cards = Object.values(kpis);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: 8,
      }}
    >
      {cards.map((c) => (
        <div
          key={c.key}
          className="app-region"
          style={{ padding: 10, background: tokens.panelAlt }}
        >
          <div style={{ fontSize: 11, color: tokens.textMuted }}>{c.label}</div>
          <div style={{ fontSize: 22, fontWeight: 600, color: tokens.text }}>
            {c.value}
            <span style={{ fontSize: 12, color: tokens.textMuted, marginLeft: 2 }}>{c.unit}</span>
          </div>
          <div style={{ fontSize: 11, color: tokens.textMuted }}>
            target {c.target}
            {c.unit} · {c.deltaPct > 0 ? '▲' : c.deltaPct < 0 ? '▼' : '–'}{' '}
            {Math.abs(c.deltaPct)}%
          </div>
        </div>
      ))}
      <div style={{ gridColumn: '1 / -1', fontSize: 11, color: tokens.textMuted }}>
        {vesselCount} vessels in current AIS batch.
      </div>
    </div>
  );
}

export function App() {
  useEffect(() => useAppStore.getState().start(), []);

  return (
    <CalciteShell style={{ height: '100vh' }}>
      <div slot="header">
        <HeaderBar />
      </div>
      <main
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 360px',
          gridTemplateRows: 'auto 1fr',
          gap: 12,
          padding: 12,
          height: '100%',
          background: tokens.bg,
          overflow: 'auto',
        }}
      >
        <div style={{ gridColumn: '1 / -1' }}>
          <Region title="KPI Strip (live preview)">
            <KpiPreview />
          </Region>
        </div>
        <Region title="AIS Map" />
        <Region title="Vessel Feed" />
        <div style={{ gridColumn: '1 / -1' }}>
          <Region title="Marine KPI Reports" />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <Region title="Weather Panel + What-If" />
        </div>
      </main>
    </CalciteShell>
  );
}
