/**
 * IntegrationConsole — the Integration Simulator Console (spec §B1.2, rubric
 * criterion 3). A right-side slide-over the operator opens to inject integration
 * faults during a demo: per source, flip its fallback rung LIVE → DEGRADED →
 * CACHED → IMPUTED → OFFLINE, dial injected latency, and watch the reconciliation
 * audit log capture every transition (recovery entries flagged). This is the
 * panel that makes "what visibly happens when AIS dies mid-demo" concrete: the
 * degrade→cache→impute→offline ladder is explicit, and recovery reconciliation
 * back to LIVE is visible and logged.
 *
 * Everything here is operator-driven fault injection over the SIM store — no
 * network, no real vessel identities, no baseline claims.
 */
import {
  CalciteButton,
  CalciteIcon,
  CalciteSegmentedControl,
  CalciteSegmentedControlItem,
  CalciteSlider,
} from '@esri/calcite-components-react';
import {
  RUNGS,
  SOURCES,
  SOURCE_BY_ID,
  rungLabel,
  isFlowing,
  type SourceId,
  type SourceState,
} from '@/provenance/sources';
import { useDataModeStore } from '@/provenance/useDataModeStore';
import { tokens } from '@/theme/tokens';

/** Rung → dot colour, mirrored from the shared provenance vocabulary. */
const RUNG_COLOR: Record<SourceState, string> = {
  LIVE: tokens.mode.LIVE,
  DEGRADED: tokens.mode.DEGRADED,
  CACHED: tokens.degradation.AMBER,
  IMPUTED: tokens.mode.SIM,
  OFFLINE: tokens.mode.OFFLINE,
};

/** The short staleness note shown once a source stops flowing. */
function stalenessNote(state: SourceState): string | null {
  switch (state) {
    case 'CACHED':
      return 'last-known-good';
    case 'IMPUTED':
      return 'model-imputed, widening band';
    case 'OFFLINE':
      return 'manual-entry fallback';
    default:
      return null;
  }
}

function RungDot({ state, live }: { state: SourceState; live?: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 10,
        height: 10,
        borderRadius: '50%',
        flex: '0 0 auto',
        background: RUNG_COLOR[state],
        boxShadow: live ? `0 0 0 3px ${tokens.mode.LIVE}22` : 'none',
      }}
    />
  );
}

function SourceRow({ id }: { id: SourceId }) {
  const meta = SOURCE_BY_ID[id];
  const runtime = useDataModeStore((s) => s.sources[id]);
  const setSourceState = useDataModeStore((s) => s.setSourceState);
  const setLatency = useDataModeStore((s) => s.setLatency);

  const state = runtime?.state ?? 'LIVE';
  const latencyMs = runtime?.latencyMs ?? 0;
  const flowing = isFlowing(state);
  const note = stalenessNote(state);

  return (
    <div
      style={{
        background: tokens.panelAlt,
        border: `1px solid ${tokens.border}`,
        borderLeft: `3px solid ${RUNG_COLOR[state]}`,
        borderRadius: tokens.radius.md,
        padding: tokens.space.md,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.space.sm,
      }}
    >
      {/* Header: label + current rung dot */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
        <RungDot state={state} live={state === 'LIVE'} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: tokens.text }}>{meta.label}</div>
          <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 2 }}>
            {meta.prodSource}
          </div>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: RUNG_COLOR[state],
            letterSpacing: 0.4,
            whiteSpace: 'nowrap',
          }}
        >
          {state}
        </span>
      </div>

      {/* Meta line: cadence + role */}
      <div style={{ fontSize: 11, color: tokens.textMuted, lineHeight: 1.4 }}>
        <span style={{ color: tokens.text }}>{meta.cadence}</span> · {meta.role}
      </div>

      {/* Fallback-rung selector */}
      <CalciteSegmentedControl
        scale="s"
        width="full"
        onCalciteSegmentedControlChange={(e) =>
          setSourceState(id, e.target.value as SourceState)
        }
      >
        {RUNGS.map((rung) => (
          <CalciteSegmentedControlItem key={rung} value={rung} checked={rung === state}>
            {rung}
          </CalciteSegmentedControlItem>
        ))}
      </CalciteSegmentedControl>

      {/* Injected latency slider */}
      <label
        style={{
          fontSize: 11,
          color: tokens.textMuted,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <span>
          Injected latency:{' '}
          <span style={{ color: latencyMs > 0 ? tokens.warn : tokens.text }}>{latencyMs} ms</span>
        </span>
        <CalciteSlider
          scale="s"
          min={0}
          max={2000}
          step={50}
          value={latencyMs}
          onCalciteSliderInput={(e) => setLatency(id, Number(e.target.value))}
        />
      </label>

      {/* Staleness note once the feed stops flowing */}
      {!flowing && note && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 11,
            color: RUNG_COLOR[state],
            background: tokens.bg,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radius.sm,
            padding: '4px 8px',
          }}
        >
          <CalciteIcon icon="exclamation-mark-triangle" scale="s" />
          <span>
            <strong>{note}</strong>
            <span style={{ color: tokens.textMuted }}> · {rungLabel(state)}</span>
          </span>
        </div>
      )}
    </div>
  );
}

function AuditLog() {
  const audit = useDataModeStore((s) => s.audit);

  if (audit.length === 0) {
    return (
      <div
        style={{
          fontSize: 11.5,
          color: tokens.textMuted,
          padding: tokens.space.md,
          textAlign: 'center',
          border: `1px dashed ${tokens.border}`,
          borderRadius: tokens.radius.sm,
        }}
      >
        No transitions yet — change a source rung above to inject a fault.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {audit.map((e) => (
        <div
          key={e.id}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: tokens.space.sm,
            fontSize: 11.5,
            padding: '6px 8px',
            background: tokens.panelAlt,
            borderBottom: `1px solid ${tokens.border}`,
          }}
        >
          <span style={{ flex: '0 0 auto', marginTop: 1 }}>
            {e.recovery ? (
              <CalciteIcon icon="check-circle" scale="s" style={{ color: tokens.good }} />
            ) : (
              <RungDot state={e.to} />
            )}
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: tokens.text }}>
              <strong>{SOURCE_BY_ID[e.source].label}</strong>{' '}
              <span style={{ color: RUNG_COLOR[e.from] }}>{e.from}</span>
              <span style={{ color: tokens.textMuted }}> → </span>
              <span style={{ color: RUNG_COLOR[e.to] }}>{e.to}</span>
            </div>
            <div style={{ color: tokens.textMuted, marginTop: 1, lineHeight: 1.35 }}>{e.note}</div>
          </div>
          <span
            style={{
              flex: '0 0 auto',
              fontSize: 10.5,
              color: tokens.textMuted,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            {new Date(e.ts).toLocaleTimeString()}
          </span>
        </div>
      ))}
    </div>
  );
}

export function IntegrationConsole() {
  const open = useDataModeStore((s) => s.consoleOpen);
  const setConsoleOpen = useDataModeStore((s) => s.setConsoleOpen);
  const reconcileAll = useDataModeStore((s) => s.reconcileAll);
  const resetAll = useDataModeStore((s) => s.resetAll);

  if (!open) return null;

  return (
    <>
      {/* Translucent backdrop — click to close */}
      <div
        onClick={() => setConsoleOpen(false)}
        style={{
          position: 'fixed',
          inset: 0,
          background: tokens.scrim,
          zIndex: 999,
        }}
      />

      {/* Slide-over drawer */}
      <aside
        aria-label="Integration Simulator Console"
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          height: '100vh',
          width: 'min(460px, 95vw)',
          background: tokens.panel,
          borderLeft: `1px solid ${tokens.border}`,
          boxShadow: `-8px 0 32px ${tokens.shadow}`,
          zIndex: 1000,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 1,
            background: tokens.bgElevated,
            borderBottom: `1px solid ${tokens.border}`,
            padding: `${tokens.space.md}px ${tokens.space.lg}px`,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.space.sm,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: tokens.space.sm }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: tokens.text }}>
                Integration Simulator Console
              </h2>
              <p style={{ margin: '4px 0 0', fontSize: 11.5, color: tokens.textMuted, lineHeight: 1.4 }}>
                Per-source LIVE / DEGRADED / OFFLINE with visible fallback + recovery reconciliation
              </p>
            </div>
            <CalciteButton
              scale="s"
              kind="neutral"
              appearance="transparent"
              iconStart="x"
              label="Close console"
              title="Close"
              onClick={() => setConsoleOpen(false)}
            />
          </div>
          <div style={{ display: 'flex', gap: tokens.space.sm }}>
            <CalciteButton
              scale="s"
              kind="brand"
              iconStart="refresh"
              onClick={() => reconcileAll()}
            >
              Reconcile all
            </CalciteButton>
            <CalciteButton
              scale="s"
              kind="neutral"
              appearance="outline-fill"
              iconStart="reset"
              onClick={() => resetAll()}
            >
              Reset
            </CalciteButton>
          </div>
        </header>

        {/* Body */}
        <div
          style={{
            padding: tokens.space.lg,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.space.md,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
            {SOURCES.map((s) => (
              <SourceRow key={s.id} id={s.id} />
            ))}
          </div>

          {/* Reconciliation audit log */}
          <section style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
            <h3
              style={{
                margin: `${tokens.space.sm}px 0 0`,
                fontSize: 12,
                fontWeight: 600,
                color: tokens.text,
                letterSpacing: 0.3,
              }}
            >
              Reconciliation audit log
            </h3>
            <p style={{ margin: 0, fontSize: 11, color: tokens.textMuted, lineHeight: 1.4 }}>
              Every rung transition, newest first. Recovery back to a flowing feed is reconciled
              against last-known-good.
            </p>
            <AuditLog />
          </section>
        </div>
      </aside>
    </>
  );
}
