/**
 * SimControls — the header sim-clock transport (spec §B1.4). Run / pause the
 * shared demo clock, reset it, and read the sim time + horizon. The clock drives
 * every live panel (map, KPIs, DUKC windows, gantt, convergence). A fixed demo
 * seed is shown so the run is visibly reproducible.
 */
import { CalciteButton, CalciteChip } from '@esri/calcite-components-react';
import { useSimStore, hasOverrides } from './simStore';
import { tokens } from '@/theme/tokens';

function fmtSimClock(clockH: number): string {
  const day = Math.floor(clockH / 24);
  const h = Math.floor(clockH % 24);
  const m = Math.floor((clockH % 1) * 60);
  return `D${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function SimControls() {
  const running = useSimStore((s) => s.running);
  const clockH = useSimStore((s) => s.clockH);
  const seed = useSimStore((s) => s.seed);
  const levers = useSimStore((s) => s.levers);
  const setRunning = useSimStore((s) => s.setRunning);

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <CalciteButton
        scale="s"
        appearance="solid"
        kind="brand"
        iconStart={running ? 'pause' : 'play'}
        onClick={() => setRunning(!running)}
        title={running ? 'Pause the sim clock' : 'Run the sim clock'}
      >
        {running ? 'Pause' : 'Run sim'}
      </CalciteButton>
      <span
        style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, color: tokens.text }}
        title="Simulated time (day + hour)"
      >
        sim {fmtSimClock(clockH)}
      </span>
      {hasOverrides(levers) && (
        <CalciteChip scale="s" kind="brand" icon="lightning">
          Scenario active
        </CalciteChip>
      )}
      <span style={{ fontSize: 11, color: tokens.textMuted }} title="Fixed demo seed — the run is reproducible">
        seed {seed}
      </span>
    </div>
  );
}
