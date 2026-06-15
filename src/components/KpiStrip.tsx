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

function Card({ kpi }: { kpi: KpiValue }) {
  const key = kpi.key as KpiKey;
  const color = deltaColor(key, kpi.deltaPct);
  const arrow = kpi.deltaPct > 0 ? '▲' : kpi.deltaPct < 0 ? '▼' : '–';

  return (
    <div
      className="app-region"
      style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6, background: tokens.panel }}
      role="group"
      aria-label={kpi.label}
    >
      <div style={{ fontSize: 11, color: tokens.textMuted, minHeight: 26 }}>{kpi.label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: tokens.text, lineHeight: 1 }}>
          {kpi.value}
        </span>
        {kpi.unit && <span style={{ fontSize: 13, color: tokens.textMuted }}>{kpi.unit}</span>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 11, color, fontWeight: 600 }} aria-label={`delta vs target ${signedPct(kpi.deltaPct)}`}>
          {arrow} {signedPct(kpi.deltaPct)}
        </span>
        <span style={{ fontSize: 10, color: tokens.textMuted }}>
          target {kpi.target}
          {kpi.unit}
        </span>
      </div>
      <Sparkline points={kpi.trend} color={color === tokens.textMuted ? tokens.accent : color} height={24} width={140} />
    </div>
  );
}

export function KpiStrip() {
  const kpis = useAppStore((s) => s.kpis);
  const kpiError = useAppStore((s) => s.kpiError);

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
          <Card key={key} kpi={kpis[key]} />
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
