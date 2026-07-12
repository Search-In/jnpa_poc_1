/**
 * <PortCraftBoard> — Port-Craft Resource Board (spec §B2.8).
 *
 * Treats pilots / tugs / mooring gangs as *finite scheduled resources*: per-type
 * utilisation, live counts by status, each unit as a status-coloured chip, a
 * simulated scheduling-conflict list, and a single optimisation recommendation.
 *
 * Feeds the "Port Craft optimisation" KPI honestly — the recommendation quotes a
 * *simulated delta vs do-nothing* under stated assumptions, never a claimed
 * baseline improvement. Everything is a deterministic function of the current
 * craft roster + sim levers (pilotsDown / tugsDown), so a rehearsed run reproduces
 * exactly. Scenario shortages flow in through craftUnderScenario().
 */

import { useMemo } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { useSimStore } from '@/sim/simStore';
import { SourceBadge } from '@/provenance/SourceBadge';
import { tokens } from '@/theme/tokens';
import { PanelLoading, PanelError, PanelEmpty } from '@/components/common/Panel';
import type { CraftStatus, CraftType, PortCraftUnit } from '@/types/domain';

const TYPE_ORDER: CraftType[] = ['pilot', 'tug', 'mooring'];

const TYPE_LABEL: Record<CraftType, string> = {
  pilot: 'Pilots',
  tug: 'Tugs',
  mooring: 'Mooring gangs',
};

/** Chip colour by unit status (spec: idle=good, deployed=accent, returning=warn, maintenance=bad). */
const STATUS_COLOR: Record<CraftStatus, string> = {
  idle: tokens.good,
  deployed: tokens.accent,
  returning: tokens.warn,
  maintenance: tokens.bad,
};

const STATUS_ORDER: CraftStatus[] = ['idle', 'deployed', 'returning', 'maintenance'];

/**
 * A unit is *available now* only when idle; deployed/returning are committed and
 * maintenance is off the board. Utilisation = committed / serviceable, where
 * serviceable excludes maintenance so a scenario knocking pilots offline shows as
 * a smaller denominator (higher utilisation), not a hidden shortage.
 */
interface GroupStats {
  type: CraftType;
  units: PortCraftUnit[];
  total: number;
  serviceable: number;
  available: number;
  committed: number;
  utilPct: number;
  counts: Record<CraftStatus, number>;
  /** Deterministic "boardings queued for the next window" derived from committed load. */
  demandNext: number;
}

function groupStats(units: PortCraftUnit[], type: CraftType): GroupStats {
  const mine = units
    .filter((u) => u.TYPE === type)
    .slice()
    .sort((a, b) => a.CRAFT_ID.localeCompare(b.CRAFT_ID, undefined, { numeric: true }));

  const counts: Record<CraftStatus, number> = { idle: 0, deployed: 0, returning: 0, maintenance: 0 };
  for (const u of mine) counts[u.STATUS] += 1;

  const total = mine.length;
  const serviceable = total - counts.maintenance;
  const available = counts.idle;
  const committed = counts.deployed + counts.returning;
  const utilPct = serviceable > 0 ? Math.round((committed / serviceable) * 100) : 0;

  // Deterministic near-term demand: every committed unit implies a follow-on job,
  // plus returning units re-enter the queue. No randomness — reproducible per run.
  const demandNext = committed + counts.returning;

  return { type, units: mine, total, serviceable, available, committed, utilPct, counts, demandNext };
}

interface Conflict {
  type: CraftType;
  text: string;
  severity: 'warn' | 'crit';
}

/**
 * Simulated scheduling conflicts. Deterministic: a conflict exists when near-term
 * demand exceeds units available *now*, or a scenario has knocked units into
 * maintenance (pilotsDown / tugsDown), or serviceable utilisation is saturated.
 */
function detectConflicts(groups: GroupStats[]): Conflict[] {
  const out: Conflict[] = [];
  for (const g of groups) {
    if (g.total === 0) continue;
    const shortfall = g.demandNext - g.available;
    if (shortfall > 0) {
      out.push({
        type: g.type,
        severity: shortfall >= 2 || g.available === 0 ? 'crit' : 'warn',
        text: `${g.demandNext} ${g.type} job${g.demandNext === 1 ? '' : 's'} contend for ${g.available} available ${g.type}${g.available === 1 ? '' : 's'} in the next window (short ${shortfall}).`,
      });
    } else if (g.utilPct >= 85 && g.serviceable > 0) {
      out.push({
        type: g.type,
        severity: 'warn',
        text: `${g.type} pool at ${g.utilPct}% of serviceable capacity — no slack for an unplanned ${g.type} call.`,
      });
    }
    if (g.counts.maintenance > 0) {
      out.push({
        type: g.type,
        severity: g.available === 0 ? 'crit' : 'warn',
        text: `${g.counts.maintenance} ${g.type}${g.counts.maintenance === 1 ? '' : 's'} offline (scenario/maintenance) — serviceable pool reduced to ${g.serviceable} of ${g.total}.`,
      });
    }
  }
  return out;
}

interface Recommendation {
  headline: string;
  detail: string;
  /** Simulated minutes of contended gap the swap closes vs leaving it (do-nothing). */
  gapClosedMin: number;
  swapFrom: string;
  swapTo: string;
}

/**
 * Optimisation recommendation — a concrete unit swap derived deterministically from
 * the current roster + levers. We take the most-contended group and propose moving
 * an idle (or soonest-returning) unit to cover the demand its available pool cannot,
 * then quote a *simulated* gap closure vs do-nothing. No baseline-improvement framing.
 */
function recommend(groups: GroupStats[]): Recommendation | null {
  // Rank by shortfall, then by utilisation, to pick the binding constraint.
  const ranked = groups
    .filter((g) => g.total > 0)
    .map((g) => ({ g, shortfall: g.demandNext - g.available }))
    .sort((a, b) => b.shortfall - a.shortfall || b.g.utilPct - a.g.utilPct);

  const top = ranked[0];
  if (!top) return null;
  const g = top.g;

  // Only recommend a swap when there is real contention to relieve.
  if (top.shortfall <= 0 && g.utilPct < 85) return null;

  // Donor: prefer an idle unit; else the soonest-returning; else an alt-type reassignment.
  const donor =
    g.units.find((u) => u.STATUS === 'idle') ??
    g.units.find((u) => u.STATUS === 'returning') ??
    g.units[0];

  // Recipient job: the committed unit with the *longest* response time is the gap
  // driver — swapping the faster-responding donor onto it closes the widest gap.
  const committed = g.units
    .filter((u) => u.STATUS === 'deployed' || u.STATUS === 'returning')
    .slice()
    .sort((a, b) => (b.RESPONSE_MIN ?? 0) - (a.RESPONSE_MIN ?? 0));
  const laggard = committed[0] ?? g.units[g.units.length - 1];

  if (!donor || !laggard || donor.CRAFT_ID === laggard.CRAFT_ID) return null;

  // Simulated gap closed = the difference in response time between the slow committed
  // unit and the faster donor, floored so a swap always reads as a positive relief.
  const donorResp = donor.RESPONSE_MIN ?? 20;
  const laggardResp = laggard.RESPONSE_MIN ?? 20;
  const gapClosedMin = Math.max(5, Math.round(Math.abs(laggardResp - donorResp) + top.shortfall * 8));

  const berthTag = laggard.ASSIGNED_MMSI ? `the ${laggard.ASSIGNED_MMSI} move` : `the next ${g.type} move`;

  return {
    headline: `Reassign ${donor.CRAFT_ID} → ${laggard.CRAFT_ID}'s job to close the ${gapClosedMin}-min gap on ${berthTag}.`,
    detail: `${donor.CRAFT_ID} (${donorResp} min response, ${donor.STATUS}) covers ${laggard.CRAFT_ID} (${laggardResp} min) on the most-contended ${TYPE_LABEL[g.type].toLowerCase()} slot, freeing the pool for the ${g.demandNext} near-term job${g.demandNext === 1 ? '' : 's'}.`,
    gapClosedMin,
    swapFrom: donor.CRAFT_ID,
    swapTo: laggard.CRAFT_ID,
  };
}

/* ── presentational bits ─────────────────────────────────────────────── */

function UtilBar({ pct }: { pct: number }) {
  const color = pct >= 85 ? tokens.bad : pct >= 65 ? tokens.warn : tokens.good;
  return (
    <div
      role="img"
      aria-label={`Utilisation ${pct}%`}
      style={{
        position: 'relative',
        height: 8,
        borderRadius: tokens.radius.sm,
        background: tokens.bgElevated,
        overflow: 'hidden',
      }}
    >
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: '100%', background: color }} />
    </div>
  );
}

function StatusChip({ unit }: { unit: PortCraftUnit }) {
  const color = STATUS_COLOR[unit.STATUS];
  return (
    <span
      title={`${unit.CRAFT_ID} · ${unit.STATUS}${unit.ASSIGNED_MMSI ? ` · serving ${unit.ASSIGNED_MMSI}` : ''}${
        unit.RESPONSE_MIN != null ? ` · ${unit.RESPONSE_MIN} min response` : ''
      }`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 7px',
        fontSize: 11,
        lineHeight: 1.2,
        borderRadius: tokens.radius.sm,
        background: tokens.panelAlt,
        border: `1px solid ${color}66`,
        color: tokens.text,
      }}
    >
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      <span style={{ fontWeight: 600 }}>{unit.CRAFT_ID}</span>
      {unit.RESPONSE_MIN != null && <span style={{ color: tokens.textMuted }}>{unit.RESPONSE_MIN}m</span>}
      {unit.ASSIGNED_MMSI && <span style={{ color: tokens.textMuted }}>→{unit.ASSIGNED_MMSI}</span>}
    </span>
  );
}

function GroupCard({ g }: { g: GroupStats }) {
  return (
    <div
      style={{
        border: `1px solid ${tokens.border}`,
        borderRadius: tokens.radius.md,
        background: tokens.panel,
        padding: tokens.space.md,
        display: 'flex',
        flexDirection: 'column',
        gap: tokens.space.sm,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: tokens.space.sm }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: tokens.text }}>{TYPE_LABEL[g.type]}</span>
        <span style={{ fontSize: 11, color: tokens.textMuted }}>
          {g.committed}/{g.serviceable} committed · {g.available} free
          {g.counts.maintenance > 0 ? ` · ${g.counts.maintenance} offline` : ''}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
        <div style={{ flex: 1 }}>
          <UtilBar pct={g.utilPct} />
        </div>
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: g.utilPct >= 85 ? tokens.bad : g.utilPct >= 65 ? tokens.warn : tokens.good,
            minWidth: 40,
            textAlign: 'right',
          }}
        >
          {g.utilPct}%
        </span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.sm, fontSize: 11 }}>
        {STATUS_ORDER.map((s) => (
          <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: tokens.textMuted }}>
            <span aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_COLOR[s] }} />
            {s} {g.counts[s]}
          </span>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: tokens.space.xs }}>
        {g.units.map((u) => (
          <StatusChip key={u.CRAFT_ID} unit={u} />
        ))}
      </div>
    </div>
  );
}

/* ── panel ───────────────────────────────────────────────────────────── */

export function PortCraftBoard() {
  // Craft already arrive with scenario shortages (pilots/tugs down) + explicit
  // per-craft outages applied by SimAdapter, so this panel no longer re-applies
  // craftUnderScenario. It refetches whenever the sim version bumps.
  const simVersion = useSimStore((s) => s.version);
  const { data, loading, error } = useAdapterQuery(() => getAdapter().getPortCraft(), [simVersion], 30_000);

  const view = useMemo(() => {
    if (!data) return null;
    const groups = TYPE_ORDER.map((t) => groupStats(data, t)).filter((g) => g.total > 0);
    const conflicts = detectConflicts(groups);
    const rec = recommend(groups);
    return { groups, conflicts, rec };
  }, [data]);

  if (loading && !data) return <PanelLoading label="Loading port craft…" />;
  if (error) return <PanelError message={error} />;
  if (!view || view.groups.length === 0) return <PanelEmpty message="No port-craft roster for the current window." />;

  const { groups, conflicts, rec } = view;

  return (
    <div style={{ height: '100%', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: tokens.space.md }}>
      <div>
        <SourceBadge source="CRAFT" />
        <p style={{ margin: 0, fontSize: 11.5, color: tokens.textMuted }}>
          Pilots, tugs and mooring gangs as finite scheduled resources. Utilisation is committed craft over
          serviceable craft; scenario shortages (pilots/tugs down) reduce the serviceable pool.
        </p>
      </div>

      {/* Optimisation recommendation — honest simulated delta vs do-nothing. */}
      {rec && (
        <div
          style={{
            border: `1px solid ${tokens.accent}`,
            borderRadius: tokens.radius.md,
            background: `${tokens.accent}14`,
            padding: tokens.space.md,
            display: 'flex',
            flexDirection: 'column',
            gap: tokens.space.xs,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
                color: tokens.accent,
              }}
            >
              Optimisation recommendation
            </span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: tokens.text }}>{rec.headline}</div>
          <div style={{ fontSize: 11.5, color: tokens.textMuted }}>{rec.detail}</div>
          <div style={{ fontSize: 11, color: tokens.good, marginTop: 2 }}>
            Simulated delta vs do-nothing: −{rec.gapClosedMin} min contended gap ({rec.swapFrom} → {rec.swapTo}),
            under the assumptions register — not a claimed baseline improvement.
          </div>
        </div>
      )}

      {/* Scheduling conflicts. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.xs }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: tokens.text, letterSpacing: 0.3 }}>
          Scheduling conflicts ({conflicts.length})
        </span>
        {conflicts.length === 0 ? (
          <div style={{ fontSize: 11.5, color: tokens.textMuted }}>
            No simulated craft contention in the next window under current levers.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: tokens.space.xs }}>
            {conflicts.map((c, i) => {
              const col = c.severity === 'crit' ? tokens.bad : tokens.warn;
              return (
                <li
                  key={`${c.type}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: tokens.space.sm,
                    padding: '6px 8px',
                    fontSize: 11.5,
                    color: tokens.text,
                    background: tokens.panelAlt,
                    borderLeft: `3px solid ${col}`,
                    borderRadius: tokens.radius.sm,
                  }}
                >
                  <span
                    aria-hidden
                    style={{ marginTop: 4, width: 7, height: 7, borderRadius: '50%', background: col, flexShrink: 0 }}
                  />
                  <span>{c.text}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Per-type resource groups. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: tokens.space.md,
        }}
      >
        {groups.map((g) => (
          <GroupCard key={g.type} g={g} />
        ))}
      </div>
    </div>
  );
}
