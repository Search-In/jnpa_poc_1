/**
 * <WindFieldLegend> — colourbar for the Zoom Earth–style wind particle overlay.
 * Shown when the Weather Layer / wind particles are on.
 */

import { useWindFieldStore } from '@/map/windFieldStore';
import { windSpeedColor } from '@/map/windParticles';
import { tokens } from '@/theme/tokens';

function speedGradient(): string {
  const stops: string[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const [r, g, b] = windSpeedColor(t);
    stops.push(`rgb(${r},${g},${b}) ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

const GRADIENT = speedGradient();

export function WindFieldLegend() {
  const speedMax = useWindFieldStore((s) => s.speedMax);
  const hi = speedMax && speedMax > 0 ? speedMax : 25;
  const mid = hi / 2;
  const fmt = (n: number) => Math.round(n).toString();

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 200,
        padding: 8,
        background: `${tokens.panel}F2`,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0,0,0,.35)',
      }}
    >
      <span style={{ fontSize: 11, fontWeight: 600, color: tokens.text }}>Wind speed</span>
      <div
        style={{
          height: 14,
          borderRadius: 3,
          background: GRADIENT,
          border: `1px solid ${tokens.border}`,
        }}
        aria-label="Wind speed colour scale"
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 10.5,
          color: tokens.textMuted,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span>{fmt(0)}</span>
        <span>{fmt(mid)}</span>
        <span>
          {fmt(hi)} kn
        </span>
      </div>
      <div style={{ fontSize: 10, color: tokens.textMuted }}>
        Particles · Open-Meteo 10 m wind · JNPA approaches
      </div>
    </div>
  );
}
