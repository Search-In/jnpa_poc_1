/**
 * <WorkflowRuns> — the Automated-Workflow ledger UI (spec §B2.12).
 *
 * Header: an AUTO/ADVISORY governance switch bound to the workflow store, plus
 * four "trigger" buttons that fire representative marine workflows so a demo can
 * show the engine reacting to port events. The ledger below lists every fired
 * run (newest first); in ADVISORY mode a proposed run exposes Acknowledge / Apply
 * sign-off actions, while in AUTO mode runs land pre-applied.
 *
 * Every proposal is framed as a *simulated proposal* under stated assumptions —
 * nothing here dispatches a real action.
 */
import { useWorkflowStore, type WorkflowTrigger, type WorkflowRun } from './workflowStore';
import {
  CalciteButton,
  CalciteChip,
  CalciteIcon,
  CalciteNotice,
  CalciteSegmentedControl,
  CalciteSegmentedControlItem,
} from '@esri/calcite-components-react';
import { tokens } from '@/theme/tokens';
import { PanelEmpty } from '@/components/common/Panel';

/** Static presentation metadata per trigger class. */
interface TriggerDef {
  trigger: WorkflowTrigger;
  label: string;
  icon: string;
  /** Severity colour bar — INFO / WARN / CRIT from tokens. */
  severity: keyof typeof tokens.severity;
  fire: {
    title: string;
    detail: string;
    proposal: string;
  };
}

const TRIGGERS: readonly TriggerDef[] = [
  {
    trigger: 'ukc-breach',
    label: 'UKC window breach → replan + notify',
    icon: 'exclamation-mark-triangle',
    severity: 'CRIT',
    fire: {
      title: 'UKC window breach — deep-draught transit',
      detail:
        'Simulated: controlling depth fell inside the marginal band for the next planned deep-draught arrival; the vessel’s go-window closes before it reaches the fairway at present speed.',
      proposal:
        'Simulated proposal: shift the transit to the next viable tidal window (+1 cycle) and notify pilot + VTS; hold berthing slot.',
    },
  },
  {
    trigger: 'eta-slip',
    label: 'ETA slip > threshold → berth re-optimisation proposal',
    icon: 'clock',
    severity: 'WARN',
    fire: {
      title: 'ETA slip beyond tolerance',
      detail:
        'Simulated: an inbound arrival’s ETA slipped past the JIT tolerance, leaving its assigned berth idle and a downstream vessel waiting at anchorage.',
      proposal:
        'Simulated proposal: re-optimise berth allocation to swap the idle slot to the ready downstream vessel and rebase the slipped arrival to a later window.',
    },
  },
  {
    trigger: 'weather-alert',
    label: 'Weather alert → pilotage-hold workflow',
    icon: 'lightning',
    severity: 'CRIT',
    fire: {
      title: 'Weather alert — pilotage limits exceeded',
      detail:
        'Simulated: forecast wind/sea-state crossed the pilotage operating limit for the coming window; boarding at the pilot station is no longer within limits.',
      proposal:
        'Simulated proposal: raise a pilotage hold for the affected window, defer boardings, and flag exposed berths for a mooring review.',
    },
  },
  {
    trigger: 'berth-release',
    label: 'Berth-release delay → cascade re-sequencing',
    icon: 'sort-descending',
    severity: 'WARN',
    fire: {
      title: 'Berth-release delay — cascade risk',
      detail:
        'Simulated: an occupying vessel’s departure slipped, delaying berth release; the next arrival and everything queued behind it are exposed to a knock-on cascade.',
      proposal:
        'Simulated proposal: re-sequence the affected berth’s queue to absorb the slip and rebalance tug/pilot tasking across the cascade.',
    },
  },
] as const;

const TRIGGER_BY_ID: Record<WorkflowTrigger, TriggerDef> = TRIGGERS.reduce(
  (acc, d) => {
    acc[d.trigger] = d;
    return acc;
  },
  {} as Record<WorkflowTrigger, TriggerDef>,
);

const STATUS_LABEL: Record<WorkflowRun['status'], string> = {
  proposed: 'Proposed',
  acknowledged: 'Acknowledged',
  applied: 'Applied',
};

function statusColor(status: WorkflowRun['status']): string {
  switch (status) {
    case 'applied':
      return tokens.good;
    case 'acknowledged':
      return tokens.accent;
    case 'proposed':
    default:
      return tokens.warn;
  }
}

export function WorkflowRuns() {
  const mode = useWorkflowStore((s) => s.mode);
  const runs = useWorkflowStore((s) => s.runs);
  const setMode = useWorkflowStore((s) => s.setMode);
  const fire = useWorkflowStore((s) => s.fire);
  const ack = useWorkflowStore((s) => s.ack);
  const apply = useWorkflowStore((s) => s.apply);
  const clear = useWorkflowStore((s) => s.clear);

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.space.md,
        color: tokens.text,
        fontSize: 12,
      }}
    >
      {/* ── Governance header ──────────────────────────────────────────── */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: tokens.space.md,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.xs }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
            <CalciteIcon icon="gears" scale="s" />
            <span style={{ fontSize: 13, fontWeight: 600 }}>Automated Workflows</span>
          </div>
          <span style={{ color: tokens.textMuted, fontSize: 11 }}>
            AUTO applies proposals automatically; ADVISORY waits for sign-off.
          </span>
        </div>

        <CalciteSegmentedControl
          scale="s"
          value={mode}
          onCalciteSegmentedControlChange={(e) => {
            const v = (e.target as HTMLCalciteSegmentedControlElement).value;
            if (v === 'AUTO' || v === 'ADVISORY') setMode(v);
          }}
        >
          <CalciteSegmentedControlItem value="ADVISORY" checked={mode === 'ADVISORY'}>
            ADVISORY
          </CalciteSegmentedControlItem>
          <CalciteSegmentedControlItem value="AUTO" checked={mode === 'AUTO'}>
            AUTO
          </CalciteSegmentedControlItem>
        </CalciteSegmentedControl>
      </div>

      {/* Governance-mode banner so the consequence of AUTO is unmistakable. */}
      <CalciteNotice open scale="s" kind={mode === 'AUTO' ? 'warning' : 'info'} icon={mode === 'AUTO' ? 'lightning' : 'user-check'}>
        <div slot="message">
          {mode === 'AUTO'
            ? 'AUTO: fired workflows are applied automatically (no human sign-off in this simulated demo path).'
            : 'ADVISORY: fired workflows are held as proposals until a human acknowledges or applies them.'}
        </div>
      </CalciteNotice>

      {/* ── Trigger buttons ────────────────────────────────────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: tokens.space.sm,
        }}
      >
        {TRIGGERS.map((d) => (
          <button
            key={d.trigger}
            type="button"
            onClick={() => fire({ trigger: d.trigger, ...d.fire })}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.space.sm,
              textAlign: 'left',
              padding: `${tokens.space.sm}px ${tokens.space.md}px`,
              background: tokens.panelAlt,
              border: `1px solid ${tokens.border}`,
              borderLeft: `3px solid ${tokens.severity[d.severity]}`,
              borderRadius: tokens.radius.sm,
              color: tokens.text,
              fontSize: 11.5,
              lineHeight: 1.3,
              cursor: 'pointer',
            }}
          >
            <CalciteIcon icon={d.icon} scale="s" style={{ color: tokens.severity[d.severity], flexShrink: 0 }} />
            <span>{d.label}</span>
          </button>
        ))}
      </div>

      {/* ── Ledger ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.space.sm }}>
        <span style={{ color: tokens.textMuted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Workflow ledger · {runs.length} run{runs.length === 1 ? '' : 's'}
        </span>
        {runs.length > 0 && (
          <CalciteButton scale="s" appearance="transparent" kind="neutral" iconStart="trash" onClick={() => clear()}>
            Clear
          </CalciteButton>
        )}
      </div>

      {runs.length === 0 ? (
        <PanelEmpty message="No workflows fired yet — trigger one above to see the engine react." />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
          {runs.map((run) => {
            const def = TRIGGER_BY_ID[run.trigger];
            const bar = def ? tokens.severity[def.severity] : tokens.severity.INFO;
            return (
              <li
                key={run.id}
                style={{
                  display: 'flex',
                  background: tokens.panelAlt,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: tokens.radius.sm,
                  overflow: 'hidden',
                }}
              >
                {/* Severity colour bar per trigger. */}
                <div style={{ width: 3, background: bar, flexShrink: 0 }} aria-hidden />

                <div style={{ flex: 1, minWidth: 0, padding: tokens.space.md, display: 'flex', flexDirection: 'column', gap: tokens.space.xs }}>
                  {/* Row 1: time · trigger tag · governance · status */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.space.sm }}>
                    <span style={{ color: tokens.textMuted, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                      {new Date(run.ts).toLocaleTimeString()}
                    </span>
                    <CalciteChip scale="s" style={{ color: bar }}>
                      {def ? def.label.split(' → ')[0] : run.trigger}
                    </CalciteChip>
                    <span style={{ flex: 1 }} />
                    <span style={{ color: tokens.textMuted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.3 }}>
                      {run.governance}
                    </span>
                    <CalciteChip scale="s" style={{ color: statusColor(run.status) }}>
                      {STATUS_LABEL[run.status]}
                    </CalciteChip>
                  </div>

                  {/* Row 2: title */}
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{run.title}</div>

                  {/* Row 3: detail */}
                  <div style={{ color: tokens.textMuted, fontSize: 11.5, lineHeight: 1.4 }}>{run.detail}</div>

                  {/* Row 4: proposal */}
                  <div
                    style={{
                      marginTop: tokens.space.xs,
                      padding: `${tokens.space.sm}px ${tokens.space.md}px`,
                      background: tokens.panel,
                      border: `1px solid ${tokens.border}`,
                      borderRadius: tokens.radius.sm,
                      fontSize: 11.5,
                      lineHeight: 1.4,
                    }}
                  >
                    <span style={{ color: tokens.accent, fontWeight: 600 }}>Proposal · </span>
                    <span>{run.proposal}</span>
                  </div>

                  {/* Row 5: ADVISORY sign-off actions on a still-proposed run. */}
                  {run.status === 'proposed' && (
                    <div style={{ display: 'flex', gap: tokens.space.sm, marginTop: tokens.space.xs }}>
                      <CalciteButton scale="s" appearance="outline" kind="neutral" iconStart="check" onClick={() => ack(run.id)}>
                        Acknowledge
                      </CalciteButton>
                      <CalciteButton scale="s" appearance="solid" kind="brand" iconStart="play" onClick={() => apply(run.id)}>
                        Apply
                      </CalciteButton>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
