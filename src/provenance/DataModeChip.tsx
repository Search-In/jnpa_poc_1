/**
 * DataModeChip — the persistent global provenance banner (spec §A3, mandatory
 * pre-flight gate). Always visible in the header. States the global DATA_MODE
 * (default SIMULATED, so no viewer can mistake the board for live JNPA data),
 * and flips to "SIMULATED · DEGRADED" whenever any source has been knocked off
 * its live feed. Clicking it opens the Integration Simulator Console.
 */
import { CalciteChip } from '@esri/calcite-components-react';
import { useDataModeStore, anyDegraded, worstState } from './useDataModeStore';
import { tokens } from '@/theme/tokens';

const MODE_LABEL: Record<string, string> = { SIM: 'SIMULATED', REPLAY: 'REPLAY', LIVE: 'LIVE' };

export function DataModeChip() {
  const mode = useDataModeStore((s) => s.mode);
  const sources = useDataModeStore((s) => s.sources);
  const setConsoleOpen = useDataModeStore((s) => s.setConsoleOpen);
  const degraded = anyDegraded(sources);
  const worst = worstState(sources);

  const base = MODE_LABEL[mode] ?? mode;
  const label = mode === 'LIVE' ? 'LIVE' : degraded ? `${base} · ${worst}` : base;
  const icon =
    mode === 'LIVE' ? 'lightning' : mode === 'REPLAY' ? 'clock' : degraded ? 'exclamation-mark-triangle' : 'play';
  const kind = mode === 'LIVE' ? 'brand' : mode === 'REPLAY' ? 'brand' : degraded ? 'inverse' : 'neutral';
  // `inverse` is a dark Calcite surface — forcing tokens.text (#151515) made
  // "SIMULATED · IMPUTED" unreadable. Light text on inverse; dark on neutral.
  const chipText = kind === 'inverse' ? '#ffffff' : tokens.text;

  return (
    <CalciteChip
      scale="s"
      kind={kind}
      icon={icon}
      style={{ cursor: 'pointer', '--calcite-chip-text-color': chipText } as React.CSSProperties}
      title={
        mode === 'REPLAY'
          ? 'Corpus replay — the twin replays the richest real week JNPA shared; live feeds swap in without code change. Click for Integration Console.'
          : 'Data provenance — click to open the Integration Simulator Console'
      }
      onClick={() => setConsoleOpen(true)}
      aria-label={`Data mode ${label}. Click to open the integration console.`}
    >
      {label}
    </CalciteChip>
  );
}
