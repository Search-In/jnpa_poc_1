/**
 * <DelayTrend> — trend line of a delay/TAT metric vs a target band.
 * Reused by Pre-Berthing Delay, Pre-Sailing Delay and Avg TAT (each passes the
 * snapshot field it reads + its target). Backed by getKpiHistory().
 */

import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { ensureChartsRegistered, baseOptions } from '@/charts/setup';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import type { KpiSnapshot } from '@/types/domain';
import { tokens } from '@/theme/tokens';
import { istTime } from '@/util/format';
import { PanelEmpty, PanelError, PanelLoading } from '../common/Panel';

ensureChartsRegistered();

export function DelayTrend({
  field,
  target,
  unit,
  label,
}: {
  field: keyof Pick<KpiSnapshot, 'PRE_BERTH_DELAY' | 'PRE_SAIL_DELAY' | 'AVG_TAT'>;
  target: number;
  unit: string;
  label: string;
}) {
  const { data, loading, error } = useAdapterQuery(
    () => getAdapter().getKpiHistory({ lastHours: 24 }),
    [],
    30_000
  );

  const chart = useMemo(() => {
    if (!data) return null;
    return {
      labels: data.map((s) => istTime(s.TS)),
      datasets: [
        {
          label: `${label} (${unit})`,
          data: data.map((s) => s[field]),
          borderColor: tokens.accent,
          backgroundColor: `${tokens.accent}22`,
          fill: true,
          tension: 0.3,
          pointRadius: 0,
        },
        {
          label: `Target ${target}${unit}`,
          data: data.map(() => target),
          borderColor: tokens.good,
          borderDash: [5, 4],
          pointRadius: 0,
          fill: false,
        },
      ],
    };
  }, [data, field, target, unit, label]);

  if (loading && !data) return <PanelLoading label={`Loading ${label}…`} />;
  if (error) return <PanelError message={error} />;
  if (!chart || data?.length === 0) return <PanelEmpty />;

  return <Line data={chart} options={baseOptions<'line'>()} />;
}
