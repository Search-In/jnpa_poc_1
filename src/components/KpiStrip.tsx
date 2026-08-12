/**
 * <KpiStrip> — the 8 headline KPI cards (UC1-042 / UI-041). Each card shows
 * measured value + unit, tender-exact name, definition tooltip (arrival-time
 * basis + n), p50/p90 distribution link, provenance chip (LIVE/SIM), and a
 * baseline-source statement. Unmeasurable = dash + explanation.
 */

import { CalciteNotice } from '@esri/calcite-components-react';
import { InfoPopover } from '@/components/common/InfoPopover';
import { useAppStore } from '@/store/useAppStore';
import { KPI_TARGETS } from '@/config/targets';
import type { KpiKey, KpiValue } from '@/types/kpi';
import { tokens } from '@/theme/tokens';
import { signedPct } from '@/util/format';
import { useHighlightedKpis } from '@/whatif/useHighlight';
import { Sparkline } from './common/Sparkline';

/** Tender display order (UC1-042). */
const ORDER: KpiKey[] = [
  'jitPct',
  'preBerthingDelay',
  'preSailingDelay',
  'avgTat',
  'portCraftOptimization',
  'forecastAccuracy',
  'berthOccupancy',
  'anchored',
];

function deltaColor(key: KpiKey, deltaPct: number): string {
  if (deltaPct === 0) return tokens.textMuted;
  const lowerIsBetter = KPI_TARGETS[key].lowerIsBetter;
  const isGood = lowerIsBetter ? deltaPct < 0 : deltaPct > 0;
  return isGood ? tokens.good : tokens.bad;
}

function ProvenanceChip({ mode }: { mode: NonNullable<KpiValue['provenance']> }) {
  const color =
    mode === 'SIM' ? tokens.mode.SIM : mode === 'LIVE' ? tokens.mode.LIVE : tokens.mode.REPLAY;
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.4,
        color,
        border: `1px solid ${color}`,
        borderRadius: 3,
        padding: '0 4px',
        lineHeight: '14px',
        whiteSpace: 'nowrap',
      }}
      aria-label={`provenance ${mode}`}
    >
      {mode}
    </span>
  );
}

function Card({
  kpi,
  lit,
  dim,
  onOpenDistribution,
}: {
  kpi: KpiValue;
  lit?: boolean;
  dim?: boolean;
  onOpenDistribution?: () => void;
}) {
  const key = kpi.key as KpiKey;
  const color = deltaColor(key, kpi.deltaPct);
  const arrow = kpi.deltaPct > 0 ? '▲' : kpi.deltaPct < 0 ? '▼' : '–';

  // Spec UI-041: a KPI the corpus cannot measure (sampleN 0 + note) renders '—'
  // and its explanation — never a fabricated zero / bare percentage.
  const unmeasurable = kpi.sampleN === 0 && !!kpi.note;
  const tooltip = [
    kpi.definition && `Definition: ${kpi.definition}`,
    kpi.basis && `Basis: ${kpi.basis}`,
    kpi.baselineSource && `Baseline: ${kpi.baselineSource}`,
    kpi.vsBaselinePct !== undefined &&
      `Measured vs published baseline: ${signedPct(kpi.vsBaselinePct)}`,
    kpi.note && `Note: ${kpi.note}`,
    kpi.sampleN !== undefined && `n = ${kpi.sampleN}`,
    kpi.p50 != null && `p50 = ${kpi.p50}${kpi.unit ? ` ${kpi.unit}` : ''}`,
    kpi.p90 != null && `p90 = ${kpi.p90}${kpi.unit ? ` ${kpi.unit}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n');

  const distLabel =
    kpi.p50 != null || kpi.p90 != null
      ? `p50 ${kpi.p50 ?? '—'} · p90 ${kpi.p90 ?? '—'}`
      : 'p50 / p90 distribution';

  // Spec UI-041 baseline-source. Same content and branching as before — it is only
  // moved OFF the card face and shown on demand through the title info popup.
  const baselineInfo =
    kpi.baselineValue !== undefined && !unmeasurable ? (
      <>
        <span style={{ fontWeight: 700 }}>
          JNPA baseline {kpi.baselineValue}
          {kpi.unit} {kpi.baselinePeriod ? `(${kpi.baselinePeriod})` : ''}
        </span>
        {kpi.vsBaselinePct !== undefined && (
          <span
            style={{ marginLeft: 4, fontWeight: 700, color: deltaColor(key, kpi.vsBaselinePct) }}
          >
            {signedPct(kpi.vsBaselinePct)} vs baseline
          </span>
        )}
        <div>{kpi.baselineSource ?? 'jnport.gov.in ▸ Reports ▸ Operating Performance Profile'}</div>
      </>
    ) : kpi.baselineSource ? (
      <span>{kpi.baselineSource}</span>
    ) : null;

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
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 6,
          minHeight: 26,
        }}
      >
        <div style={{ fontSize: 11, color: tokens.textMuted, lineHeight: 1.3 }}>
          {kpi.label}
          {baselineInfo && (
            <span style={{ marginLeft: 3, verticalAlign: 'middle' }}>
              <InfoPopover label={`${kpi.label} — baseline & source`}>{baselineInfo}</InfoPopover>
            </span>
          )}
        </div>
        {kpi.provenance && kpi.provenance !== 'SIM' && <ProvenanceChip mode={kpi.provenance} />}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: tokens.text, lineHeight: 1 }}>
          {unmeasurable ? '—' : kpi.value}
        </span>
        {!unmeasurable && kpi.unit && (
          <span style={{ fontSize: 13, color: tokens.textMuted }}>{kpi.unit}</span>
        )}
        {!unmeasurable && kpi.sampleN !== undefined && (
          <span style={{ fontSize: 11, color: tokens.textMuted }}>(n={kpi.sampleN})</span>
        )}
      </div>

      {kpi.breakdown && !unmeasurable && (
        <div style={{ fontSize: 10, color: tokens.textMuted, lineHeight: 1.3 }}>{kpi.breakdown}</div>
      )}

      {unmeasurable ? (
        <div style={{ fontSize: 10, color: tokens.textMuted, lineHeight: 1.35 }}>{kpi.note}</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span
            style={{ fontSize: 11, color, fontWeight: 600 }}
            aria-label={`delta vs target ${signedPct(kpi.deltaPct)}`}
          >
            {arrow} {signedPct(kpi.deltaPct)}
          </span>
          <span style={{ fontSize: 10, color: tokens.textMuted }}>
            target {kpi.target}
            {kpi.unit}
          </span>
        </div>
      )}

      {!unmeasurable && (
        <button
          type="button"
          onClick={onOpenDistribution}
          style={{
            alignSelf: 'flex-start',
            fontSize: 10,
            color: tokens.accent,
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: onOpenDistribution ? 'pointer' : 'help',
            textDecoration: 'underline',
            textUnderlineOffset: 2,
          }}
          title={
            kpi.p50 != null || kpi.p90 != null
              ? `Distribution: p50=${kpi.p50 ?? '—'} p90=${kpi.p90 ?? '—'} (n=${kpi.sampleN ?? '—'})`
              : 'Open Analytics & JIT for waiting-time / TAT distribution'
          }
        >
          {distLabel}
        </button>
      )}

      {!unmeasurable && (
        <Sparkline
          points={kpi.trend}
          color={color === tokens.textMuted ? tokens.accent : color}
          height={24}
          width={140}
        />
      )}

      {/* Spec UI-041 baseline-source is no longer rendered on the card face — its
          content moved into the title info popup (`baselineInfo`). */}
    </div>
  );
}

export function KpiStrip({ onOpenDistribution }: { onOpenDistribution?: () => void } = {}) {
  const kpis = useAppStore((s) => s.kpis);
  const kpiError = useAppStore((s) => s.kpiError);
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
          <Card
            key={key}
            kpi={kpis[key]}
            lit={litKpis.has(key)}
            dim={litKpis.size > 0 && !litKpis.has(key)}
            onOpenDistribution={onOpenDistribution}
          />
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
        ),
      )}
    </div>
  );
}
