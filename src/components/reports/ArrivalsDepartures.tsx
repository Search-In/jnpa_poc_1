/**
 * <ArrivalsDepartures> — grouped bar of arrivals vs departures per 4h block.
 * Backed by getArrivalsDepartures().
 */

import { useMemo } from 'react';
import { Bar } from 'react-chartjs-2';
import { ensureChartsRegistered, baseOptions } from '@/charts/setup';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { env } from '@/data/config';
import { tokens } from '@/theme/tokens';
import { PanelEmpty, PanelError, PanelLoading } from '../common/Panel';

ensureChartsRegistered();

const H = 3_600_000;

export function ArrivalsDepartures() {
  const now = Date.now();
  // Cap the display span so the 4h-block bar chart stays readable, but cover at
  // least 48h so the seeded plan (which spans ~2 days) appears.
  const spanH = Math.min(env.historyHours, 48);
  const { data, loading, error } = useAdapterQuery(
    () => getAdapter().getArrivalsDepartures({ from: now - spanH * H, to: now }),
    [],
    30_000
  );

  const chart = useMemo(() => {
    if (!data) return null;
    return {
      labels: data.map((b) => b.label),
      datasets: [
        {
          label: 'Arrivals',
          data: data.map((b) => b.arrivals),
          backgroundColor: tokens.accent,
          borderRadius: 3,
        },
        {
          label: 'Departures',
          data: data.map((b) => b.departures),
          backgroundColor: tokens.warn,
          borderRadius: 3,
        },
      ],
    };
  }, [data]);

  if (loading && !data) return <PanelLoading label="Loading arrivals/departures…" />;
  if (error) return <PanelError message={error} />;
  if (!chart || data?.length === 0) return <PanelEmpty />;

  const opts = baseOptions<'bar'>();
  return (
    <Bar
      data={chart}
      options={{
        ...opts,
        scales: {
          x: { grid: { color: tokens.border }, ticks: { font: { size: 10 } } },
          y: { grid: { color: tokens.border }, beginAtZero: true, ticks: { precision: 0, font: { size: 10 } } },
        },
      }}
    />
  );
}
