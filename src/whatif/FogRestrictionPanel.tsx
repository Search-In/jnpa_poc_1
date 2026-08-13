/**
 * UC-1 What-If — Fog / Night Navigation Restriction panel (visibility < 1 km).
 *
 * Sits in the What-If tab next to the vessel-omission scenario and follows the
 * same visual language: vessel/call selection, a Simulate button, the verdict,
 * an Original/Simulated/Impact table, and the collapsed working with input
 * provenance. Everything shown is a SIMULATED result under stated assumptions;
 * running it changes nothing (pure engine over adapter reads).
 *
 * The visibility shown is the adapter's current reading (which already reflects
 * any sim levers — SimAdapter overlays getWeather). Because the reading is in
 * clear conditions most of the time, the operator can set a HYPOTHETICAL
 * visibility for the run — declared as a parameter ("you set this"), never
 * silently. The restriction duration is likewise a parameter: no feed carries
 * a visibility forecast, so without it the impact is reported not calculable.
 */
import { useMemo, useState } from 'react';
import {
  CalciteButton,
  CalciteChip,
  CalciteNotice,
  CalciteOption,
  CalciteSelect,
} from '@esri/calcite-components-react';
import { getAdapter } from '@/data';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { PanelError, PanelLoading } from '@/components/common/Panel';
import type { BerthingPlanEntry, WeatherReading } from '@/types/domain';
import { durationFromHours, istDateTime, istStamp } from '@/util/format';
import { tokens } from '@/theme/tokens';
import { jnpaCallsFor } from './vesselOmission';
import {
  evaluateVisibility,
  simulateFogRestriction,
  VISIBILITY_THRESHOLD_KM,
  type FogRestrictionOutcome,
  type FogRestrictionResult,
} from './fogRestriction';

const H = 3_600_000;

/** The ticket's own example visibilities, offered as declared hypotheticals. */
const HYPOTHETICAL_KM = [0.3, 0.5, 0.8, 0.99, 1.0, 1.5, 2.0];
/** Selectable expected hold durations (hours). */
const HOLD_HOURS = [1, 2, 3, 4, 6, 8, 12];

function signedDuration(h: number): string {
  if (h === 0) return '0h';
  return `${h > 0 ? '+' : '−'}${durationFromHours(Math.abs(h))}`;
}

export function FogRestrictionPanel() {
  const [mountedAt] = useState(() => Date.now());
  const planQuery = useAdapterQuery<BerthingPlanEntry[]>(
    () => getAdapter().getBerthPlan({ from: mountedAt - 48 * H, to: mountedAt + 48 * H }),
    [mountedAt]
  );
  const weatherQuery = useAdapterQuery<WeatherReading>(() => getAdapter().getWeather(), [mountedAt]);

  const [mmsi, setMmsi] = useState<string>('');
  const [planId, setPlanId] = useState<string | null>(null);
  /** '' = use the measured reading; otherwise a declared hypothetical (km). */
  const [visChoice, setVisChoice] = useState<string>('');
  /** '' = duration not known → impact reported as not calculable. */
  const [holdChoice, setHoldChoice] = useState<string>('');
  const [outcome, setOutcome] = useState<FogRestrictionOutcome | null>(null);

  const plan = useMemo(() => planQuery.data ?? [], [planQuery.data]);
  const weather = weatherQuery.data ?? null;

  const vessels = useMemo(() => {
    const seen = new Map<string, { mmsi: string; name: string; calls: number }>();
    for (const p of plan) {
      const cur = seen.get(p.MMSI);
      if (cur) cur.calls += 1;
      else seen.set(p.MMSI, { mmsi: p.MMSI, name: p.VESSEL_NAME, calls: 1 });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [plan]);

  const calls = useMemo(() => (mmsi ? jnpaCallsFor(plan, mmsi) : []), [plan, mmsi]);
  const selectedCall =
    calls.length === 1 ? calls[0] : calls.find((c) => c.PLAN_ID === planId) ?? null;

  const overrideKm = visChoice === '' ? undefined : Number(visChoice);
  const preview = evaluateVisibility(weather, overrideKm);

  const run = () => {
    setOutcome(
      simulateFogRestriction(plan, weather, {
        mmsi,
        planId: selectedCall?.PLAN_ID,
        now: Date.now(),
        visibilityOverrideKm: overrideKm,
        holdDurationH: holdChoice === '' ? undefined : Number(holdChoice),
      })
    );
  };

  return (
    <section
      style={{
        background: tokens.panel,
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius.md,
        padding: tokens.space.md,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.space.md,
      }}
      aria-label="Fog / night navigation restriction what-if"
    >
      <div>
        <h3 style={{ margin: 0, fontSize: 12.5, fontWeight: 600, letterSpacing: 0.3 }}>
          Fog / night navigation restriction — visibility below 1 km
        </h3>
        <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 2 }}>
          Simulate the schedule impact when navigation is restricted by visibility below 1 km.
          Hypothetical only — the operational plan is not changed and nothing is notified. Night
          cannot be evaluated: this system holds no day/night data.
        </div>
      </div>

      {(planQuery.loading || weatherQuery.loading) && <PanelLoading label="Loading plan + weather…" />}
      {planQuery.error && <PanelError message={planQuery.error} />}
      {weatherQuery.error && <PanelError message={weatherQuery.error} />}

      {!planQuery.loading && !planQuery.error && !weatherQuery.loading && (
        <>
          {/* Current visibility + restriction preview */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.space.sm,
              flexWrap: 'wrap',
              background: tokens.panelAlt,
              border: `1px solid ${tokens.border}`,
              borderRadius: tokens.radius.sm,
              padding: tokens.space.sm,
              fontSize: 11.5,
            }}
          >
            <span>
              Visibility:{' '}
              <strong>
                {preview.visibilityKm !== null ? `${preview.visibilityKm.toFixed(2)} km` : 'not available'}
              </strong>
              {preview.visibilitySource === 'MEASURED' && preview.visibilityNm !== null
                ? ` (measured ${preview.visibilityNm.toFixed(1)} NM)`
                : preview.visibilitySource === 'PARAMETER'
                  ? ' (hypothetical — you set this)'
                  : ''}
            </span>
            <span>· Threshold: &lt; {VISIBILITY_THRESHOLD_KM} km</span>
            <CalciteChip
              scale="s"
              style={{
                marginLeft: 'auto',
                background: preview.active === true ? tokens.warn : undefined,
              }}
            >
              {preview.active === true
                ? 'Restriction ACTIVE'
                : preview.active === false
                  ? 'No restriction'
                  : 'Not evaluable'}
            </CalciteChip>
          </div>

          {/* Scenario inputs */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: tokens.space.sm,
            }}
          >
            <CalciteSelect
              label="Visibility input"
              scale="s"
              value={visChoice}
              onCalciteSelectChange={(e) => {
                setVisChoice((e.target as HTMLCalciteSelectElement).value);
                setOutcome(null);
              }}
            >
              <CalciteOption value="">
                {weather && preview.visibilitySource !== null
                  ? `Measured reading${visChoice === '' && preview.visibilityKm !== null ? ` (${preview.visibilityKm.toFixed(2)} km)` : ''}`
                  : 'Measured reading (unavailable)'}
              </CalciteOption>
              {HYPOTHETICAL_KM.map((km) => (
                <CalciteOption key={km} value={String(km)}>
                  {`Hypothetical ${km} km`}
                </CalciteOption>
              ))}
            </CalciteSelect>

            <CalciteSelect
              label="Expected restriction duration"
              scale="s"
              value={holdChoice}
              onCalciteSelectChange={(e) => {
                setHoldChoice((e.target as HTMLCalciteSelectElement).value);
                setOutcome(null);
              }}
            >
              <CalciteOption value="">Not known — report impact as not calculable</CalciteOption>
              {HOLD_HOURS.map((h) => (
                <CalciteOption key={h} value={String(h)}>{`${h} h (you set this)`}</CalciteOption>
              ))}
            </CalciteSelect>
          </div>

          {/* Vessel + call selection (same pattern as vessel omission) */}
          <CalciteSelect
            label="Vessel"
            scale="s"
            value={mmsi}
            onCalciteSelectChange={(e) => {
              setMmsi((e.target as HTMLCalciteSelectElement).value);
              setPlanId(null);
              setOutcome(null);
            }}
          >
            <CalciteOption value="">Select a vessel with a JNPA call…</CalciteOption>
            {vessels.map((v) => (
              <CalciteOption key={v.mmsi} value={v.mmsi}>
                {`${v.name} · MMSI ${v.mmsi}${v.calls > 1 ? ` · ${v.calls} calls` : ''}`}
              </CalciteOption>
            ))}
          </CalciteSelect>

          {mmsi && calls.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11.5 }}>
              <span style={{ color: tokens.warn }}>
                This vessel has {calls.length} JNPA calls in the window — select the one to simulate.
              </span>
              {calls.map((c) => {
                const on = selectedCall?.PLAN_ID === c.PLAN_ID;
                return (
                  <button
                    key={c.PLAN_ID}
                    type="button"
                    onClick={() => {
                      setPlanId(c.PLAN_ID);
                      setOutcome(null);
                    }}
                    style={{
                      cursor: 'pointer',
                      textAlign: 'left',
                      font: 'inherit',
                      fontWeight: 600,
                      color: on ? tokens.bg : tokens.text,
                      background: on ? tokens.accent : 'transparent',
                      border: `1px solid ${on ? tokens.accent : tokens.border}`,
                      borderRadius: tokens.radius.sm,
                      padding: '4px 8px',
                    }}
                  >
                    {`JNPA · berth ${c.BERTH_ID} · ${istDateTime(c.PLANNED_START)} → ${istDateTime(c.PLANNED_END)} · ${c.STATUS}${on ? ' · selected' : ''}`}
                  </button>
                );
              })}
            </div>
          )}

          {mmsi && calls.length === 0 && (
            <CalciteNotice open scale="s" kind="warning" icon="exclamation-mark-triangle">
              <div slot="message">
                Selected vessel does not have a JNPA port call in the berthing plan window.
              </div>
            </CalciteNotice>
          )}

          <div>
            <CalciteButton
              scale="s"
              iconStart="play"
              disabled={!mmsi || (calls.length > 1 && !selectedCall) || undefined}
              onClick={run}
            >
              Simulate
            </CalciteButton>
          </div>

          {outcome?.kind === 'error' && (
            <CalciteNotice open scale="s" kind="danger" icon="exclamation-mark-triangle">
              <div slot="title">Cannot simulate</div>
              <div slot="message">
                {outcome.error.message}
                {outcome.error.candidates && outcome.error.candidates.length > 0 && (
                  <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    {outcome.error.candidates.map((c) => (
                      <CalciteChip key={c.planId} scale="s">{c.planId}</CalciteChip>
                    ))}
                  </span>
                )}
              </div>
            </CalciteNotice>
          )}

          {outcome?.kind === 'result' && <FogAnswer result={outcome.result} />}
        </>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────── the answer */

function FogAnswer({ result }: { result: FogRestrictionResult }) {
  const r = result;
  const active = r.restriction.active;
  const delay = r.simulated.delayH;
  const tone = !r.data_available ? 'unavailable' : active && delay !== null && delay > 0 ? 'warning' : 'ok';

  const vis =
    r.restriction.visibilityKm !== null ? `${r.restriction.visibilityKm.toFixed(2)} km` : 'unavailable';

  const headline =
    active === null
      ? 'The restriction rule cannot be evaluated — no visibility value is available.'
      : active === false
        ? `Visibility is ${vis} — at or above the 1 km threshold, so no fog restriction applies and ${r.vessel.name}'s schedule is unchanged.`
        : delay === null
          ? `Visibility is ${vis} — below 1 km, navigation is RESTRICTED. The schedule impact is not calculable: no restriction duration is available (set the expected duration and re-run).`
          : delay === 0
            ? `Visibility is ${vis} — below 1 km, navigation is RESTRICTED, but this call is not affected (impact 0h).`
            : `Visibility is ${vis} — below 1 km, navigation is RESTRICTED. ${r.vessel.name}'s call is delayed by ${durationFromHours(delay)}.`;

  const fmtTs = (v: number | null) => (v === null ? 'not calculable' : istDateTime(v));

  const rows: Array<{ metric: string; original: string; simulated: string; impact: string }> = [
    {
      metric: 'Visibility',
      original: vis,
      simulated: vis,
      impact: active === true ? `below ${r.restriction.thresholdKm} km` : active === false ? 'above threshold' : '—',
    },
    {
      metric: 'Navigation',
      original: 'Normal',
      simulated: r.simulated.navigation === 'RESTRICTED' ? 'Restricted' : 'Normal',
      impact: r.simulated.navigation === 'RESTRICTED' ? 'Restricted' : '—',
    },
    {
      metric: 'ETA (berthing)',
      original: fmtTs(r.original.eta),
      simulated: fmtTs(r.simulated.eta),
      impact:
        delay !== null && r.original.eta !== null && r.simulated.eta !== null
          ? signedDuration((r.simulated.eta - r.original.eta) / H)
          : 'not calculable',
    },
    {
      metric: 'ETD (departure)',
      original: fmtTs(r.original.etd),
      simulated: fmtTs(r.simulated.etd),
      impact:
        delay !== null && r.original.etd !== null && r.simulated.etd !== null
          ? signedDuration((r.simulated.etd - r.original.etd) / H)
          : 'not calculable',
    },
    {
      metric: 'Schedule deviation',
      original:
        r.original.scheduleDeviationH !== null ? signedDuration(r.original.scheduleDeviationH) : 'no actuals yet',
      simulated:
        r.simulated.scheduleDeviationH !== null ? signedDuration(r.simulated.scheduleDeviationH) : 'not calculable',
      impact: delay !== null ? signedDuration(delay) : 'not calculable',
    },
    {
      metric: 'Downstream (next call at berth)',
      original: '—',
      simulated:
        r.downstream.nextCallKnockOnH !== null
          ? r.downstream.nextCallKnockOnH === 0
            ? 'no knock-on'
            : `up to ${durationFromHours(r.downstream.nextCallKnockOnH)} knock-on`
          : r.downstream.laterCallsAtBerth.length === 0
            ? 'no later call at this berth'
            : 'not calculable',
      impact:
        r.downstream.nextCallKnockOnH !== null && r.downstream.nextCallKnockOnH > 0
          ? signedDuration(r.downstream.nextCallKnockOnH)
          : '—',
    },
  ];

  return (
    <div className="audited-answer" data-scenario={r.scenario} data-tone={tone}>
      <div className="audited-verdict" data-tone={tone}>
        <p className="audited-detail">
          {`UC-1 — Fog / night navigation restriction · ${r.vessel.name} · call ${r.call.planId}`}
        </p>
        <p className="audited-headline" role="status">{headline}</p>
        <p className="audited-detail">
          Hypothetical only — the operational plan is not changed. Night condition: not evaluable
          (no day/night data in this system).
        </p>
      </div>

      <table className="audited-table">
        <thead>
          <tr>
            <th scope="col">Metric</th>
            <th scope="col">Original</th>
            <th scope="col">Simulated</th>
            <th scope="col">Impact</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.metric}>
              <th scope="row">{row.metric}</th>
              <td>{row.original}</td>
              <td>{row.simulated}</td>
              <td>{row.impact}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <details className="audited-evidence">
        <summary className="audited-summary">
          Show the working — method, {r.assumptions.length} assumption{r.assumptions.length === 1 ? '' : 's'},{' '}
          {r.unavailable.length} unavailable input{r.unavailable.length === 1 ? '' : 's'}, {r.queries.length} data reads
        </summary>

        <div className="audited-section">
          <h4>How this was worked out</h4>
          <p style={{ margin: 0 }}>{r.method}</p>
        </div>

        <div className="audited-section">
          <h4>Inputs and their provenance</h4>
          <table className="audited-table">
            <thead>
              <tr><th scope="col">Input</th><th scope="col">Value</th><th scope="col">Why</th></tr>
            </thead>
            <tbody>
              {r.assumptions.map((a, i) => (
                <tr key={`${a.field}-${i}`}>
                  <td>
                    {a.field.replace(/_/g, ' ')}
                    {a.source !== 'MEASURED' && (
                      <span className="audited-chip" data-source={a.source}> {a.source.toLowerCase()}</span>
                    )}
                  </td>
                  <td>{String(a.value)}</td>
                  <td>{a.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="audited-section">
          <h4>Not calculable from the data</h4>
          <table className="audited-table">
            <tbody>
              {r.unavailable.map((u, i) => (
                <tr key={`${u.field}-${i}`}>
                  <th scope="row">{u.field.replace(/_/g, ' ')}</th>
                  <td>{u.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="audited-section">
          <h4>Where the data came from</h4>
          {r.queries.map((q, i) => (
            <details key={`${q.purpose}-${i}`}>
              <summary>{q.purpose}{q.row_count !== undefined ? ` — ${q.row_count} rows` : ''}</summary>
              {q.api ? <p style={{ margin: '4px 0 0' }}><code>{q.api}</code></p> : null}
              <pre>{q.sql}</pre>
            </details>
          ))}
        </div>

        {r.notes.length > 0 && (
          <div className="audited-section">
            <h4>Notes</h4>
            <ul style={{ margin: 0, paddingLeft: 16 }}>
              {r.notes.map((note, i) => (
                <li key={i} style={{ fontSize: 11.5, lineHeight: 1.45 }}>{note}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="audited-section">
          <h4>Audit</h4>
          <p style={{ margin: 0, fontSize: 11 }}>
            {`Executed ${istStamp(r.executedAt)} · vessel ${r.vessel.name} (MMSI ${r.vessel.mmsi}) · call ${r.call.planId} at berth ${r.call.berthId} (${r.call.status}) · visibility ${vis} (${r.restriction.visibilitySource ?? 'unavailable'}) vs < ${r.restriction.thresholdKm} km · simulation only, operational plan unchanged.`}
          </p>
        </div>
      </details>
    </div>
  );
}

export default FogRestrictionPanel;
