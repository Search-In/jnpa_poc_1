/**
 * <VesselTable> — the Vessels tab: every vessel in the current feed as a sortable
 * tabular grid with all relevant field values (MMSI, name, type, status, SOG,
 * COG, heading, position, berth, ETA, last fix, source). Reads the same live
 * vessel set the map and feed use, so it stays consistent with them.
 *
 * Columns are click-to-sort; a summary bar reports total / live / simulated
 * counts so the mock-vs-real split is explicit (SOURCE='live' hulls are badged
 * LIVE, matching the map ring and the VesselFeed tag).
 *
 * The trailing **Predictions** column opens the UC-1 AI/ML model suite for that
 * hull (`<VesselPredictionsSheet>`). It is an action, not a value: predictions
 * cost real computation — the berth optimiser and the TAT engine run over the
 * whole fleet — so they are produced when an operator asks for one vessel, never
 * eagerly for every row. The one call scores the feed, so opening a second row
 * is instant.
 */

import { useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { CalciteButton } from '@esri/calcite-components-react';
import { useAppStore } from '@/store/useAppStore';
import { usePredictionStore } from '@/data/ml/predictionStore';
import { buildContext } from '@/data/ml/predictions';
import { env } from '@/data/config';
import type { NavStatus, Vessel } from '@/types/domain';
import { navStatusColor, tokens } from '@/theme/tokens';
import { istDateTime } from '@/util/format';
import { PanelEmpty } from './common/Panel';

// Table styles mirror MethodologyPanel's grid so the app reads as one system.
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

/** Operational priority used as the default sort (matches VesselFeed). */
const PRIORITY: Record<NavStatus, number> = {
  approaching: 0,
  berthing: 1,
  anchored: 2,
  underway: 3,
  moored: 4,
};

type SortKey =
  | 'VESSEL_NAME'
  | 'MMSI'
  | 'VESSEL_TYPE'
  | 'NAV_STATUS'
  | 'SOG'
  | 'COG'
  | 'HEADING'
  | 'POSITION'
  | 'BERTH_ID'
  | 'ETA'
  | 'TIMESTAMP'
  | 'SOURCE';

interface Column {
  key: SortKey;
  label: string;
  numeric?: boolean;
}

/**
 * Sortable value columns. The Predictions column is appended in the markup
 * rather than listed here: it holds an action, and there is nothing to sort by
 * until the operator has asked for a prediction.
 */
const COLUMNS: Column[] = [
  { key: 'VESSEL_NAME', label: 'Vessel' },
  { key: 'MMSI', label: 'MMSI' },
  { key: 'VESSEL_TYPE', label: 'Type' },
  { key: 'NAV_STATUS', label: 'Status' },
  { key: 'SOG', label: 'SOG (kn)', numeric: true },
  { key: 'COG', label: 'COG (°)', numeric: true },
  { key: 'HEADING', label: 'Hdg (°)', numeric: true },
  { key: 'POSITION', label: 'Position (lat, lon)' },
  { key: 'BERTH_ID', label: 'Berth' },
  { key: 'ETA', label: 'ETA' },
  { key: 'TIMESTAMP', label: 'Last fix' },
  { key: 'SOURCE', label: 'Source' },
];

/** Comparable value per sort key. Nulls sort last; POSITION sorts by lat then lon. */
function sortValue(v: Vessel, key: SortKey): number | string {
  switch (key) {
    case 'NAV_STATUS':
      return PRIORITY[v.NAV_STATUS];
    case 'SOG':
      return v.SOG;
    case 'COG':
      return v.COG;
    case 'HEADING':
      return v.HEADING;
    case 'POSITION':
      return v.LAT * 1000 + v.LON; // lat-major ordering
    case 'ETA':
      return v.ETA ?? Number.POSITIVE_INFINITY;
    case 'TIMESTAMP':
      return v.TIMESTAMP;
    case 'SOURCE':
      return v.SOURCE ?? 'mock';
    case 'BERTH_ID':
      return v.BERTH_ID ?? '￿'; // unassigned last
    case 'MMSI':
      return v.MMSI;
    case 'VESSEL_TYPE':
      return v.VESSEL_TYPE || '￿';
    case 'VESSEL_NAME':
    default:
      return v.VESSEL_NAME.toLowerCase();
  }
}

function LiveTag() {
  return (
    <span
      title="Real AIS position (live source)"
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.4,
        color: '#052e16',
        background: '#22c55e',
        borderRadius: 3,
        padding: '1px 4px',
      }}
    >
      LIVE
    </span>
  );
}

function StatusCell({ status }: { status: NavStatus }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span
        aria-hidden
        style={{ width: 8, height: 8, borderRadius: '50%', background: navStatusColor[status], flexShrink: 0 }}
      />
      <span style={{ textTransform: 'capitalize' }}>{status}</span>
    </span>
  );
}

/**
 * The per-row Predictions action.
 *
 * Shows which vessel is currently open and which one is being scored, so the
 * operator can see that the wait belongs to their click. The button stays
 * enabled for other rows during a fetch: the store simply re-targets, which is
 * what someone who clicked the wrong row expects.
 */
function PredictionsCell({ vessel, fleet }: { vessel: Vessel; fleet: Vessel[] }) {
  const openMmsi = usePredictionStore((s) => s.openMmsi);
  const loading = usePredictionStore((s) => s.loading);
  const open = usePredictionStore((s) => s.open);
  const kpis = useAppStore((s) => s.kpis);

  const isOpen = openMmsi === vessel.MMSI;
  return (
    <CalciteButton
      scale="s"
      appearance={isOpen ? 'solid' : 'outline'}
      kind="brand"
      iconStart="lightbulb"
      loading={isOpen && loading ? true : undefined}
      title={`Run the eight UC-1 models for ${vessel.VESSEL_NAME} — UKC, tidal window, TAT, ETA band, berth plan, JIT, craft and risk chain`}
      onClick={() => {
        // Berth occupancy is the one piece of port context this screen already
        // holds; everything else is left out so the service applies (and
        // reports) its own documented fallback rather than a UI placeholder.
        void open(vessel, fleet, buildContext({ berthOccupancyPct: kpis?.berthOccupancy.value ?? null }));
      }}
    >
      {isOpen ? 'Open' : 'Predict'}
    </CalciteButton>
  );
}

export function VesselTable() {
  const vessels = useAppStore((s) => s.vessels);
  const [sortKey, setSortKey] = useState<SortKey>('NAV_STATUS');
  const [asc, setAsc] = useState(true);

  const counts = useMemo(() => {
    const live = vessels.filter((v) => v.SOURCE === 'live').length;
    return { total: vessels.length, live, mock: vessels.length - live };
  }, [vessels]);

  const rows = useMemo(() => {
    const sorted = [...vessels].sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      let cmp: number;
      if (typeof va === 'number' && typeof vb === 'number') cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      // Stable tiebreak on name so equal keys keep a deterministic order.
      if (cmp === 0) cmp = a.VESSEL_NAME.localeCompare(b.VESSEL_NAME);
      return asc ? cmp : -cmp;
    });
    return sorted;
  }, [vessels, sortKey, asc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setAsc(true);
    }
  };

  if (vessels.length === 0) {
    return <PanelEmpty message="No vessels in the current AIS feed." />;
  }

  const arrow = (key: SortKey) => (key === sortKey ? (asc ? ' ▲' : ' ▼') : '');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space.md,
          padding: `0 0 ${tokens.space.sm}px`,
          fontSize: 12,
          color: tokens.textMuted,
        }}
      >
        <span>
          <strong style={{ color: tokens.text }}>{counts.total}</strong> vessels
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <LiveTag />
          <strong style={{ color: tokens.text }}>{counts.live}</strong> live
        </span>
        <span>
          <strong style={{ color: tokens.text }}>{counts.mock}</strong> simulated
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        <table style={TABLE}>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  style={{ ...TH_BASE, textAlign: c.numeric ? 'right' : 'left' }}
                  onClick={() => toggleSort(c.key)}
                  aria-sort={c.key === sortKey ? (asc ? 'ascending' : 'descending') : 'none'}
                  title="Click to sort"
                >
                  {c.label}
                  {arrow(c.key)}
                </th>
              ))}
              {env.ml.enabled && (
                <th
                  style={{ ...TH_BASE, cursor: 'default', textAlign: 'center' }}
                  title="AI/ML predictions from the eight UC-1 models"
                >
                  Predictions
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((v) => (
              <tr key={v.MMSI}>
                <td style={{ ...TD, fontWeight: 600 }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    {v.VESSEL_NAME}
                    {v.SOURCE === 'live' && <LiveTag />}
                  </span>
                </td>
                <td style={{ ...TD, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>{v.MMSI}</td>
                <td style={TD}>{v.VESSEL_TYPE || '—'}</td>
                <td style={TD}>
                  <StatusCell status={v.NAV_STATUS} />
                </td>
                <td style={TD_NUM}>{v.SOG.toFixed(1)}</td>
                <td style={TD_NUM}>{Math.round(v.COG)}</td>
                <td style={TD_NUM}>{Math.round(v.HEADING)}</td>
                <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>
                  {v.LAT.toFixed(4)}, {v.LON.toFixed(4)}
                </td>
                <td style={TD}>{v.BERTH_ID ?? '—'}</td>
                <td style={TD}>{v.ETA ? istDateTime(v.ETA) : '—'}</td>
                <td style={{ ...TD, color: tokens.textMuted }}>{istDateTime(v.TIMESTAMP)}</td>
                <td style={TD}>{v.SOURCE === 'live' ? 'Live AIS' : 'Simulated'}</td>
                {env.ml.enabled && (
                  <td style={{ ...TD, textAlign: 'center' }}>
                    <PredictionsCell vessel={v} fleet={vessels} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
