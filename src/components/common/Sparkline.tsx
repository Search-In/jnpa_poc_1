/** Tiny inline-SVG sparkline — no chart lib per card. */

import type { TrendPoint } from '@/types/kpi';
import { tokens } from '@/theme/tokens';

export function Sparkline({
  points,
  color = tokens.accent,
  width = 120,
  height = 28,
}: {
  points: TrendPoint[];
  color?: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) {
    return <svg width={width} height={height} role="img" aria-label="trend (insufficient data)" />;
  }
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const path = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / span) * (height - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <svg width={width} height={height} role="img" aria-label="trend" style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
