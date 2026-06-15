/**
 * <PredictionAccuracy> — predicted ETA vs actual ATA overlay + MAPE/accuracy.
 * Backed by getPrediction(). Accuracy uses the same forecastAccuracyPct() the
 * KPI engine uses, computed over prediction lead time.
 */

import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { ensureChartsRegistered, baseOptions } from '@/charts/setup';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { forecastAccuracyPct, mape, hoursBetween, type EtaPrediction } from '@/kpi';
import { tokens } from '@/theme/tokens';
import { PanelError, PanelLoading, PanelEmpty } from '../common/Panel';

ensureChartsRegistered();

const H = 3_600_000;

export function PredictionAccuracy() {
  const now = Date.now();
  const { data, loading, error } = useAdapterQuery(
    () => getAdapter().getPrediction({ lastHours: 24 }),
    [],
    30_000
  );

  const view = useMemo(() => {
    if (!data) return null;
    const resolved = data.filter((p) => p.actualAta !== null);
    const reference = now - 12 * H;
    const etaPredictions: EtaPrediction[] = data.map((p) => ({
      reference,
      predictedEta: p.predictedEta,
      actualAta: p.actualAta,
    }));
    const accuracy = forecastAccuracyPct(etaPredictions);
    const mapePct =
      mape(
        etaPredictions.map((p) => ({
          predicted: hoursBetween(p.reference, p.predictedEta),
          actual: p.actualAta === null ? null : hoursBetween(p.reference, p.actualAta),
        }))
      ) * 100;

    const chart = {
      labels: resolved.map((p) => p.VESSEL_NAME),
      datasets: [
        {
          label: 'Predicted ETA (lead h)',
          data: resolved.map((p) => Number(hoursBetween(reference, p.predictedEta).toFixed(2))),
          borderColor: tokens.accent,
          pointRadius: 3,
          tension: 0.2,
        },
        {
          label: 'Actual ATA (lead h)',
          data: resolved.map((p) => Number(hoursBetween(reference, p.actualAta as number).toFixed(2))),
          borderColor: tokens.warn,
          pointRadius: 3,
          tension: 0.2,
        },
      ],
    };
    return { chart, accuracy, mapePct, count: resolved.length };
  }, [data, now]);

  if (loading && !data) return <PanelLoading label="Loading prediction accuracy…" />;
  if (error) return <PanelError message={error} />;
  if (!view || view.count === 0) return <PanelEmpty message="No resolved ETA predictions yet." />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>
      <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
        <span style={{ color: tokens.text }}>
          Accuracy <strong style={{ color: tokens.good }}>{view.accuracy.toFixed(1)}%</strong>
        </span>
        <span style={{ color: tokens.textMuted }}>MAPE {view.mapePct.toFixed(1)}%</span>
        <span style={{ color: tokens.textMuted }}>n={view.count}</span>
      </div>
      <div style={{ flex: 1, minHeight: 120 }}>
        <Line data={view.chart} options={baseOptions<'line'>()} />
      </div>
    </div>
  );
}
