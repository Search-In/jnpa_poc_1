/**
 * <TatPredictionCard> — forward turnaround forecast from the submitted Gen-2
 * UC1-M3 service (`POST /ml-api/uc1/m3/predict`, LightGBM artifact).
 *
 * UC1-068 decision (a): dashboard numbers come from the Python pack on :8100,
 * not the older in-browser additive `tatPredict.ts`. Demo pin matches the
 * evaluator curl: 4,000 TEU / draft 15.0 m → same P50 on screen and in terminal.
 */
import { useEffect, useState } from 'react';
import { CalciteButton } from '@esri/calcite-components-react';
import { env } from '@/data/config';
import { DEMO_TAT_INPUT, predictM3Tat, type M3PredictResult } from '@/data/ml/m3Tat';
import { friendlyError } from '@/data/friendlyError';
import { tokens } from '@/theme/tokens';

export function TatPredictionCard() {
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pred, setPred] = useState<M3PredictResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!show || !env.ml.enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    predictM3Tat(DEMO_TAT_INPUT)
      .then((r) => {
        if (!cancelled) setPred(r);
      })
      .catch((err) => {
        if (!cancelled) {
          setPred(null);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [show]);

  const top = (pred?.contributions ?? []).slice(0, 5);
  const friendly = error ? friendlyError(error) : null;
  const shaShort = pred?.artifact_sha256
    ? `${pred.artifact_sha256.slice(0, 8)}…`
    : null;

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>
          Turnaround forecast (LightGBM)
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              color: tokens.accent,
              border: `1px solid ${tokens.accent}`,
              borderRadius: 3,
              padding: '0 4px',
              marginLeft: 6,
              verticalAlign: 'middle',
            }}
          >
            GEN-2
          </span>
        </h4>
        <CalciteButton
          scale="s"
          appearance="outline"
          iconStart={show ? 'chevron-up' : 'lightbulb'}
          disabled={!env.ml.enabled}
          onClick={() => setShow((v) => !v)}
        >
          {show ? 'Hide' : 'Predict TAT'}
        </CalciteButton>
      </div>
      {!env.ml.enabled && (
        <div style={{ fontSize: 11, color: tokens.textMuted }}>
          AI/ML is off (`VITE_ML_ENABLED=false`). Enable it and start{' '}
          <code>cd ml && JNPA_PORT=8100 python run.py serve</code>.
        </div>
      )}
      {show && env.ml.enabled && (
        <div
          style={{
            fontSize: 12,
            background: tokens.panelAlt,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radius.sm,
            padding: 10,
            lineHeight: 1.6,
          }}
        >
          <div style={{ color: tokens.textMuted, marginBottom: 6 }}>
            Gen-2 M3 · {DEMO_TAT_INPUT.parcel_teu.toLocaleString()} TEU · draft{' '}
            {DEMO_TAT_INPUT.draft_m.toFixed(1)} m · engine=lightgbm — same contract as{' '}
            <code>POST /uc1/m3/predict</code> (service on :8100; gateway keeps :8000).
          </div>
          {loading && <div style={{ color: tokens.textMuted }}>Scoring…</div>}
          {friendly && (
            <div style={{ color: tokens.bad }}>
              <div style={{ fontWeight: 600 }}>{friendly.title}</div>
              <div style={{ fontSize: 11 }}>{friendly.action}</div>
            </div>
          )}
          {pred && !loading && (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <Band label="P10 · optimistic" value={pred.p10_hours} />
                <Band label="P50 · median" value={pred.p50_hours} accent />
                <Band label="P90 · conservative" value={pred.p90_hours} />
              </div>
              <div style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 4 }}>
                {pred.engine}
                {pred.model_version ? ` · ${pred.model_version}` : ''}
                {pred.holdout_mae_hours != null
                  ? ` · holdout MAE ${pred.holdout_mae_hours.toFixed(2)} h`
                  : ''}
                {shaShort ? ` · SHA-256 ${shaShort}` : ''}
                {Number.isFinite(pred.sigma_hours) && pred.sigma_hours > 0
                  ? ` · ± ${pred.sigma_hours.toFixed(1)} h (1σ)`
                  : ''}
              </div>
              {top.length > 0 && (
                <>
                  <div style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 4 }}>
                    Top drivers:
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {top.map((c) => (
                      <div key={c.factor} style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ color: tokens.text }}>{c.factor}</span>
                        <span
                          style={{ color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}
                        >
                          +{c.hours.toFixed(1)} h
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Band({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '6px 4px',
        background: tokens.panel,
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius.sm,
      }}
    >
      <div
        style={{
          fontSize: 10,
          color: tokens.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 700,
          color: accent ? tokens.accent : tokens.text,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {Number.isFinite(value) ? value.toFixed(1) : '—'}
        <span style={{ fontSize: 10, color: tokens.textMuted }}> h</span>
      </div>
    </div>
  );
}
