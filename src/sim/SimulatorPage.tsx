/**
 * SimulatorPage — the standalone "control room" for the JNPA twin, reached at
 * `#/simulator` (its own tab). It is the PoC_1 analogue of PoC_2's Simulator
 * page: an operator drives the clock plus four families of controls —
 *
 *   • Vessel & berth data  (spawn/force vessels, force per-berth status)
 *   • Port craft           (take specific pilots/tugs/mooring gangs offline)
 *   • KPI metrics          (nudge each headline KPI directly)
 *   • Environment levers    (weather, tide, channel depth, pilots/tugs down…)
 *
 * — each writing into `useSimStore`. State is mirrored across tabs by the store's
 * BroadcastChannel, and the main dashboard tab (`#/`) reflects every change live
 * through `SimAdapter`. Nothing here draws the map/dashboard itself; it is purely
 * the control surface, so it stays light and can run beside the dashboard.
 *
 * The controls reference REAL asset ids (berths, craft) loaded from the adapter,
 * exactly like the data forms, so what the operator drives matches the data.
 */
import { useEffect } from 'react';
import {
  CalciteButton,
  CalciteChip,
  CalciteLabel,
  CalciteNotice,
  CalciteSegmentedControl,
  CalciteSegmentedControlItem,
  CalciteSlider,
} from '@esri/calcite-components-react';
import { getAdapter } from '@/data';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import {
  useSimStore,
  connectSimBroadcast,
  hasOverrides,
  hasDataOverrides,
  type BerthStatusOverride,
  type KpiDeltas,
  type SimLevers,
} from '@/sim/simStore';
import { useSimClock } from '@/sim/useSimClock';
import { SCENARIOS } from '@/sim/scenarios';
import { KPI_TARGETS } from '@/config/targets';
import type { Berth, PortCraftUnit } from '@/types/domain';
import type { KpiBundle } from '@/types/kpi';
import { tokens } from '@/theme/tokens';

/* ── shared bits ───────────────────────────────────────────────────────── */

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section
      style={{
        background: tokens.panel,
        border: `1px solid ${tokens.border}`,
        borderRadius: 10,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: tokens.text }}>{title}</h2>
        {hint && <p style={{ margin: '4px 0 0', fontSize: 11.5, color: tokens.textMuted }}>{hint}</p>}
      </div>
      {children}
    </section>
  );
}

interface SliderRow {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Integer scale so Calcite stays on whole ticks (value = raw / scale). */
  scale?: number;
  unit?: string;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}

function Slider({ label, value, min, max, step, scale = 1, unit, onChange, fmt }: SliderRow) {
  const shown = fmt ? fmt(value) : `${value}${unit ? ` ${unit}` : ''}`;
  return (
    <CalciteLabel scale="s" style={{ '--calcite-label-margin-bottom': '0.5rem' } as React.CSSProperties}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2 }}>
        <span style={{ fontSize: 12, color: tokens.text }}>{label}</span>
        <span style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: tokens.accent }}>{shown}</span>
      </div>
      <CalciteSlider
        min={min * scale}
        max={max * scale}
        step={step * scale}
        value={value * scale}
        snap
        onCalciteSliderInput={(e) => {
          const raw = (e.target as unknown as { value: number }).value;
          onChange(Number((raw / scale).toFixed(4)));
        }}
      />
    </CalciteLabel>
  );
}

function fmtSimClock(clockH: number): string {
  const day = Math.floor(clockH / 24);
  const h = Math.floor(clockH % 24);
  const m = Math.floor((clockH % 1) * 60);
  return `Day ${day} · ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const BERTH_STATUS_OPTIONS: (BerthStatusOverride | 'auto')[] = ['auto', 'available', 'occupied', 'reserved', 'maintenance'];

/* ── page ──────────────────────────────────────────────────────────────── */

export function SimulatorPage() {
  // Standalone tab: run the clock + cross-tab broadcast here too, and restore.
  useEffect(() => {
    useSimStore.getState().restore();
    return connectSimBroadcast();
  }, []);
  useSimClock();

  const s = useSimStore();
  const simVersion = s.version;

  const berthsQ = useAdapterQuery<Berth[]>(() => getAdapter().getBerths(), []);
  const craftQ = useAdapterQuery<PortCraftUnit[]>(() => getAdapter().getPortCraft(), [simVersion]);
  // Live KPI preview so the operator sees the effect of their nudges immediately.
  const kpiQ = useAdapterQuery<KpiBundle>(() => getAdapter().getKPIs(), [simVersion]);

  const dirty = hasOverrides(s.levers) || hasDataOverrides(s.overrides);

  return (
    <div style={{ minHeight: '100vh', background: tokens.bg, color: tokens.text }}>
      {/* Header / transport */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 5,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
          padding: '12px 20px',
          background: tokens.panel,
          borderBottom: `1px solid ${tokens.border}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <strong style={{ fontSize: 16 }}>JNPA · Simulator Control Room</strong>
          <span style={{ fontSize: 12, color: tokens.textMuted }}>Use Case 1 · drives the dashboard tab live</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {dirty && (
            <CalciteChip scale="s" kind="brand" icon="lightning">
              Overrides active
            </CalciteChip>
          )}
          <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, color: tokens.textMuted }}>
            {fmtSimClock(s.clockH)} · seed {s.seed}
          </span>
          <CalciteButton
            scale="s"
            kind="brand"
            iconStart={s.running ? 'pause' : 'play'}
            onClick={() => s.setRunning(!s.running)}
          >
            {s.running ? 'Pause' : 'Run'}
          </CalciteButton>
          <CalciteSegmentedControl
            scale="s"
            width="auto"
            onCalciteSegmentedControlChange={(e) =>
              s.setRate(Number((e.target as unknown as { value: string }).value))
            }
          >
            {[0.25, 0.5, 1, 2].map((r) => (
              <CalciteSegmentedControlItem key={r} value={String(r)} checked={s.rate === r}>
                {r}×
              </CalciteSegmentedControlItem>
            ))}
          </CalciteSegmentedControl>
          <CalciteButton
            scale="s"
            appearance="outline"
            kind="neutral"
            iconStart="reset"
            disabled={!dirty}
            onClick={() => s.resetAll()}
          >
            Reset all
          </CalciteButton>
          <CalciteButton scale="s" appearance="outline" iconStart="launch" onClick={() => window.open('#/', '_blank')}>
            Open dashboard
          </CalciteButton>
        </div>
      </header>

      <div style={{ padding: 20, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, alignItems: 'start' }}>
        {/* One-click scenarios */}
        <Section title="Scenarios" hint="One-click scripted runs load a lever set and start the clock. Every effect is SIMULATED under stated assumptions.">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {SCENARIOS.map((sc) => (
              <div key={sc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                    {sc.code} · {sc.title}
                  </div>
                  <div style={{ fontSize: 11, color: tokens.textMuted, overflow: 'hidden', textOverflow: 'ellipsis' }}>{sc.summary}</div>
                </div>
                <CalciteButton
                  scale="s"
                  appearance={s.scenarioId === sc.id ? 'solid' : 'outline'}
                  kind="brand"
                  onClick={() => {
                    s.loadScenario(sc.id, { ...s.levers, ...sc.levers } as SimLevers);
                    s.setRunning(true);
                  }}
                >
                  {s.scenarioId === sc.id ? 'Active' : 'Load'}
                </CalciteButton>
              </div>
            ))}
          </div>
        </Section>

        {/* Vessel & berth data */}
        <Section title="Vessel & berth data" hint="Inject contacts and flood the anchorage / approach; force a specific berth's status. Shows on the 3D scene + berth panels.">
          <Slider label="Spawn vessels (extra contacts)" value={s.overrides.spawnVessels} min={0} max={20} step={1} onChange={(v) => s.setOverrides({ spawnVessels: v })} />
          <Slider label="Force anchored" value={s.overrides.forceAnchored} min={0} max={12} step={1} onChange={(v) => s.setOverrides({ forceAnchored: v })} />
          <Slider label="Force approaching" value={s.overrides.forceApproaching} min={0} max={12} step={1} onChange={(v) => s.setOverrides({ forceApproaching: v })} />

          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 12, color: tokens.text, marginBottom: 6 }}>Berth status override</div>
            {berthsQ.loading && <span style={{ fontSize: 11.5, color: tokens.textMuted }}>Loading berths…</span>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 240, overflow: 'auto' }}>
              {(berthsQ.data ?? []).map((b) => {
                const cur = s.overrides.berthStatus[b.BERTH_ID] ?? 'auto';
                return (
                  <div key={b.BERTH_ID} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 11.5, whiteSpace: 'nowrap' }} title={b.BERTH_NAME}>
                      {b.BERTH_ID}
                    </span>
                    <CalciteSegmentedControl
                      scale="s"
                      width="auto"
                      onCalciteSegmentedControlChange={(e) => {
                        const v = (e.target as unknown as { value: BerthStatusOverride | 'auto' }).value;
                        s.setBerthStatus(b.BERTH_ID, v === 'auto' ? null : v);
                      }}
                    >
                      {BERTH_STATUS_OPTIONS.map((opt) => (
                        <CalciteSegmentedControlItem key={opt} value={opt} checked={cur === opt}>
                          {opt === 'auto' ? 'auto' : opt[0].toUpperCase()}
                        </CalciteSegmentedControlItem>
                      ))}
                    </CalciteSegmentedControl>
                  </div>
                );
              })}
            </div>
          </div>
        </Section>

        {/* Port craft */}
        <Section title="Port craft & resources" hint="Take specific pilots, tugs or mooring gangs out of service. Reduces the serviceable pool on the Port Craft board.">
          {craftQ.loading && <span style={{ fontSize: 11.5, color: tokens.textMuted }}>Loading craft…</span>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(craftQ.data ?? []).map((c) => {
              const out = s.overrides.craftOut.includes(c.CRAFT_ID);
              return (
                <CalciteChip
                  key={c.CRAFT_ID}
                  scale="s"
                  kind={out ? 'inverse' : 'neutral'}
                  icon={out ? 'x-circle' : c.TYPE === 'pilot' ? 'user' : c.TYPE === 'tug' ? 'anchor' : 'link'}
                  style={{ cursor: 'pointer' }}
                  onClick={() => s.toggleCraftOut(c.CRAFT_ID)}
                  title={`${c.TYPE} · ${out ? 'forced out of service' : c.STATUS} — click to toggle`}
                >
                  {c.CRAFT_ID}
                </CalciteChip>
              );
            })}
          </div>
          <span style={{ fontSize: 11, color: tokens.textMuted }}>
            {s.overrides.craftOut.length} craft forced out of service
          </span>
        </Section>

        {/* KPI metrics */}
        <Section title="KPI metrics" hint="Nudge each headline KPI directly. The KPI strip + trend charts on the dashboard move in lock-step. Framed as a staged demo value, not a claimed baseline.">
          {(Object.keys(KPI_TARGETS) as (keyof typeof KPI_TARGETS)[])
            .filter((k) => k in s.overrides.kpiDeltas)
            .map((k) => {
              const t = KPI_TARGETS[k];
              const key = k as keyof KpiDeltas;
              const isPct = t.unit === '%';
              return (
                <Slider
                  key={k}
                  label={`${t.label} Δ`}
                  value={s.overrides.kpiDeltas[key]}
                  min={isPct ? -40 : -12}
                  max={isPct ? 40 : 12}
                  step={isPct ? 1 : 0.5}
                  scale={isPct ? 1 : 2}
                  onChange={(v) => s.setKpiDelta(key, v)}
                  fmt={(v) => `${v > 0 ? '+' : ''}${v}${t.unit ? ` ${t.unit}` : ''}`}
                />
              );
            })}
          <KpiPreview kpis={kpiQ.data} />
        </Section>

        {/* Environment levers */}
        <Section title="Environment levers" hint="The What-If causes: weather, tide, channel depth and roster shortfalls. Drive DUKC windows, pilotage suspension and JIT slip.">
          <EnvironmentLevers />
        </Section>
      </div>
    </div>
  );
}

/* ── sub-panels ────────────────────────────────────────────────────────── */

function KpiPreview({ kpis }: { kpis: KpiBundle | null }) {
  if (!kpis) return null;
  const rows: [string, string][] = [
    ['Pre-berth delay', `${kpis.preBerthingDelay.value} h`],
    ['Avg TAT', `${kpis.avgTat.value} h`],
    ['Just-in-time', `${kpis.jitPct.value} %`],
    ['Forecast acc.', `${kpis.forecastAccuracy.value} %`],
    ['Berth occ.', `${kpis.berthOccupancy.value} %`],
  ];
  return (
    <div style={{ marginTop: 4, borderTop: `1px solid ${tokens.border}`, paddingTop: 8 }}>
      <div style={{ fontSize: 11, color: tokens.textMuted, marginBottom: 6 }}>Live KPI preview (overlaid)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px' }}>
        {rows.map(([label, val]) => (
          <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}>
            <span style={{ color: tokens.textMuted }}>{label}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{val}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface LeverSpec {
  key: keyof Pick<SimLevers, 'weatherSeverity' | 'tideOffsetM' | 'channelDepthDeltaM' | 'pilotsDown' | 'tugsDown' | 'extraArrivals'>;
  label: string;
  min: number;
  max: number;
  step: number;
  scale: number;
  unit?: string;
  fmt?: (v: number) => string;
}

const LEVERS: LeverSpec[] = [
  { key: 'weatherSeverity', label: 'Weather severity', min: 0, max: 1, step: 0.05, scale: 100, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'tideOffsetM', label: 'Tide offset', min: -2, max: 2, step: 0.1, scale: 10, unit: 'm' },
  { key: 'channelDepthDeltaM', label: 'Channel depth delta', min: -1, max: 1, step: 0.1, scale: 10, unit: 'm' },
  { key: 'pilotsDown', label: 'Pilots unavailable', min: 0, max: 4, step: 1, scale: 1 },
  { key: 'tugsDown', label: 'Tugs unavailable', min: 0, max: 4, step: 1, scale: 1 },
  { key: 'extraArrivals', label: 'Extra arrivals (bunching)', min: 0, max: 8, step: 1, scale: 1 },
];

function EnvironmentLevers() {
  const levers = useSimStore((s) => s.levers);
  const setLevers = useSimStore((s) => s.setLevers);
  const dirty = hasOverrides(levers);
  return (
    <>
      {LEVERS.map((spec) => (
        <Slider
          key={spec.key}
          label={spec.label}
          value={levers[spec.key]}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          scale={spec.scale}
          unit={spec.unit}
          fmt={spec.fmt}
          onChange={(v) => setLevers({ [spec.key]: v })}
        />
      ))}
      {dirty && (
        <CalciteNotice open scale="s" kind="brand" icon="information">
          <div slot="message">Levers are perturbing the twin — the dashboard reflects the simulated state.</div>
        </CalciteNotice>
      )}
    </>
  );
}
