/**
 * <ShippingLinesUploadHistory> — the import ledger shown beneath the upload panel on
 * Shipping Lines ▸ Data Upload.
 *
 * Reads `GET /api/shipping-lines/uploads` through the existing uc3/shippingDocs
 * connector. No endpoint, parameter or response shape is changed, and the upload
 * WRITE path (validate → import) is untouched — that stays entirely inside
 * <ShippingLinesUploadPanel>.
 *
 * WHERE EACH REFINEMENT IS RESOLVED:
 *   SERVER  · list type → `list_type`, status → `status`, source → `source`
 *   CLIENT  · file-name search and upload-date range (returned, not filterable)
 *           · every column sort (no `sort` param)
 *
 * The gateway defaults `source` to 'UPLOAD' (UI imports only); the filter here can
 * widen that to 'DIRECTORY' (the bulk importer) or to both, which is why an explicit
 * value is always sent.
 */

import { useMemo, useState } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import {
  fetchShippingUploadsPage,
  SHIPPING_UPLOADS_PAGE_LIMIT,
  type ShippingUploadFilters,
} from '@/data/uc3/shippingDocs';
import type { ShippingUploadFile } from '@/types/domain';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';
import {
  DateRange, FilterSelect, Pager, ResetButton, ScopeNote, SearchBox, SortableTh,
  StatusChip, TableFrame, TableShell,
} from '@/components/shipping/dataTable';
import {
  TABLE, TD, TH, TOOLBAR, inDateRange, matchesAny, nextSort, paginate, sortRows,
  type SortState, type SortValue,
} from '@/components/shipping/tableUtils';

const PAGE_SIZE = 15;
const NO_ROWS: ShippingUploadFile[] = [];

const LIST_TYPES = ['IAL', 'EAL', 'EDO'];
const STATUSES = ['SUCCESS', 'PARTIAL', 'FAILED', 'SKIPPED_DUPLICATE', 'PENDING'];
/** '' means "both", which the gateway expresses by omitting `source`. */
const SOURCES = ['UPLOAD', 'DIRECTORY'];

/** Same tone mapping the upload panel already uses for its status strings. */
function statusTone(s: string): 'good' | 'warn' | 'bad' | 'muted' {
  if (s === 'SUCCESS') return 'good';
  if (s === 'PARTIAL' || s === 'SKIPPED_DUPLICATE') return 'warn';
  if (s === 'PENDING') return 'muted';
  return 'bad';
}

const SORT_VALUE: Record<string, (r: ShippingUploadFile) => SortValue> = {
  file: (r) => r.sourceFile,
  list: (r) => r.listType,
  terminal: (r) => r.terminal,
  format: (r) => r.physicalFormat,
  records: (r) => r.recordCount,
  imported: (r) => r.importedCount,
  errors: (r) => r.errorCount,
  status: (r) => r.importStatus,
  by: (r) => r.uploadedBy,
  created: (r) => r.createdAt,
};

const COLUMNS: {
  key: string; label: string; numeric?: boolean; sortable?: boolean; wrap?: boolean;
  render: (r: ShippingUploadFile) => React.ReactNode;
}[] = [
  { key: 'file', label: 'File Name', sortable: true, wrap: true, render: (r) => r.sourceFile || '—' },
  { key: 'list', label: 'Type', sortable: true, render: (r) => r.listType || '—' },
  { key: 'terminal', label: 'Terminal', sortable: true, render: (r) => r.terminal || '—' },
  { key: 'format', label: 'Format', sortable: true, render: (r) => r.physicalFormat || '—' },
  { key: 'records', label: 'Records', numeric: true, sortable: true, render: (r) => String(r.recordCount) },
  { key: 'imported', label: 'Imported', numeric: true, sortable: true, render: (r) => String(r.importedCount) },
  { key: 'errors', label: 'Errors', numeric: true, sortable: true, render: (r) => String(r.errorCount) },
  { key: 'status', label: 'Status', sortable: true, render: (r) => <StatusChip label={r.importStatus} tone={statusTone(r.importStatus)} /> },
  { key: 'by', label: 'Uploaded By', sortable: true, render: (r) => r.uploadedBy || '—' },
  { key: 'created', label: 'Uploaded At', sortable: true, render: (r) => (r.createdAt ? istDateTime(r.createdAt) : '—') },
];

export function ShippingLinesUploadHistory({ refreshKey = 0 }: { refreshKey?: number }) {
  const [search, setSearch] = useState('');
  const [listType, setListType] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'created', dir: 'desc' });
  const [offset, setOffset] = useState(0);

  const filters: ShippingUploadFilters = {
    listType: listType || undefined,
    status: status || undefined,
    // Omitting `source` lets the gateway apply its 'UPLOAD' default; an explicit
    // value is only sent when the operator picks one.
    source: source || undefined,
  };

  const query = useAdapterQuery(
    () => fetchShippingUploadsPage(filters, SHIPPING_UPLOADS_PAGE_LIMIT, 0),
    [listType, status, source, refreshKey],
  );

  const loaded = query.data?.items ?? NO_ROWS;
  const serverTotal = query.data?.total ?? 0;

  const refined = useMemo(
    () => loaded.filter((r) => matchesAny(search, r.sourceFile) && inDateRange(r.createdAt, dateFrom, dateTo)),
    [loaded, search, dateFrom, dateTo],
  );

  const sorted = useMemo(
    () => sortRows(refined, SORT_VALUE[sort.key] ?? SORT_VALUE.created, sort.dir),
    [refined, sort],
  );

  const { page, total, from, to } = paginate(sorted, offset, PAGE_SIZE);

  const dirty = !!(search || listType || status || source || dateFrom || dateTo);
  const reset = () => {
    setSearch(''); setListType(''); setStatus(''); setSource('');
    setDateFrom(''); setDateTo(''); setOffset(0);
  };
  const bind = <T,>(set: (v: T) => void) => (v: T) => { setOffset(0); set(v); };

  return (
    <TableShell>
      <div style={TOOLBAR}>
        <SearchBox placeholder="Search file name…" value={search} onChange={bind(setSearch)} width={220} />
        <FilterSelect label="Filter by document type" value={listType} onChange={bind(setListType)} options={LIST_TYPES} allLabel="All types" />
        <FilterSelect label="Filter by status" value={status} onChange={bind(setStatus)} options={STATUSES} allLabel="All statuses" />
        <FilterSelect label="Filter by source" value={source} onChange={bind(setSource)} options={SOURCES} allLabel="UI uploads (default)" />
        <DateRange label="Uploaded" from={dateFrom} to={dateTo} onFrom={bind(setDateFrom)} onTo={bind(setDateTo)} />
        {dirty && <ResetButton onClick={reset} />}
        <ScopeNote from={from} to={to} filtered={total} loaded={loaded.length} serverTotal={serverTotal} noun="files" />
      </div>

      <TableFrame
        loading={query.loading && !query.data}
        error={query.error}
        loadedCount={loaded.length}
        visibleCount={page.length}
        loadingLabel="Loading upload history…"
        emptyMessage="No uploads yet. Validate and import an IAL / EAL / EDO file above."
        noMatchMessage="No uploads match the current search or filters."
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
                      fontWeight: c.key === 'file' ? 600 : undefined,
                      whiteSpace: c.wrap ? 'normal' : 'nowrap',
                      maxWidth: c.wrap ? 280 : undefined,
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
