/**
 * <PilotageTable> — the paged pilotage table for the Vessels ▸ Pilotage sub-tab.
 * Reads `/api/marine/pilotage` via the UC-3 connector and renders the VesselTable
 * table idiom (tokens-styled <table>, filter + pager, PanelEmpty on no rows).
 *
 * Pilot-card movements (INWARD/OUTWARD/SHIFTING) — marine-side actuals, distinct from
 * the AIS feed and from the vessel-call spine. Data arrives via the SHARED Data Upload
 * sub-tab (Pilot_card_data.xlsx), so this view is empty until a pilot card is uploaded.
 */

import { useState, type CSSProperties } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchPilotagePage, type PilotageFilters } from '@/data/uc3/pilotage';
import type { Pilotage } from '@/types/domain';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
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

const PAGE_SIZE = 50;
const MOVEMENTS = ['', 'INWARD', 'OUTWARD', 'SHIFTING'];

function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

const COLUMNS: { key: string; label: string; render: (p: Pilotage) => string; num?: boolean }[] = [
  { key: 'movement', label: 'Movement', render: (p) => p.movementType || '—' },
  { key: 'vessel', label: 'Vessel', render: (p) => p.vesselName || '—' },
  { key: 'via', label: 'VIA', render: (p) => p.viaNo || '—' },
  { key: 'imo', label: 'IMO', render: (p) => p.imoNo || '—' },
  { key: 'pilot', label: 'Pilot', render: (p) => p.pilotCode || '—' },
  { key: 'boarded', label: 'Boarded', render: (p) => fmt(p.pilotBoardedAt), num: true },
  { key: 'allfast', label: 'All Fast', render: (p) => fmt(p.allFastAt), num: true },
  { key: 'submitted', label: 'Submitted', render: (p) => fmt(p.submittedAt), num: true },
];

export function PilotageTable() {
  const [movement, setMovement] = useState('');
  const [vessel, setVessel] = useState('');
  const [offset, setOffset] = useState(0);

  const filters: PilotageFilters = {
    movement: movement || undefined,
    vessel: vessel.trim() || undefined,
    sort: 'submitted_at',
    direction: 'desc',
  };
  const q = useAdapterQuery(() => fetchPilotagePage(filters, PAGE_SIZE, offset), [movement, vessel, offset]);

  const page = q.data;
  const total = page?.total ?? 0;
  const rows = page?.items ?? [];
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <select
          value={movement}
          onChange={(e) => { setOffset(0); setMovement(e.target.value); }}
          style={{
            fontSize: 12, padding: '5px 8px', borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.border}`, background: tokens.panel, color: tokens.text,
          }}
          aria-label="Filter by movement type"
        >
          {MOVEMENTS.map((m) => <option key={m || 'all'} value={m}>{m || 'All movements'}</option>)}
        </select>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search vessel name…"
          value={vessel}
          style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) => { setOffset(0); setVessel((e.target as unknown as { value: string }).value); }}
        />
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {from}–{to} of {total}
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {q.loading && !page ? (
          <PanelLoading label="Loading pilotage…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No pilotage records yet. Upload Pilot_card_data.xlsx from the Data Upload sub-tab." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>{COLUMNS.map((c) => <th key={c.key} style={TH}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.pilotageId}>
                  {COLUMNS.map((col) => (
                    <td key={col.key} style={{ ...TD, fontWeight: col.key === 'movement' ? 600 : undefined, fontVariantNumeric: col.num ? 'tabular-nums' : undefined }}>
                      {col.render(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm, paddingTop: tokens.space.sm }}>
        <button style={btn(offset === 0)} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹ Prev</button>
        <button style={btn(to >= total)} disabled={to >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next ›</button>
      </div>
    </div>
  );
}

function btn(disabled: boolean): CSSProperties {
  return {
    fontSize: 12, padding: '4px 10px', borderRadius: tokens.radius.sm,
    border: `1px solid ${tokens.border}`, background: tokens.panel,
    color: disabled ? tokens.textMuted : tokens.text, cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
