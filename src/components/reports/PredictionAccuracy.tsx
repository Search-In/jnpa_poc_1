/**
 * <PredictionAccuracy> — ETA-vs-ATA accuracy.
 *
 * Two views, picked by what data exists:
 *   1. When the prediction source has RESOLVED pairs (predicted ETA + actual
 *      arrival), show the per-vessel predicted-vs-actual lead-time overlay +
 *      computed accuracy/MAPE (the live/Velocity history path).
 *   2. Otherwise fall back to the FORECAST_ACC trend from the KPISnapshots layer
 *      (real persisted accuracy), so the widget always shows real data instead
 *      of a blank "no predictions" state.
 */

import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import { ensureChartsRegistered, baseOptions } from '@/charts/setup';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { env } from '@/data/config';
import { forecastAccuracyPct, mape, hoursBetween, mean, type EtaPrediction } from '@/kpi';
import { tokens } from '@/theme/tokens';
import { istTime } from '@/util/format';
import { PanelError, PanelLoading, PanelEmpty } from '../common/Panel';

ensureChartsRegistered();

const H = 3_600_000;

export function PredictionAccuracy() {
  const now = Date.now();
  // Pull both sources; widen the snapshot window so seeded history still shows
  // even when its dates don't line up exactly with the live clock.
  const predQ = useAdapterQuery(
    () => getAdapter().getPrediction({ lastHours: env.historyHours }),
    [],
    30_000
  );
  const histQ = useAdapterQuery(
    () => getAdapter().getKpiHistory({ lastHours: env.historyHours }),
    [],
    30_000
  );

  const resolvedView = useMemo(() => {
    const data = predQ.data;
    if (!data) return null;
    const resolved = data.filter((p) => p.actualAta !== null);
    if (resolved.length === 0) return null;
    const reference = now - 12 * H;
    const etaPredictions: EtaPrediction[] = resolved.map((p) => ({
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
  }, [predQ.data, now]);

  const trendView = useMemo(() => {
    const snaps = histQ.data;
    if (!snaps || snaps.length === 0) return null;
    const accValues = snaps.map((s) => s.FORECAST_ACC);
    return {
      latest: accValues[accValues.length - 1],
      avg: mean(accValues),
      chart: {
        labels: snaps.map((s) => istTime(s.TS)),
        datasets: [
          {
            label: 'Forecast accuracy %',
            data: accValues,
            borderColor: tokens.accent,
            backgroundColor: `${tokens.accent}22`,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
          },
        ],
      },
    };
  }, [histQ.data]);

  if ((predQ.loading && !predQ.data) || (histQ.loading && !histQ.data)) {
    return <PanelLoading label="Loading prediction accuracy…" />;
  }
  if (predQ.error && histQ.error) return <PanelError message={predQ.error} />;

  // Preferred: resolved per-vessel overlay.
  if (resolvedView) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>
        <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
          <span style={{ color: tokens.text }}>
            Accuracy <strong style={{ color: tokens.good }}>{resolvedView.accuracy.toFixed(1)}%</strong>
          </span>
          <span style={{ color: tokens.textMuted }}>MAPE {resolvedView.mapePct.toFixed(1)}%</span>
          <span style={{ color: tokens.textMuted }}>n={resolvedView.count}</span>
        </div>
        <div style={{ flex: 1, minHeight: 120 }}>
          <Line data={resolvedView.chart} options={baseOptions<'line'>()} />
        </div>
      </div>
    );
  }

  // Fallback: persisted FORECAST_ACC trend.
  if (trendView) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6 }}>
        <div style={{ display: 'flex', gap: 16, fontSize: 12 }}>
          <span style={{ color: tokens.text }}>
            Latest <strong style={{ color: tokens.good }}>{trendView.latest.toFixed(1)}%</strong>
          </span>
          <span style={{ color: tokens.textMuted }}>avg {trendView.avg.toFixed(1)}%</span>
          <span style={{ color: tokens.textMuted }}>(ETA forecast trend)</span>
        </div>
        <div style={{ flex: 1, minHeight: 120 }}>
          <Line data={trendView.chart} options={baseOptions<'line'>()} />
        </div>
      </div>
    );
  }

  return <PanelEmpty message="No prediction or forecast-accuracy data available." />;
}
