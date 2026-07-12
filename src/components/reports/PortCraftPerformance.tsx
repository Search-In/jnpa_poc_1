/**
 * <PortCraftPerformance> — pilot/tug/mooring utilisation bars + avg response.
 * Backed by getPortCraft(); computed with the craftPerformance() KPI formula.
 */

import { useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import { ensureChartsRegistered, baseOptions } from '@/charts/setup';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { craftPerformance, type CraftJob } from '@/kpi';
import { useSimStore } from '@/sim/simStore';
import { tokens } from '@/theme/tokens';
import { PanelError, PanelLoading, PanelEmpty } from '../common/Panel';

ensureChartsRegistered();

export function PortCraftPerformance() {
  const simVersion = useSimStore((s) => s.version);
  const { data, loading, error } = useAdapterQuery(() => getAdapter().getPortCraft(), [simVersion], 30_000);

  const stats = useMemo(() => {
    if (!data) return null;
    const jobs: CraftJob[] = data.map((c) => ({
      type: c.TYPE,
      deployed: c.STATUS === 'deployed',
      responseMin: c.RESPONSE_MIN,
    }));
    return craftPerformance(jobs);
  }, [data]);

  if (loading && !data) return <PanelLoading label="Loading port craft…" />;
  if (error) return <PanelError message={error} />;
  if (!stats || stats.every((s) => s.count === 0)) return <PanelEmpty message="No port craft data." />;

  const chart = {
    labels: stats.map((s) => s.type.toUpperCase()),
    datasets: [
      {
        label: 'Utilisation %',
        data: stats.map((s) => Math.round(s.utilisationPct)),
        backgroundColor: tokens.accent,
        borderRadius: 3,
        yAxisID: 'y',
      },
      {
        label: 'Avg response (min)',
        data: stats.map((s) => Math.round(s.avgResponseMin)),
        backgroundColor: tokens.warn,
        borderRadius: 3,
        yAxisID: 'y1',
      },
    ],
  };

  const opts = baseOptions<'bar'>();
  return (
    <Bar
      data={chart}
      options={{
        ...opts,
        scales: {
          x: { grid: { color: tokens.border }, ticks: { font: { size: 10 } } },
          y: {
            grid: { color: tokens.border },
            beginAtZero: true,
            max: 100,
            title: { display: true, text: '% util' },
          },
          y1: {
            type: 'linear',
            position: 'right',
            beginAtZero: true,
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'min' },
          },
        },
      }}
    />
  );
}
