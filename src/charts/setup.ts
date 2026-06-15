/**
 * Central Chart.js registration + shared light-theme defaults.
 * Import this once (side-effect) before rendering any chart. Colours come from
 * the token file — no literals here (quality-bar rule).
 */

import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  TimeScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
  type ChartType,
} from 'chart.js';
import { tokens } from '@/theme/tokens';

let registered = false;

/** Register the chart pieces we use. Idempotent. */
export function ensureChartsRegistered(): void {
  if (registered) return;
  ChartJS.register(
    CategoryScale,
    LinearScale,
    TimeScale,
    PointElement,
    LineElement,
    BarElement,
    ArcElement,
    Tooltip,
    Legend,
    Filler
  );
  ChartJS.defaults.color = tokens.textMuted;
  ChartJS.defaults.font.family = "'Avenir Next', 'Segoe UI', sans-serif";
  ChartJS.defaults.borderColor = tokens.border;
  registered = true;
}

/**
 * Base options shared by the report charts (light theme, responsive). Generic
 * over the chart kind so callers get `ChartOptions<'bar'>` / `<'line'>` and can
 * extend `scales` without type clashes.
 */
export function baseOptions<T extends ChartType = ChartType>(): ChartOptions<T> {
  // Built once and cast: every chart in this app is cartesian (bar/line), so the
  // x/y scale block is always valid for the kinds we render.
  const opts: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: { labels: { boxWidth: 12, font: { size: 11 } } },
      tooltip: {
        backgroundColor: tokens.panel,
        titleColor: tokens.text,
        bodyColor: tokens.text,
        borderColor: tokens.border,
        borderWidth: 1,
      },
    },
    scales: {
      x: { grid: { color: tokens.border }, ticks: { font: { size: 10 } } },
      y: { grid: { color: tokens.border }, ticks: { font: { size: 10 } } },
    },
  };
  return opts as ChartOptions<T>;
}
