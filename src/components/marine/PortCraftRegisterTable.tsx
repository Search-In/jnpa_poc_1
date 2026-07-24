/**
 * <PortCraftRegisterTable> — the UC-3 port-craft fleet REGISTER, shown inside the
 * existing Port Craft tab BELOW the live-ops PortCraftBoard (which is untouched).
 *
 * Reads `/api/marine/port-craft` via the UC-3 connector and renders the VesselTable
 * table idiom (tokens-styled <table>, PanelEmpty on no rows). Static particulars from
 * Details_of_Port_Crafts.pdf — distinct from the mock live-ops board. Empty until the
 * PDF is uploaded through the marine Data Upload flow.
 */

import { useState, type CSSProperties } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchPortCraft, type PortCraftFilters } from '@/data/uc3/portCraft';
import type { PortCraft } from '@/types/domain';
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

const TYPES = ['', 'Tug', 'Launch', 'Pilot Launch', 'VIP Launch'];

function n2(v: number | null, unit = ''): string {
  return v === null ? '—' : `${v.toFixed(2)}${unit}`;
}

const COLUMNS: { key: string; label: string; render: (c: PortCraft) => string; wrap?: boolean }[] = [
  { key: 'name', label: 'Name', render: (c) => c.name || '—' },
  { key: 'type', label: 'Type', render: (c) => c.craftType || '—' },
  { key: 'oh', label: 'Owned/Hired', render: (c) => c.ownedOrHired || '—' },
  { key: 'owner', label: 'Owner', render: (c) => c.ownerName || '—' },
  { key: 'year', label: 'Year Built', render: (c) => c.yearBuilt || '—' },
  { key: 'loa', label: 'LOA', render: (c) => n2(c.loaM, ' m') },
  { key: 'breadth', label: 'Breadth', render: (c) => n2(c.breadthM, ' m') },
  { key: 'draft', label: 'Draft', render: (c) => n2(c.draftM, ' m') },
  { key: 'engines', label: 'Engines', render: (c) => c.mainEngines || '—', wrap: true },
  { key: 'bollard', label: 'Bollard Pull', render: (c) => (c.bollardPullT === null ? '—' : `${c.bollardPullT} T`) },
  { key: 'speed', label: 'Speed', render: (c) => (c.designSpeedKn === null ? '—' : `${c.designSpeedKn.toFixed(2)} kn`) },
];

export function PortCraftRegisterTable() {
  const [craftType, setCraftType] = useState('');
  const [name, setName] = useState('');

  const filters: PortCraftFilters = {
    craftType: craftType || undefined,
    name: name.trim() || undefined,
    sort: 'name',
    direction: 'asc',
  };
  const q = useAdapterQuery(() => fetchPortCraft(filters), [craftType, name]);
  const rows = q.data ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <select
          value={craftType}
          onChange={(e) => setCraftType(e.target.value)}
          style={{ fontSize: 12, padding: '5px 8px', borderRadius: tokens.radius.sm, border: `1px solid ${tokens.border}`, background: tokens.panel, color: tokens.text }}
          aria-label="Filter by craft type"
        >
          {TYPES.map((t) => <option key={t || 'all'} value={t}>{t || 'All types'}</option>)}
        </select>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search craft name…"
          value={name}
          style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) => setName((e.target as unknown as { value: string }).value)}
        />
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {rows.length} craft{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {q.loading && !q.data ? (
          <PanelLoading label="Loading port-craft register…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No port-craft register yet. Upload Details_of_Port_Crafts.pdf via the Vessels ▸ Data Upload flow." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>{COLUMNS.map((c) => <th key={c.key} style={TH}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.craftId}>
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      style={{ ...TD, fontWeight: col.key === 'name' ? 600 : undefined, whiteSpace: col.wrap ? 'normal' : 'nowrap', maxWidth: col.wrap ? 260 : undefined }}
                    >
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
