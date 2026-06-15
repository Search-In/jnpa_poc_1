/**
 * <JustInTime> — half-gauge of current JIT% + a small trend line beneath.
 * Reads JIT from the store's KPI bundle (current) and getKpiHistory() (trend).
 */

import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { ensureChartsRegistered, baseOptions } from '@/charts/setup';
import { useAppStore } from '@/store/useAppStore';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { env } from '@/data/config';
import { KPI_TARGETS } from '@/config/targets';
import { tokens } from '@/theme/tokens';
import { istTime } from '@/util/format';
import { PanelLoading } from '../common/Panel';

ensureChartsRegistered();

function Gauge({ pct, target }: { pct: number; target: number }) {
  const r = 70;
  const cx = 90;
  const cy = 86;
  // Semicircle from 180° (left) to 0° (right).
  const angle = Math.PI * (1 - Math.min(100, Math.max(0, pct)) / 100);
  const x = cx + r * Math.cos(angle);
  const y = cy - r * Math.sin(angle);
  const targetAngle = Math.PI * (1 - target / 100);
  const tx = cx + r * Math.cos(targetAngle);
  const ty = cy - r * Math.sin(targetAngle);
  const color = pct >= target ? tokens.good : pct >= target * 0.8 ? tokens.warn : tokens.bad;

  return (
    <svg width={180} height={104} role="img" aria-label={`Just-in-time ${pct}%`}>
      {/* track */}
      <path d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`} fill="none" stroke={tokens.border} strokeWidth={12} />
      {/* value arc */}
      <path
        d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${x} ${y}`}
        fill="none"
        stroke={color}
        strokeWidth={12}
        strokeLinecap="round"
      />
      {/* target tick */}
      <line x1={cx + (r - 8) * Math.cos(targetAngle)} y1={cy - (r - 8) * Math.sin(targetAngle)} x2={tx} y2={ty} stroke={tokens.text} strokeWidth={2} />
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize={26} fontWeight={700} fill={tokens.text}>
        {pct.toFixed(0)}%
      </text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize={10} fill={tokens.textMuted}>
        target {target}%
      </text>
    </svg>
  );
}

export function JustInTime() {
  const kpis = useAppStore((s) => s.kpis);
  const { data } = useAdapterQuery(
    () => getAdapter().getKpiHistory({ lastHours: env.historyHours }),
    [],
    30_000
  );

  const trend = useMemo(() => {
    if (!data) return null;
    return {
      labels: data.map((s) => istTime(s.TS)),
      datasets: [
        {
          label: 'JIT %',
          data: data.map((s) => s.JIT_PCT),
          borderColor: tokens.accent,
          backgroundColor: `${tokens.accent}22`,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
        },
      ],
    };
  }, [data]);

  if (!kpis) return <PanelLoading label="Loading JIT…" />;

  const pct = kpis.jitPct.value;
  const target = KPI_TARGETS.jitPct.target;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 4 }}>
      <div style={{ display: 'grid', placeItems: 'center' }}>
        <Gauge pct={pct} target={target} />
      </div>
      <div style={{ flex: 1, minHeight: 80 }}>
        {trend && <Line data={trend} options={{ ...baseOptions<'line'>(), plugins: { legend: { display: false } } }} />}
      </div>
    </div>
  );
}
