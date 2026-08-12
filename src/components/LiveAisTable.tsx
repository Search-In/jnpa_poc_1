/**
 * <LiveAisTable> — the REAL AIS picture, in a table.
 *
 * Reads the SHARED live feed (`map/liveVesselStore`), the same one the map's Live AIS
 * overlay draws, so the Vessels tab and the map can never show different traffic — and,
 * because the poller is shared, having both open costs exactly one request per interval
 * rather than two.
 *
 * Subscribing here is also what keeps the feed alive with the overlay switched OFF: the
 * poller runs while it has at least one subscriber, so an operator who only wants the
 * table still gets live data, and closing the tab stops the polling if nobody else is
 * reading it.
 *
 * WHY THIS IS NOT <VesselTable>. A `LiveVessel` is a genuinely different record from the
 * simulated/derived `Vessel`: it carries a MarineTraffic SHIP_ID rather than an MMSI, a
 * ship-type code, a destination, a flag and a position age — and carries NO nav-status,
 * berth or ETA, because a raw AIS report has none of those. Forcing it into the fleet
 * table's columns would mean inventing the missing ones, which is exactly the kind of
 * quiet fabrication the provenance work exists to prevent.
 *
 * Polls only while mounted, i.e. only while the Live tab is the one on screen.
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { env } from '@/data/config';
import { acquireLiveFeed, useLiveVesselStore } from '@/map/liveVesselStore';
import { PanelEmpty, PanelError, PanelLoading } from './common/Panel';
import { tokens } from '@/theme/tokens';
import type { LiveVessel } from '@/types/domain';

const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse' };

const TH: CSSProperties = {
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
  // Above the rows: a sticky header is a POSITIONED element with z-index auto, so any
  // positioned cell content below would otherwise paint over it as the rows scroll under.
  zIndex: 1,
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

/**
 * The Ship ID cell. Most upstream ids are short numerics ('655493'), but MarineTraffic
 * also returns opaque base64 tokens 60+ characters long, and one of those stretched the
 * column past every other field in the table.
 *
 * Truncated in CSS rather than by slicing the string: a short id renders whole with no
 * ellipsis, only a genuinely long one is clipped, and — the reason it matters — the FULL
 * value stays in the DOM, so selecting the cell still copies the complete id. Slicing
 * would silently put a broken identifier on the operator's clipboard.
 */
const TD_ID: CSSProperties = {
  ...TD,
  maxWidth: 130,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11.5,
};

type SortKey =
  | 'vesselName' | 'mmsi' | 'shipTypeLabel' | 'speedKnots'
  | 'course' | 'position' | 'destination' | 'flag' | 'length' | 'elapsedSeconds';

const COLUMNS: { key: SortKey; label: string; numeric?: boolean; title?: string }[] = [
  { key: 'vesselName', label: 'Vessel' },
  // Labelled SHIP ID, not MMSI: the upstream value is MarineTraffic's own key. Calling it
  // an MMSI would invite an operator to look it up in a registry where it does not exist.
  { key: 'mmsi', label: 'Ship ID', title: 'MarineTraffic SHIP_ID — a stable key, not an MMSI' },
  { key: 'shipTypeLabel', label: 'Type' },
  { key: 'speedKnots', label: 'SOG (kn)', numeric: true },
  { key: 'course', label: 'COG (°)', numeric: true },
  { key: 'position', label: 'Position (lat, lon)' },
  { key: 'destination', label: 'Destination' },
  { key: 'flag', label: 'Flag' },
  { key: 'length', label: 'LOA (m)', numeric: true },
  { key: 'elapsedSeconds', label: 'Fix age', numeric: true },
];

function sortValue(v: LiveVessel, key: SortKey): number | string {
  switch (key) {
    case 'position':
      return v.lat;
    case 'speedKnots':
      return v.speedKnots;
    case 'course':
      return v.course;
    case 'length':
      // Null LOA sorts last rather than as zero — absent is not small.
      return v.length ?? Number.MAX_SAFE_INTEGER;
    case 'elapsedSeconds':
      return v.elapsedSeconds ?? Number.MAX_SAFE_INTEGER;
    case 'destination':
      return v.destination ?? '';
    case 'flag':
      return v.flag ?? '';
    default:
      return v[key] ?? '';
  }
}

/** Position age in the units an operator reads it in. */
function fixAge(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

const num = (v: number | null, digits = 0): string =>
  v === null || !Number.isFinite(v) ? '—' : v.toFixed(digits);

export function LiveAisTable() {
  const [sortKey, setSortKey] = useState<SortKey>('vesselName');
  const [asc, setAsc] = useState(true);

  // Configured-off is a real state, not an error: the button is hidden in that case and
  // this must not fire a request either. Checked before the query so nothing is polled.
  const available = env.liveAis.enabled && env.uc3.enabled;

  // Join the shared feed for as long as this table is on screen. The store starts the
  // timer for the first subscriber and stops it after the last leaves, so the Live tab
  // keeps real data flowing even with the map overlay off.
  useEffect(() => {
    if (!available) return;
    return acquireLiveFeed();
  }, [available]);

  const vessels = useLiveVesselStore((s) => s.vessels);
  const loading = useLiveVesselStore((s) => s.loading);
  const error = useLiveVesselStore((s) => s.error);
  const lastUpdated = useLiveVesselStore((s) => s.lastUpdated);

  const rows = useMemo(() => {
    return [...vessels].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      const cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb));
      return asc ? cmp : -cmp;
    });
  }, [vessels, sortKey, asc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setAsc((v) => !v);
    else {
      setSortKey(key);
      setAsc(true);
    }
  };

  if (!available) {
    return (
      <PanelEmpty
        message={
          'Live AIS is switched off in this build. Set VITE_LIVE_AIS_ENABLED=true '
          + '(and VITE_UC3_ENABLED=true) to read real MarineTraffic positions through the '
          + 'shared JNPA gateway.'
        }
      />
    );
  }
  // `lastUpdated` rather than a data check: before the first poll there is genuinely no
  // picture yet, and an empty array would otherwise render as 'no vessels'.
  if (lastUpdated === null && !error) return <PanelLoading label="Loading live AIS…" />;
  if (error) return <PanelError message={`Live AIS feed unavailable — ${error}`} />;
  if (rows.length === 0) {
    return (
      <PanelEmpty message="No vessels reported in the JNPA tile window on the last poll." />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ paddingBottom: tokens.space.sm, fontSize: 12, color: tokens.textMuted }}>
        <strong style={{ color: tokens.text }}>{rows.length}</strong> vessels · real
        MarineTraffic positions via the shared JNPA gateway · {loading ? 'refreshing…' : 'refreshed'} every{' '}
        {Math.round(env.liveAis.pollMs / 60_000)} min
      </div>

      <div
        style={{
          flex: 1,
          overflow: 'auto',
          minHeight: 0,
          border: `1px solid ${tokens.border}`,
          borderRadius: tokens.radius.sm,
        }}
      >
        <table style={TABLE}>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  style={{ ...TH, textAlign: c.numeric ? 'right' : 'left' }}
                  title={c.title}
                  onClick={() => toggleSort(c.key)}
                  aria-sort={c.key === sortKey ? (asc ? 'ascending' : 'descending') : 'none'}
                >
                  {c.label}
                  {c.key === sortKey ? (asc ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.mmsi}>
                <td style={{ ...TD, fontWeight: 600 }}>{v.vesselName || '—'}</td>
                {/* Full id on hover; the cell itself clips. */}
                <td style={TD_ID} title={v.mmsi}>{v.mmsi}</td>
                <td style={TD}>{v.shipTypeLabel || '—'}</td>
                <td style={TD_NUM}>{num(v.speedKnots, 1)}</td>
                <td style={TD_NUM}>{num(v.course)}</td>
                <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>
                  {v.lat.toFixed(4)}, {v.lon.toFixed(4)}
                </td>
                <td style={TD}>{v.destination || '—'}</td>
                <td style={TD}>{v.flag || '—'}</td>
                <td style={TD_NUM}>{v.length === null ? '—' : v.length}</td>
                <td style={TD_NUM}>{fixAge(v.elapsedSeconds)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
