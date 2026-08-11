/**
 * <PerformanceTrafficTable> — daily container TEU + rail movements
 * (Performance & Reports ▸ Daily Traffic).
 *
 * Reads `GET /api/performance/daily/traffic` (read-only) through the uc3/performance
 * connector. No endpoint, parameter or response shape is changed.
 *
 * FULLY SERVER-DRIVEN, unlike the Shipping Lines tables. This endpoint accepts
 * `from`, `to`, `terminal`, `period`, `sort`, `direction`, `limit` and `offset`, so
 * every filter, the sort and the pagination are resolved by the gateway and span the
 * WHOLE dataset. There is no client-side window here and therefore no scope caveat to
 * display — the row count shown is the server's own `total`.
 *
 * Only the four columns the gateway maps in `_TRAFFIC_SORTS` are sortable; the rest
 * render as plain headers rather than offering a control that would silently fall back
 * to `report_date`.
 */

import { useState } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import {
  fetchPerformanceTrafficPage,
  fetchPerformanceTerminals,
  PERF_PERIODS,
  type PerformanceTrafficFilters,
} from '@/data/uc3/performance';
import type { PerformanceTraffic } from '@/types/domain';
import { tokens } from '@/theme/tokens';
import {
  DateRange, FilterSelect, Labelled, Pager, ResetButton, SortableTh,
  TableFrame, TableShell,
} from '@/components/shipping/dataTable';
import { TABLE, TD, TH, TOOLBAR, nextSort, type SortState } from '@/components/shipping/tableUtils';

const PAGE_SIZE = 25;
const NO_ROWS: PerformanceTraffic[] = [];

/** Column key → the gateway's `sort` value. Only these four are server-sortable. */
const SERVER_SORT: Record<string, string> = {
  date: 'report_date',
  terminal: 'terminal_code',
  total: 'total_teus',
  vessels: 'vessels',
};

function n(v: number | null): string {
  return v === null ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

const COLUMNS: {
  key: string; label: string; numeric?: boolean; render: (r: PerformanceTraffic) => string;
}[] = [
  { key: 'date', label: 'Report Date', render: (r) => r.reportDate || '—' },
  { key: 'terminal', label: 'Terminal', render: (r) => r.terminalCode || '—' },
  { key: 'period', label: 'Grain', render: (r) => r.period || '—' },
  { key: 'vessels', label: 'Vessels', numeric: true, render: (r) => n(r.vessels) },
  { key: 'imp', label: 'Import TEU', numeric: true, render: (r) => n(r.impTeus) },
  { key: 'exp', label: 'Export TEU', numeric: true, render: (r) => n(r.expTeus) },
  { key: 'total', label: 'Total TEU', numeric: true, render: (r) => n(r.totalTeus) },
  { key: 'rakes', label: 'Rakes', numeric: true, render: (r) => n(r.rakes) },
  { key: 'raildis', label: 'Rail Disch.', numeric: true, render: (r) => n(r.railDisTeus) },
  { key: 'railldg', label: 'Rail Load.', numeric: true, render: (r) => n(r.railLdgTeus) },
  { key: 'railtot', label: 'Rail Total', numeric: true, render: (r) => n(r.railTotalTeus) },
];

export function PerformanceTrafficTable() {
  const [terminal, setTerminal] = useState('');
  const [period, setPeriod] = useState('DAY');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'date', dir: 'desc' });
  const [offset, setOffset] = useState(0);

  // Terminal options come from the canonical dimension endpoint, not from the loaded
  // page, so the list is complete regardless of the current filter.
  const terminalsQ = useAdapterQuery(() => fetchPerformanceTerminals(), []);
  const terminalOptions = (terminalsQ.data ?? []).map((t) => t.code);

  const filters: PerformanceTrafficFilters = {
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    terminal: terminal || undefined,
    period: period || undefined,
    sort: SERVER_SORT[sort.key] ?? 'report_date',
    direction: sort.dir,
  };

  const q = useAdapterQuery(
    () => fetchPerformanceTrafficPage(filters, PAGE_SIZE, offset),
    [terminal, period, dateFrom, dateTo, sort.key, sort.dir, offset],
  );

  const rows = q.data?.items ?? NO_ROWS;
  const total = q.data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  const dirty = !!(terminal || dateFrom || dateTo || period !== 'DAY');
  const reset = () => {
    setTerminal(''); setPeriod('DAY'); setDateFrom(''); setDateTo(''); setOffset(0);
  };
  /** Any filter or sort change returns to page 1 — a stale offset would page past the end. */
  const bind = <T,>(set: (v: T) => void) => (v: T) => { setOffset(0); set(v); };

  return (
    <TableShell>
      <div style={TOOLBAR}>
        <Labelled label="Grain">
          <FilterSelect
            label="Filter by aggregation grain"
            value={period}
            onChange={bind(setPeriod)}
            options={[...PERF_PERIODS]}
            allLabel="All grains"
          />
        </Labelled>
        <Labelled label="Terminal">
          <FilterSelect
            label="Filter by terminal"
            value={terminal}
            onChange={bind(setTerminal)}
            options={terminalOptions}
            allLabel="All terminals"
          />
        </Labelled>
        <Labelled label="Report date">
          <DateRange label="Report date" from={dateFrom} to={dateTo} onFrom={bind(setDateFrom)} onTo={bind(setDateTo)} />
        </Labelled>
        {dirty && <ResetButton onClick={reset} />}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {from}–{to} of {total} rows
        </span>
      </div>

      <TableFrame
        loading={q.loading && !q.data}
        error={q.error}
        loadedCount={rows.length}
        visibleCount={rows.length}
        loadingLabel="Loading daily traffic…"
        emptyMessage="No daily traffic rows for the current filters. Import a Daily Status Report under Performance & Reports → Data Upload (admin), then switch to DEMO if needed."
        noMatchMessage="No daily traffic rows match the current filters."
      >
        <table style={TABLE}>
          <thead>
            <tr>
              {COLUMNS.map((c) =>
                SERVER_SORT[c.key] ? (
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
            {rows.map((r) => (
              <tr key={r.id}>
                {COLUMNS.map((c) => (
                  <td
                    key={c.key}
                    style={{
                      ...TD,
                      textAlign: c.numeric ? 'right' : 'left',
                      fontWeight: c.key === 'date' ? 600 : undefined,
                      fontVariantNumeric: c.numeric || c.key === 'date' ? 'tabular-nums' : undefined,
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
