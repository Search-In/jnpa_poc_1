/**
 * <ShippingLinesAdvanceLists> — the IAL/EAL advance-list container browser
 * (Shipping Lines ▸ Advance Lists).
 *
 * TOOLBAR SHAPE: one global search + two basic filters (list type, terminal) always
 * visible; category / freight / line / POD / date range behind "More filters", which
 * shows a count so a collapsed filter can never silently narrow the result set.
 *
 * Reads `GET /api/shipping-lines` through the existing uc3/shippingDocs connector.
 * No endpoint, parameter or response shape is changed.
 *
 * WHERE EACH REFINEMENT IS RESOLVED — this split is dictated by the gateway, which
 * is frozen, and is the reason <ScopeNote> is always on screen:
 *
 *   SERVER (exact at any data volume, spans the whole dataset)
 *     · list type      → `list_type`   (the All / IAL / EAL selector)
 *     · terminal       → `terminal`
 *     · category       → `category`
 *     · freight status → `freight_kind`
 *     · shipping line  → `shipping_line`
 *     · search         → `q`, an ILIKE over container_no OR bill_of_lading OR
 *                        shipping_line_code
 *
 *   CLIENT (refines the fetched window only — the gateway cannot express these)
 *     · POD                     — returned, not filterable
 *     · voyage / vessel visit    — returned, not filterable, and NOT covered by `q`.
 *                                  Shown as sortable columns; a second, client-scoped
 *                                  search box for them was removed as a duplicate.
 *     · ingest date range        — returned, not filterable
 *     · every column sort        — no list endpoint accepts a `sort` param
 *
 * The window is one request at the gateway's own 1000-row ceiling, so in normal data
 * volumes the entire filtered set is resident and the client refinements are exact.
 * When it is not, ScopeNote says so rather than presenting a partial view as whole.
 */

import { useMemo, useState } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  fetchAdvanceListPage,
  SHIPPING_DOC_PAGE_LIMIT,
  type AdvanceListFilters,
} from '@/data/uc3/shippingDocs';
import type { AdvanceListItem } from '@/types/domain';
import { istDate } from '@/util/format';
import { tokens } from '@/theme/tokens';
import {
  DataNotice, DateRange, FilterSelect, Labelled, MoreFilters, Pager, ResetButton,
  ScopeNote, SearchBox, SortableTh, StatusChip, TableFrame, TableShell,
} from '@/components/shipping/dataTable';
import {
  TABLE, TD, TH, TOOLBAR, inDateRange, nextSort, paginate, sortRows,
  useOptions, type SortState, type SortValue,
} from '@/components/shipping/tableUtils';

const PAGE_SIZE = 25;

/** Fixed server-side vocabularies (the gateway validates these). */
const CATEGORIES = ['IMPORT', 'EXPORT', 'TRANSHIP', 'OTHER'];
const FREIGHT = ['FULL', 'EMPTY'];

/** Which advance-list view is shown. 'all' sends no `list_type` at all. */
export type AdvanceListView = 'all' | 'IAL' | 'EAL';

const NO_ROWS: AdvanceListItem[] = [];

function weight(kg: number | null): string {
  return kg === null ? '—' : `${(kg / 1000).toFixed(3)} t`;
}

function catTone(c: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (c === 'IMPORT') return 'good';
  if (c === 'EXPORT') return 'warn';
  if (c === 'TRANSHIP') return 'bad';
  return 'muted';
}

/** Sort accessors, keyed by column. Kept beside COLUMNS so the two cannot drift. */
const SORT_VALUE: Record<string, (r: AdvanceListItem) => SortValue> = {
  container: (r) => r.containerNo,
  list: (r) => r.listType,
  terminal: (r) => r.terminal,
  line: (r) => r.shippingLineCode,
  category: (r) => r.category,
  freight: (r) => r.freightKind,
  weight: (r) => r.grossWeightKg,
  pod: (r) => r.pod,
  bl: (r) => r.billOfLading,
  visit: (r) => r.vesselVisit,
  voyage: (r) => r.voyage,
  created: (r) => r.createdAt,
};

const COLUMNS: {
  key: string; label: string; numeric?: boolean; sortable?: boolean;
  render: (r: AdvanceListItem) => React.ReactNode;
}[] = [
  { key: 'container', label: 'Container No', sortable: true, render: (r) => r.containerNo || '—' },
  { key: 'iso', label: 'ISO', render: (r) => r.isoCode || '—' },
  { key: 'list', label: 'List', sortable: true, render: (r) => <StatusChip label={r.listType} tone={r.listType === 'IAL' ? 'good' : 'warn'} /> },
  { key: 'terminal', label: 'Terminal', sortable: true, render: (r) => r.terminal || '—' },
  { key: 'line', label: 'Line', sortable: true, render: (r) => r.shippingLineCode || '—' },
  { key: 'category', label: 'Category', sortable: true, render: (r) => <StatusChip label={r.category} tone={catTone(r.category)} /> },
  { key: 'freight', label: 'Freight', sortable: true, render: (r) => <StatusChip label={r.freightKind} tone={r.freightKind === 'FULL' ? 'good' : 'muted'} /> },
  { key: 'weight', label: 'Gross Wt.', numeric: true, sortable: true, render: (r) => weight(r.grossWeightKg) },
  { key: 'pol', label: 'POL', render: (r) => r.pol || '—' },
  { key: 'pod', label: 'POD', sortable: true, render: (r) => r.pod || '—' },
  { key: 'bl', label: 'BL No', sortable: true, render: (r) => r.billOfLading || '—' },
  { key: 'visit', label: 'Vessel Visit', sortable: true, render: (r) => r.vesselVisit || '—' },
  { key: 'voyage', label: 'Voyage', sortable: true, render: (r) => r.voyage || '—' },
  { key: 'created', label: 'Ingested', sortable: true, render: (r) => (r.createdAt ? istDate(r.createdAt) : '—') },
];

export function ShippingLinesAdvanceLists({ view: initialView = 'all' }: { view?: AdvanceListView } = {}) {
  /* server-resolved */
  const [view, setView] = useState<AdvanceListView>(initialView);
  const [q, setQ] = useState('');
  const [terminal, setTerminal] = useState('');
  const [category, setCategory] = useState('');
  const [freightKind, setFreightKind] = useState('');
  const [shippingLine, setShippingLine] = useState('');
  /* client-resolved */
  const [pod, setPod] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: 'created', dir: 'desc' });
  const [offset, setOffset] = useState(0);

  // `q` drives the SearchBox immediately; only this debounced copy feeds the server
  // query, so fast typing no longer refetches (and re-renders) on every keystroke —
  // the race that could re-apply a stale value and drop a character.
  const debouncedQ = useDebouncedValue(q, 250);

  const filters: AdvanceListFilters = {
    listType: view === 'all' ? undefined : view,
    terminal: terminal || undefined,
    category: category || undefined,
    freightKind: freightKind || undefined,
    shippingLine: shippingLine || undefined,
    q: debouncedQ.trim() || undefined,
  };

  // One window per server-filter change. `view` is a dep because it maps to list_type.
  const query = useAdapterQuery(
    () => fetchAdvanceListPage(filters, SHIPPING_DOC_PAGE_LIMIT, 0),
    [view, terminal, category, freightKind, shippingLine, debouncedQ],
  );

  const loaded = query.data?.items ?? NO_ROWS;
  const serverTotal = query.data?.total ?? 0;

  // Options come from the loaded window — the gateway exposes no distinct-value
  // endpoint for these, so they reflect what is actually on screen.
  const terminalOptions = useOptions(loaded, (r) => r.terminal);
  const lineOptions = useOptions(loaded, (r) => r.shippingLineCode);
  const podOptions = useOptions(loaded, (r) => r.pod);

  const refined = useMemo(
    () => loaded.filter((r) => (!pod || r.pod === pod) && inDateRange(r.createdAt, dateFrom, dateTo)),
    [loaded, pod, dateFrom, dateTo],
  );

  const sorted = useMemo(
    () => sortRows(refined, SORT_VALUE[sort.key] ?? SORT_VALUE.created, sort.dir),
    [refined, sort],
  );

  const { page, total, from, to } = paginate(sorted, offset, PAGE_SIZE);

  /** Filters hidden behind "More filters" — counted on the button so a collapsed
   *  filter can never silently narrow the table. */
  const advancedCount = [category, freightKind, shippingLine, pod, dateFrom || dateTo]
    .filter(Boolean).length;
  const dirty = !!(q || terminal || view !== 'all' || advancedCount);
  const reset = () => {
    setView('all'); setQ(''); setTerminal(''); setCategory(''); setFreightKind('');
    setShippingLine(''); setPod(''); setDateFrom(''); setDateTo(''); setOffset(0);
  };
  /** Every refinement resets the pager, so `offset` can never point past the end. */
  const bind = <T,>(set: (v: T) => void) => (v: T) => { setOffset(0); set(v); };

  return (
    <TableShell>
      <div style={TOOLBAR}>
        {/* PRIMARY: one global search, resolved server-side over container_no /
            bill_of_lading / shipping_line_code — spans the whole dataset. */}
        <SearchBox
          placeholder="Search container, BL, vessel…"
          value={q}
          onChange={bind(setQ)}
          width={280}
        />

        {/* BASIC: the two filters an operator reaches for daily. List type was a
            nested All/IAL/EAL tab strip; as a dropdown it sits with the other
            filters instead of hiding a filter inside navigation. */}
        <FilterSelect
          label="Filter by list type"
          value={view === 'all' ? '' : view}
          onChange={bind((v: string) => setView((v || 'all') as AdvanceListView))}
          options={['IAL', 'EAL']}
          allLabel="All list types"
        />
        <FilterSelect
          label="Filter by terminal"
          value={terminal}
          onChange={bind(setTerminal)}
          options={terminalOptions}
          allLabel="All terminals"
        />

        {dirty && <ResetButton onClick={reset} />}
        <ScopeNote from={from} to={to} filtered={total} loaded={loaded.length} serverTotal={serverTotal} noun="containers" />

        {/* ADVANCED: everything less frequently used. */}
        <MoreFilters open={moreOpen} onToggle={() => setMoreOpen((o) => !o)} activeCount={advancedCount}>
          <Labelled label="Category">
            <FilterSelect label="Filter by category" value={category} onChange={bind(setCategory)} options={CATEGORIES} allLabel="All categories" />
          </Labelled>
          <Labelled label="Freight">
            <FilterSelect label="Filter by freight status" value={freightKind} onChange={bind(setFreightKind)} options={FREIGHT} allLabel="Full & empty" />
          </Labelled>
          <Labelled label="Line">
            <FilterSelect label="Filter by shipping line" value={shippingLine} onChange={bind(setShippingLine)} options={lineOptions} allLabel="All lines" />
          </Labelled>
          <Labelled label="POD">
            <FilterSelect label="Filter by port of discharge" value={pod} onChange={bind(setPod)} options={podOptions} allLabel="All PODs" />
          </Labelled>
          <Labelled label="Ingested">
            <DateRange label="Ingested" from={dateFrom} to={dateTo} onFrom={bind(setDateFrom)} onTo={bind(setDateTo)} />
          </Labelled>
        </MoreFilters>

        <DataNotice skipped={query.data?.skipped ?? 0} serverTotal={serverTotal} loaded={loaded.length} />
      </div>

      <TableFrame
        loading={query.loading && !query.data}
        error={query.error}
        loadedCount={loaded.length}
        visibleCount={page.length}
        loadingLabel="Loading advance lists…"
        emptyMessage="No advance-list rows yet. Upload an IAL or EAL from the Data Upload tab."
        noMatchMessage="No advance-list rows match the current search or filters."
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
                      fontWeight: c.key === 'container' ? 600 : undefined,
                      color: c.key === 'created' ? tokens.textMuted : TD.color,
                      fontVariantNumeric: c.numeric || c.key === 'created' ? 'tabular-nums' : undefined,
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
