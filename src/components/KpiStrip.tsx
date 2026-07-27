/**
 * <KpiStrip> — the 8 headline KPI cards. Reads the computed KpiBundle from the
 * store (which sources it from the active DataAdapter). Each card shows value,
 * unit, target, a ▲/▼ delta coloured by whether the move is good, and a
 * sparkline of the recent trend.
 */

import { CalciteNotice } from '@esri/calcite-components-react';
import { useAppStore } from '@/store/useAppStore';
import { KPI_TARGETS } from '@/config/targets';
import type { KpiKey, KpiValue } from '@/types/kpi';
import { tokens } from '@/theme/tokens';
import { signedPct } from '@/util/format';
import { useHighlightedKpis } from '@/whatif/useHighlight';
import { Sparkline } from './common/Sparkline';

/** Card display order (matches the reference layout). */
const ORDER: KpiKey[] = [
  'preBerthingDelay',
  'preSailingDelay',
  'avgTat',
  'jitPct',
  'forecastAccuracy',
  'berthOccupancy',
  'anchored',
  'approaching',
];

function deltaColor(key: KpiKey, deltaPct: number): string {
  if (deltaPct === 0) return tokens.textMuted;
  const lowerIsBetter = KPI_TARGETS[key].lowerIsBetter;
  // "good" = value moved in the favourable direction relative to target.
  const isGood = lowerIsBetter ? deltaPct < 0 : deltaPct > 0;
  return isGood ? tokens.good : tokens.bad;
}

function Card({ kpi, lit, dim }: { kpi: KpiValue; lit?: boolean; dim?: boolean }) {
  const key = kpi.key as KpiKey;
  const color = deltaColor(key, kpi.deltaPct);
  const arrow = kpi.deltaPct > 0 ? '▲' : kpi.deltaPct < 0 ? '▼' : '–';

  // Spec UI-041 card anatomy: definition + arrival-time basis + baseline source
  // ride on the card (tooltip + footer) when the adapter supplies them. A KPI the
  // corpus cannot measure (sampleN 0 + note) renders '—' and its explanation —
  // never a fabricated zero.
  const unmeasurable = kpi.sampleN === 0 && !!kpi.note;
  const tooltip = [
    kpi.definition && `Definition: ${kpi.definition}`,
    kpi.basis && `Basis: ${kpi.basis}`,
    kpi.baselineSource && `Baseline: ${kpi.baselineSource}`,
    kpi.vsBaselinePct !== undefined &&
      `Measured vs published baseline: ${signedPct(kpi.vsBaselinePct)}`,
    kpi.note && `Note: ${kpi.note}`,
    kpi.sampleN !== undefined && `n = ${kpi.sampleN}`,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      className="app-region"
      style={{
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: lit ? `${tokens.accent}14` : tokens.panel,
        boxShadow: lit ? `inset 0 0 0 1.5px ${tokens.accent}` : 'none',
        opacity: dim ? 0.5 : 1,
        transition: 'opacity 120ms ease',
      }}
      role="group"
      aria-label={`${kpi.label}${lit ? ' — spotlighted by the active scenario' : ''}`}
      title={tooltip || undefined}
    >
      <div style={{ fontSize: 11, color: tokens.textMuted, minHeight: 26 }}>
        {kpi.label}
        {tooltip && (
          <span aria-hidden style={{ marginLeft: 4, cursor: 'help', opacity: 0.7 }}>ⓘ</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: tokens.text, lineHeight: 1 }}>
          {unmeasurable ? '—' : kpi.value}
        </span>
        {!unmeasurable && kpi.unit && (
          <span style={{ fontSize: 13, color: tokens.textMuted }}>{kpi.unit}</span>
        )}
      </div>
      {unmeasurable ? (
        <div style={{ fontSize: 10, color: tokens.textMuted, lineHeight: 1.35 }}>{kpi.note}</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 11, color, fontWeight: 600 }} aria-label={`delta vs target ${signedPct(kpi.deltaPct)}`}>
            {arrow} {signedPct(kpi.deltaPct)}
          </span>
          <span style={{ fontSize: 10, color: tokens.textMuted }}>
            target {kpi.target}
            {kpi.unit}
          </span>
        </div>
      )}
      {!unmeasurable && (
        <Sparkline points={kpi.trend} color={color === tokens.textMuted ? tokens.accent : color} height={24} width={140} />
      )}
      {/* Spec UI-041: the published-baseline line. When JNPA publishes a figure for
          this KPI, show it with the measured-vs-published delta — the tender's
          "improvement vs current baseline operations", against a REAL number. */}
      {kpi.baselineValue !== undefined ? (
        <div style={{ fontSize: 9.5, color: tokens.textMuted, lineHeight: 1.35 }}>
          <span style={{ fontWeight: 700 }}>
            JNPA baseline {kpi.baselineValue}
            {kpi.unit} {kpi.baselinePeriod ? `(${kpi.baselinePeriod})` : ''}
          </span>
          {kpi.vsBaselinePct !== undefined && (
            <span
              style={{
                marginLeft: 4,
                fontWeight: 700,
                color: deltaColor(key, kpi.vsBaselinePct),
              }}
            >
              {signedPct(kpi.vsBaselinePct)} vs baseline
            </span>
          )}
          <div>jnport.gov.in ▸ Reports ▸ Operating Performance Profile</div>
        </div>
      ) : (
        kpi.baselineSource && (
          <div style={{ fontSize: 9, color: tokens.textMuted, lineHeight: 1.3 }}>
            {kpi.baselineSource}
          </div>
        )
      )}
    </div>
  );
}

export function KpiStrip() {
  const kpis = useAppStore((s) => s.kpis);
  const kpiError = useAppStore((s) => s.kpiError);
  // What-if spotlight: light the KPI cards the active scenario's causal chain
  // names (e.g. M4 → JIT), keeping the KPI wall in sync with the reactive guide.
  const litKpis = useHighlightedKpis();

  if (kpiError) {
    return (
      <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
        <div slot="title">KPI computation failed</div>
        <div slot="message">{kpiError}</div>
      </CalciteNotice>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 10,
      }}
    >
      {ORDER.map((key) =>
        kpis ? (
          <Card key={key} kpi={kpis[key]} lit={litKpis.has(key)} dim={litKpis.size > 0 && !litKpis.has(key)} />
        ) : (
          <div
            key={key}
            className="app-region"
            style={{ padding: 12, minHeight: 110, background: tokens.panelAlt }}
            aria-label={`${KPI_TARGETS[key].label} loading`}
          >
            <div style={{ fontSize: 11, color: tokens.textMuted }}>{KPI_TARGETS[key].label}</div>
            <div style={{ fontSize: 13, color: tokens.textMuted, marginTop: 8 }}>…</div>
          </div>
        )
      )}
    </div>
  );
}
