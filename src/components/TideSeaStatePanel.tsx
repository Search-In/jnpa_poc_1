/**
 * <TideSeaStatePanel> — the Tide & Sea State tab: per-station tide height + trend,
 * significant wave height (sea state), swell and wind for every JNPA monitoring
 * point, as a sortable table. Mirrors the same station set the map overlay draws,
 * so map + table stay consistent.
 *
 * Production source is INCOIS Ocean State Forecast (OSF). INCOIS has no free,
 * public, CORS-enabled tide/OSF API today, so the live source here is INTERIM —
 * Open-Meteo Marine per station — honestly labelled via the TIDE SourceBadge and
 * the notice below. See src/data/tide.ts and docs/INCOIS.md.
 */

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { getAdapter } from '@/data';
import { useSimStore } from '@/sim/simStore';
import type { TideStation } from '@/types/domain';
import { tokens } from '@/theme/tokens';
import { istDateTime } from '@/util/format';
import { SourceBadge } from '@/provenance/SourceBadge';
import { PanelEmpty, PanelError, PanelLoading } from './common/Panel';

const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse' };

const TH_BASE: CSSProperties = {
  textAlign: 'left',
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: tokens.textMuted,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  borderBottom: `1px solid ${tokens.border}`,
  position: 'sticky',
  top: 0,
  background: tokens.panelAlt,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  userSelect: 'none',
};

const TD: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.4,
  color: tokens.text,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  borderBottom: `1px solid ${tokens.border}`,
  whiteSpace: 'nowrap',
};

const TD_NUM: CSSProperties = { ...TD, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

/** Sea state colour band — calm / moderate / rough, mirroring pilotage limits. */
function seaStateColor(m: number): string {
  if (m >= 2.5) return tokens.bad;
  if (m >= 1.5) return tokens.warn;
  return tokens.good;
}

const TREND_GLYPH: Record<TideStation['tideTrend'], string> = {
  rising: '▲',
  falling: '▼',
  slack: '▬',
};
const TREND_COLOR: Record<TideStation['tideTrend'], string> = {
  rising: tokens.good,
  falling: tokens.bad,
  slack: tokens.textMuted,
};

type SortKey = 'NAME' | 'tideM' | 'tideTrend' | 'seaStateM' | 'swellM' | 'windKt';

interface Column {
  key: SortKey;
  label: string;
  numeric?: boolean;
}

const COLUMNS: Column[] = [
  { key: 'NAME', label: 'Station' },
  { key: 'tideM', label: 'Tide (m CD)', numeric: true },
  { key: 'tideTrend', label: 'Trend' },
  { key: 'seaStateM', label: 'Sea state — SWH (m)', numeric: true },
  { key: 'swellM', label: 'Swell (m)', numeric: true },
  { key: 'windKt', label: 'Wind (kn)', numeric: true },
];

function cmp(a: TideStation, b: TideStation, key: SortKey): number {
  switch (key) {
    case 'NAME':
      return a.NAME.localeCompare(b.NAME);
    case 'tideTrend':
      return a.tideTrend.localeCompare(b.tideTrend);
    default:
      return a[key] - b[key];
  }
}

export function TideSeaStatePanel() {
  const simVersion = useSimStore((s) => s.version);
  const { data, loading, error } = useAdapterQuery(
    () => getAdapter().getTideStations(),
    [simVersion],
    60_000
  );

  const [sortKey, setSortKey] = useState<SortKey>('NAME');
  const [asc, setAsc] = useState(true);

  const rows = useMemo(() => {
    const s = [...(data?.stations ?? [])];
    s.sort((a, b) => (asc ? 1 : -1) * cmp(a, b, sortKey));
    return s;
  }, [data, sortKey, asc]);

  const clickSort = (k: SortKey) => {
    if (k === sortKey) setAsc((v) => !v);
    else {
      setSortKey(k);
      setAsc(true);
    }
  };

  if (loading && !data) return <PanelLoading label="Loading tide & sea state…" />;
  if (error) return <PanelError message={error} />;
  if (!rows.length) return <PanelEmpty message="No tide stations reporting." />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
      <SourceBadge
        source="TIDE"
        info={
          <>
            Interim live source: Open-Meteo Marine (real wave height + sea level → tide) per station.
            Production source is INCOIS Ocean State Forecast (SAMUDRA) — pending a server-side proxy +
            INCOIS data agreement (no free public CORS-enabled INCOIS API today). See docs/INCOIS.md.
          </>
        }
      />

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table style={TABLE}>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  style={{ ...TH_BASE, textAlign: c.numeric ? 'right' : 'left' }}
                  onClick={() => clickSort(c.key)}
                  title="Click to sort"
                >
                  {c.label}
                  {sortKey === c.key ? (asc ? ' ↑' : ' ↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.STATION_ID}>
                <td style={TD}>{s.NAME}</td>
                <td style={TD_NUM}>{s.tideM.toFixed(2)}</td>
                <td style={{ ...TD, color: TREND_COLOR[s.tideTrend] }}>
                  {TREND_GLYPH[s.tideTrend]} {s.tideTrend}
                </td>
                <td style={{ ...TD_NUM, color: seaStateColor(s.seaStateM), fontWeight: 600 }}>
                  {s.seaStateM.toFixed(1)}
                </td>
                <td style={TD_NUM}>{s.swellM.toFixed(1)}</td>
                <td style={TD_NUM}>{s.windKt.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data && (
        <div style={{ fontSize: 11, color: tokens.textMuted }}>
          {rows.length} stations · updated {istDateTime(data.TS)} IST · tide heights above chart datum
        </div>
      )}
    </div>
  );
}
