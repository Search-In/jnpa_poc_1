/**
 * <VesselCallsTable> — the paged, sortable vessel-CALL table for the
 * Vessels ▸ Vessel Calls sub-tab. Reads `/api/marine/calls` via the Phase-1
 * connector and renders the VesselTable table idiom (tokens-styled <table>,
 * click-to-sort headers with aria-sort, PanelEmpty on no rows).
 *
 * This is the UC-3 scheduling spine (VCN/IMO-keyed), NOT the live-AIS feed
 * (MMSI-keyed) — a distinct entity, so this is a sibling of VesselTable, never a
 * modification of it. Sorting and pagination are SERVER-side (the backend paginates
 * and sorts), so a header click refetches rather than reordering a partial page.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { CalciteButton, CalciteInput, CalciteCheckbox, CalciteLabel } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { useMarineStateVersion } from '@/data/uc3/marineStateBus';
import { fetchVesselCallsPage, type VesselCallFilters } from '@/data/uc3/marineCalls';
import type { VesselCall } from '@/types/domain';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { StatusChip } from '@/components/shipping/dataTable';
import { lifecycleTone } from '@/components/marine/lifecycleTone';
import { tokens } from '@/theme/tokens';

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
  background: tokens.panelAlt,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  position: 'sticky',
  top: 0,
};
const TD: CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.4,
  color: tokens.text,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  borderBottom: `1px solid ${tokens.border}`,
  whiteSpace: 'nowrap',
};

const PAGE_SIZE = 50;

/** Sortable columns → the backend `sort` key it maps to. */
const COLUMNS: {
  key: string; label: string; sort?: string; render: (c: VesselCall) => ReactNode;
}[] = [
  { key: 'vcn', label: 'VCN', sort: 'vcn', render: (c) => c.vcn || '—' },
  { key: 'vessel', label: 'Vessel', sort: 'vessel_name', render: (c) => c.vesselName || '—' },
  { key: 'via', label: 'VIA', sort: 'via_no', render: (c) => c.viaNo || '—' },
  { key: 'voyage', label: 'Voyage', render: (c) => c.voyageNo || '—' },
  // Terminal shows the resolved CODE, not the FK id — '—' when the PCS code carried only
  // the port (INJNP1), which declares no terminal.
  { key: 'terminal', label: 'Terminal', sort: 'terminal_id', render: (c) => c.terminalCode || '—' },
  // Berth is allotted by BERALT — '—' means "not yet allotted", a lifecycle stage rather
  // than missing data, so it reads the same as any other unreached milestone.
  { key: 'berth', label: 'Berth', sort: 'berth_id', render: (c) => c.berthCode || '—' },
  // Operational state from the backend projection when it has one, else the stored parser
  // stage. Same precedence the detail pane uses, so the table and the timeline agree.
  // `sort` stays on the STORED column — that is what the gateway can order by.
  { key: 'status', label: 'Status', sort: 'status',
    render: (c) => {
      const v = c.lifecycle?.status || c.status;
      return v ? <StatusChip label={v} tone={lifecycleTone(v)} /> : '—';
    } },
  { key: 'eta', label: 'ETA', sort: 'eta', render: (c) => fmt(c.eta) },
  // BERMAN's EDB — the expected berthing time. It was returned by the API and rendered
  // nowhere, so the berth-application step was invisible except as a status change.
  { key: 'etb', label: 'ETB', sort: 'etb', render: (c) => fmt(c.etb) },
  { key: 'ata', label: 'ATA', sort: 'ata', render: (c) => fmt(c.ata) },
  { key: 'atd', label: 'ATD', sort: 'atd', render: (c) => fmt(c.atd) },
  { key: 'updated', label: 'Updated', sort: 'updated_at', render: (c) => fmt(c.updatedAt) },
];

/** epoch ms → IST string, or '—' when unknown (0). */
function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

export function VesselCallsTable({
  onRowClick,
  selectedCallId,
}: {
  onRowClick: (call: VesselCall) => void;
  selectedCallId: number | null;
}) {
  const [vessel, setVessel] = useState('');
  const [inPort, setInPort] = useState(false);
  const [sort, setSort] = useState('updated_at');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);
  // Refetch whenever a manual pilot/craft action changes backend lifecycle state.
  const marineVersion = useMarineStateVersion();


  const filters: VesselCallFilters = {
    vessel: vessel.trim() || undefined,
    inPort: inPort || undefined,
    sort,
    direction,
  };

  const q = useAdapterQuery(
    () => fetchVesselCallsPage(filters, PAGE_SIZE, offset),
    [vessel, inPort, sort, direction, offset, marineVersion],
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
      {/* Toolbar: search + in-port filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search vessel name…"
          value={vessel}
          style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) => {
            setOffset(0);
            setVessel((e.target as unknown as { value: string }).value);
          }}
        />
        <CalciteLabel layout="inline" scale="s" style={{ margin: 0 }}>
          <CalciteCheckbox
            checked={inPort || undefined}
            onCalciteCheckboxChange={(e) => {
              setOffset(0);
              setInPort((e.target as unknown as { checked: boolean }).checked);
            }}
          />
          In port only
        </CalciteLabel>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {from}–{to} of {total}
        </span>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {q.loading && !page ? (
          <PanelLoading label="Loading vessel calls…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No vessel calls yet. Use the Data Upload sub-tab to import a vessel-call CSV." />
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
              {rows.map((c) => {
                const active = c.callId === selectedCallId;
                return (
                  <tr
                    key={c.callId}
                    onClick={() => onRowClick(c)}
                    style={{ cursor: 'pointer', background: active ? tokens.panelAlt : undefined }}
                  >
                    {COLUMNS.map((col) => (
                      <td
                        key={col.key}
                        style={{
                          ...TD,
                          fontWeight: col.key === 'vcn' ? 600 : undefined,
                          color: col.key === 'updated' ? tokens.textMuted : TD.color,
                          fontVariantNumeric: ['eta', 'ata', 'atd', 'updated'].includes(col.key) ? 'tabular-nums' : undefined,
                        }}
                      >
                        {col.render(c)}
                      </td>
                    ))}
                  </tr>
                );
              })}
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
