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
 *
 * The ONE exception is an active search. The gateway AND-s its filters and has no
 * OR/`q` parameter, so a box meaning "name OR VCN OR VIA OR voyage" is assembled by
 * fanning out one request per identifier and merging — which means the merged set is
 * ordered and paged in the browser. `truncated` reports when that set hit the
 * per-field ceiling, so the row count is never silently short.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  CalciteButton,
  CalciteInput,
  CalciteCheckbox,
  CalciteLabel,
} from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { useMarineStateVersion } from '@/data/uc3/marineStateBus';
import {
  fetchVesselCallsPage,
  searchVesselCallsPage,
  SEARCH_FETCH_LIMIT,
  type VesselCallFilters,
} from '@/data/uc3/marineCalls';
import type { VesselCall } from '@/types/domain';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { StatusChip } from '@/components/shipping/dataTable';
import { lifecycleTone } from '@/components/marine/lifecycleTone';
import { assessRecord } from '@/data/quality/dataQuality';
import { VESSEL_CALL_QUALITY } from '@/data/quality/datasets';
import { AnomalyBadge } from '@/components/common/AnomalyBadge';
import { ShowAnomalyToggle } from '@/components/common/ShowAnomalyToggle';
import { PilotCell } from '@/components/marine/PilotCell';
import { usePilotDesk } from '@/components/marine/usePilotDesk';
import { CalciteNotice } from '@esri/calcite-components-react';
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
  // Sticky alone is not enough. `position: sticky` makes the header a POSITIONED
  // element with `z-index: auto`, so it paints in DOM order against other positioned
  // elements — and a Calcite button in a row below establishes its own stacking
  // context, so it painted OVER the header as the row scrolled under it. Plain text
  // cells never showed this because unpositioned content always paints beneath.
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

const PAGE_SIZE = 50;

/** Sortable columns → the backend `sort` key it maps to. */
const COLUMNS: {
  key: string;
  label: string;
  sort?: string;
  /**
   * Absent for the Pilot column ONLY: its cell needs the open-picker state and the
   * mutation handles, which a module constant cannot reach. Its POSITION is still
   * declared here so header order and cell order cannot drift apart.
   */
  render?: (c: VesselCall) => ReactNode;
}[] = [
  // The badge marks the ROW and rides with its primary identifier. Computed in the view
  // model on read (see data/quality) — nothing is persisted and no request changes.
  {
    key: 'vcn',
    label: 'VCN',
    sort: 'vcn',
    render: (c) => (
      <>
        {c.vcn || '—'}
        <AnomalyBadge
          result={assessRecord(c, VESSEL_CALL_QUALITY)}
          dataset={VESSEL_CALL_QUALITY.dataset}
        />
      </>
    ),
  },
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
  {
    key: 'status',
    label: 'Status',
    sort: 'status',
    render: (c) => {
      const v = c.lifecycle?.status || c.status;
      return v ? <StatusChip label={v} tone={lifecycleTone(v)} /> : '—';
    },
  },
  // No `sort`: pilot state is DERIVED by the projection and has no column in
  // core.vessel_call for the gateway to ORDER BY. A clickable header would promise
  // an ordering the backend cannot deliver.
  { key: 'pilot', label: 'Pilot' },
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
  // One box across every identifier the row carries, not the vessel name alone.
  // Most corpus calls are seeded by a CALINF seconds before a name is known, so a
  // name-only search could not reach them at all — the operator has a VCN, a VIA or
  // a voyage off the manifest and nothing else. See searchVesselCallsPage().
  const [search, setSearch] = useState('');
  const [inPort, setInPort] = useState(false);
  const [sort, setSort] = useState('updated_at');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [offset, setOffset] = useState(0);
  // Default ON: the table behaves exactly as before until an operator opts out.
  const [showAnomalies, setShowAnomalies] = useState(true);
  // Refetch whenever a manual pilot/craft action changes backend lifecycle state.
  const marineVersion = useMarineStateVersion();
  // Pilot identities, the manual-assignment ids Board/Release target, and the free-pilot
  // register. Pilot STATE is not fetched — it already rides on every call row.
  const desk = usePilotDesk();
  // At most one open picker in the table: two would mean two pending writes against a
  // register whose availability the first one changes.
  const [pickerCallId, setPickerCallId] = useState<number | null>(null);
  const [pickerPilotId, setPickerPilotId] = useState('');

  const term = search.trim();
  // The identifier fields are deliberately absent here: when a term is typed the
  // search owns them (it fans one request out per field and merges), and when it is
  // not there is nothing to constrain. Everything else AND-s as before either way.
  const filters: VesselCallFilters = {
    inPort: inPort || undefined,
    sort,
    direction,
  };

  const q = useAdapterQuery(
    () =>
      term
        ? searchVesselCallsPage(term, filters, PAGE_SIZE, offset)
        : fetchVesselCallsPage(filters, PAGE_SIZE, offset),
    [term, inPort, sort, direction, offset, marineVersion]
  );

  /** Any change of the visible page invalidates an open picker — the row may be gone. */
  const closePicker = () => {
    setPickerCallId(null);
    setPickerPilotId('');
  };

  const toggleSort = (col: (typeof COLUMNS)[number]) => {
    if (!col.sort) return;
    closePicker();
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
  // Only a fanned-out search can be capped; the plain paged fetch always reports a
  // true total, so it has no `truncated` field and this stays false.
  const truncated = (page as { truncated?: boolean } | null)?.truncated ?? false;
  const fetched = page?.items ?? [];
  // Filtering is applied to the FETCHED PAGE, because this table is paginated and sorted
  // SERVER-side and the rule requires no API change. Hiding anomalies therefore thins the
  // current page rather than re-paginating the whole set — so the count below reports what
  // was removed instead of silently showing a short page.
  const rows = showAnomalies
    ? fetched
    : fetched.filter((c) => !assessRecord(c, VESSEL_CALL_QUALITY).isAnomaly);
  const hiddenOnPage = fetched.length - rows.length;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {desk.actionError && (
        <CalciteNotice
          open
          kind="danger"
          scale="s"
          icon="exclamation-mark-triangle"
          closable
          style={{ marginBottom: tokens.space.sm }}
          onCalciteNoticeClose={desk.clearActionError}
        >
          <div slot="title">Pilot action refused</div>
          <div slot="message">{desk.actionError}</div>
        </CalciteNotice>
      )}

      {/* Toolbar: search + in-port filter */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space.md,
          paddingBottom: tokens.space.sm,
          flexWrap: 'wrap',
        }}
      >
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search vessel / VCN / VIA / voyage…"
          title="Matches any one of: Vessel Name · VCN · VIA · Voyage No"
          style={{ maxWidth: 260 }}
          onCalciteInputInput={(e) => {
            closePicker();
            setOffset(0);
            setSearch((e.target as unknown as { value: string }).value);
          }}
        />
        <CalciteLabel layout="inline" scale="s" style={{ margin: 0 }}>
          <CalciteCheckbox
            checked={inPort || undefined}
            onCalciteCheckboxChange={(e) => {
              closePicker();
              setOffset(0);
              setInPort((e.target as unknown as { checked: boolean }).checked);
            }}
          />
          In port only
        </CalciteLabel>
        <ShowAnomalyToggle
          checked={showAnomalies}
          onChange={setShowAnomalies}
          hiddenCount={hiddenOnPage}
        />
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            color: tokens.textMuted,
            fontVariantNumeric: 'tabular-nums',
          }}
          // A capped search set makes `total` a floor rather than the count, and the
          // operator has to know that before concluding a vessel is not in the corpus.
          title={truncated ? `First ${SEARCH_FETCH_LIMIT} matches per identifier` : undefined}
        >
          {from}–{to} of {total}
          {truncated && '+'}
        </span>
      </div>

      {/* Body */}
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          minHeight: 0,
          border: `1px solid ${tokens.border}`,
          borderRadius: tokens.radius.sm,
        }}
      >
        {q.loading && !page ? (
          <PanelLoading label="Loading vessel calls…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty
              message={
                term
                  ? `No call matches “${term}” by vessel name, VCN, VIA or voyage.`
                  : 'No vessel calls yet. Use the Data Upload sub-tab to import a vessel-call CSV.'
              }
            />
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
                    aria-sort={
                      c.sort && c.sort === sort
                        ? direction === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : 'none'
                    }
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
                          fontVariantNumeric: ['eta', 'ata', 'atd', 'updated'].includes(col.key)
                            ? 'tabular-nums'
                            : undefined,
                        }}
                      >
                        {col.key === 'pilot' ? (
                          <PilotCell
                            call={c}
                            desk={desk}
                            open={pickerCallId === c.callId}
                            onOpenChange={(o) => {
                              setPickerCallId(o ? c.callId : null);
                              setPickerPilotId('');
                            }}
                            pilotId={pickerPilotId}
                            onPilotIdChange={setPickerPilotId}
                          />
                        ) : (
                          col.render?.(c)
                        )}
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.space.sm,
          paddingTop: tokens.space.sm,
        }}
      >
        <CalciteButton
          scale="s"
          appearance="outline"
          iconStart="chevron-left"
          disabled={offset === 0 || undefined}
          onClick={() => {
            closePicker();
            setOffset(Math.max(0, offset - PAGE_SIZE));
          }}
        >
          Prev
        </CalciteButton>
        <CalciteButton
          scale="s"
          appearance="outline"
          iconEnd="chevron-right"
          disabled={to >= total || undefined}
          onClick={() => {
            closePicker();
            setOffset(offset + PAGE_SIZE);
          }}
        >
          Next
        </CalciteButton>
      </div>
    </div>
  );
}
