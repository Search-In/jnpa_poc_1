/**
 * <BerthingPlanGantt> — 24h gantt: berths (rows) × scheduled/actual windows
 * (bars), with a NOW line. Backed by getBerthPlan(). Custom SVG because Chart.js
 * has no native gantt. Planned windows render as outlined bars; actual windows
 * render as filled bars overlaid, so slippage is visible at a glance.
 */

import { useMemo } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import type { BerthingPlanEntry } from '@/types/domain';
import { tokens } from '@/theme/tokens';
import { istTime } from '@/util/format';
import { PanelEmpty, PanelError, PanelLoading } from '../common/Panel';

const H = 3_600_000;
const WINDOW_H = 24;

interface Lane {
  berthId: string;
  entries: BerthingPlanEntry[];
}

function groupByBerth(plan: BerthingPlanEntry[]): Lane[] {
  const map = new Map<string, BerthingPlanEntry[]>();
  for (const e of plan) {
    const list = map.get(e.BERTH_ID) ?? [];
    list.push(e);
    map.set(e.BERTH_ID, list);
  }
  return [...map.entries()]
    .map(([berthId, entries]) => ({ berthId, entries }))
    .sort((a, b) => a.berthId.localeCompare(b.berthId));
}

export function BerthingPlanGantt() {
  const now = Date.now();
  const winStart = now - 12 * H;
  const winEnd = now + 12 * H;

  const { data, loading, error } = useAdapterQuery(
    () => getAdapter().getBerthPlan({ from: winStart, to: winEnd }),
    [],
    30_000
  );

  const lanes = useMemo(() => groupByBerth(data ?? []), [data]);

  if (loading && !data) return <PanelLoading label="Loading berthing plan…" />;
  if (error) return <PanelError message={error} />;
  if (lanes.length === 0) return <PanelEmpty message="No berthing windows in the next 24h." />;

  const laneH = 30;
  const labelW = 80;
  const chartW = 720;
  const span = WINDOW_H * H;
  const xOf = (ts: number) => labelW + ((ts - winStart) / span) * (chartW - labelW);
  const wOf = (a: number, b: number) => ((b - a) / span) * (chartW - labelW);
  const nowX = xOf(now);
  const height = lanes.length * laneH + 28;

  return (
    <div style={{ overflowX: 'auto', height: '100%' }}>
      <svg width={chartW} height={height} role="img" aria-label="24-hour berthing plan gantt">
        {/* hour gridlines + labels every 4h */}
        {Array.from({ length: WINDOW_H / 4 + 1 }, (_, i) => {
          const ts = winStart + i * 4 * H;
          const x = xOf(ts);
          return (
            <g key={i}>
              <line x1={x} y1={20} x2={x} y2={height} stroke={tokens.border} strokeWidth={1} />
              <text x={x + 2} y={14} fontSize={9} fill={tokens.textMuted}>
                {istTime(ts)}
              </text>
            </g>
          );
        })}

        {lanes.map((lane, i) => {
          const y = 24 + i * laneH;
          return (
            <g key={lane.berthId}>
              <text x={4} y={y + laneH / 2 + 3} fontSize={11} fill={tokens.text} fontWeight={600}>
                {lane.berthId}
              </text>
              {lane.entries.map((e) => {
                const planX = xOf(e.PLANNED_START);
                const planW = Math.max(2, wOf(e.PLANNED_START, e.PLANNED_END));
                const actStart = e.ACTUAL_START;
                const actEnd = e.ACTUAL_END ?? now; // open windows run to NOW
                return (
                  <g key={e.PLAN_ID}>
                    {/* planned (outline) */}
                    <rect
                      x={planX}
                      y={y + 4}
                      width={planW}
                      height={laneH - 12}
                      fill="none"
                      stroke={tokens.accent}
                      strokeDasharray="3 2"
                      rx={2}
                    >
                      <title>{`${e.VESSEL_NAME} planned ${istTime(e.PLANNED_START)}–${istTime(e.PLANNED_END)}`}</title>
                    </rect>
                    {/* actual (filled) */}
                    {actStart !== null && (
                      <rect
                        x={xOf(actStart)}
                        y={y + 7}
                        width={Math.max(2, wOf(actStart, actEnd))}
                        height={laneH - 18}
                        fill={e.STATUS === 'active' ? tokens.good : tokens.accentDim}
                        rx={2}
                      >
                        <title>{`${e.VESSEL_NAME} actual ${istTime(actStart)}–${e.ACTUAL_END ? istTime(e.ACTUAL_END) : 'now'}`}</title>
                      </rect>
                    )}
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* NOW line */}
        <line x1={nowX} y1={20} x2={nowX} y2={height} stroke={tokens.bad} strokeWidth={1.5} />
        <text x={nowX + 2} y={height - 4} fontSize={9} fill={tokens.bad}>
          NOW
        </text>
      </svg>
      <div style={{ display: 'flex', gap: 16, fontSize: 10, color: tokens.textMuted, marginTop: 4 }}>
        <span>▭ planned</span>
        <span style={{ color: tokens.accentDim }}>▬ actual</span>
        <span style={{ color: tokens.good }}>▬ active</span>
      </div>
    </div>
  );
}
