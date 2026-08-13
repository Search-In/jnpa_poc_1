/**
 * Scenarios panel (spec §B2.11) — one-click scripted runs M1–M5 plus a
 * free-parameter mode that drives the individual sim levers directly.
 *
 * Every effect shown here is framed as a SIMULATED result under stated
 * assumptions — never a claimed baseline improvement (integrity rule, §A3).
 * The scenario cards load a lever set + guided tour and start the clock; the
 * free-parameter block lets an operator perturb the twin by hand and read back
 * the resulting synthesised weather and pilotage state.
 */
import {
  CalciteButton,
  CalciteChip,
  CalciteLabel,
  CalciteNotice,
  CalciteSlider,
} from '@esri/calcite-components-react';
import { useSimStore, NEUTRAL_LEVERS, hasOverrides, type SimLevers } from '@/sim/simStore';
import { SCENARIOS } from '@/sim/scenarios';
import { weatherAt, pilotageSuspended, incidentSuspendsMovements } from '@/sim/derive';
import { SourceBadge } from '@/provenance/SourceBadge';
import { PanelLoading, PanelError } from '@/components/common/Panel';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import type { Berth } from '@/types/domain';
import { tokens } from '@/theme/tokens';
import { AuditedAnswer } from '../whatif/AuditedAnswer';
import { VesselOmissionPanel } from '../whatif/VesselOmissionPanel';

/** A free-parameter lever control, either a scaled slider or a stepped counter. */
interface LeverSpec {
  key: keyof Pick<
    SimLevers,
    | 'weatherSeverity'
    | 'tideOffsetM'
    | 'channelDepthDeltaM'
    | 'pilotsDown'
    | 'tugsDown'
    | 'extraArrivals'
    | 'rainMmHr'
    | 'oilSpill'
    | 'accident'
    | 'berthWindowExtendH'
    | 'dredgeRestoreM'
  >;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Integer scale factor so Calcite's slider stays on whole ticks. */
  scale: number;
  unit?: string;
  hint: string;
}

const LEVERS: LeverSpec[] = [
  { key: 'weatherSeverity', label: 'Weather severity', min: 0, max: 1, step: 0.05, scale: 100, hint: 'wind / sea-state driver' },
  { key: 'tideOffsetM', label: 'Tide offset', min: -2, max: 2, step: 0.1, scale: 10, unit: 'm', hint: 'surge / siltation on tide prediction' },
  { key: 'channelDepthDeltaM', label: 'Channel depth delta', min: -1, max: 1, step: 0.1, scale: 10, unit: 'm', hint: 'siltation on controlling depth' },
  { key: 'pilotsDown', label: 'Pilots unavailable', min: 0, max: 4, step: 1, scale: 1, hint: 'roster shortfall → JIT slip' },
  { key: 'tugsDown', label: 'Tugs unavailable', min: 0, max: 4, step: 1, scale: 1, hint: 'unberthing slip' },
  { key: 'extraArrivals', label: 'Extra arrivals', min: 0, max: 8, step: 1, scale: 1, hint: 'vessel bunching into the window' },
  // --- UC-1 additive levers (default 0 / OFF — identical baseline when untouched) ---
  { key: 'rainMmHr', label: 'Rain intensity', min: 0, max: 80, step: 5, scale: 1, unit: 'mm/h', hint: 'rain squall → visibility → pilotage' },
  { key: 'oilSpill', label: 'Oil spill severity', min: 0, max: 1, step: 0.1, scale: 10, hint: 'fairway closure + movement hold' },
  { key: 'accident', label: 'Marine accident', min: 0, max: 1, step: 0.1, scale: 10, hint: 'grounding/collision → movements held' },
  { key: 'berthWindowExtendH', label: 'Extended berth window', min: 0, max: 12, step: 1, scale: 1, unit: 'h', hint: 'service overrun → TAT' },
  { key: 'dredgeRestoreM', label: 'Dredging restore', min: 0, max: 1, step: 0.1, scale: 10, unit: 'm', hint: 'restores controlling depth (offsets siltation)' },
];

function fmtLever(spec: LeverSpec, value: number): string {
  const shown = spec.key === 'weatherSeverity' ? `${Math.round(value * 100)}%` : value.toFixed(spec.step < 1 ? 1 : 0);
  return spec.unit ? `${shown} ${spec.unit}` : shown;
}

export function Scenarios(_props: { onResult?: (r: unknown) => void }) {
  const scenarioId = useSimStore((s) => s.scenarioId);
  const levers = useSimStore((s) => s.levers);
  const clockH = useSimStore((s) => s.clockH);
  const loadScenario = useSimStore((s) => s.loadScenario);
  const startTour = useSimStore((s) => s.startTour);
  const setRunning = useSimStore((s) => s.setRunning);
  const clearScenario = useSimStore((s) => s.clearScenario);
  const endTour = useSimStore((s) => s.endTour);
  const setLevers = useSimStore((s) => s.setLevers);
  const resetLevers = useSimStore((s) => s.resetLevers);

  const berthsQuery = useAdapterQuery<Berth[]>(() => getAdapter().getBerths(), []);

  const weather = weatherAt(clockH, levers);
  // A marine incident (oil spill / accident) also suspends pilot boarding and
  // vessel movements while it is active — resumes automatically once cleared
  // (levers reset). Default levers → incident false → identical to before.
  const incident = incidentSuspendsMovements(levers);
  const suspended = pilotageSuspended(weather) || incident;
  const dirty = hasOverrides(levers);

  const runScenario = (id: string, lv: Partial<SimLevers>) => {
    loadScenario(id, { ...NEUTRAL_LEVERS, ...lv });
    startTour(id, true);
    setRunning(true);
  };

  const stopScenario = () => {
    clearScenario();
    endTour();
  };

  const toggleBerthOut = (berthId: string) => {
    const out = new Set(levers.berthsOut);
    if (out.has(berthId)) out.delete(berthId);
    else out.add(berthId);
    setLevers({ berthsOut: [...out] });
  };

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        padding: tokens.space.md,
        color: tokens.text,
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.space.lg,
      }}
    >
      <SourceBadge source="BERTH_PLAN" />

      {/* ── Scripted scenarios M1–M5 ─────────────────────────────────── */}
      <section>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: tokens.space.sm,
            marginBottom: tokens.space.sm,
          }}
        >
          <h3 style={{ margin: 0, fontSize: 12.5, fontWeight: 600, letterSpacing: 0.3 }}>
            Scripted scenarios
          </h3>
          <CalciteButton
            scale="s"
            kind="neutral"
            appearance="outline"
            iconStart="reset"
            disabled={scenarioId === null || undefined}
            onClick={stopScenario}
          >
            Stop / free run
          </CalciteButton>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: tokens.space.md,
          }}
        >
          {SCENARIOS.map((sc) => {
            const active = scenarioId === sc.id;
            return (
              <div
                key={sc.id}
                style={{
                  background: tokens.panelAlt,
                  border: `1px solid ${active ? tokens.accent : tokens.border}`,
                  borderRadius: tokens.radius.md,
                  padding: tokens.space.md,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: tokens.space.sm,
                  boxShadow: active ? `0 0 0 1px ${tokens.accent}` : 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: tokens.bg,
                      background: active ? tokens.accent : tokens.accentDim,
                      borderRadius: tokens.radius.sm,
                      padding: '1px 6px',
                      letterSpacing: 0.5,
                    }}
                  >
                    {sc.code}
                  </span>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: tokens.text }}>{sc.title}</span>
                </div>

                <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.45, color: tokens.textMuted }}>
                  {sc.summary}
                </p>

                <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.space.sm, flexWrap: 'wrap', rowGap: tokens.space.xs }}>
                  <CalciteChip scale="s" title={sc.rubric} style={{ minWidth: 0, maxWidth: '100%' }}>
                    {sc.rubric}
                  </CalciteChip>
                  <CalciteButton
                    scale="s"
                    iconStart={active ? 'check' : 'play'}
                    appearance={active ? 'solid' : 'outline'}
                    onClick={() => runScenario(sc.id, sc.levers)}
                    style={{ flexShrink: 0, marginLeft: 'auto' }}
                  >
                    {active ? 'Running' : 'Run'}
                  </CalciteButton>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ── UC-1 · Vessel omission (line skips JNPA) ─────────────────── */}
      <VesselOmissionPanel />

      {/* ── Free-parameter mode ──────────────────────────────────────── */}
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
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.space.sm }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 12.5, fontWeight: 600, letterSpacing: 0.3 }}>Free-parameter mode</h3>
            <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 2 }}>
              Perturb the twin by hand — effects are simulated under stated assumptions.
            </div>
          </div>
          <CalciteButton
            scale="s"
            kind="neutral"
            appearance="outline"
            iconStart="reset"
            disabled={!dirty || undefined}
            onClick={() => resetLevers()}
          >
            Reset levers
          </CalciteButton>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: `${tokens.space.sm}px ${tokens.space.lg}px`,
          }}
        >
          {LEVERS.map((spec) => {
            const value = levers[spec.key];
            return (
              <CalciteLabel key={spec.key} scale="s" style={{ marginBottom: 0 }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', gap: tokens.space.sm }}>
                  <span>{spec.label}</span>
                  <span style={{ color: tokens.accent, fontWeight: 600 }}>{fmtLever(spec, value)}</span>
                </span>
                <CalciteSlider
                  value={Math.round(value * spec.scale)}
                  min={spec.min * spec.scale}
                  max={spec.max * spec.scale}
                  step={spec.step * spec.scale}
                  ticks={spec.scale === 1 ? 1 : undefined}
                  labelHandles={false}
                  onCalciteSliderChange={(e) =>
                    setLevers({ [spec.key]: Number(e.target.value) / spec.scale } as Partial<SimLevers>)
                  }
                />
                <span style={{ fontSize: 10.5, color: tokens.textMuted }}>{spec.hint}</span>
              </CalciteLabel>
            );
          })}
        </div>

        {/* Berths out of service — multi-toggle chips from the live berth list. */}
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: tokens.space.xs }}>
            Berths out of service
          </div>
          {berthsQuery.loading && <PanelLoading label="Loading berths…" />}
          {berthsQuery.error && <PanelError message={berthsQuery.error} />}
          {!berthsQuery.loading && !berthsQuery.error && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.xs }}>
              {(berthsQuery.data ?? []).map((b) => {
                const on = levers.berthsOut.includes(b.BERTH_ID);
                return (
                  <button
                    key={b.BERTH_ID}
                    type="button"
                    onClick={() => toggleBerthOut(b.BERTH_ID)}
                    title={`${b.BERTH_NAME} · ${b.TERMINAL}`}
                    style={{
                      cursor: 'pointer',
                      fontSize: 11,
                      fontWeight: 600,
                      color: on ? tokens.bg : tokens.textMuted,
                      background: on ? tokens.warn : tokens.panelAlt,
                      border: `1px solid ${on ? tokens.warn : tokens.border}`,
                      borderRadius: tokens.radius.sm,
                      padding: '3px 8px',
                    }}
                  >
                    {b.BERTH_ID}
                  </button>
                );
              })}
              {(berthsQuery.data ?? []).length === 0 && (
                <span style={{ fontSize: 11, color: tokens.textMuted }}>No berths available.</span>
              )}
            </div>
          )}
        </div>

        {/* Live readout — resulting weather + pilotage state under the levers. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: tokens.space.sm,
            background: tokens.panelAlt,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radius.sm,
            padding: tokens.space.sm,
          }}
        >
          <Readout label="Wind" value={`${weather.windKt.toFixed(0)} kt`} />
          <Readout label="Sea state" value={`${weather.seaStateM.toFixed(1)} m`} />
          <Readout label="Visibility" value={`${weather.visibilityNm.toFixed(1)} NM`} />
          <Readout label="Tide" value={`${weather.tideM.toFixed(2)} m`} />
          {weather.rainMmHr !== undefined && weather.rainMmHr > 0 && (
            <Readout label="Rain" value={`${weather.rainMmHr.toFixed(1)} mm/h`} />
          )}
        </div>

        <CalciteNotice open scale="s" kind={suspended ? 'warning' : 'success'} icon={suspended ? 'exclamation-mark-triangle' : 'check-circle'}>
          <div slot="title">
            {incident ? 'Movements suspended — marine incident' : suspended ? 'Pilotage suspended' : 'Pilotage available'}
          </div>
          <div slot="message">
            {incident
              ? 'Simulated: an oil spill / marine accident is active under these levers — pilot boarding and vessel movements are held until the incident clears.'
              : suspended
                ? 'Simulated: synthesised wind / sea-state / visibility exceed the pilot-transfer limit under these levers — inbound vessels would hold at the anchorage.'
                : 'Simulated: synthesised conditions are within the pilot-transfer limit under these levers.'}
          </div>
        </CalciteNotice>

        {/* The audited figures for the two scenarios the JNPA Notice dates.
            Fetched on request so the walkthrough stays offline. */}
        <AuditedAnswer scenarioId={scenarioId} />
      </section>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 10.5, color: tokens.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: tokens.text }}>{value}</span>
    </div>
  );
}
