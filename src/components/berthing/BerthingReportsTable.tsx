/**
 * <BerthingReportsTable> — the paged, sortable per-terminal berthing vessel-call table
 * for the 5-Day Berthing ▸ Terminal Reports sub-tab. Reads `/api/berthing` via the
 * Phase-1 connector and renders the VesselTable table idiom (tokens-styled <table>,
 * click-to-sort headers with aria-sort, PanelEmpty on no rows).
 *
 * This is the REPORTED actuals layer (jnpa.berthing_reports) for the five container
 * terminals — DISTINCT from the forward-looking 5-Day berth PLAN gantt (BerthGantt5Day),
 * which is left untouched. Sorting and pagination are SERVER-side, so a header click
 * refetches rather than reordering a partial page. Empty until a terminal report is
 * uploaded through the Data Upload sub-tab.
 */

import { useState, type CSSProperties } from 'react';
import { CalciteButton, CalciteInput, CalciteCheckbox, CalciteLabel } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import {
  fetchBerthingReportsPage,
  BERTHING_TERMINALS,
  BERTHING_STATUSES,
  type BerthingReportFilters,
} from '@/data/uc3/berthing';
import type { BerthingReport } from '@/types/domain';
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

/** Sortable columns → the backend `sort` key it maps to (see repository._SORTS). */
const COLUMNS: { key: string; label: string; sort?: string; render: (r: BerthingReport) => string; num?: boolean }[] = [
  { key: 'terminal', label: 'Terminal', sort: 'terminal', render: (r) => r.terminal || '—' },
  { key: 'vessel', label: 'Vessel', sort: 'vessel_name', render: (r) => r.vesselName || '—' },
  { key: 'voyage', label: 'Voyage', render: (r) => r.voyageNumber || '—' },
  { key: 'line', label: 'Line', render: (r) => r.shippingLine || '—' },
  { key: 'berth', label: 'Berth', render: (r) => r.berthNumber || '—' },
  { key: 'status', label: 'Status', sort: 'status', render: (r) => r.status || '—' },
  { key: 'eta', label: 'ETA', sort: 'eta', render: (r) => fmt(r.eta) },
  { key: 'ata', label: 'ATA', sort: 'ata', render: (r) => fmt(r.ata) },
  { key: 'berthed', label: 'Berthed', render: (r) => fmt(r.berthingTime) },
  { key: 'departed', label: 'Departed', render: (r) => fmt(r.departureTime) },
  { key: 'updated', label: 'Updated', sort: 'updated_at', render: (r) => fmt(r.updatedAt) },
];

/** epoch ms → IST string, or '—' when unknown (0). */
function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

const selectStyle: CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.border}`, background: tokens.panel, color: tokens.text,
};

export function BerthingReportsTable() {
  const [terminal, setTerminal] = useState('');
  const [statusF, setStatusF] = useState('');
  const [vessel, setVessel] = useState('');
  const [berthedOnly, setBerthedOnly] = useState(false);
  const [sort, setSort] = useState('updated_at');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);

  const filters: BerthingReportFilters = {
    terminal: terminal || undefined,
    status: statusF || undefined,
    vessel: vessel.trim() || undefined,
    berthedOnly: berthedOnly || undefined,
    sort,
    direction,
  };

  const q = useAdapterQuery(
    () => fetchBerthingReportsPage(filters, PAGE_SIZE, offset),
    [terminal, statusF, vessel, berthedOnly, sort, direction, offset],
  );

  const toggleSort = (col: (typeof COLUMNS)[number]) => {
    if (!col.sort) return;
    setOffset(0);
    if (sort === col.sort) setDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSort(col.sort);
      setDirection('asc');
    }
  };
  const arrow = (col: (typeof COLUMNS)[number]) =>
    col.sort && col.sort === sort ? (direction === 'asc' ? ' ▲' : ' ▼') : '';

  const page = q.data;
  const total = page?.total ?? 0;
  const rows = page?.items ?? [];
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar: terminal + status + vessel search + berthed filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <select
          value={terminal}
          onChange={(e) => { setOffset(0); setTerminal(e.target.value); }}
          style={selectStyle}
          aria-label="Filter by terminal"
        >
          <option value="">All terminals</option>
          {BERTHING_TERMINALS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={statusF}
          onChange={(e) => { setOffset(0); setStatusF(e.target.value); }}
          style={selectStyle}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {BERTHING_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search vessel name…"
          value={vessel}
          style={{ maxWidth: 220 }}
          onCalciteInputChange={(e) => {
            setOffset(0);
            setVessel((e.target as unknown as { value: string }).value);
          }}
        />
        <CalciteLabel layout="inline" scale="s" style={{ margin: 0 }}>
          <CalciteCheckbox
            checked={berthedOnly || undefined}
            onCalciteCheckboxChange={(e) => {
              setOffset(0);
              setBerthedOnly((e.target as unknown as { checked: boolean }).checked);
            }}
          />
          Berthed only
        </CalciteLabel>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {from}–{to} of {total}
        </span>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {q.loading && !page ? (
          <PanelLoading label="Loading berthing reports…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No berthing reports yet. Upload a terminal berthing report (PDF/CSV/XLS/XLSX) via the Data Upload sub-tab." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    style={{ ...TH, cursor: c.sort ? 'pointer' : 'default' }}
                    onClick={() => toggleSort(c)}
                    aria-sort={c.sort && c.sort === sort ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                    title={c.sort ? 'Click to sort' : undefined}
                  >
                    {c.label}
                    {arrow(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        ...TD,
                        fontWeight: col.key === 'vessel' ? 600 : undefined,
                        color: col.key === 'updated' ? tokens.textMuted : TD.color,
                        fontVariantNumeric: ['eta', 'ata', 'berthed', 'departed', 'updated'].includes(col.key) ? 'tabular-nums' : undefined,
                      }}
                    >
                      {col.render(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pager */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm, paddingTop: tokens.space.sm }}>
        <CalciteButton scale="s" appearance="outline" iconStart="chevron-left" disabled={offset === 0 || undefined} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          Prev
        </CalciteButton>
        <CalciteButton scale="s" appearance="outline" iconEnd="chevron-right" disabled={to >= total || undefined} onClick={() => setOffset(offset + PAGE_SIZE)}>
          Next
        </CalciteButton>
      </div>
    </div>
  );
}
