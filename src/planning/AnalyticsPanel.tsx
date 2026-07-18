/**
 * <AnalyticsPanel> — competitive analytics surface (spec C-1, C-3, C-7).
 * Three sections:
 *   • JIT / RTA advisory — recommended arrival + simulated bunker/CO₂ saved.
 *   • Historical views — berth-occupancy heat calendar, waiting-time
 *     distribution, terminal-wise TAT comparison.
 *   • Optimise — a one-click conflict-free berth proposal with its explainable
 *     objective breakdown (decision support; a planner accepts/edits).
 *
 * All figures are SIMULATED under stated assumptions — never JNPA baselines.
 */
import { Fragment, useMemo, useState } from 'react';
import { CalciteButton } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { recommendRta } from './jit';
import { optimiseBerthPlan, type BerthRequest } from './optimiser';
import { vesselDims } from './constraints';
import { occupancyCalendar, waitingTimeDistribution, terminalTat } from '@/kpi/analytics';
import type { Berth, BerthingPlanEntry } from '@/types/domain';
import { tokens } from '@/theme/tokens';
import { istDateTime } from '@/util/format';
import { SourceBadge } from '@/provenance/SourceBadge';
import { PanelEmpty, PanelLoading } from '@/components/common/Panel';
import { TatPredictionCard } from './TatPredictionCard';

const H = 3_600_000;

function heatColor(f: number): string {
  // green (low) → amber → red (high). Not hue-only: cells also show the %.
  if (f < 0.34) return `${tokens.good}`;
  if (f < 0.67) return `${tokens.warn}`;
  return `${tokens.bad}`;
}

export function AnalyticsPanel() {
  const berthsQ = useAdapterQuery<Berth[]>(() => getAdapter().getBerths(), [], 60_000);
  const planQ = useAdapterQuery<BerthingPlanEntry[]>(() => getAdapter().getBerthPlan({ lastHours: 120 }), [], 60_000);

  const [proposal, setProposal] = useState<ReturnType<typeof optimiseBerthPlan> | null>(null);

  const berths = berthsQ.data;
  const plan = planQ.data;

  const analytics = useMemo(() => {
    if (!berths || !plan || plan.length === 0) return null;
    const from = Math.min(...plan.map((p) => p.PLANNED_START));
    return {
      occ: occupancyCalendar(plan, berths, from, 5),
      wait: waitingTimeDistribution(plan),
      tat: terminalTat(plan, berths),
      days: 5,
    };
  }, [berths, plan]);

  // JIT for the earliest scheduled call.
  const jit = useMemo(() => {
    if (!plan || plan.length === 0) return null;
    const next = [...plan].sort((a, b) => a.PLANNED_START - b.PLANNED_START)[0];
    const etaMs = next.PLANNED_START;
    return {
      call: next,
      rec: recommendRta({
        etaMs,
        berthReadyMs: etaMs + 5 * H, // simulated: berth frees 5h after ETA
        goWindowStartMs: etaMs + 3 * H,
        distanceNm: 150,
        currentSpeedKn: 16,
      }),
    };
  }, [plan]);

  const runOptimise = () => {
    if (!berths || !plan) return;
    const requests: BerthRequest[] = plan.map((p) => {
      const dims = vesselDims({ VESSEL_TYPE: 'Container Ship' });
      return {
        planId: p.PLAN_ID,
        mmsi: p.MMSI,
        vesselName: p.VESSEL_NAME,
        requestedBerthId: p.BERTH_ID,
        requestedStartMs: p.PLANNED_START,
        durationMs: p.PLANNED_END - p.PLANNED_START,
        loaM: dims.loaM,
        draftM: dims.draftM,
      };
    });
    setProposal(optimiseBerthPlan(requests, berths));
  };

  if ((berthsQ.loading && !berths) || (planQ.loading && !plan)) return <PanelLoading label="Loading analytics…" />;
  if (!analytics || !jit) return <PanelEmpty message="No plan data for analytics yet." />;

  const occByBerth = new Map<string, number[]>();
  for (const c of analytics.occ) {
    if (!occByBerth.has(c.berthId)) occByBerth.set(c.berthId, []);
    occByBerth.get(c.berthId)!.push(c.fraction);
  }

  return (
    <div style={{ color: tokens.text, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <SourceBadge source="BERTH_PLAN" />

      {/* JIT / RTA */}
      <section>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Just-In-Time arrival advisory <Sim /></h4>
        <div style={{ fontSize: 12, background: tokens.panelAlt, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm, padding: 10, lineHeight: 1.6 }}>
          <div><strong>{jit.call.VESSEL_NAME}</strong> → recommended RTA <strong>{istDateTime(jit.rec.rtaMs)}</strong></div>
          <div style={{ color: tokens.textMuted }}>{jit.rec.advisory}</div>
          {jit.rec.bunkerSavedT > 0 && (
            <div style={{ marginTop: 4 }}>
              Simulated saving: <strong>{jit.rec.bunkerSavedT} t</strong> bunker ·{' '}
              <strong>{jit.rec.co2SavedT} t</strong> CO₂ · <strong>${jit.rec.costSavedUsd.toLocaleString()}</strong>
            </div>
          )}
        </div>
      </section>

      {/* Occupancy heat calendar */}
      <section>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Berth occupancy — 5-day heat calendar</h4>
        <div style={{ display: 'grid', gridTemplateColumns: `120px repeat(${analytics.days}, 1fr)`, gap: 3, fontSize: 11 }}>
          <div />
          {Array.from({ length: analytics.days }, (_, d) => (
            <div key={d} style={{ textAlign: 'center', color: tokens.textMuted }}>D{d + 1}</div>
          ))}
          {[...occByBerth.entries()].map(([berthId, fracs]) => (
            <Fragment key={berthId}>
              <div style={{ color: tokens.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{berthId}</div>
              {fracs.map((f, d) => (
                <div
                  key={`${berthId}-${d}`}
                  title={`${berthId} · D${d + 1} · ${(f * 100).toFixed(0)}% occupied`}
                  style={{ background: `${heatColor(f)}33`, border: `1px solid ${heatColor(f)}`, borderRadius: 2, textAlign: 'center', color: tokens.text, padding: '2px 0' }}
                >
                  {(f * 100).toFixed(0)}%
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      </section>

      {/* Waiting-time distribution */}
      <section>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Pre-berthing waiting-time distribution</h4>
        {analytics.wait.n === 0 ? (
          <div style={{ fontSize: 11, color: tokens.textMuted }}>No completed calls yet — distribution appears once vessels berth.</div>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 80 }}>
              {analytics.wait.buckets.map((b) => {
                const max = Math.max(1, ...analytics.wait.buckets.map((x) => x.count));
                return (
                  <div key={b.label} style={{ flex: 1, textAlign: 'center' }}>
                    <div style={{ height: `${(b.count / max) * 64}px`, background: tokens.accent, borderRadius: 2 }} title={`${b.count} calls`} />
                    <div style={{ fontSize: 9, color: tokens.textMuted, marginTop: 2 }}>{b.label}</div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: tokens.textMuted, marginTop: 4 }}>
              n={analytics.wait.n} · mean {analytics.wait.meanH}h · p50 {analytics.wait.p50H}h · p90 {analytics.wait.p90H}h
            </div>
          </div>
        )}
      </section>

      {/* Terminal TAT */}
      <section>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Terminal-wise mean TAT</h4>
        {analytics.tat.length === 0 ? (
          <div style={{ fontSize: 11, color: tokens.textMuted }}>No completed calls yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {analytics.tat.map((t) => (
              <div key={t.terminal} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
                <span style={{ width: 70 }}>{t.terminal}</span>
                <div style={{ flex: 1, background: tokens.panelAlt, borderRadius: 2 }}>
                  <div style={{ width: `${Math.min(100, (t.meanTatH / 48) * 100)}%`, background: tokens.accentDim, height: 14, borderRadius: 2 }} />
                </div>
                <span style={{ width: 60, textAlign: 'right' }}>{t.meanTatH}h · {t.calls}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Optional forward TAT forecast (feature model) — hidden until requested. */}
      <TatPredictionCard />

      {/* Optimiser */}
      <section>
        <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>Berth-plan optimiser <Sim /></h4>
        <CalciteButton scale="s" iconStart="lightbulb" onClick={runOptimise}>Optimise (propose conflict-free plan)</CalciteButton>
        {proposal && (
          <div style={{ marginTop: 8, fontSize: 12, background: tokens.panelAlt, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm, padding: 10 }}>
            <div style={{ fontWeight: 600 }}>
              Objective {proposal.cost} — waiting {proposal.breakdown.waitH}h · tide misses {proposal.breakdown.tideMisses} · shifts {proposal.breakdown.shifts}
            </div>
            <div style={{ color: tokens.textMuted, marginTop: 2 }}>
              {proposal.assignments.length} placed{proposal.unplaced.length ? `, ${proposal.unplaced.length} unplaceable` : ''}. Decision support — a planner accepts or edits.
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Sim() {
  return <span style={{ fontSize: 9, fontWeight: 700, color: tokens.warn, border: `1px solid ${tokens.warn}`, borderRadius: 3, padding: '0 4px', marginLeft: 6, verticalAlign: 'middle' }}>SIMULATED</span>;
}
