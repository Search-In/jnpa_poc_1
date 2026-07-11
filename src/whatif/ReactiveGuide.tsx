/**
 * <ReactiveGuide> — the Reactive Causality Guide (spec §B2.10, rubric C5).
 *
 * Rides alongside a running scenario and answers WHICH / WHERE / HOW / WHY /
 * WHAT-NOW for the causal chain the active scenario lights up. Everything is
 * derived offline and deterministically from the scenario's chain of causal
 * nodes/edges — no external calls, no live model.
 *
 * Integrity (spec §A3): every magnitude is framed as a SIMULATED result from the
 * twin-vs-shadow run, never as a measured baseline improvement.
 */

import { useMemo } from 'react';
import { CalciteButton, CalciteIcon } from '@esri/calcite-components-react';
import { tokens } from '@/theme/tokens';
import { useSimStore } from '@/sim/simStore';
import { SCENARIO_BY_ID } from '@/sim/scenarios';
import {
  NODE_BY_ID,
  chainEdges,
  DOMAIN_COLOR,
  type CausalNode,
  type CausalEdge,
  type Domain,
} from '@/whatif/causalGraph';

/** Intervention suggestion keyed to a scenario's dominant domain. */
interface Intervention {
  action: string;
  effect: string;
}

/** WHAT-NOW playbook — 2-3 moves per dominant domain, each with a simulated
 *  effect framed vs do-nothing (never vs a real baseline). */
const PLAYBOOK: Record<Domain, Intervention[]> = {
  weather: [
    { action: 'Hold pilotage; re-sequence inbound on clearance', effect: 'Simulated: recovers the arrival queue in one tidal cycle vs do-nothing.' },
    { action: 'Pre-stage pilots at the boarding ground for the lift', effect: 'Simulated: cuts first-boarding lag once the hold clears vs do-nothing.' },
    { action: 'Prioritise deep-draft on the next high-water window', effect: 'Simulated: protects the tidal-critical calls from cascading delay.' },
  ],
  tide: [
    { action: 'Shift deep-draft calls to the next high-water window', effect: 'Simulated: restores under-keel clearance vs berthing on a closing tide.' },
    { action: 'Backfill freed windows with shallow-draft calls', effect: 'Simulated: keeps berth occupancy up while deep-draft waits, vs do-nothing.' },
  ],
  channel: [
    { action: 'Shift deep-draft calls to the next high-water window', effect: 'Simulated: restores DUKC margin against the reduced controlling depth.' },
    { action: 'Re-verify controlling depth per segment before transit', effect: 'Simulated: narrows go/marginal bands to the surveyed floor vs stale charts.' },
    { action: 'Sequence shallow-draft first to hold throughput', effect: 'Simulated: smooths pre-berthing delay while windows are constrained.' },
  ],
  pilotage: [
    { action: 'Reassign pilots to close the largest JIT gap first', effect: 'Simulated: recovers the most at-risk arrival window vs first-come.' },
    { action: 'Compress boarding slots onto priority calls', effect: 'Simulated: limits JIT slippage under the shortfall vs do-nothing.' },
  ],
  craft: [
    { action: 'Reassign pilots to close the largest JIT gap first', effect: 'Simulated: recovers the most at-risk arrival window vs first-come.' },
    { action: 'Reallocate tugs to unblock unberthing turns', effect: 'Simulated: releases berths sooner for the next call vs do-nothing.' },
    { action: 'Prioritise deep-draft on a closing tide', effect: 'Simulated: protects tidal-critical turns under limited craft.' },
  ],
  berth: [
    { action: 'Reallocate affected calls to compatible berths', effect: 'Simulated: absorbs the outage within draft limits vs holding calls.' },
    { action: 'Re-optimise the berthing sequence across terminals', effect: 'Simulated: rebalances load off the constrained terminal vs do-nothing.' },
    { action: 'Meter arrivals out of the anchorage to berth availability', effect: 'Simulated: smooths the peak instead of berthing first-come.' },
  ],
  kpi: [
    { action: 'Re-sequence to protect the highest-value windows', effect: 'Simulated: converges TAT/JIT back toward target vs do-nothing.' },
    { action: 'Notify stakeholders and lock the recovery plan', effect: 'Simulated: shortens time-to-decision on the corrective move.' },
  ],
};

const DOMAIN_LABEL: Record<Domain, string> = {
  weather: 'Weather',
  tide: 'Tide',
  channel: 'Channel',
  pilotage: 'Pilotage',
  berth: 'Berth',
  craft: 'Port craft',
  kpi: 'KPI',
};

/** Pick the dominant domain of a chain: the first non-KPI domain drives the
 *  playbook (KPI nodes are effects, not levers), falling back to the first. */
function dominantDomain(nodes: CausalNode[]): Domain {
  const lever = nodes.find((n) => n.domain !== 'kpi');
  return (lever ?? nodes[0]).domain;
}

/** Compose a deterministic plain-language WHY narrative from the chain. The
 *  edges are ordered to follow the chain so the prose reads cause→effect. */
function composeWhy(nodes: CausalNode[], edges: CausalEdge[]): string {
  if (nodes.length === 0) return '';
  if (edges.length === 0) return `${nodes[0].label} is the single factor in play in this scenario.`;

  const first = NODE_BY_ID[edges[0].from];
  const last = NODE_BY_ID[edges[edges.length - 1].to];

  const clauses = edges.map((e, i) => {
    const from = NODE_BY_ID[e.from];
    const to = NODE_BY_ID[e.to];
    if (i === 0) return `Because ${from.label.toLowerCase()} ${e.mechanism}, ${to.label.toLowerCase()} follows`;
    return `which ${e.mechanism}, driving ${to.label.toLowerCase()}`;
  });

  const body = clauses.join('; ');
  return `${body} — ultimately affecting ${last.label.toLowerCase()}. Magnitudes are simulated from the twin-vs-shadow run for ${first.label.toLowerCase()}.`;
}

/** Order the chain's edges to follow the node ordering (cause → effect). */
function orderedEdges(chain: string[], edges: CausalEdge[]): CausalEdge[] {
  const idx = new Map(chain.map((id, i) => [id, i]));
  return [...edges].sort((a, b) => {
    const fa = idx.get(a.from) ?? 0;
    const fb = idx.get(b.from) ?? 0;
    if (fa !== fb) return fa - fb;
    return (idx.get(a.to) ?? 0) - (idx.get(b.to) ?? 0);
  });
}

const SECTION_META: { key: string; label: string; sub: string }[] = [
  { key: 'which', label: 'WHICH', sub: 'factors hit — ranked along the chain' },
  { key: 'where', label: 'WHERE', sub: 'spotlight the geography on the map' },
  { key: 'how', label: 'HOW', sub: 'mechanism-labelled propagation' },
  { key: 'why', label: 'WHY', sub: 'auto-composed plain-language chain' },
  { key: 'whatnow', label: 'WHAT NOW', sub: 'interventions vs simulated do-nothing' },
];

function SectionHead({ index }: { index: number }) {
  const m = SECTION_META[index];
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: tokens.space.sm, marginBottom: tokens.space.sm }}>
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 1,
          color: tokens.accent,
          background: tokens.panelAlt,
          border: `1px solid ${tokens.border}`,
          borderRadius: tokens.radius.sm,
          padding: '2px 6px',
        }}
      >
        {m.label}
      </span>
      <span style={{ fontSize: 11, color: tokens.textMuted }}>{m.sub}</span>
    </div>
  );
}

export function ReactiveGuide(props: { onSpotlight?: (ids: string[]) => void }) {
  const scenarioId = useSimStore((s) => s.scenarioId);
  const scenario = scenarioId ? SCENARIO_BY_ID[scenarioId] : undefined;

  const model = useMemo(() => {
    if (!scenario) return null;
    const nodes = scenario.chain.map((id) => NODE_BY_ID[id]).filter(Boolean);
    const edges = orderedEdges(scenario.chain, chainEdges(scenario.chain));
    const domain = dominantDomain(nodes);
    return {
      nodes,
      edges,
      domain,
      why: composeWhy(nodes, edges),
      interventions: PLAYBOOK[domain],
      whereNodes: nodes.filter((n) => n.where && n.where.length > 0),
    };
  }, [scenario]);

  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!scenario || !model) {
    return (
      <div
        style={{
          height: '100%',
          overflow: 'auto',
          display: 'grid',
          placeItems: 'center',
          padding: tokens.space.lg,
        }}
      >
        <div style={{ textAlign: 'center', color: tokens.textMuted, maxWidth: 320 }}>
          <CalciteIcon icon="graph-time-series" scale="l" />
          <p style={{ fontSize: 13, margin: `${tokens.space.md}px 0 4px`, color: tokens.text }}>
            No scenario running
          </p>
          <p style={{ fontSize: 12, margin: 0 }}>Run a scenario to see its causal chain.</p>
        </div>
      </div>
    );
  }

  const spotlight = (ids: string[]) => {
    props.onSpotlight?.(ids);
    useSimStore.getState().setHighlights(ids);
  };

  const sectionStyle: React.CSSProperties = {
    padding: `${tokens.space.md}px 0`,
    borderTop: `1px solid ${tokens.border}`,
  };

  return (
    <div style={{ height: '100%', overflow: 'auto', color: tokens.text }}>
      {/* Scenario header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space.sm,
          padding: `0 0 ${tokens.space.sm}px`,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: tokens.text,
            background: tokens.accentDim,
            borderRadius: tokens.radius.sm,
            padding: '2px 7px',
          }}
        >
          {scenario.code}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{scenario.title}</div>
          <div style={{ fontSize: 11, color: tokens.textMuted }}>{scenario.summary}</div>
        </div>
      </div>

      {/* WHICH */}
      <div style={sectionStyle}>
        <SectionHead index={0} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.xs }}>
          {model.nodes.map((n, i) => (
            <div
              key={n.id}
              style={{
                display: 'flex',
                gap: tokens.space.sm,
                alignItems: 'flex-start',
                background: tokens.panelAlt,
                borderLeft: `3px solid ${DOMAIN_COLOR[n.domain]}`,
                borderRadius: tokens.radius.sm,
                padding: `6px ${tokens.space.sm}px`,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: tokens.textMuted,
                  minWidth: 16,
                }}
              >
                {i + 1}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>
                  {n.label}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      color: DOMAIN_COLOR[n.domain],
                      marginLeft: tokens.space.sm,
                      textTransform: 'uppercase',
                      letterSpacing: 0.5,
                    }}
                  >
                    {DOMAIN_LABEL[n.domain]}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: tokens.textMuted }}>{n.desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ fontSize: 10, color: tokens.textMuted, marginTop: tokens.space.xs, fontStyle: 'italic' }}>
          Ranking and magnitudes are simulated, from the twin-vs-shadow run.
        </div>
      </div>

      {/* WHERE */}
      <div style={sectionStyle}>
        <SectionHead index={1} />
        {model.whereNodes.length === 0 ? (
          <div style={{ fontSize: 11, color: tokens.textMuted }}>
            No mapped geography for this chain.
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.sm }}>
            {model.whereNodes.map((n) => (
              <CalciteButton
                key={n.id}
                scale="s"
                appearance="outline"
                iconStart="pin-tear"
                onClick={() => spotlight(n.where ?? [])}
              >
                {n.label}
              </CalciteButton>
            ))}
          </div>
        )}
      </div>

      {/* HOW */}
      <div style={sectionStyle}>
        <SectionHead index={2} />
        {model.edges.length === 0 ? (
          <div style={{ fontSize: 11, color: tokens.textMuted }}>
            Single-factor scenario — no propagation edges.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.xs }}>
            {model.edges.map((e) => {
              const from = NODE_BY_ID[e.from];
              const to = NODE_BY_ID[e.to];
              return (
                <div
                  key={`${e.from}->${e.to}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: tokens.space.sm,
                    flexWrap: 'wrap',
                    fontSize: 12,
                    background: tokens.panelAlt,
                    borderRadius: tokens.radius.sm,
                    padding: `5px ${tokens.space.sm}px`,
                  }}
                >
                  <span style={{ fontWeight: 600, color: DOMAIN_COLOR[from.domain] }}>{from.label}</span>
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 10,
                      color: tokens.textMuted,
                    }}
                  >
                    <span
                      aria-hidden
                      className={reduceMotion ? undefined : 'rg-arrow'}
                      style={{
                        display: 'inline-block',
                        width: 22,
                        height: 1,
                        background: tokens.border,
                        position: 'relative',
                      }}
                    />
                    <span style={{ fontStyle: 'italic' }}>{e.mechanism}</span>
                    <span aria-hidden style={{ color: tokens.textMuted }}>→</span>
                  </span>
                  <span style={{ fontWeight: 600, color: DOMAIN_COLOR[to.domain] }}>{to.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* WHY */}
      <div style={sectionStyle}>
        <SectionHead index={3} />
        <p
          style={{
            fontSize: 12,
            lineHeight: 1.5,
            margin: 0,
            color: tokens.text,
            background: tokens.panelAlt,
            borderRadius: tokens.radius.sm,
            padding: tokens.space.sm,
          }}
        >
          {model.why}
        </p>
      </div>

      {/* WHAT NOW */}
      <div style={{ ...sectionStyle, borderBottom: `1px solid ${tokens.border}` }}>
        <SectionHead index={4} />
        <div style={{ fontSize: 10, color: tokens.textMuted, marginBottom: tokens.space.xs }}>
          Dominant domain: {DOMAIN_LABEL[model.domain]}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.xs }}>
          {model.interventions.map((iv, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                gap: tokens.space.sm,
                alignItems: 'flex-start',
                background: tokens.panelAlt,
                borderLeft: `3px solid ${tokens.good}`,
                borderRadius: tokens.radius.sm,
                padding: `6px ${tokens.space.sm}px`,
              }}
            >
              <CalciteIcon icon="lightbulb" scale="s" style={{ color: tokens.good, flexShrink: 0 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600 }}>{iv.action}</div>
                <div style={{ fontSize: 11, color: tokens.textMuted }}>{iv.effect}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {!reduceMotion && (
        <style>{`
          @keyframes rg-flow { 0% { opacity: .35 } 50% { opacity: 1 } 100% { opacity: .35 } }
          .rg-arrow { animation: rg-flow 1.6s ease-in-out infinite; }
          @media (prefers-reduced-motion: reduce) { .rg-arrow { animation: none; } }
        `}</style>
      )}
    </div>
  );
}
