/**
 * <SeaChannelTable> — the UC-3 sea-channel register, shown inside the existing DUKC /
 * RTUKC tab BELOW the DukcCorridor view (which is untouched).
 *
 * Reads `/api/marine/sea-channels` via the UC-3 connector and lists the JNPA channel /
 * anchorage / berth-pocket polygons (from the JNPA_Sea_Channels shapefile, reprojected
 * to WGS84). Empty until the shapefile ZIP is uploaded through the marine Data Upload
 * flow. The GeoJSON geometry is available via the connector for a future map overlay.
 */

import { useState, type CSSProperties } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchSeaChannels, type SeaChannelFilters } from '@/data/uc3/seaChannels';
import type { SeaChannel } from '@/types/domain';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';

const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse' };
const TH: CSSProperties = {
  textAlign: 'left', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
  textTransform: 'uppercase', color: tokens.textMuted,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderBottom: `1px solid ${tokens.border}`,
  background: tokens.panelAlt, whiteSpace: 'nowrap', position: 'sticky', top: 0,
};
const TD: CSSProperties = {
  fontSize: 12.5, lineHeight: 1.4, color: tokens.text,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderBottom: `1px solid ${tokens.border}`,
  whiteSpace: 'nowrap',
};

function vertexCount(c: SeaChannel): number {
  if (!c.geometry) return 0;
  return c.geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0);
}

const COLUMNS: { key: string; label: string; render: (c: SeaChannel) => string; num?: boolean }[] = [
  { key: 'name', label: 'Name', render: (c) => c.name || '—' },
  { key: 'section', label: 'Section', render: (c) => c.sectionLabel || '—' },
  { key: 'area', label: 'Area (ha)', render: (c) => (c.areaHa === null ? '—' : c.areaHa.toFixed(2)), num: true },
  { key: 'length', label: 'Length (m)', render: (c) => (c.lengthM === null ? '—' : c.lengthM.toFixed(0)), num: true },
  { key: 'verts', label: 'Vertices', render: (c) => String(vertexCount(c)), num: true },
];

export function SeaChannelTable() {
  const [name, setName] = useState('');
  const filters: SeaChannelFilters = { name: name.trim() || undefined, sort: 'name', direction: 'asc' };
  const q = useAdapterQuery(() => fetchSeaChannels(filters), [name]);
  const rows = q.data ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search channel name…"
          value={name}
          style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) => setName((e.target as unknown as { value: string }).value)}
        />
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {rows.length} channel{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {q.loading && !q.data ? (
          <PanelLoading label="Loading sea channels…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No sea channels yet. Upload the JNPA_Sea_Channels shapefile (zipped) via the DUKC ▸ Data Upload flow." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>{COLUMNS.map((c) => <th key={c.key} style={{ ...TH, textAlign: c.num ? 'right' : 'left' }}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.channelId}>
                  {COLUMNS.map((col) => (
                    <td key={col.key} style={{ ...TD, textAlign: col.num ? 'right' : 'left', fontWeight: col.key === 'name' ? 600 : undefined, fontVariantNumeric: col.num ? 'tabular-nums' : undefined }}>
                      {col.render(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
