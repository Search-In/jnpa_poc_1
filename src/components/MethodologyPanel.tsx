/**
 * <MethodologyPanel> — Methodology & Assumptions (spec §B1.5 / A2 crit 1 +
 * open-source honesty §A3). A read-only reference screen that states, plainly and
 * without improvement claims, what the twin is: a SIMULATED JNPA marine picture
 * calibrated to public FY24-25-class figures, a DUKC computed from first
 * principles, and scenarios compared against a simulated do-nothing shadow run —
 * never against a claimed JNPA baseline. Also lists the assumptions register,
 * the open-source components and their licences, and the seven data sources with
 * their intended production feeds and cadences.
 *
 * Integrity: every figure here is a calibration TARGET / public reference figure,
 * not a baseline and not an improvement claim.
 */

import { CalciteChip, CalciteIcon } from '@esri/calcite-components-react';
import { ASSUMPTIONS, OSS } from '@/config/assumptions';
import { SUITE_ASSUMPTIONS } from '@/config/suiteAssumptions';
import { SOURCES } from '@/provenance/sources';
import { tokens } from '@/theme/tokens';

/** Section shell — a titled block with a rule under the heading. */
function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        background: tokens.panel,
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius.md,
        padding: tokens.space.lg,
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 15,
          fontWeight: 700,
          color: tokens.text,
          letterSpacing: 0.3,
        }}
      >
        {title}
      </h3>
      {subtitle ? (
        <div style={{ fontSize: 12.5, color: tokens.textMuted, marginTop: 4 }}>{subtitle}</div>
      ) : null}
      <div
        style={{
          height: 1,
          background: tokens.border,
          margin: `${tokens.space.md}px 0 ${tokens.space.md}px`,
        }}
      />
      {children}
    </section>
  );
}

/** A definition-style row for the methodology prose. */
function Point({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(150px, 190px) 1fr',
        gap: tokens.space.md,
        padding: `${tokens.space.sm}px 0`,
        borderBottom: `1px solid ${tokens.border}`,
        alignItems: 'baseline',
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: tokens.accent }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: tokens.text }}>{children}</div>
    </div>
  );
}

const TH: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: tokens.textMuted,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  borderBottom: `1px solid ${tokens.border}`,
  position: 'sticky',
  top: 0,
  background: tokens.panelAlt,
  whiteSpace: 'nowrap',
};

const TD: React.CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.45,
  color: tokens.text,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  borderBottom: `1px solid ${tokens.border}`,
  verticalAlign: 'top',
};

const TABLE: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  tableLayout: 'fixed',
};

export function MethodologyPanel() {
  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.space.lg,
        padding: tokens.space.lg,
        background: tokens.bg,
      }}
    >
      {/* Integrity banner — the single most important frame for evaluators. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space.sm,
          fontSize: 12.5,
          fontWeight: 600,
          color: tokens.mode.SIM,
          background: tokens.panelAlt,
          border: `1px solid ${tokens.border}`,
          borderRadius: tokens.radius.sm,
          padding: `${tokens.space.sm}px ${tokens.space.md}px`,
        }}
      >
        <CalciteIcon icon="lightbulb" scale="s" />
        <span>
          Default demo mode is SIMULATED. No figure below is a claimed JNPA baseline or an
          improvement-vs-baseline claim — each is a calibration target or a stated modelling
          assumption.
        </span>
      </div>

      {/* 1) METHODOLOGY */}
      <Section
        title="1 · Methodology"
        subtitle="How the digital twin is built, and exactly what its numbers do and do not mean."
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Point label="The twin">
            A synthetic JNPA marine picture — vessels, berths, port-craft, weather, tide — generated
            by a simulator and <strong>calibrated to public FY24-25-class figures</strong> so its
            statistics land near credible values. It is a plausible stand-in for the port, not a
            recording of it.
          </Point>
          <Point label="DUKC computation">
            Under-keel clearance is computed from first principles as{' '}
            <strong>depth + tide − static draft − squat</strong>, checked against a fixed UKC safety
            margin. It is a simplified open-water model, not a proprietary DUKC product.
          </Point>
          <Point label="DUKC vs RTUKC">
            <strong>DUKC</strong> is <em>predictive</em> — it forecasts clearance windows ahead of
            time from tide and bathymetry predictions; <strong>RTUKC</strong> is the{' '}
            <em>real-time</em> clearance evaluated against live-observed tide and vessel state.
          </Point>
          <Point label="Scenarios">
            Each scenario perturbs the twin (weather, tide, channel depth, pilots/tugs down, berths
            out) and is compared against a <strong>simulated do-nothing “shadow” run</strong> of the
            same clock — so the delta is “vs simulated do-nothing”, never “vs a JNPA baseline”.
          </Point>
          <Point label="Prediction accuracy">
            Accuracy of prediction vs real-time is assessed by a <strong>holdout</strong>: the
            predictive DUKC is generated for a future window, then scored against the twin's later
            real-time (RTUKC) outcome for the same window — the two are never fit to each other.
          </Point>
          <Point label="Provenance">
            Every screen carries a provenance chip and every data source a fallback rung, so a viewer
            can never mistake simulated data for a live JNPA feed.
          </Point>
        </div>
      </Section>

      {/* 2) ASSUMPTIONS REGISTER */}
      <Section
        title="2 · Assumptions register"
        subtitle="Calibration targets and modelling choices the twin leans on — reference figures, not baselines."
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={TABLE}>
            <colgroup>
              <col style={{ width: '22%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '34%' }} />
              <col style={{ width: '26%' }} />
            </colgroup>
            <thead>
              <tr>
                <th style={TH}>Assumption</th>
                <th style={TH}>Value (target)</th>
                <th style={TH}>Source / justification</th>
                <th style={TH}>How the twin uses it</th>
              </tr>
            </thead>
            <tbody>
              {ASSUMPTIONS.map((a) => (
                <tr key={a.id}>
                  <td style={{ ...TD, fontWeight: 600, color: tokens.text }}>{a.label}</td>
                  <td style={{ ...TD, color: tokens.accent, fontVariantNumeric: 'tabular-nums' }}>
                    {a.value}
                  </td>
                  <td style={{ ...TD, color: tokens.textMuted }}>{a.source}</td>
                  <td style={TD}>{a.use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 2b) SHARED SUITE REGISTER (A-01..A-06) — identical across UC-1/2/3 */}
      <Section
        title="2b · Suite data-provenance register (A-01…A-06)"
        subtitle="The one numbered register shared by all three use cases (deck slide 6). Each cross-domain KPI delta and simulated feed cites one of these ids; each names the JNPA feed that replaces it post-award."
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={TABLE}>
            <colgroup>
              <col style={{ width: '7%' }} />
              <col style={{ width: '37%' }} />
              <col style={{ width: '31%' }} />
              <col style={{ width: '25%' }} />
            </colgroup>
            <thead>
              <tr>
                <th style={TH}>ID</th>
                <th style={TH}>Assumption</th>
                <th style={TH}>Basis / justification</th>
                <th style={TH}>Replaced by, post-award</th>
              </tr>
            </thead>
            <tbody>
              {SUITE_ASSUMPTIONS.map((a) => (
                <tr key={a.id}>
                  <td style={{ ...TD, fontWeight: 700, color: tokens.accent }}>{a.id}</td>
                  <td style={{ ...TD, color: tokens.text }}>
                    {a.assumption}
                    <span style={{ color: tokens.textMuted, fontSize: 11 }}>
                      {' '}· {a.usedBy.join(', ')}
                    </span>
                  </td>
                  <td style={{ ...TD, color: tokens.textMuted }}>{a.basis}</td>
                  <td style={TD}>{a.replacedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 3) OPEN-SOURCE COMPONENTS */}
      <Section
        title="3 · Open-source components"
        subtitle="Libraries the PoC is built on, with their licences (open-source honesty §A3)."
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={TABLE}>
            <colgroup>
              <col style={{ width: '42%' }} />
              <col style={{ width: '26%' }} />
              <col style={{ width: '32%' }} />
            </colgroup>
            <thead>
              <tr>
                <th style={TH}>Component</th>
                <th style={TH}>Licence</th>
                <th style={TH}>Role</th>
              </tr>
            </thead>
            <tbody>
              {OSS.map((c) => (
                <tr key={c.name}>
                  <td style={{ ...TD, fontWeight: 600 }}>{c.name}</td>
                  <td style={TD}>
                    <CalciteChip scale="s" appearance="outline-fill">
                      {c.license}
                    </CalciteChip>
                  </td>
                  <td style={{ ...TD, color: tokens.textMuted }}>{c.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* 4) DATA PROVENANCE */}
      <Section
        title="4 · Data provenance"
        subtitle="The seven production feeds the twin integrates. In the default demo they are SIMULATED, and every screen carries a provenance chip."
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={TABLE}>
            <colgroup>
              <col style={{ width: '18%' }} />
              <col style={{ width: '30%' }} />
              <col style={{ width: '18%' }} />
              <col style={{ width: '34%' }} />
            </colgroup>
            <thead>
              <tr>
                <th style={TH}>Source</th>
                <th style={TH}>Intended production feed</th>
                <th style={TH}>Cadence</th>
                <th style={TH}>Role in the twin</th>
              </tr>
            </thead>
            <tbody>
              {SOURCES.map((s) => (
                <tr key={s.id}>
                  <td style={{ ...TD, fontWeight: 600, color: tokens.text }}>{s.label}</td>
                  <td style={{ ...TD, color: tokens.textMuted }}>{s.prodSource}</td>
                  <td style={{ ...TD, color: tokens.accent, fontVariantNumeric: 'tabular-nums' }}>
                    {s.cadence}
                  </td>
                  <td style={TD}>{s.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space.sm,
            marginTop: tokens.space.md,
            fontSize: 12,
            color: tokens.textMuted,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: tokens.mode.SIM,
            }}
          />
          <span>
            Demo mode: <strong style={{ color: tokens.mode.SIM }}>SIMULATED</strong> — each source
            degrades through cached → imputed → offline fallback rungs, labelled live on every panel.
          </span>
        </div>
      </Section>
    </div>
  );
}
