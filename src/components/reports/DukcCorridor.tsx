/**
 * <DukcCorridor> — the DUKC / RTUKC channel-clearance panel (spec §B2.9, §A7
 * kill-shot). Two deliberately distinct sub-sections that evaluators can tell
 * apart at a glance:
 *
 *  1. DUKC (predictive) — the passage-plan view. A seaward→quay channel-corridor
 *     strip colour-coded by projected UKC status, plus a per-transit UKC profile
 *     chart and the vessel's go/no-go tidal windows. This answers "when may this
 *     vessel transit?" ahead of time.
 *  2. RTUKC (live) — the real-time readout for a transit already in progress:
 *     current UKC recomputed each sim tick from the observed tide + squat at the
 *     vessel's speed. This answers "what is the clearance right now?".
 *
 * Both are computed from the same physical relation (available − required); the
 * UI makes them visibly different features so the predictive-vs-live distinction
 * is honest and obvious.
 */

import { useMemo, useState } from 'react';
import { Line } from 'react-chartjs-2';
import {
  CalciteSelect,
  CalciteOption,
  CalciteIcon,
} from '@esri/calcite-components-react';
import { ensureChartsRegistered, baseOptions } from '@/charts/setup';
import { tokens, ukcColor } from '@/theme/tokens';
import { useSimStore } from '@/sim/simStore';
import {
  corridorUkc,
  plannedTransits,
  tideNow,
  channelSegmentsClosed,
  type PlannedTransit,
} from '@/sim/derive';
import {
  computeUkc,
  UKC_SAFETY_MARGIN_M,
  UKC_MARGINAL_BAND_M,
  type UkcResult,
} from '@/dukc/ukc';
import { CHANNEL } from '@/map/portGeometry';
import { getAdapter } from '@/data';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { SourceBadge } from '@/provenance/SourceBadge';
import { useHighlightMatch } from '@/whatif/useHighlight';
import { PanelLoading, PanelError, PanelEmpty } from '../common/Panel';

ensureChartsRegistered();

/** Sim clock is hours-from-epoch; render as H:MM treating clock 0 as 00:00. */
function clockLabel(hoursFromEpoch: number): string {
  const total = ((hoursFromEpoch % 24) + 24) % 24;
  const h = Math.floor(total);
  const m = Math.round((total - h) * 60);
  const hh = m === 60 ? (h + 1) % 24 : h;
  const mm = m === 60 ? 0 : m;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function statusColor(status: UkcResult['status']): string {
  return status === 'go' ? ukcColor.go : status === 'marginal' ? ukcColor.marginal : ukcColor.noGo;
}


/** Small labelled figure used across both sub-sections. */
function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 10, color: tokens.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </span>
      <span style={{ fontSize: 12.5, color: tokens.text, fontVariantNumeric: 'tabular-nums' }}>
        {value}
        {unit ? <span style={{ color: tokens.textMuted, fontSize: 10.5 }}> {unit}</span> : null}
      </span>
    </div>
  );
}

export function DukcCorridor() {
  const clockH = useSimStore((s) => s.clockH);
  const levers = useSimStore((s) => s.levers);

  // What-if spotlight: ring the channel segment(s) the active scenario lights
  // (e.g. M2 CH-INNER), so the corridor strip and the map spotlight the same
  // stretch of channel.
  const hl = useHighlightMatch();

  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);

  const plan = useAdapterQuery(() => getAdapter().getBerthPlan(), []);

  // ---- Derived data (deterministic in clockH + levers) --------------------
  const transits = useMemo<PlannedTransit[]>(
    () => (plan.data ? plannedTransits(plan.data, levers) : []),
    [plan.data, levers],
  );

  // Default the profile chart to the deepest-draft (most tide-gated) call.
  const deepest = useMemo<PlannedTransit | null>(() => {
    if (!transits.length) return null;
    return transits.reduce((a, b) => (b.staticDraftM > a.staticDraftM ? b : a));
  }, [transits]);

  const selected = useMemo<PlannedTransit | null>(() => {
    if (!transits.length) return null;
    return transits.find((t) => t.planId === selectedPlanId) ?? deepest;
  }, [transits, selectedPlanId, deepest]);

  // Live corridor colouring at the current tide (re-derives every tick).
  const corridor = useMemo(() => corridorUkc(clockH, levers), [clockH, levers]);

  // Fairway segments closed by an active oil-spill incident (empty by default).
  // Only non-empty when the oil-spill lever/scenario (M7) is active — the corridor
  // marks these segments CLOSED and treats them as inactive (no-go), additively.
  const closed = useMemo(() => new Set(channelSegmentsClosed(levers)), [levers]);

  // Per-segment UKC profile for the SELECTED transit (its own draft/hull).
  const profile = useMemo(() => {
    if (!selected) return null;
    const tide = tideNow(clockH, levers);
    return CHANNEL.map((seg) =>
      computeUkc({
        staticDraftM: selected.staticDraftM,
        chartedDepthM: seg.chartedDepthM + levers.channelDepthDeltaM + (levers.dredgeRestoreM ?? 0),
        tideM: tide,
        speedKt: 8,
        blockCoef: selected.blockCoef,
      }),
    );
  }, [selected, clockH, levers]);

  const chart = useMemo(() => {
    if (!profile) return null;
    return {
      labels: CHANNEL.map((s) => s.name),
      datasets: [
        {
          label: 'UKC (available − required)',
          data: profile.map((p) => p.ukcM),
          borderColor: tokens.accent,
          backgroundColor: `${tokens.accent}22`,
          fill: true,
          tension: 0.25,
          pointRadius: 4,
          pointBackgroundColor: profile.map((p) => statusColor(p.status)),
          pointBorderColor: profile.map((p) => statusColor(p.status)),
        },
        {
          label: `Safety margin (${UKC_SAFETY_MARGIN_M.toFixed(1)} m)`,
          data: CHANNEL.map(() => UKC_SAFETY_MARGIN_M),
          borderColor: tokens.bad,
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
        {
          label: `Marginal band (${(UKC_SAFETY_MARGIN_M + UKC_MARGINAL_BAND_M).toFixed(1)} m)`,
          data: CHANNEL.map(() => UKC_SAFETY_MARGIN_M + UKC_MARGINAL_BAND_M),
          borderColor: tokens.warn,
          borderDash: [3, 3],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    };
  }, [profile]);

  const chartOptions = useMemo(() => {
    const base = baseOptions<'line'>();
    return {
      ...base,
      plugins: {
        ...base.plugins,
        legend: { display: true, labels: { boxWidth: 12, font: { size: 10 } } },
      },
      scales: {
        ...base.scales,
        y: {
          ...base.scales?.y,
          title: { display: true, text: 'UKC (m)', color: tokens.textMuted, font: { size: 10 } },
        },
      },
    };
  }, []);

  // ---- RTUKC: pick an in-progress transit ---------------------------------
  // Simplest robust source per spec: an *active* berth-plan entry. We colour its
  // live clearance from computeUkc at the current tide, keyed on clockH so it
  // updates every tick — the real-time counterpart to the predictive windows.
  const liveEntry = useMemo(() => {
    if (!plan.data) return null;
    const active = plan.data.find((p) => p.STATUS === 'active');
    return active ?? plan.data[0] ?? null;
  }, [plan.data]);

  const liveTransit = useMemo<PlannedTransit | null>(() => {
    if (!liveEntry) return null;
    return transits.find((t) => t.planId === liveEntry.PLAN_ID) ?? null;
  }, [liveEntry, transits]);

  const liveUkc = useMemo<UkcResult | null>(() => {
    if (!liveTransit) return null;
    const tide = tideNow(clockH, levers);
    // Live readout is taken at the controlling (shallowest transited) depth —
    // the pinch point that actually governs the vessel underway.
    const controlling = Math.min(...CHANNEL.map((s) => s.chartedDepthM + levers.channelDepthDeltaM + (levers.dredgeRestoreM ?? 0)));
    // Underway speed a touch faster than the planning speed → more squat live.
    return computeUkc({
      staticDraftM: liveTransit.staticDraftM,
      chartedDepthM: controlling,
      tideM: tide,
      speedKt: 9,
      blockCoef: liveTransit.blockCoef,
    });
  }, [liveTransit, clockH, levers]);

  // ---- States -------------------------------------------------------------
  if (plan.loading) return <PanelLoading label="Loading DUKC transits…" />;
  if (plan.error) return <PanelError message={plan.error} />;
  if (!transits.length) return <PanelEmpty message="No planned transits in the berthing plan." />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'auto', gap: tokens.space.lg }}>
      <SourceBadge source="TIDE" />

      {/* ================= 1. DUKC (predictive) ============================ */}
      <section aria-label="DUKC predictive corridor" style={{ display: 'flex', flexDirection: 'column', gap: tokens.space.sm }}>
        <header style={{ display: 'flex', alignItems: 'baseline', gap: tokens.space.sm }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: tokens.text, letterSpacing: 0.3 }}>
            DUKC · Predictive
          </span>
          <span style={{ fontSize: 10.5, color: tokens.textMuted }}>
            Passage-plan clearance projected across the channel · clock {clockLabel(clockH)}
          </span>
        </header>

        {/* Channel corridor strip, seaward → quay. */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
          {corridor.map(({ seg, ukcM, status, availableM, requiredM }) => {
            const lit = hl.has(seg.id);
            const dim = hl.any && !lit;
            // A closed segment (oil-spill incident) is inactive: shown greyed +
            // hatched with a CLOSED label, overriding the UKC status colour.
            const isClosed = closed.has(seg.id);
            const topColor = isClosed ? tokens.textMuted : statusColor(status);
            return (
            <div
              key={seg.id}
              title={`${seg.name} · available ${availableM} m · required ${requiredM} m${isClosed ? ' · CLOSED (marine incident — fairway secured)' : ''}${lit ? ' · spotlighted by the active scenario' : ''}`}
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                padding: '8px 6px',
                borderRadius: tokens.radius.sm,
                background: isClosed
                  ? `repeating-linear-gradient(45deg, ${tokens.panelAlt}, ${tokens.panelAlt} 6px, ${tokens.panel} 6px, ${tokens.panel} 12px)`
                  : lit ? `${tokens.accent}14` : tokens.panelAlt,
                opacity: isClosed ? 0.7 : dim ? 0.45 : 1,
                borderTop: `3px solid ${topColor}`,
                border: `1px solid ${lit ? tokens.accent : tokens.border}`,
                boxShadow: lit ? `0 0 0 1px ${tokens.accent}` : 'none',
                borderTopWidth: 3,
                borderTopColor: topColor,
                transition: 'opacity 120ms ease',
              }}
            >
              <span style={{ fontSize: 10.5, color: tokens.text, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {seg.name}
              </span>
              <span style={{ fontSize: 10, color: tokens.textMuted }}>charted {seg.chartedDepthM} m</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: isClosed ? tokens.textMuted : statusColor(status), fontVariantNumeric: 'tabular-nums' }}>
                {ukcM.toFixed(2)} m
              </span>
              <span style={{ fontSize: 9.5, color: isClosed ? tokens.warn : tokens.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: isClosed ? 700 : 400 }}>
                {isClosed ? '⛔ Closed' : `UKC · ${status === 'noGo' ? 'no-go' : status}`}
              </span>
            </div>
            );
          })}
        </div>
        <span style={{ fontSize: 10, color: tokens.textMuted }}>
          Seaward → quay. Cell colour = projected UKC status at the current tide for a {corridor.length ? '15.5 m' : ''} reference deep-draft transit.
        </span>

        {/* Transit picker. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: tokens.textMuted }}>Transit</span>
          <CalciteSelect
            label="Select planned transit"
            scale="s"
            value={selected?.planId ?? ''}
            onCalciteSelectChange={(e) => setSelectedPlanId(e.target.value)}
            style={{ minWidth: 260 }}
          >
            {transits.map((t) => (
              <CalciteOption key={t.planId} value={t.planId} selected={t.planId === selected?.planId}>
                {t.vesselName} · {t.terminal} · {t.staticDraftM.toFixed(1)} m draft
              </CalciteOption>
            ))}
          </CalciteSelect>
          {selected && selected.planId === deepest?.planId ? (
            <span style={{ fontSize: 10, color: tokens.textMuted }}>(deepest draft — most tide-gated)</span>
          ) : null}
        </div>

        {selected ? (
          <div style={{ display: 'flex', gap: tokens.space.lg, flexWrap: 'wrap' }}>
            <Stat label="Static draft" value={selected.staticDraftM.toFixed(1)} unit="m" />
            <Stat label="Block coef" value={selected.blockCoef.toFixed(2)} />
            <Stat label="Controlling depth" value={selected.controllingDepthM.toFixed(2)} unit="m" />
          </div>
        ) : null}

        {/* Per-transit UKC profile across the channel. */}
        <div style={{ height: 220, minHeight: 200 }}>
          {chart ? <Line data={chart} options={chartOptions} /> : null}
        </div>

        {/* Go / no-go tidal windows for the selected transit. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 10.5, color: tokens.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            Tidal windows (next 5 days)
          </span>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {selected && selected.windows.length ? (
              selected.windows.map((w, i) => (
                <span
                  key={`${w.fromH}-${i}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    fontSize: 11,
                    padding: '3px 8px',
                    borderRadius: tokens.radius.sm,
                    color: tokens.text,
                    background: tokens.panelAlt,
                    border: `1px solid ${w.status === 'go' ? ukcColor.go : ukcColor.marginal}`,
                  }}
                >
                  <span
                    aria-hidden
                    style={{ width: 8, height: 8, borderRadius: '50%', background: w.status === 'go' ? ukcColor.go : ukcColor.marginal }}
                  />
                  {w.status === 'go' ? 'Go' : 'Marginal'} {clockLabel(w.fromH)}–{clockLabel(w.toH)}
                </span>
              ))
            ) : (
              <span style={{ fontSize: 11, color: tokens.bad }}>No transit window in horizon at current channel depth/tide.</span>
            )}
          </div>
        </div>
      </section>

      {/* ================= 2. RTUKC (live) ================================= */}
      <section
        aria-label="RTUKC live readout"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: tokens.space.sm,
          padding: tokens.space.md,
          borderRadius: tokens.radius.md,
          background: tokens.bgElevated,
          border: `1px solid ${tokens.border}`,
        }}
      >
        <header style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
          <span
            aria-hidden
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: tokens.live,
              boxShadow: `0 0 0 3px ${tokens.live}33`,
            }}
          />
          <span style={{ fontSize: 12, fontWeight: 700, color: tokens.text, letterSpacing: 0.3 }}>
            RTUKC · Live
          </span>
          <span style={{ fontSize: 10.5, color: tokens.textMuted }}>
            measured tide + squat at position · updates each tick
          </span>
        </header>

        {liveTransit && liveUkc ? (
          <div style={{ display: 'flex', gap: tokens.space.xl, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 10.5, color: tokens.textMuted }}>
                {liveTransit.vesselName} · {liveTransit.terminal} · underway
              </span>
              <span
                style={{
                  fontSize: 40,
                  fontWeight: 800,
                  lineHeight: 1,
                  color: statusColor(liveUkc.status),
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {liveUkc.ukcM.toFixed(2)}
                <span style={{ fontSize: 15, color: tokens.textMuted, fontWeight: 600 }}> m</span>
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: statusColor(liveUkc.status), fontWeight: 600 }}>
                <CalciteIcon icon={liveUkc.status === 'noGo' ? 'exclamation-mark-triangle' : liveUkc.status === 'marginal' ? 'exclamation-mark-circle' : 'check-circle'} scale="s" />
                {liveUkc.status === 'noGo' ? 'NO-GO' : liveUkc.status === 'marginal' ? 'MARGINAL' : 'GO'} · current UKC
              </span>
            </div>

            <div style={{ display: 'flex', gap: tokens.space.lg, flexWrap: 'wrap' }}>
              <Stat label="Tide now" value={tideNow(clockH, levers).toFixed(2)} unit="m" />
              <Stat label="Available" value={liveUkc.availableM.toFixed(2)} unit="m" />
              <Stat label="Required" value={liveUkc.requiredM.toFixed(2)} unit="m" />
              <Stat label="Squat" value={liveUkc.squatM.toFixed(2)} unit="m" />
              <Stat label="At clock" value={clockLabel(clockH)} />
            </div>
          </div>
        ) : (
          <PanelEmpty message="No in-progress transit right now — RTUKC activates when a planned call goes active." />
        )}
      </section>

      {/* Honest DUKC-vs-RTUKC caption. */}
      <p style={{ fontSize: 10.5, color: tokens.textMuted, lineHeight: 1.5, margin: 0 }}>
        DUKC (predictive) projects go/no-go windows for a passage plan from the tide forecast and
        charted bathymetry; RTUKC (live) reports the clearance a vessel actually has right now from
        the observed tide and its measured squat — the same water-column relation, one forecast and
        one live. Figures are simulated under the stated tide/squat/margin assumptions. Inputs: tide
        (INCOIS-class), bathymetry (survey), AIS vessel state.
      </p>
    </div>
  );
}
