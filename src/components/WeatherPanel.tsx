/**
 * <WeatherPanel> — wind / sea-state / visibility / tide readout + a What-If
 * stub that recomputes JIT and TAT under a hypothetical delay / berth shift /
 * weather impact. Backed by getWeather() and runWhatIf() on the adapter.
 */

import { useState } from 'react';
import {
  CalciteButton,
  CalciteInputNumber,
  CalciteLabel,
  CalciteSlider,
} from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import type { WhatIfResult } from '@/data';
import { useAppStore } from '@/store/useAppStore';
import { useSimStore } from '@/sim/simStore';
import { tokens } from '@/theme/tokens';
import { PanelError, PanelLoading } from './common/Panel';

function Metric({ label, value, unit }: { label: string; value: string | number; unit: string }) {
  return (
    <div className="app-region" style={{ padding: 8, background: tokens.panelAlt }}>
      <div style={{ fontSize: 10, color: tokens.textMuted }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: tokens.text }}>
        {value}
        <span style={{ fontSize: 11, color: tokens.textMuted, marginLeft: 2 }}>{unit}</span>
      </div>
    </div>
  );
}

export function WeatherPanel() {
  const simVersion = useSimStore((s) => s.version);
  const { data, loading, error } = useAdapterQuery(() => getAdapter().getWeather(), [simVersion], 60_000);
  const vessels = useAppStore((s) => s.vessels);

  const [delayHours, setDelayHours] = useState(2);
  const [severity, setSeverity] = useState(0.3);
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [running, setRunning] = useState(false);

  const runWhatIf = async () => {
    setRunning(true);
    try {
      const r = await getAdapter().runWhatIf({
        delayVesselMmsi: vessels[0]?.MMSI,
        delayHours,
        weatherSeverity: severity,
      });
      setResult(r);
    } finally {
      setRunning(false);
    }
  };

  if (loading && !data) return <PanelLoading label="Loading weather…" />;
  if (error) return <PanelError message={error} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: 8 }}>
        {data && (
          <>
            <Metric label="Wind" value={data.windKt} unit="kn" />
            <Metric label="Wind dir" value={Math.round(data.windDir)} unit="°" />
            <Metric label="Sea state" value={data.seaStateM} unit="m" />
            <Metric label="Visibility" value={data.visibilityNm} unit="nm" />
            <Metric label="Tide" value={data.tideM} unit="m" />
          </>
        )}
      </div>

      <div className="app-region" style={{ padding: 12, background: tokens.panel }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: tokens.text, marginBottom: 8 }}>
          What-If — recompute JIT &amp; TAT
        </div>

        <CalciteLabel scale="s">
          Delay first vessel by (hours)
          <CalciteInputNumber
            value={String(delayHours)}
            min={0}
            max={24}
            step={0.5}
            onCalciteInputNumberChange={(e) => setDelayHours(Number(e.target.value) || 0)}
          />
        </CalciteLabel>

        <CalciteLabel scale="s">
          Weather severity ({Math.round(severity * 100)}%)
          <CalciteSlider
            value={Math.round(severity * 100)}
            min={0}
            max={100}
            onCalciteSliderChange={(e) => setSeverity(Number(e.target.value) / 100)}
          />
        </CalciteLabel>

        <CalciteButton scale="s" loading={running || undefined} onClick={() => void runWhatIf()} width="full">
          Run scenario
        </CalciteButton>

        {result && (
          <div style={{ marginTop: 10, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ color: tokens.textMuted }}>{result.note}</div>
            <div style={{ color: tokens.text }}>
              JIT: {result.jitPctBefore}% →{' '}
              <strong style={{ color: result.jitPctAfter < result.jitPctBefore ? tokens.bad : tokens.good }}>
                {result.jitPctAfter}%
              </strong>
            </div>
            <div style={{ color: tokens.text }}>
              Avg TAT: {result.avgTatBefore}h →{' '}
              <strong style={{ color: result.avgTatAfter > result.avgTatBefore ? tokens.bad : tokens.good }}>
                {result.avgTatAfter}h
              </strong>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
