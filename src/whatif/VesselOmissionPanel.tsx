/**
 * UC-1 What-If — Vessel Omission panel: "line skips JNPA for schedule recovery".
 *
 * Lives inside the What-If tab (ScenariosPanel) next to the scripted scenarios
 * and the audited answers, because that is where an operator goes to ask a
 * what-if question. The flow mirrors the brief:
 *
 *   select vessel → see its JNPA call sequence → pick the call (when there is
 *   more than one — the engine refuses to guess) → Simulate → read the
 *   original-vs-simulated comparison, the recovered time, and the working.
 *
 * Everything shown is a SIMULATED result under stated assumptions (integrity
 * rule, spec §A3). Running it changes nothing: the engine is a pure function
 * over the adapter's berthing-plan read — no store write, no network call, no
 * event published. The result panel reuses the audited-answer CSS classes so a
 * local answer reads exactly like a gateway one.
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
import type { BerthingPlanEntry } from '@/types/domain';
import { durationFromHours, istDateTime, istStamp } from '@/util/format';
import { tokens } from '@/theme/tokens';
import {
  jnpaCallsFor,
  simulateVesselOmission,
  type OmissionCallRef,
  type VesselOmissionOutcome,
  type VesselOmissionResult,
} from './vesselOmission';

const H = 3_600_000;

/** Signed hours for reading: +2.5 → "+2h 30m", −4 → "−4h", 0 → "0h". */
function signedDuration(h: number): string {
  if (h === 0) return '0h';
  return `${h > 0 ? '+' : '−'}${durationFromHours(Math.abs(h))}`;
}

/** A nullable figure, shown honestly: null → "not calculable". */
function fig(v: string | null): string {
  return v ?? 'not calculable';
}

export function VesselOmissionPanel() {
  // Window fixed at mount: ±48 h around now, so scheduled future calls are in
  // scope as well as recently completed ones.
  const [mountedAt] = useState(() => Date.now());
  const planQuery = useAdapterQuery<BerthingPlanEntry[]>(
    () => getAdapter().getBerthPlan({ from: mountedAt - 48 * H, to: mountedAt + 48 * H }),
    [mountedAt]
  );

  const [mmsi, setMmsi] = useState<string>('');
  const [planId, setPlanId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<VesselOmissionOutcome | null>(null);

  const plan = useMemo(() => planQuery.data ?? [], [planQuery.data]);

  /** Vessels present in the plan window, deduped by MMSI. */
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

  const selectVessel = (next: string) => {
    setMmsi(next);
    setPlanId(null);
    setOutcome(null);
  };

  const run = () => {
    setOutcome(
      simulateVesselOmission(plan, {
        mmsi,
        planId: selectedCall?.PLAN_ID,
        now: Date.now(),
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
      aria-label="Vessel omission what-if"
    >
      <div>
        <h3 style={{ margin: 0, fontSize: 12.5, fontWeight: 600, letterSpacing: 0.3 }}>
          Vessel omission — line skips JNPA
        </h3>
        <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 2 }}>
          Simulate a shipping line omitting its JNPA call to recover schedule. Hypothetical only —
          the operational plan is not changed and nothing is notified.
        </div>
      </div>

      {planQuery.loading && <PanelLoading label="Loading berthing plan…" />}
      {planQuery.error && <PanelError message={planQuery.error} />}

      {!planQuery.loading && !planQuery.error && (
        <>
          {/* Step 1 — vessel */}
          <CalciteSelect
            label="Vessel"
            scale="s"
            value={mmsi}
            onCalciteSelectChange={(e) => selectVessel((e.target as HTMLCalciteSelectElement).value)}
          >
            <CalciteOption value="">Select a vessel with a JNPA call…</CalciteOption>
            {vessels.map((v) => (
              <CalciteOption key={v.mmsi} value={v.mmsi}>
                {`${v.name} · MMSI ${v.mmsi}${v.calls > 1 ? ` · ${v.calls} calls` : ''}`}
              </CalciteOption>
            ))}
          </CalciteSelect>

          {/* Step 2 — the call sequence. Previous/next port are stated as not in
              the data rather than invented — the plan covers JNPA only. */}
          {mmsi && calls.length > 0 && (
            <div
              style={{
                background: tokens.panelAlt,
                border: `1px solid ${tokens.border}`,
                borderRadius: tokens.radius.sm,
                padding: tokens.space.sm,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                fontSize: 11.5,
              }}
            >
              <span style={{ color: tokens.textMuted }}>Previous port — not in the JNPA feed</span>
              <span style={{ color: tokens.textMuted }}>↓</span>
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
                      cursor: calls.length > 1 ? 'pointer' : 'default',
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
                    {`JNPA · berth ${c.BERTH_ID} · ${istDateTime(c.PLANNED_START)} → ${istDateTime(c.PLANNED_END)} · ${c.STATUS}${on ? ' · selected to omit' : ''}`}
                  </button>
                );
              })}
              <span style={{ color: tokens.textMuted }}>↓</span>
              <span style={{ color: tokens.textMuted }}>Next port — not in the JNPA feed</span>
              {calls.length > 1 && !selectedCall && (
                <span style={{ color: tokens.warn, fontSize: 11 }}>
                  This vessel has {calls.length} JNPA calls in the window — select the one to omit.
                </span>
              )}
            </div>
          )}

          {mmsi && calls.length === 0 && (
            <CalciteNotice open scale="s" kind="warning" icon="exclamation-mark-triangle">
              <div slot="message">
                Selected vessel does not have a JNPA port call in the berthing plan window.
              </div>
            </CalciteNotice>
          )}

          {/* Step 3 — run */}
          <div>
            <CalciteButton
              scale="s"
              iconStart="play"
              disabled={!mmsi || (calls.length > 1 && !selectedCall) || undefined}
              onClick={run}
            >
              Omit JNPA call — simulate
            </CalciteButton>
          </div>

          {/* Step 4 — the answer */}
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

          {outcome?.kind === 'result' && <OmissionAnswer result={outcome.result} />}
        </>
      )}
    </section>
  );
}

/* ────────────────────────────────────────────────────────────── the answer */

function OmissionAnswer({ result }: { result: VesselOmissionResult }) {
  const r = result;
  const recovered = r.recoveredH;
  const tone = !r.data_available ? 'unavailable' : recovered === 0 ? 'warning' : 'ok';

  // The one-sentence verdict, local to this scenario (the shared verdict file
  // is canonical in the UC-3 repo and covers only the nine catalogue scenarios).
  const headline = !r.data_available
    ? 'Recovered time cannot be calculated — a required schedule input is missing from the plan entry.'
    : recovered === 0
      ? `Skipping JNPA recovers no schedule time for ${r.vessel.name} — the available data shows no recoverable window.`
      : `Skipping JNPA recovers ${durationFromHours(recovered ?? 0)} of schedule for ${r.vessel.name}.`;

  const detail =
    r.data_available && r.simulated.scheduleDeviationH !== null && r.original.scheduleDeviationH !== null
      ? `The call was running ${signedDuration(r.original.scheduleDeviationH)} against plan; omitting JNPA moves it to ${signedDuration(r.simulated.scheduleDeviationH)} against the downstream schedule.`
      : r.data_available
        ? 'The downstream schedule advances by the recovered time; the port-rotation beyond JNPA is not in this system, so absolute downstream ETAs are not restated.'
        : undefined;

  const fmtTs = (v: number | null) => (v === null ? null : istDateTime(v));
  const fmtH = (v: number | null) => (v === null ? null : durationFromHours(Math.abs(v)));

  const rows: Array<{ metric: string; original: string; simulated: string; impact: string }> = [
    {
      metric: 'JNPA call',
      original: 'Included',
      simulated: 'Omitted',
      impact: 'Skipped',
    },
    {
      metric: 'JNPA call duration',
      original: fig(fmtH(r.original.callDurationH)),
      simulated: '0h',
      impact: r.original.callDurationH !== null ? `−${durationFromHours(r.original.callDurationH)}` : 'not calculable',
    },
    {
      metric: 'Departure past JNPA',
      original: fig(fmtTs(r.original.departure)),
      simulated: fig(fmtTs(r.simulated.passBy)),
      impact: recovered !== null ? `${durationFromHours(recovered)} earlier` : 'not calculable',
    },
    {
      metric: 'Schedule deviation',
      original: r.original.scheduleDeviationH !== null ? signedDuration(r.original.scheduleDeviationH) : 'no actuals yet',
      simulated: r.simulated.scheduleDeviationH !== null ? signedDuration(r.simulated.scheduleDeviationH) : 'not calculable',
      impact:
        r.original.scheduleDeviationH !== null && r.simulated.scheduleDeviationH !== null
          ? signedDuration(r.simulated.scheduleDeviationH - r.original.scheduleDeviationH)
          : 'not calculable',
    },
    {
      metric: 'Next-port ETA',
      original: 'not in the data',
      simulated: 'not in the data',
      impact: recovered !== null ? `advances by ${durationFromHours(recovered)}` : 'not calculable',
    },
    {
      metric: 'Recovered time',
      original: '—',
      simulated: '—',
      impact: recovered !== null ? durationFromHours(recovered) : 'not calculable',
    },
  ];

  return (
    <div className="audited-answer" data-scenario={r.scenario} data-tone={tone}>
      {/* 1 — verdict */}
      <div className="audited-verdict" data-tone={tone}>
        <p className="audited-detail">{`UC-1 — Vessel omission · ${r.vessel.name} · call ${r.omittedCall.planId}`}</p>
        <p className="audited-headline" role="status">{headline}</p>
        {detail ? <p className="audited-detail">{detail}</p> : null}
      </div>

      {/* 2 — the comparison */}
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

      {/* 3 — downstream at JNPA (the effect the data supports) */}
      <div className="audited-section">
        <h4>Downstream impact</h4>
        <p className="audited-detail" style={{ margin: 0 }}>
          {r.downstream.berthFreedFrom !== null && r.downstream.berthFreedTo !== null
            ? `Berth ${r.downstream.berthId} is freed from ${istDateTime(r.downstream.berthFreedFrom)} to ${istDateTime(r.downstream.berthFreedTo)}. `
            : `The freed window at berth ${r.downstream.berthId} cannot be established from this entry. `}
          {r.downstream.laterCallsAtBerth.length === 0
            ? 'No later call is planned at this berth inside the horizon.'
            : `${r.downstream.laterCallsAtBerth.length} later call${r.downstream.laterCallsAtBerth.length === 1 ? '' : 's'} at this berth inside the horizon${
                r.downstream.nextCallPotentialAdvanceH !== null
                  ? `; the next (${r.downstream.laterCallsAtBerth[0]?.planId}) could berth up to ${durationFromHours(r.downstream.nextCallPotentialAdvanceH)} earlier.`
                  : '.'
              }`}
          {' '}Beyond JNPA, the vessel's downstream schedule advances by the recovered time — absolute
          downstream ETAs are not restated because the port rotation is not in this system.
        </p>
      </div>

      {/* 4 — the working, collapsed */}
      <details className="audited-evidence">
        <summary className="audited-summary">
          Show the working — method, {r.assumptions.length} assumption{r.assumptions.length === 1 ? '' : 's'},{' '}
          {r.unavailable.length} unavailable input{r.unavailable.length === 1 ? '' : 's'}, {r.queries.length} data read
          {r.queries.length === 1 ? '' : 's'}
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
                    {(a.source === 'DERIVED' || a.source === 'PARAMETER' || a.source === 'ASSUMED') && (
                      <span className="audited-chip" data-source={a.source}> {a.source.toLowerCase()}</span>
                    )}
                  </td>
                  <td>
                    {typeof a.value === 'number' && a.value > 10_000_000_000
                      ? istDateTime(a.value)
                      : String(a.value)}
                  </td>
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

        {/* Audit line — what was simulated, on what, when. */}
        <div className="audited-section">
          <h4>Audit</h4>
          <p style={{ margin: 0, fontSize: 11 }}>
            {`Executed ${istStamp(r.executedAt)} · vessel ${r.vessel.name} (MMSI ${r.vessel.mmsi}) · omitted call ${r.omittedCall.planId} at berth ${r.omittedCall.berthId} (${r.omittedCall.status}) · original window ${istDateTime(r.omittedCall.plannedStart)} → ${istDateTime(r.omittedCall.plannedEnd)} · simulation only, operational plan unchanged.`}
          </p>
        </div>
      </details>
    </div>
  );
}

export default VesselOmissionPanel;

/** Exported for tests: the candidate list a disambiguation error carries. */
export type { OmissionCallRef };
