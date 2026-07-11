/**
 * SourceBadge — per-panel provenance label (spec §A3: no unlabelled screen).
 * Names the panel's intended production source system and its current fallback
 * rung, colour-coded. In SIM/REPLAY mode it appends "· Simulated" so a viewer
 * always knows the data behind this panel is not a live JNPA feed.
 */
import { CalciteIcon } from '@esri/calcite-components-react';
import { type SourceId, SOURCE_BY_ID, rungLabel } from './sources';
import { useDataModeStore } from './useDataModeStore';
import { tokens } from '@/theme/tokens';

const RUNG_COLOR: Record<string, string> = {
  LIVE: tokens.mode.LIVE,
  DEGRADED: tokens.mode.DEGRADED,
  CACHED: tokens.warn,
  IMPUTED: tokens.mode.SIM,
  OFFLINE: tokens.mode.OFFLINE,
};

export function SourceBadge({ source }: { source: SourceId }) {
  const meta = SOURCE_BY_ID[source];
  const runtime = useDataModeStore((s) => s.sources[source]);
  const mode = useDataModeStore((s) => s.mode);
  const state = runtime?.state ?? 'LIVE';
  const sim = mode !== 'LIVE';

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11.5,
        color: tokens.textMuted,
        margin: '0 0 8px',
      }}
      title={`${meta.prodSource} · ${meta.cadence} · ${rungLabel(state)}`}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: RUNG_COLOR[state] ?? tokens.offline,
          boxShadow: state === 'LIVE' ? `0 0 0 3px ${tokens.mode.LIVE}22` : 'none',
        }}
      />
      <CalciteIcon icon="information" scale="s" />
      <span>
        Source: {meta.label} · {state}
        {sim ? ' · Simulated' : ''}
      </span>
    </div>
  );
}
