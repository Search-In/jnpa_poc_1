/**
 * <TatPredictionCard> — OPTIONAL forward turnaround forecast that surfaces the
 * existing `predictTat` feature model (planning/tatPredict.ts) in the UI. Purely
 * additive: it changes no existing KPI and is hidden until the operator clicks
 * "Predict TAT". It reads the current what-if levers and shows a P10/P50/P90
 * band + the top drivers for a representative deep-draft container call.
 *
 * Framed as a SIMULATED forecast under stated assumptions (an explainable
 * feature model, not a trained/claimed baseline).
 */
import { useMemo, useState } from 'react';
import { CalciteButton } from '@esri/calcite-components-react';
import { useSimStore } from '@/sim/simStore';
import { predictTat, tatFeaturesFromLevers } from './tatPredict';
import { tokens } from '@/theme/tokens';

// Representative call: a JNPA container parcel (~2,355 TEU, assumptions register)
// at a deep-draft terminal (GTI/BMCT class, 16.5 m max design draft).
const REF_CALL = { parcelTeu: 2355, terminalMaxDraftM: 16.5 };

export function TatPredictionCard() {
  const levers = useSimStore((s) => s.levers);
  const [show, setShow] = useState(false);

  const pred = useMemo(() => predictTat(tatFeaturesFromLevers(levers, REF_CALL)), [levers]);
  const top = useMemo(
    () => pred.contributions.filter((c) => c.hours > 0).sort((a, b) => b.hours - a.hours).slice(0, 5),
    [pred],
  );

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Turnaround forecast (feature model)</h4>
        <CalciteButton
          scale="s"
          appearance="outline"
          iconStart={show ? 'chevron-up' : 'lightbulb'}
          onClick={() => setShow((v) => !v)}
        >
          {show ? 'Hide' : 'Predict TAT'}
        </CalciteButton>
      </div>
      {show && (
        <div style={{ fontSize: 12, background: tokens.panelAlt, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm, padding: 10, lineHeight: 1.6 }}>
          <div style={{ color: tokens.textMuted, marginBottom: 6 }}>
            Simulated forecast for a representative deep-draft container call (~{REF_CALL.parcelTeu} TEU) under the current what-if levers — separate from the historical Average TAT KPI.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
            <Band label="P10 · optimistic" value={pred.hoursP10} />
            <Band label="P50 · median" value={pred.hoursP50} accent />
            <Band label="P90 · conservative" value={pred.hoursP90} />
          </div>
          <div style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 4 }}>
            ± {pred.sigmaH.toFixed(1)} h (1σ). Top drivers:
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {top.map((c) => (
              <div key={c.factor} style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: tokens.text }}>{c.factor}</span>
                <span style={{ color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>+{c.hours.toFixed(1)} h</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Band({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div style={{ textAlign: 'center', padding: '6px 4px', background: tokens.panel, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
      <div style={{ fontSize: 10, color: tokens.textMuted, textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: accent ? tokens.accent : tokens.text, fontVariantNumeric: 'tabular-nums' }}>
        {value.toFixed(1)}
        <span style={{ fontSize: 10, color: tokens.textMuted }}> h</span>
      </div>
    </div>
  );
}
