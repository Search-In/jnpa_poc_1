/**
 * <VesselFeed> — live vessel list, sorted by operational priority:
 * approaching → berthing → anchored → underway → moored, then by ETA/name.
 * Reads the live vessel set from the store (adapter-fed).
 */

import { useMemo } from 'react';
import { CalciteChip } from '@esri/calcite-components-react';
import { useAppStore } from '@/store/useAppStore';
import type { NavStatus, Vessel } from '@/types/domain';
import { navStatusColor, tokens } from '@/theme/tokens';
import { istTime } from '@/util/format';
import { PanelEmpty } from './common/Panel';

const PRIORITY: Record<NavStatus, number> = {
  approaching: 0,
  berthing: 1,
  anchored: 2,
  underway: 3,
  moored: 4,
};

function sortVessels(vessels: Vessel[]): Vessel[] {
  return [...vessels].sort((a, b) => {
    const p = PRIORITY[a.NAV_STATUS] - PRIORITY[b.NAV_STATUS];
    if (p !== 0) return p;
    // Within a status, soonest ETA first; vessels without ETA after those with.
    if (a.ETA !== null && b.ETA !== null) return a.ETA - b.ETA;
    if (a.ETA !== null) return -1;
    if (b.ETA !== null) return 1;
    return a.VESSEL_NAME.localeCompare(b.VESSEL_NAME);
  });
}

function Row({ v }: { v: Vessel }) {
  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 4px',
        borderBottom: `1px solid ${tokens.border}`,
      }}
    >
      <span
        aria-hidden
        style={{ width: 9, height: 9, borderRadius: '50%', background: navStatusColor[v.NAV_STATUS], flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{ fontSize: 12, color: tokens.text, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          title={v.VESSEL_NAME}
        >
          {v.VESSEL_NAME}
        </div>
        <div style={{ fontSize: 10, color: tokens.textMuted }}>
          {v.MMSI} · {v.SOG.toFixed(1)} kn · {Math.round(v.COG)}°
          {v.BERTH_ID ? ` · ${v.BERTH_ID}` : ''}
        </div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <CalciteChip scale="s" style={{ textTransform: 'capitalize' }}>
          {v.NAV_STATUS}
        </CalciteChip>
        {v.ETA && (
          <div style={{ fontSize: 10, color: tokens.textMuted, marginTop: 2 }}>ETA {istTime(v.ETA)}</div>
        )}
      </div>
    </li>
  );
}

export function VesselFeed() {
  const vessels = useAppStore((s) => s.vessels);
  const sorted = useMemo(() => sortVessels(vessels), [vessels]);

  if (sorted.length === 0) {
    return <PanelEmpty message="No vessels in the current AIS feed." />;
  }

  return (
    <ul
      style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', height: '100%' }}
      aria-label="Live vessel feed"
    >
      {sorted.map((v) => (
        <Row key={v.MMSI} v={v} />
      ))}
    </ul>
  );
}
