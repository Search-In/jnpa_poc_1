/**
 * <ShippingLinesDeliveryOrders> — the EDO / CODECO delivery-order browser
 * (Shipping Lines ▸ Delivery Orders).
 *
 * Reads `GET /api/shipping-lines/delivery-orders` through the existing
 * uc3/shippingDocs connector. No endpoint, parameter or response shape is changed.
 *
 * WHERE EACH REFINEMENT IS RESOLVED. This endpoint is the most constrained of the
 * four: the gateway accepts `container` and `vehicle` ONLY, both EXACT matches, and
 * no sort. Everything else is refined over the fetched window, and <ScopeNote>
 * states that scope on screen at all times.
 *
 *   SERVER  · nothing by default — the window is unfiltered and paged at the
 *             gateway's own 1000-row ceiling.
 *   CLIENT  · EDO reference / container / gate pass / vehicle search
 *           · status (equipment status), delivery mode, agent, destination port
 *           · receipt-date range
 *           · every column sort
 *
 * TWO REQUESTED FILTERS ARE ABSENT, AND NOT FAKED:
 *   · Bill of Lading — the gateway's delivery-order projection does not return
 *     `bl_no` at all. There is nothing to search or display. A BL filter here
 *     needs a backend change; showing a dead control would be worse than omitting it.
 *   · Terminal — likewise not returned by the projection.
 * The closest available carrier field is `shipping_agent_code`, which is a customs
 * AGENT code and not the registry's carrier code, so it is labelled "Agent" rather
 * than "Shipping Line" to avoid implying a join that does not hold.
 */

import { useMemo, useState } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchDeliveryOrderPage, SHIPPING_DOC_PAGE_LIMIT } from '@/data/uc3/shippingDocs';
import type { DeliveryOrder } from '@/types/domain';
import { istDate } from '@/util/format';
import { tokens } from '@/theme/tokens';
import {
  DataNotice, DateRange, FilterSelect, Labelled, MoreFilters, Pager, ResetButton,
  ScopeNote, SearchBox, SortableTh, StatusChip, TableFrame, TableShell,
} from '@/components/shipping/dataTable';
import {
  TABLE, TD, TH, TOOLBAR, inDateRange, matchesAny, nextSort, paginate, sortRows,
  useOptions, type SortState, type SortValue,
} from '@/components/shipping/tableUtils';

const PAGE_SIZE = 25;
const NO_ROWS: DeliveryOrder[] = [];

/** A gate pass having been issued is the meaningful lifecycle signal on this row. */
function gateTone(r: DeliveryOrder): 'good' | 'warn' | 'muted' {
  if (r.gatePassTs) return 'good';
  if (r.gatePassNo) return 'warn';
  return 'muted';
}

const SORT_VALUE: Record<string, (r: DeliveryOrder) => SortValue> = {
  ref: (r) => r.commonRefNumber,
  container: (r) => r.containerNo,
  status: (r) => r.equipmentStatus,
  agent: (r) => r.shippingAgentCode,
  vcn: (r) => r.vcn,
  pod: (r) => r.destPort,
  mode: (r) => r.deliveryMode,
  gatepass: (r) => r.gatePassNo,
  vehicle: (r) => r.vehicleNo,
  receipt: (r) => r.receiptDate,
  issued: (r) => r.issuedTs,
};

const COLUMNS: {
  key: string; label: string; numeric?: boolean; sortable?: boolean;
  render: (r: DeliveryOrder) => React.ReactNode;
}[] = [
  { key: 'ref', label: 'EDO Ref', sortable: true, render: (r) => r.commonRefNumber || '—' },
  { key: 'container', label: 'Container No', sortable: true, render: (r) => r.containerNo || '—' },
  { key: 'iso', label: 'ISO', render: (r) => r.isoCode || '—' },
  { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusChip label={r.equipmentStatus} tone={r.equipmentStatus ? 'good' : 'muted'} /> },
  { key: 'agent', label: 'Agent', sortable: true, render: (r) => r.shippingAgentCode || '—' },
  { key: 'vcn', label: 'VCN', sortable: true, render: (r) => r.vcn || '—' },
  { key: 'pod', label: 'Dest. Port', sortable: true, render: (r) => r.destPort || r.finalPod || '—' },
  { key: 'mode', label: 'Delivery', sortable: true, render: (r) => r.deliveryMode || '—' },
  { key: 'gatepass', label: 'Gate Pass', sortable: true, render: (r) => <StatusChip label={r.gatePassNo || 'none'} tone={gateTone(r)} /> },
  { key: 'vehicle', label: 'Vehicle', sortable: true, render: (r) => r.vehicleNo || '—' },
  { key: 'receipt', label: 'Receipt', sortable: true, render: (r) => (r.receiptDate ? istDate(r.receiptDate) : '—') },
  { key: 'issued', label: 'Issued', sortable: true, render: (r) => (r.issuedTs ? istDate(r.issuedTs) : '—') },
];

export function ShippingLinesDeliveryOrders() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [agent, setAgent] = useState('');
  const [mode, setMode] = useState('');
  const [pod, setPod] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: 'issued', dir: 'desc' });
  const [offset, setOffset] = useState(0);

  // Unfiltered window: the gateway's only filters are EXACT container/vehicle, which
  // a substring search box cannot use. Refinement happens below.
  const query = useAdapterQuery(() => fetchDeliveryOrderPage({}, SHIPPING_DOC_PAGE_LIMIT, 0), []);

  const loaded = query.data?.items ?? NO_ROWS;
  const serverTotal = query.data?.total ?? 0;

  const statusOptions = useOptions(loaded, (r) => r.equipmentStatus);
  const agentOptions = useOptions(loaded, (r) => r.shippingAgentCode);
  const modeOptions = useOptions(loaded, (r) => r.deliveryMode);
  const podOptions = useOptions(loaded, (r) => r.destPort || r.finalPod);

  const refined = useMemo(
    () =>
      loaded.filter(
        (r) =>
          (!status || r.equipmentStatus === status) &&
          (!agent || r.shippingAgentCode === agent) &&
          (!mode || r.deliveryMode === mode) &&
          (!pod || (r.destPort || r.finalPod) === pod) &&
          matchesAny(search, r.commonRefNumber, r.containerNo, r.gatePassNo, r.vehicleNo) &&
          inDateRange(r.receiptDate, dateFrom, dateTo),
      ),
    [loaded, status, agent, mode, pod, search, dateFrom, dateTo],
  );

  const sorted = useMemo(
    () => sortRows(refined, SORT_VALUE[sort.key] ?? SORT_VALUE.issued, sort.dir),
    [refined, sort],
  );

  const { page, total, from, to } = paginate(sorted, offset, PAGE_SIZE);

  /** Filters hidden behind "More filters" — counted on the button so a collapsed
   *  filter can never silently narrow the table. */
  const advancedCount = [agent, mode, pod, dateFrom || dateTo].filter(Boolean).length;
  const dirty = !!(search || status || advancedCount);
  const reset = () => {
    setSearch(''); setStatus(''); setAgent(''); setMode(''); setPod('');
    setDateFrom(''); setDateTo(''); setOffset(0);
  };
  const bind = <T,>(set: (v: T) => void) => (v: T) => { setOffset(0); set(v); };

  return (
    <TableShell>
      <div style={TOOLBAR}>
        {/* PRIMARY: one search over the EDO reference, container, gate pass and
            vehicle — the four identifiers an operator is handed on the phone. */}
        <SearchBox
          placeholder="Search EDO reference, container…"
          value={search}
          onChange={bind(setSearch)}
          width={280}
        />

        {/* BASIC: status is the one filter used on nearly every visit. */}
        <FilterSelect
          label="Filter by status"
          value={status}
          onChange={bind(setStatus)}
          options={statusOptions}
          allLabel="All statuses"
        />

        {dirty && <ResetButton onClick={reset} />}
        <ScopeNote from={from} to={to} filtered={total} loaded={loaded.length} serverTotal={serverTotal} noun="orders" />

        {/* ADVANCED: agents, delivery modes, destinations, dates. */}
        <MoreFilters open={moreOpen} onToggle={() => setMoreOpen((o) => !o)} activeCount={advancedCount}>
          <Labelled label="Agent">
            <FilterSelect label="Filter by agent" value={agent} onChange={bind(setAgent)} options={agentOptions} allLabel="All agents" />
          </Labelled>
          <Labelled label="Delivery mode">
            <FilterSelect label="Filter by delivery mode" value={mode} onChange={bind(setMode)} options={modeOptions} allLabel="All delivery modes" />
          </Labelled>
          <Labelled label="Destination">
            <FilterSelect label="Filter by destination port" value={pod} onChange={bind(setPod)} options={podOptions} allLabel="All destinations" />
          </Labelled>
          <Labelled label="Receipt date">
            <DateRange label="Receipt date" from={dateFrom} to={dateTo} onFrom={bind(setDateFrom)} onTo={bind(setDateTo)} />
          </Labelled>
        </MoreFilters>

        <DataNotice skipped={query.data?.skipped ?? 0} serverTotal={serverTotal} loaded={loaded.length} />
      </div>

      <TableFrame
        loading={query.loading && !query.data}
        error={query.error}
        loadedCount={loaded.length}
        visibleCount={page.length}
        loadingLabel="Loading delivery orders…"
        emptyMessage="No delivery orders yet. Upload an EDO (CODECO) file from the Data Upload tab."
        noMatchMessage="No delivery orders match the current search or filters."
      >
        <table style={TABLE}>
          <thead>
            <tr>
              {COLUMNS.map((c) =>
                c.sortable ? (
                  <SortableTh
                    key={c.key}
                    label={c.label}
                    sortKey={c.key}
                    sort={sort}
                    onSort={(k) => { setOffset(0); setSort((s) => nextSort(s, k)); }}
                    numeric={c.numeric}
                  />
                ) : (
                  <th key={c.key} style={{ ...TH, textAlign: c.numeric ? 'right' : 'left' }}>{c.label}</th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {page.map((r) => (
              <tr key={r.id}>
                {COLUMNS.map((c) => (
                  <td
                    key={c.key}
                    style={{
                      ...TD,
                      textAlign: c.numeric ? 'right' : 'left',
                      fontWeight: c.key === 'ref' ? 600 : undefined,
                      color: c.key === 'receipt' || c.key === 'issued' ? tokens.textMuted : TD.color,
                      fontVariantNumeric: c.key === 'receipt' || c.key === 'issued' ? 'tabular-nums' : undefined,
                    }}
                  >
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </TableFrame>

      <Pager offset={offset} pageSize={PAGE_SIZE} total={total} onOffset={setOffset} />
    </TableShell>
  );
}
