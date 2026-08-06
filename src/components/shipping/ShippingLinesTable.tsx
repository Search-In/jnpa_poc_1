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

import { useMemo, useState, type ReactNode } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchShippingLines } from '@/data/uc3/shippingLines';
import {
  fetchCarrierLifecycleMap, type CarrierLifecycle,
} from '@/data/uc3/shippingLinesState';
import { AnomalyMark } from '@/components/marine/AnomalyMark';
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

/**
 * A registry row joined to its lifecycle tally. `lc` is undefined when the carrier has no
 * resolved vessel visit — the lifecycle columns then render '—' rather than 0, because
 * "no vessel tracked" and "zero vessels in port" are different facts.
 */
type Row = ShippingLine & { lc?: CarrierLifecycle };

/**
 * Count → text. '—' unless the carrier has at least one CORRELATED visit: a real 0
 * ("no vessel in port") is worth showing, a fabricated 0 for a carrier nothing resolved
 * for is not.
 */
function count(lc: CarrierLifecycle | undefined, pick: (l: CarrierLifecycle) => number): string {
  return lc && lc.activeVessels > 0 ? String(pick(lc)) : '—';
}

/**
 * Tooltip for the correlation warning. Reports ONLY what the gateway returned: how many
 * of the carrier's advance-list visits resolved to no vessel call, and — as context, not
 * as a second warning — how many matched by the weaker composite rule.
 */
function correlationReason(lc: CarrierLifecycle): string {
  const n = lc.unmatchedVisits;
  const head = `${n} vessel visit${n === 1 ? '' : 's'} could not be correlated to a vessel call`;
  return lc.compositeMatches > 0
    ? `${head}. ${lc.compositeMatches} of ${lc.activeVessels} matched visit`
      + `${lc.activeVessels === 1 ? '' : 's'} resolved by vessel-code prefix, not by VIA.`
    : `${head}.`;
}

/** Container-availability filter — carriers actually carrying boxes vs. code-only rows. */
const AVAILABILITY = ['With containers', 'Without containers'];

/** epoch ms → IST string, or '—' when unknown (0). */
function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

const SORT_VALUE: Record<string, (l: Row) => SortValue> = {
  code: (l) => l.lineCode,
  name: (l) => l.lineName,
  source: (l) => l.source,
  containers: (l) => l.containerCount,
  first: (l) => l.firstSeen,
  last: (l) => l.lastSeen,
  // Lifecycle columns sort on the raw number/epoch, so a carrier with no data sorts as 0
  // rather than as the string '—'.
  active: (l) => l.lc?.activeVessels ?? 0,
  inport: (l) => l.lc?.inPort ?? 0,
  atberth: (l) => l.lc?.atBerth ?? 0,
  activity: (l) => l.lc?.latestActivity ?? '',
  updated: (l) => l.lc?.lastUpdated ?? 0,
};

const COLUMNS: {
  key: string; label: string; render: (l: Row) => ReactNode; num?: boolean;
}[] = [
  { key: 'code', label: 'Line Code', render: (l) => l.lineCode || '—' },
  { key: 'name', label: 'Name', render: (l) => l.lineName || '—' },
  { key: 'source', label: 'Source', render: (l) => l.source || '—' },
  { key: 'containers', label: 'Containers', render: (l) => String(l.containerCount), num: true },
  { key: 'first', label: 'First Seen', render: (l) => fmt(l.firstSeen) },
  { key: 'last', label: 'Last Seen', render: (l) => fmt(l.lastSeen) },
  // Lifecycle columns — counts of the engine's own verdicts, from
  // /api/marine/state/shipping-lines. Nothing is derived here.
  // The ⚠ marks a VERIFIED correlation failure the gateway reported (`lifecycle: null`
  // on a visit) — never an empty value. Active Vessels is the affected field: it is the
  // count correlation produces, so a failure belongs here and nowhere else.
  { key: 'active', label: 'Active Vessels', num: true,
    render: (l) => (
      <>
        {count(l.lc, (x) => x.activeVessels)}
        {l.lc && l.lc.unmatchedVisits > 0 && (
          <AnomalyMark reason={correlationReason(l.lc)} />
        )}
      </>
    ) },
  { key: 'inport', label: 'In Port', render: (l) => count(l.lc, (x) => x.inPort), num: true },
  { key: 'atberth', label: 'At Berth', render: (l) => count(l.lc, (x) => x.atBerth), num: true },
  { key: 'activity', label: 'Latest Activity', render: (l) => l.lc?.latestActivity || '—' },
  { key: 'updated', label: 'Last Updated', render: (l) => fmt(l.lc?.lastUpdated ?? 0) },
];

export function ShippingLinesTable() {
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [availability, setAvailability] = useState('');
  // Busiest-first is the server's own ordering, so it stays the default view.
  const [sort, setSort] = useState<SortState>({ key: 'containers', dir: 'desc' });
  const [offset, setOffset] = useState(0);

  const query = useAdapterQuery(() => fetchShippingLines(), []);
  // Separate query: the lifecycle tally must never delay or break the registry. It
  // resolves to an empty map on failure, and the lifecycle columns then show '—'.
  const lifecycle = useAdapterQuery(() => fetchCarrierLifecycleMap(), []);

  const registry = query.data ?? NO_ROWS;
  const sourceOptions = useOptions(registry, (l) => l.source);

  // Join by carrier code. Registry rows are never dropped or reordered by this — a
  // carrier with no resolved visit simply carries no `lc`.
  const loaded = useMemo<Row[]>(
    () => registry.map((l) => ({ ...l, lc: lifecycle.data?.get(l.lineCode) })),
    [registry, lifecycle.data],
  );

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
