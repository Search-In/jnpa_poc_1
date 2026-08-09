/**
 * <PortCraftDemandStrip> — the Port Craft Overview summary: fleet capacity, then live
 * craft DEMAND as KPI cards.
 *
 * Additive only. It renders nothing of its own when the endpoint does not answer, so
 * <PortCraftOverview> falls back to exactly the page it showed before.
 *
 * EVERY VALUE IS BACKEND-SUPPLIED. Fleet counts come from core.port_craft; the demand
 * counts come from the Marine Projection via /api/marine/state/port-craft. Nothing is
 * inferred, estimated or computed here — the card labels are presentation only, and the
 * numbers behind them are the phase counts the backend already reported.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW
 * ----------------------------------
 *   * no per-craft Busy/Available — core.port_craft has no state column;
 *   * no "craft X is serving vessel Y" — no column links a craft to a call;
 *   * no utilisation percentage — that needs a craft-per-movement ratio not in the data.
 *
 * SUMMARY ONLY. The vessels behind each count are listed once, on the Active Marine
 * Operations tab, so no vessel appears twice in this module.
 *
 * The axis is VESSEL → craft requirement, never craft → vessel. The caption says so,
 * because a count of 536 must not be read as "536 craft engaged".
 *
 * The card grid is the app's shared KPI idiom, identical to <MarineStatCards>,
 * <ShippingLinesSummaryCards> and <BerthingStats> — same padding, minHeight, type scale,
 * tabular numerals, auto-fit columns and gap. No new design language is introduced.
 */

import { type CSSProperties } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { useMarineStateVersion } from '@/data/uc3/marineStateBus';
import { fetchPortCraftDemand } from '@/data/uc3/portCraftState';
import { tokens } from '@/theme/tokens';

/** Refresh cadence matches <PortCraftBoard>, so the two panes never disagree on screen. */
const REFRESH_MS = 30_000;

const CHIP: CSSProperties = {
  display: 'inline-flex', alignItems: 'baseline', gap: 5,
  fontSize: 11.5, padding: '2px 8px', borderRadius: tokens.radius.sm,
  background: tokens.panel, border: `1px solid ${tokens.border}`, whiteSpace: 'nowrap',
};
const LABEL: CSSProperties = {
  fontSize: 10.5, letterSpacing: 0.4, textTransform: 'uppercase', color: tokens.textMuted,
};
const NUM: CSSProperties = { fontWeight: 700, fontVariantNumeric: 'tabular-nums' };

/** Fleet register chip — unchanged. */
function Chip({ label, value, title }: { label: string; value: number; title?: string }) {
  return (
    <span style={CHIP} title={title}>
      <span style={LABEL}>{label}</span>
      <span style={NUM}>{value.toLocaleString()}</span>
    </span>
  );
}

/** One KPI card — the shared app idiom, matching <MarineStatCards> exactly. */
function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div
      className="app-region"
      aria-label={label}
      style={{ padding: 12, minHeight: 84, background: tokens.panelAlt, borderRadius: tokens.radius.sm }}
    >
      <div style={{ fontSize: 11, color: tokens.textMuted, letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tokens.text, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      {hint && <div style={{ fontSize: 10.5, color: tokens.textMuted, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export function PortCraftDemandStrip() {
  // Resolves to null on any failure (see fetchPortCraftDemand), so a gateway outage
  // silently omits this summary instead of surfacing an error over the working board.
  // Refetch whenever a manual pilot/craft action changes backend lifecycle state.
  const marineVersion = useMarineStateVersion();
  const q = useAdapterQuery(() => fetchPortCraftDemand(), [marineVersion], REFRESH_MS);
  const d = q.data;
  if (!d) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
      {/* Fleet summary — unchanged. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span style={{ ...LABEL, fontWeight: 700 }}>Fleet</span>
        <Chip label="Total" value={d.fleetTotal} title="core.port_craft — the fleet register" />
        {d.fleetByType.map((t) => (
          <Chip key={t.craftType} label={t.craftType} value={t.count} />
        ))}
      </div>

      {/* Live demand. The labels are OPERATOR-FACING names for the same three phases the
          backend already reports — Inbound / Alongside / Outbound — and each value is that
          phase's count verbatim. No phase was merged, split, reordered or re-derived. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <StatCard
          label="Requiring marine support"
          value={d.totalDemand.toLocaleString()}
          hint={`of ${d.activeCalls.toLocaleString()} active calls`}
        />
        <StatCard
          label="Awaiting Berthing"
          value={d.inboundCount.toLocaleString()}
          hint="pilot aboard, not yet berthed"
        />
        <StatCard
          label="At Berth"
          value={d.alongsideCount.toLocaleString()}
          hint="berthed, not yet departed"
        />
        <StatCard
          label="Preparing Departure"
          value={d.outboundCount.toLocaleString()}
          hint="sailed, not yet cleared"
        />
      </div>

      {/* Load-bearing, not decoration: without it a count reads as "craft engaged". */}
      <p style={{ margin: 0, fontSize: 11, color: tokens.textMuted }}>
        Craft <strong>demand</strong> derived from the vessel lifecycle — the number of
        vessels requiring marine support, not the number of craft engaged. Individual
        craft assignment is not recorded, so no per-craft status is shown. Vessel-level
        detail is on the <strong>Active Marine Operations</strong> tab.
      </p>
    </div>
  );
}
