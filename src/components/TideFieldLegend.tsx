/**
 * <TideFieldLegend> — the INCOIS-OSF-style colorbar + variable selector for the
 * tide/sea-state raster field. A horizontal viridis gradient with min / mid / max
 * value ticks (read from the last-rendered field) and a dropdown to switch the
 * field between sea state / tide / wind. Floated on the map like the other map
 * controls; shown only when the field overlay is turned on.
 */

import { CalciteOption, CalciteSelect } from '@esri/calcite-components-react';
import { useTideFieldStore } from '@/map/tideFieldStore';
import { FIELD_META, viridis, type FieldVar } from '@/map/tideField';
import { tokens } from '@/theme/tokens';

/** CSS linear-gradient built from the viridis LUT (33 stops). */
function viridisGradient(): string {
  const stops: string[] = [];
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    const [r, g, b] = viridis(t);
    stops.push(`rgb(${r},${g},${b}) ${Math.round(t * 100)}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}

const GRADIENT = viridisGradient();

export function TideFieldLegend() {
  const variable = useTideFieldStore((s) => s.variable);
  const range = useTideFieldStore((s) => s.range);
  const setVariable = useTideFieldStore((s) => s.setVariable);
  const meta = FIELD_META[variable];

  const [lo, hi] = range ?? [0, 1];
  const mid = (lo + hi) / 2;
  const fmt = (n: number) => n.toFixed(variable === 'windKt' ? 0 : 1);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minWidth: 220,
        padding: 8,
        background: `${tokens.panel}F2`,
        border: `1px solid ${tokens.border}`,
        borderRadius: 8,
        boxShadow: '0 2px 8px rgba(0,0,0,.35)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: tokens.text }}>Tide &amp; Sea State</span>
        <CalciteSelect
          scale="s"
          label="Field variable"
          value={variable}
          onCalciteSelectChange={(e) =>
            setVariable((e.target as unknown as { value: FieldVar }).value)
          }
          style={{ minWidth: 130 }}
        >
          {(Object.keys(FIELD_META) as FieldVar[]).map((k) => (
            <CalciteOption key={k} value={k} selected={k === variable || undefined}>
              {FIELD_META[k].label}
            </CalciteOption>
          ))}
        </CalciteSelect>
      </div>

      {/* Viridis colorbar */}
      <div
        style={{
          height: 14,
          borderRadius: 3,
          background: GRADIENT,
          border: `1px solid ${tokens.border}`,
        }}
        aria-label={`${meta.label} colour scale`}
      />

      {/* Min / mid / max ticks */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 10.5,
          color: tokens.textMuted,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span>{fmt(lo)}</span>
        <span>{fmt(mid)}</span>
        <span>
          {fmt(hi)} {meta.unit}
        </span>
      </div>

      <div style={{ fontSize: 10, color: tokens.textMuted }}>
        Interpolated from station readings · interim Open-Meteo · INCOIS OSF pending
      </div>
    </div>
  );
}
