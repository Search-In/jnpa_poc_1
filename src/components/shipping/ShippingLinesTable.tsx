/**
 * <ShippingLinesTable> — the shared JNPA carrier registry, shown inside the
 * Shipping Lines ▸ Carrier Registry tab. Reads `/api/shipping-lines/lines` via the
 * UC-3 connector and renders the UC-1 table idiom through the shared Shipping Lines
 * table primitives.
 *
 * This is a reference registry (carrier code + container attribution), populated as a
 * side effect of the advance-list (IAL/EAL) imports — distinct from the live-AIS feed
 * and the vessel-call spine. Empty until an advance list is uploaded.
 *
 * ALL REFINEMENT IS EXACT HERE, unlike the document tables. The registry is a small
 * reference set (tens of carriers) and the gateway caps this list at 1000 rows, so a
 * single request holds the whole thing; search, both filters, sorting and pagination
 * therefore operate on the complete registry rather than on a window. The endpoint
 * accepts no filter or sort parameters at all, so client-side is the only option —
 * and at this size it is also the correct one.
 *
 * Columns and the API call are unchanged from the original implementation; the search
 * box, the two filters, sortable headers and the pager are additive.
 */

import { useMemo, useState } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchShippingLines } from '@/data/uc3/shippingLines';
import type { ShippingLine } from '@/types/domain';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';
import {
  FilterSelect, Pager, ResetButton, ScopeNote, SearchBox, SortableTh,
  TableFrame, TableShell,
} from '@/components/shipping/dataTable';
import {
  TABLE, TD, TOOLBAR, matchesAny, nextSort, paginate, sortRows, useOptions,
  type SortState, type SortValue,
} from '@/components/shipping/tableUtils';

const PAGE_SIZE = 15;
const NO_ROWS: ShippingLine[] = [];

/** Container-availability filter — carriers actually carrying boxes vs. code-only rows. */
const AVAILABILITY = ['With containers', 'Without containers'];

/** epoch ms → IST string, or '—' when unknown (0). */
function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

const SORT_VALUE: Record<string, (l: ShippingLine) => SortValue> = {
  code: (l) => l.lineCode,
  name: (l) => l.lineName,
  source: (l) => l.source,
  containers: (l) => l.containerCount,
  first: (l) => l.firstSeen,
  last: (l) => l.lastSeen,
};

const COLUMNS: { key: string; label: string; render: (l: ShippingLine) => string; num?: boolean }[] = [
  { key: 'code', label: 'Line Code', render: (l) => l.lineCode || '—' },
  { key: 'name', label: 'Name', render: (l) => l.lineName || '—' },
  { key: 'source', label: 'Source', render: (l) => l.source || '—' },
  { key: 'containers', label: 'Containers', render: (l) => String(l.containerCount), num: true },
  { key: 'first', label: 'First Seen', render: (l) => fmt(l.firstSeen) },
  { key: 'last', label: 'Last Seen', render: (l) => fmt(l.lastSeen) },
];

export function ShippingLinesTable() {
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [availability, setAvailability] = useState('');
  // Busiest-first is the server's own ordering, so it stays the default view.
  const [sort, setSort] = useState<SortState>({ key: 'containers', dir: 'desc' });
  const [offset, setOffset] = useState(0);

  const query = useAdapterQuery(() => fetchShippingLines(), []);

  const loaded = query.data ?? NO_ROWS;
  const sourceOptions = useOptions(loaded, (l) => l.source);

  const refined = useMemo(
    () =>
      loaded.filter((l) => {
        if (source && l.source !== source) return false;
        if (availability === 'With containers' && l.containerCount <= 0) return false;
        if (availability === 'Without containers' && l.containerCount > 0) return false;
        return matchesAny(search, l.lineCode, l.lineName);
      }),
    [loaded, search, source, availability],
  );

  const sorted = useMemo(
    () => sortRows(refined, SORT_VALUE[sort.key] ?? SORT_VALUE.containers, sort.dir),
    [refined, sort],
  );

  const { page, total, from, to } = paginate(sorted, offset, PAGE_SIZE);

  const dirty = !!(search || source || availability);
  const reset = () => { setSearch(''); setSource(''); setAvailability(''); setOffset(0); };
  const bind = <T,>(set: (v: T) => void) => (v: T) => { setOffset(0); set(v); };

  return (
    <TableShell>
      <div style={TOOLBAR}>
        <SearchBox placeholder="Search line code / name…" value={search} onChange={bind(setSearch)} />
        <FilterSelect label="Filter by source" value={source} onChange={bind(setSource)} options={sourceOptions} allLabel="All sources" />
        <FilterSelect label="Filter by container availability" value={availability} onChange={bind(setAvailability)} options={AVAILABILITY} allLabel="Any container count" />
        {dirty && <ResetButton onClick={reset} />}
        {/* The whole registry is resident, so loaded === serverTotal and ScopeNote
            never shows a shortfall warning. */}
        <ScopeNote from={from} to={to} filtered={total} loaded={loaded.length} serverTotal={loaded.length} noun="lines" />
      </div>

      <TableFrame
        loading={query.loading && !query.data}
        error={query.error}
        loadedCount={loaded.length}
        visibleCount={page.length}
        loadingLabel="Loading shipping-line registry…"
        emptyMessage="No shipping lines yet. Upload an advance list (IAL/EAL) from the Data Upload tab."
        noMatchMessage="No shipping lines match the current search or filters."
      >
        <table style={TABLE}>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <SortableTh
                  key={c.key}
                  label={c.label}
                  sortKey={c.key}
                  sort={sort}
                  onSort={(k) => { setOffset(0); setSort((s) => nextSort(s, k)); }}
                  numeric={c.num}
                />
              ))}
            </tr>
          </thead>
          <tbody>
            {page.map((l) => (
              <tr key={l.lineCode}>
                {COLUMNS.map((col) => (
                  <td
                    key={col.key}
                    style={{
                      ...TD,
                      textAlign: col.num ? 'right' : 'left',
                      fontWeight: col.key === 'code' ? 600 : undefined,
                      color: col.key === 'first' || col.key === 'last' ? tokens.textMuted : TD.color,
                      fontVariantNumeric:
                        col.num || col.key === 'first' || col.key === 'last' ? 'tabular-nums' : undefined,
                    }}
                  >
                    {col.render(l)}
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
