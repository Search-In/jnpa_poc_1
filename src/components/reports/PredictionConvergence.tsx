/**
 * <PredictionConvergence> — Prediction-vs-Actual Convergence (spec §B2.6).
 *
 * The literal answer to the "Accuracy of prediction vs real-time" KPI. As the
 * sim clock (useSimStore.clockH) advances, we plot two series against the
 * shrinking forecast horizon of a set of target events (vessel arrivals):
 *
 *   • Predicted  — the horizon-time estimate, ~fixed once issued (tokens.accent).
 *   • Realised   — the running estimate that the sim reveals with shrinking
 *                  error as the clock approaches each event (tokens.warn).
 *
 * A faint on-target band (tokens.good) marks the ±tolerance the two series must
 * fall within to count as converged. Rolling MAE (mean absolute error, hours)
 * and MAPE (%) are recomputed every tick over the last N *resolved* events.
 *
 * INTEGRITY: this is a *simulated convergence under stated assumptions*, driven
 * deterministically from getAdapter().getPrediction() (predictedEta vs
 * actualAta) plus a seeded horizon model. It is a holdout-style accuracy readout
 * — NOT a claimed baseline or an improvement figure.
 */

import { useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import type { ChartData, ChartOptions } from 'chart.js';
import { ensureChartsRegistered, baseOptions } from '@/charts/setup';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { env } from '@/data/config';
import { useSimStore } from '@/sim/simStore';
import { tokens } from '@/theme/tokens';
import type { PredictionPoint } from '@/types/domain';
import { PanelError, PanelLoading, PanelEmpty } from '../common/Panel';

ensureChartsRegistered();

const H = 3_600_000;

/** Rolling window: error is averaged over the last N resolved events. */
const ROLLING_N = 12;
/** On-target band half-width, hours. Two series "converged" inside ±this. */
const ON_TARGET_BAND_H = 0.5;
/** Sim-hours before an event at which a prediction is first issued (horizon). */
const ISSUE_HORIZON_H = 12;

/** Deterministic unit hash from a string seed → [0,1). No Math.random. */
function seed01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // >>> 0 → unsigned; scale into [0,1)
  return ((h >>> 0) % 100000) / 100000;
}

interface EventModel {
  key: string;
  /** Sim-hour (relative to the loaded prediction window) at which the event lands. */
  eventH: number;
  /** The true realised value in the same sim-hour axis. */
  actualH: number;
  /** The fixed prediction issued at horizon, in the same axis. */
  predictedH: number;
}

interface Sample {
  key: string;
  /** Remaining horizon at the current clock: eventH − clockH (hours, ≥0). */
  horizonH: number;
  predicted: number;
  realised: number;
  resolved: boolean;
}

export function PredictionConvergence() {
  // Recompute the convergence on every clock tick — clockH is the sim time.
  const clockH = useSimStore((s) => s.clockH);

  const predQ = useAdapterQuery(
    () => getAdapter().getPrediction({ lastHours: env.historyHours }),
    [],
    30_000
  );

  // Map the adapter's predicted/actual epoch pairs onto a sim-hour horizon axis.
  // predictedEta is the fixed forecast; actualAta (when present) is the truth,
  // and its offset from the prediction seeds a deterministic residual so the
  // synthesised realised series converges to a real, non-arbitrary endpoint.
  const events = useMemo<EventModel[]>(() => {
    const pts = predQ.data;
    if (!pts) return [];
    const base = pts.reduce((min, p) => Math.min(min, p.predictedEta), Infinity);
    if (!Number.isFinite(base)) return [];

    return pts.map((p: PredictionPoint, i): EventModel => {
      const predictedH = (p.predictedEta - base) / H;
      // Realised residual: use the real ATA gap when resolved, else a seeded one.
      const residualH =
        p.actualAta !== null
          ? (p.actualAta - p.predictedEta) / H
          : (seed01(`${p.MMSI}:${i}`) - 0.5) * 4; // ±2h seeded spread
      const actualH = predictedH + residualH;
      // The event "lands" at the realised time; predictions issue ISSUE_HORIZON_H
      // sim-hours before that so the clock can walk the horizon down to zero.
      return { key: `${p.MMSI}:${i}`, eventH: actualH, actualH, predictedH };
    });
  }, [predQ.data]);

  // Per-tick samples: for each event, project predicted (~fixed) and realised
  // (revealed with error ∝ remaining horizon) at the current clock.
  const samples = useMemo<Sample[]>(() => {
    return events
      .filter((e) => clockH >= e.eventH - ISSUE_HORIZON_H)
      .map((e): Sample => {
        const horizonH = Math.max(0, e.eventH - clockH);
        const resolved = clockH >= e.eventH;
        // Error shrinks linearly from full residual at issue-horizon to 0 at the
        // event. The realised estimate walks from predicted toward the truth.
        const frac = horizonH / ISSUE_HORIZON_H;
        const realised = resolved
          ? e.actualH
          : e.predictedH + (e.actualH - e.predictedH) * (1 - frac);
        return { key: e.key, horizonH, predicted: e.predictedH, realised, resolved };
      });
  }, [events, clockH]);

  // Rolling MAE / MAPE over the last N resolved events (by event time).
  const stats = useMemo(() => {
    const resolved = events
      .filter((e) => clockH >= e.eventH)
      .sort((a, b) => a.eventH - b.eventH)
      .slice(-ROLLING_N);
    const n = resolved.length;
    if (n === 0) return { maeH: 0, mapePct: 0, n: 0 };
    let absErr = 0;
    let absPct = 0;
    for (const e of resolved) {
      const err = Math.abs(e.actualH - e.predictedH);
      absErr += err;
      // MAPE denominator: horizon the prediction was issued at (ISSUE_HORIZON_H)
      // — a stable, non-zero forecast-lead reference, avoiding divide-by-tiny.
      absPct += err / ISSUE_HORIZON_H;
    }
    return { maeH: absErr / n, mapePct: (absPct / n) * 100, n };
  }, [events, clockH]);

  // Convergence curve: sort samples by shrinking horizon (event nearest → far),
  // so both series read left-to-right as "closer to the event".
  const chart = useMemo<ChartData<'line'> | null>(() => {
    if (samples.length === 0) return null;
    const ordered = [...samples].sort((a, b) => a.horizonH - b.horizonH);
    const labels = ordered.map((s) => `${s.horizonH.toFixed(1)}h`);
    const midline = ordered.map((s) => s.predicted);
    return {
      labels,
      datasets: [
        // On-target band: predicted ± ON_TARGET_BAND_H, drawn as a faint fill
        // between an upper and lower bound (good = "within tolerance").
        {
          label: 'On-target band',
          data: midline.map((v) => v + ON_TARGET_BAND_H),
          borderColor: 'transparent',
          backgroundColor: `${tokens.good}1f`,
          pointRadius: 0,
          fill: '+1',
          tension: 0.25,
        },
        {
          label: '_band_lower',
          data: midline.map((v) => v - ON_TARGET_BAND_H),
          borderColor: 'transparent',
          backgroundColor: 'transparent',
          pointRadius: 0,
          fill: false,
          tension: 0.25,
        },
        {
          label: 'Predicted',
          data: ordered.map((s) => Number(s.predicted.toFixed(2))),
          borderColor: tokens.accent,
          backgroundColor: tokens.accent,
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.25,
        },
        {
          label: 'Realised',
          data: ordered.map((s) => Number(s.realised.toFixed(2))),
          borderColor: tokens.warn,
          backgroundColor: tokens.warn,
          borderWidth: 2,
          pointRadius: 2,
          tension: 0.25,
        },
      ],
    };
  }, [samples]);

  const options = useMemo<ChartOptions<'line'>>(() => {
    const o = baseOptions<'line'>();
    return {
      ...o,
      plugins: {
        ...o.plugins,
        legend: {
          ...o.plugins?.legend,
          // Hide the two internal band-boundary datasets from the legend.
          labels: {
            ...o.plugins?.legend?.labels,
            filter: (item) =>
              item.text !== '_band_lower' && item.text !== 'On-target band',
          },
        },
        tooltip: {
          ...o.plugins?.tooltip,
          callbacks: {
            title: (items) =>
              items.length > 0 ? `Horizon ${items[0].label}` : '',
            label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(2)} h`,
          },
          filter: (item) =>
            item.dataset.label !== '_band_lower' &&
            item.dataset.label !== 'On-target band',
        },
      },
      scales: {
        ...o.scales,
        x: {
          ...o.scales?.x,
          title: { display: true, text: 'Remaining horizon to event (h)', color: tokens.textMuted, font: { size: 10 } },
          reverse: true,
        },
        y: {
          ...o.scales?.y,
          title: { display: true, text: 'Event time estimate (sim-h)', color: tokens.textMuted, font: { size: 10 } },
        },
      },
    };
  }, []);

  if (predQ.loading && !predQ.data) {
    return <PanelLoading label="Loading prediction convergence…" />;
  }
  if (predQ.error) return <PanelError message={predQ.error} />;
  if (!chart) {
    return (
      <PanelEmpty message="No target events within the forecast horizon yet — advance the sim clock to reveal convergence." />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto', gap: tokens.space.sm }}>
      {/* Stat tiles: rolling MAE, MAPE, n resolved. */}
      <div style={{ display: 'flex', gap: tokens.space.sm }}>
        <StatTile label="Rolling MAE" value={stats.maeH.toFixed(2)} unit="h" accent={tokens.accent} />
        <StatTile label="MAPE" value={stats.mapePct.toFixed(1)} unit="%" accent={tokens.warn} />
        <StatTile label="Resolved" value={String(stats.n)} unit="n" accent={tokens.good} />
      </div>

      <div style={{ flex: 1, minHeight: 160 }}>
        <Line data={chart} options={options} />
      </div>

      <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: tokens.textMuted }}>
        <strong style={{ color: tokens.text }}>Holdout methodology</strong> — predicted at
        horizon vs realised as the sim clock reaches the event; rolling error over the last{' '}
        {ROLLING_N} resolved. Simulated convergence under stated assumptions (deterministic,
        seeded from predicted-vs-actual pairs) — not a claimed baseline or improvement.
      </p>
    </div>
  );
}

function StatTile({
  label,
  value,
  unit,
  accent,
}: {
  label: string;
  value: string;
  unit: string;
  accent: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        background: tokens.panelAlt,
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius.sm,
        padding: `${tokens.space.xs}px ${tokens.space.sm}px`,
      }}
    >
      <div style={{ fontSize: 10, color: tokens.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span style={{ fontSize: 18, fontWeight: 600, color: accent }}>{value}</span>
        <span style={{ fontSize: 11, color: tokens.textMuted }}>{unit}</span>
      </div>
    </div>
  );
}
