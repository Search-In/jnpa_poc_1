/**
 * <BerthGantt5Day> — the 5-day berth Gantt (spec §B2.7), replacing the 24h gantt.
 *
 * Rows = berths, x-axis = a 5-day (120h) horizon anchored on the earliest planned
 * start. Each berthing-plan entry renders as a status-coloured block. BEHIND the
 * blocks each berth row is shaded with its transit's DUKC-constrained tidal
 * feasibility (go / marginal / no-go) so the operator sees WHEN the water column
 * actually supports the call, not just when it's booked. Berths knocked out by the
 * current scenario are hatched out-of-service.
 *
 * In "What-if replan" mode a block can be dragged horizontally to a new start
 * time. The drop stays in LOCAL state only (adapter data is never mutated) and a
 * "simulated do-nothing vs replanned" caption reports the shift and whether the
 * new slot lands in a go window under the same DUKC model. Every figure is a
 * simulated result under the stated tide/depth assumptions.
 */

import { useMemo, useRef, useState } from 'react';
import { CalciteSwitch } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { useSimStore } from '@/sim/simStore';
import { plannedTransits, controllingDepthM, type PlannedTransit } from '@/sim/derive';
import { computeUkc, tideAt } from '@/dukc/ukc';
import { intervalsOverlap, type PlanViolation } from '@/planning/constraints';
import { useRoleStore } from '@/auth/roleStore';
import { scopeData, canEdit } from '@/auth/roles';
import { usePlanStore } from '@/planning/planStore';
import type { Berth, BerthingPlanEntry } from '@/types/domain';
import { tokens, ukcColor } from '@/theme/tokens';
import { istDateTime, istTime, durationFromHours } from '@/util/format';
import { SourceBadge } from '@/provenance/SourceBadge';
import { useHighlightMatch } from '@/whatif/useHighlight';
import { PanelEmpty, PanelError, PanelLoading } from '../common/Panel';

const H = 3_600_000;
const HORIZON_H = 120; // 5 days
const DAY_MS = 24 * H;

/** Status → block fill (tokens only). */
function statusFill(status: BerthingPlanEntry['STATUS']): string {
  switch (status) {
    case 'active':
      return tokens.accent;
    case 'completed':
      return tokens.good;
    case 'cancelled':
      return tokens.bad;
    case 'scheduled':
    default:
      return tokens.accentDim;
  }
}

/** Faint feasibility fill for a tidal-window status. */
function windowFill(status: 'go' | 'marginal' | 'noGo'): string {
  const base = status === 'go' ? ukcColor.go : status === 'marginal' ? ukcColor.marginal : ukcColor.noGo;
  return `${base}22`; // ~13% alpha — a background wash under the blocks
}

interface Row {
  berthId: string;
  berthName: string;
  /** Terminal id (e.g. GTI) so a terminal-level scenario highlight lights the row. */
  terminal?: string;
  outOfService: boolean;
  entries: BerthingPlanEntry[];
  transit?: PlannedTransit;
}

export function BerthGantt5Day() {
  // Key the query on clockH so the DUKC feasibility bands advance with the sim.
  const clockH = useSimStore((s) => s.clockH);
  const levers = useSimStore((s) => s.levers);
  const simVersion = useSimStore((s) => s.version);

  const role = useRoleStore((s) => s.role);
  const principal = useRoleStore((s) => s.principal);
  const roleCanEdit = canEdit(role);

  // What-if / guided-tour spotlight: light the berth rows the active scenario
  // rings on the map, so map + gantt highlight the same assets in sync.
  const hl = useHighlightMatch();

  const berthsQ = useAdapterQuery<Berth[]>(() => getAdapter().getBerths(), [clockH, simVersion], 30_000);
  const planQ = useAdapterQuery<BerthingPlanEntry[]>(
    () => getAdapter().getBerthPlan({ lastHours: 24 }),
    [clockH],
    30_000
  );

  // Local, non-destructive replan overrides: PLAN_ID → new planned start (ms).
  const [replan, setReplan] = useState<Record<string, number>>({});
  const [replanMode, setReplanMode] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  // W-4: a drop that violates a constraint is rejected, naming the violation.
  const [rejected, setRejected] = useState<PlanViolation | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Manually imported / entered calls overlay the adapter plan (IU-2).
  const importedPlan = usePlanStore((s) => s.imported);

  // Apply the active role's visibility scope to the plan + berths (R-5).
  const scoped = useMemo(() => {
    if (!planQ.data || !berthsQ.data) return null;
    // Merge overlay (imported/manual) with adapter plan before scoping.
    const merged = [...planQ.data, ...importedPlan];
    return scopeData(role, principal, {
      plan: merged,
      berths: berthsQ.data,
      vessels: [],
      craft: [],
    });
  }, [planQ.data, berthsQ.data, importedPlan, role, principal]);

  const plan = scoped?.plan;
  const berths = scoped?.berths;

  // Transits (with DUKC windows) for the CURRENT levers, phased on the sim clock
  // so the feasibility shading moves as time advances.
  const transits = useMemo(
    () => (plan ? plannedTransits(plan, levers, clockH) : []),
    [plan, levers, clockH]
  );

  // 5-day axis anchored on the earliest planned start (floored to the IST day).
  const { winStart, rows } = useMemo(() => {
    if (!plan || plan.length === 0 || !berths) return { winStart: 0, rows: [] as Row[] };
    const starts = plan.map((p) => replan[p.PLAN_ID] ?? p.PLANNED_START);
    const earliest = Math.min(...starts);
    const start = Math.floor(earliest / DAY_MS) * DAY_MS; // day-aligned epoch

    const nameOf = new Map(berths.map((b) => [b.BERTH_ID, b.BERTH_NAME] as const));
    const terminalOf = new Map(berths.map((b) => [b.BERTH_ID, b.TERMINAL] as const));
    const transitOf = new Map(transits.map((t) => [t.planId, t] as const));
    const out = new Set(levers.berthsOut);

    // One row per berth that either exists or is referenced by the plan.
    const berthIds = new Set<string>([...berths.map((b) => b.BERTH_ID), ...plan.map((p) => p.BERTH_ID)]);
    const rowsArr: Row[] = [...berthIds]
      .sort((a, b) => a.localeCompare(b))
      .map((berthId) => {
        const entries = plan.filter((p) => p.BERTH_ID === berthId);
        // Representative transit for the row (first planned call on this berth).
        const t = entries.map((e) => transitOf.get(e.PLAN_ID)).find(Boolean);
        return {
          berthId,
          berthName: nameOf.get(berthId) ?? berthId,
          terminal: terminalOf.get(berthId),
          outOfService: out.has(berthId),
          entries,
          transit: t,
        };
      });
    return { winStart: start, rows: rowsArr };
  }, [plan, berths, transits, levers.berthsOut, replan]);

  if ((berthsQ.loading && !berths) || (planQ.loading && !plan))
    return <PanelLoading label="Loading 5-day berth plan…" />;
  if (planQ.error) return <PanelError message={planQ.error} />;
  if (berthsQ.error) return <PanelError message={berthsQ.error} />;
  if (!plan || plan.length === 0 || rows.length === 0)
    return <PanelEmpty message="No berthing windows scheduled in the horizon." />;

  // ---- geometry --------------------------------------------------------------
  const labelW = 150;
  const chartW = 960;
  const laneH = 34;
  const headH = 30;
  const plotW = chartW - labelW;
  const winEnd = winStart + HORIZON_H * H;
  const span = winEnd - winStart;
  const height = headH + rows.length * laneH + 8;

  const xOf = (ts: number) => labelW + ((ts - winStart) / span) * plotW;
  const wOf = (a: number, b: number) => Math.max(2, ((b - a) / span) * plotW);
  const clampX = (ts: number) => Math.min(winEnd, Math.max(winStart, ts));

  // Window hours are "hours-from-epoch" phased by clockH (see plannedTransits'
  // startH). Map an hour h back to an epoch-ms position on our day-aligned axis:
  // h === clockH sits at winStart.
  const hToMs = (h: number) => winStart + (h - clockH) * H;

  // ---- drag-to-replan --------------------------------------------------------
  const msPerPx = span / plotW;

  // W-4: does moving `entry` to `newStart` (same berth, time-only drag) collide
  // with another window already on that berth? Returns the named violation, or
  // null if the slot is feasible. Uses committed/replanned positions of peers.
  const violationForMove = (
    entry: BerthingPlanEntry,
    newStart: number
  ): PlanViolation | null => {
    const dur = entry.PLANNED_END - entry.PLANNED_START;
    const newEnd = newStart + dur;
    const peers = (plan ?? []).filter(
      (p) => p.BERTH_ID === entry.BERTH_ID && p.PLAN_ID !== entry.PLAN_ID
    );
    for (const p of peers) {
      const pStart = replan[p.PLAN_ID] ?? p.PLANNED_START;
      const pEnd = pStart + (p.PLANNED_END - p.PLANNED_START);
      if (intervalsOverlap(newStart, newEnd, pStart, pEnd)) {
        return {
          code: 'BERTH_TIME_OVERLAP',
          planId: entry.PLAN_ID,
          berthId: entry.BERTH_ID,
          message: `Move rejected: ${entry.VESSEL_NAME} would overlap ${p.VESSEL_NAME} at berth ${entry.BERTH_ID}. Choose a free slot or another berth.`,
        };
      }
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent, entry: BerthingPlanEntry) => {
    if (!replanMode || !roleCanEdit) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setRejected(null);
    setDragId(entry.PLAN_ID);
  };
  const onPointerMove = (e: React.PointerEvent, entry: BerthingPlanEntry) => {
    if (!replanMode || dragId !== entry.PLAN_ID || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    // Scale client px → SVG user units (viewBox is chartW wide).
    const svgX = ((e.clientX - rect.left) / rect.width) * chartW;
    const orig = entry.PLANNED_START;
    const dur = entry.PLANNED_END - entry.PLANNED_START;
    // Position so the pointer sits at the block's left edge, clamped to horizon.
    let newStart = winStart + (svgX - labelW) * msPerPx;
    newStart = Math.min(winEnd - dur, Math.max(winStart, newStart));
    void orig;
    // Track the candidate live for a responsive drag; validity is enforced on drop.
    setReplan((r) => ({ ...r, [entry.PLAN_ID]: newStart }));
  };
  const onPointerUp = (e: React.PointerEvent, entry: BerthingPlanEntry) => {
    if (dragId !== entry.PLAN_ID) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    setDragId(null);
    // Validate the committed drop; reject (revert) if it violates a constraint.
    const proposed = replan[entry.PLAN_ID];
    if (proposed === undefined) return;
    const v = violationForMove(entry, proposed);
    if (v) {
      setRejected(v);
      setReplan((r) => {
        const next = { ...r };
        delete next[entry.PLAN_ID]; // snap back to the last valid position
        return next;
      });
    } else {
      setRejected(null);
    }
  };

  // ---- replan delta caption --------------------------------------------------
  // Compute a "do-nothing vs replanned" delta for the most-recently moved block.
  const movedIds = Object.keys(replan);
  const lastMovedId = movedIds.length ? movedIds[movedIds.length - 1] : null;
  const caption = (() => {
    if (!lastMovedId) return null;
    const entry = plan.find((p) => p.PLAN_ID === lastMovedId);
    if (!entry) return null;
    const newStart = replan[lastMovedId];
    const shiftH = (newStart - entry.PLANNED_START) / H;
    const t = transits.find((x) => x.planId === lastMovedId);
    // Classify the NEW slot under the same DUKC model at its arrival hour.
    const arrivalH = clockH + (newStart - winStart) / H;
    const ukc = t
      ? computeUkc({
          staticDraftM: t.staticDraftM,
          chartedDepthM: t.controllingDepthM,
          tideM: tideAt(arrivalH),
          speedKt: 8,
          blockCoef: t.blockCoef,
        })
      : computeUkc({
          staticDraftM: 13.5,
          chartedDepthM: controllingDepthM(levers),
          tideM: tideAt(arrivalH),
          speedKt: 8,
          blockCoef: 0.65,
        });
    return { entry, newStart, shiftH, ukc };
  })();

  const captionColor =
    caption?.ukc.status === 'go' ? ukcColor.go : caption?.ukc.status === 'marginal' ? ukcColor.marginal : ukcColor.noGo;

  const nowMs = winStart + (0 /* clockH sits at winStart */) * H; // NOW == start of visible sim time
  const nowX = xOf(clampX(nowMs));

  // Day gridlines.
  const days = Array.from({ length: 6 }, (_, i) => winStart + i * DAY_MS);

  return (
    <div style={{ height: '100%', overflow: 'auto', color: tokens.text }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <SourceBadge source="BERTH_PLAN" />
          {scoped?.scoped && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                color: tokens.accent,
                border: `1px solid ${tokens.accent}`,
                borderRadius: 3,
                padding: '1px 5px',
              }}
              title="Rows filtered to your role's scope"
            >
              ROLE-SCOPED
            </span>
          )}
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 12,
            color: tokens.textMuted,
            cursor: roleCanEdit ? 'pointer' : 'not-allowed',
            opacity: roleCanEdit ? 1 : 0.55,
          }}
          title={roleCanEdit ? undefined : 'Your role is read-only'}
        >
          <CalciteSwitch
            checked={replanMode && roleCanEdit}
            disabled={!roleCanEdit}
            onCalciteSwitchChange={(ev) => {
              const on = (ev.target as HTMLCalciteSwitchElement).checked;
              setReplanMode(on);
            }}
            scale="s"
          />
          What-if replan (simulated — drag a block)
        </label>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${chartW} ${height}`}
          width={chartW}
          height={height}
          role="img"
          aria-label="Five-day berth gantt with DUKC feasibility"
          style={{ minWidth: chartW, touchAction: replanMode ? 'none' : 'auto' }}
        >
          <defs>
            <pattern id="oos-hatch" width={6} height={6} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={6} height={6} fill={tokens.panelAlt} />
              <line x1={0} y1={0} x2={0} y2={6} stroke={tokens.offline} strokeWidth={1.5} />
            </pattern>
            {/* Spec UI-028: indicative (twin-generated) entries are hatched so nobody
                can mistake our projection for the port's confirmed plan — at a glance,
                from six metres. */}
            <pattern id="indicative-hatch" width={7} height={7} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={7} height={7} fill={tokens.accentDim} />
              <line x1={0} y1={0} x2={0} y2={7} stroke={tokens.panel} strokeWidth={2.5} />
            </pattern>
          </defs>

          {/* day gridlines + labels */}
          {days.map((ts, i) => {
            const x = xOf(ts);
            return (
              <g key={ts}>
                <line x1={x} y1={headH - 6} x2={x} y2={height} stroke={tokens.border} strokeWidth={1} />
                {i < 5 && (
                  <text x={x + 4} y={14} fontSize={11} fill={tokens.textMuted} fontWeight={600}>
                    {istDateTime(ts).replace(/ \d\d:\d\d$/, '')}
                  </text>
                )}
              </g>
            );
          })}

          {rows.map((row, i) => {
            const y = headH + i * laneH;
            const transit = row.transit;
            const lit = hl.berth(row.berthId, row.terminal);
            const dim = hl.any && !lit;
            return (
              <g key={row.berthId} opacity={dim ? 0.4 : 1}>
                {/* row background */}
                <rect x={labelW} y={y} width={plotW} height={laneH} fill={i % 2 ? tokens.panelAlt : tokens.panel} />

                {/* what-if spotlight: ring the highlighted berth row */}
                {lit && (
                  <rect
                    x={labelW}
                    y={y + 1}
                    width={plotW - 1}
                    height={laneH - 2}
                    fill={`${tokens.accent}14`}
                    stroke={tokens.accent}
                    strokeWidth={1.5}
                  >
                    <title>{`${row.berthName} — spotlighted by the active scenario`}</title>
                  </rect>
                )}

                {/* out-of-service hatch overlay */}
                {row.outOfService && (
                  <rect x={labelW} y={y} width={plotW} height={laneH} fill="url(#oos-hatch)" opacity={0.9}>
                    <title>{`${row.berthName} — out of service (simulated scenario)`}</title>
                  </rect>
                )}

                {/* DUKC feasibility shading: go/marginal windows + no-go gaps */}
                {!row.outOfService && transit && (
                  <FeasibilityBand
                    transit={transit}
                    y={y + 2}
                    h={laneH - 4}
                    winStart={winStart}
                    winEnd={winEnd}
                    hToMs={hToMs}
                    xOf={xOf}
                  />
                )}

                {/* berth label */}
                <text x={8} y={y + laneH / 2 + 4} fontSize={12} fill={tokens.text} fontWeight={600}>
                  {row.berthName.length > 22 ? `${row.berthName.slice(0, 21)}…` : row.berthName}
                </text>

                {/* blocks */}
                {row.entries.map((e) => {
                  const start = replan[e.PLAN_ID] ?? e.PLANNED_START;
                  const dur = e.PLANNED_END - e.PLANNED_START;
                  const end = start + dur;
                  if (end < winStart || start > winEnd) return null;
                  const x = xOf(clampX(start));
                  const w = wOf(clampX(start), clampX(end));
                  const moved = replan[e.PLAN_ID] !== undefined;
                  return (
                    <g
                      key={e.PLAN_ID}
                      style={{ cursor: replanMode ? 'ew-resize' : 'default' }}
                      onPointerDown={(ev) => onPointerDown(ev, e)}
                      onPointerMove={(ev) => onPointerMove(ev, e)}
                      onPointerUp={(ev) => onPointerUp(ev, e)}
                    >
                      <rect
                        x={x}
                        y={y + 6}
                        width={w}
                        height={laneH - 12}
                        rx={3}
                        fill={e.KIND === 'indicative' ? 'url(#indicative-hatch)' : statusFill(e.STATUS)}
                        stroke={moved ? tokens.text : e.KIND === 'indicative' ? tokens.accentDim : 'none'}
                        strokeDasharray={moved ? '3 2' : e.KIND === 'indicative' ? '4 2' : undefined}
                        strokeWidth={moved ? 1 : e.KIND === 'indicative' ? 1 : 0}
                        opacity={dragId === e.PLAN_ID ? 0.8 : 1}
                      >
                        <title>
                          {`${e.VESSEL_NAME} — ${e.STATUS}\n${istDateTime(start)} → ${istTime(end)}` +
                            (e.KIND
                              ? `\n${e.KIND === 'confirmed' ? 'CONFIRMED' : 'INDICATIVE (twin-generated)'}` +
                                `${e.PROVENANCE ? ` — ${e.PROVENANCE}` : ''}` +
                                (e.END_ESTIMATED ? '\nend time estimated (source carried none)' : '')
                              : '') +
                            (moved ? '\n(simulated replan)' : '')}
                        </title>
                      </rect>
                      {w > 46 && (
                        <text
                          x={x + 5}
                          y={y + laneH / 2 + 4}
                          fontSize={11}
                          fill={tokens.bg}
                          fontWeight={600}
                          style={{ pointerEvents: 'none' }}
                        >
                          {e.VESSEL_NAME.length > Math.floor(w / 7)
                            ? `${e.VESSEL_NAME.slice(0, Math.max(1, Math.floor(w / 7) - 1))}…`
                            : e.VESSEL_NAME}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}

          {/* NOW marker (start of visible sim time) */}
          <line x1={nowX} y1={headH - 6} x2={nowX} y2={height} stroke={tokens.warn} strokeWidth={1.5} />
          <text x={nowX + 3} y={height - 3} fontSize={10} fill={tokens.warn} fontWeight={600}>
            NOW
          </text>
        </svg>
      </div>

      {/* legend */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 14,
          fontSize: 11,
          color: tokens.textMuted,
          marginTop: 8,
          alignItems: 'center',
        }}
      >
        <LegendSwatch color={tokens.accentDim} label="scheduled" />
        <LegendSwatch color={tokens.accent} label="active" />
        <LegendSwatch color={tokens.good} label="completed" />
        <LegendSwatch color={tokens.bad} label="cancelled" />
        <span style={{ opacity: 0.5 }}>│</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              width: 14,
              height: 10,
              background: `repeating-linear-gradient(45deg, ${tokens.accentDim}, ${tokens.accentDim} 2px, ${tokens.panel} 2px, ${tokens.panel} 4px)`,
              display: 'inline-block',
              borderRadius: 2,
              border: `1px dashed ${tokens.accentDim}`,
            }}
          />
          indicative (twin-generated) vs solid confirmed (JNPA report)
        </span>
        <span style={{ opacity: 0.5 }}>│</span>
        <LegendSwatch color={windowFill('go')} label="DUKC go" border />
        <LegendSwatch color={windowFill('marginal')} label="marginal" border />
        <LegendSwatch color={windowFill('noGo')} label="no-go" border />
        <span style={{ opacity: 0.5 }}>│</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span
            style={{
              width: 14,
              height: 10,
              background: `repeating-linear-gradient(45deg, ${tokens.panelAlt}, ${tokens.panelAlt} 2px, ${tokens.offline} 2px, ${tokens.offline} 3px)`,
              display: 'inline-block',
              borderRadius: 2,
            }}
          />
          out of service
        </span>
      </div>

      {/* W-4: rejected move — names the violated constraint */}
      {rejected && (
        <div
          role="alert"
          style={{
            marginTop: 10,
            padding: '8px 12px',
            background: `${tokens.bad}18`,
            border: `1px solid ${tokens.bad}`,
            borderRadius: tokens.radius.sm,
            fontSize: 12,
            lineHeight: 1.5,
            color: tokens.text,
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
          }}
        >
          <span aria-hidden style={{ color: tokens.bad, fontWeight: 700 }}>⛔</span>
          <span>
            <span style={{ color: tokens.bad, fontWeight: 700 }}>
              {rejected.code.replace(/_/g, ' ')}
            </span>{' '}
            — {rejected.message}
          </span>
        </div>
      )}

      {/* replan delta caption (simulated) */}
      {caption && (
        <div
          style={{
            marginTop: 10,
            padding: '8px 12px',
            background: tokens.panelAlt,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radius.sm,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <div style={{ color: tokens.textMuted, fontWeight: 600, marginBottom: 2 }}>
            Simulated replan — do-nothing vs replanned
          </div>
          <div>
            <span style={{ color: tokens.text, fontWeight: 600 }}>{caption.entry.VESSEL_NAME}</span>{' '}
            shifted{' '}
            <span style={{ color: tokens.text, fontWeight: 600 }}>
              {caption.shiftH >= 0 ? '+' : '−'}
              {durationFromHours(Math.abs(caption.shiftH))}
            </span>{' '}
            (do-nothing {istDateTime(caption.entry.PLANNED_START)} → replanned {istDateTime(caption.newStart)}).
          </div>
          <div>
            New slot lands in a{' '}
            <span style={{ color: captionColor, fontWeight: 700 }}>{caption.ukc.status.toUpperCase()}</span>{' '}
            tidal window — simulated UKC{' '}
            <span style={{ color: captionColor, fontWeight: 600 }}>{caption.ukc.ukcM.toFixed(2)} m</span> under the
            stated tide/depth assumptions.
          </div>
        </div>
      )}
    </div>
  );
}

/** Faint DUKC go/marginal/no-go shading across a berth row's plot area. */
function FeasibilityBand({
  transit,
  y,
  h,
  winStart,
  winEnd,
  hToMs,
  xOf,
}: {
  transit: PlannedTransit;
  y: number;
  h: number;
  winStart: number;
  winEnd: number;
  hToMs: (h: number) => number;
  xOf: (ts: number) => number;
}) {
  // Base the whole row as no-go, then paint the go/marginal windows over it so
  // gaps read as no-go without enumerating them.
  const x0 = xOf(winStart);
  const x1 = xOf(winEnd);
  return (
    <g style={{ pointerEvents: 'none' }}>
      <rect x={x0} y={y} width={x1 - x0} height={h} fill={windowFill('noGo')} />
      {transit.windows.map((w, i) => {
        const a = Math.max(winStart, hToMs(w.fromH));
        const b = Math.min(winEnd, hToMs(w.toH));
        if (b <= a) return null;
        const xa = xOf(a);
        const xb = xOf(b);
        return (
          <rect
            key={i}
            x={xa}
            y={y}
            width={Math.max(1, xb - xa)}
            height={h}
            fill={windowFill(w.status === 'marginal' ? 'marginal' : 'go')}
          />
        );
      })}
    </g>
  );
}

function LegendSwatch({ color, label, border }: { color: string; label: string; border?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span
        style={{
          width: 14,
          height: 10,
          background: color,
          borderRadius: 2,
          border: border ? `1px solid ${tokens.border}` : 'none',
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  );
}
