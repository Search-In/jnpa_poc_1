/**
 * Shared table COMPONENTS for the Shipping Lines module.
 *
 * Every Shipping Lines table needs the same six things — search, business filters,
 * sorting, pagination, and distinct loading / error / empty states — so the controls
 * live here once instead of four times. Styles and pure helpers live in the sibling
 * tableUtils.ts (a .tsx file may only export components without breaking Fast
 * Refresh, which the project lints for).
 *
 * Presentation only: no transport, no business rules, no knowledge of any entity.
 *
 * WHY CLIENT-SIDE SORT AND SOME CLIENT-SIDE FILTERS. The gateway accepts no `sort`
 * param on any shipping-lines list, and cannot filter several fields it happily
 * RETURNS (advance-list pod / voyage / vessel_visit / dates; delivery-order
 * reference / status / dates; upload file name / dates). The backend is frozen, so
 * those refinements happen here — over the window the server returned. UC-3's own
 * Shipping Lines screen sorts client-side for exactly the same reason.
 *
 * That is only honest if the scope is visible, which is what <ScopeNote> is for: it
 * always states how many rows are loaded against the server's total, and warns
 * explicitly when the window is short of the full result set.
 */

import type { ReactNode } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';
import { SELECT, TH, pagerBtn, type SortState } from '@/components/shipping/tableUtils';

/** A clickable, accessible sort header. */
export function SortableTh({
  label, sortKey, sort, onSort, numeric,
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  numeric?: boolean;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      style={{ ...TH, textAlign: numeric ? 'right' : 'left', cursor: 'pointer', userSelect: 'none' }}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label}`}
        style={{
          all: 'unset', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
          font: 'inherit', letterSpacing: 'inherit', textTransform: 'inherit',
          color: active ? tokens.text : tokens.textMuted,
        }}
      >
        {label}
        <span aria-hidden style={{ fontSize: 9, opacity: active ? 1 : 0.35 }}>
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅'}
        </span>
      </button>
    </th>
  );
}

/** Prev/Next pager — same markup and styling as PilotageTable's. */
export function Pager({
  offset, pageSize, total, onOffset,
}: {
  offset: number;
  pageSize: number;
  total: number;
  onOffset: (next: number) => void;
}) {
  const atStart = offset === 0;
  const atEnd = offset + pageSize >= total;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm, paddingTop: tokens.space.sm }}>
      <button style={pagerBtn(atStart)} disabled={atStart} onClick={() => onOffset(Math.max(0, offset - pageSize))}>
        ‹ Prev
      </button>
      <button style={pagerBtn(atEnd)} disabled={atEnd} onClick={() => onOffset(offset + pageSize)}>
        Next ›
      </button>
    </div>
  );
}

/** Search box, matching the existing tables' CalciteInput usage. */
export function SearchBox({
  placeholder, value, onChange, width = 240,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  width?: number;
}) {
  return (
    <CalciteInput
      scale="s"
      clearable
      placeholder={placeholder}
      value={value}
      style={{ maxWidth: width }}
      onCalciteInputChange={(e) => onChange((e.target as unknown as { value: string }).value)}
    />
  );
}

/** Native <select> filter — the idiom already used by PilotageTable. */
export function FilterSelect({
  label, value, options, onChange, allLabel,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
  allLabel: string;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={SELECT} aria-label={label}>
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}

/** A from/to date pair. Values are `yyyy-mm-dd` strings, '' when unset. */
export function DateRange({
  from, to, onFrom, onTo, label,
}: {
  from: string;
  to: string;
  onFrom: (v: string) => void;
  onTo: (v: string) => void;
  label: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.space.xs }}>
      <input
        type="date"
        value={from}
        onChange={(e) => onFrom(e.target.value)}
        style={SELECT}
        aria-label={`${label} from`}
        title={`${label} from`}
      />
      <span style={{ fontSize: 11, color: tokens.textMuted }}>→</span>
      <input
        type="date"
        value={to}
        onChange={(e) => onTo(e.target.value)}
        style={SELECT}
        aria-label={`${label} to`}
        title={`${label} to`}
      />
    </span>
  );
}

/** Clear-all control, shown only when at least one refinement is active. */
export function ResetButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} style={pagerBtn(false)} title="Clear search and filters">
      Reset
    </button>
  );
}

/**
 * The honesty line. Always states the visible range against the filtered count, and
 * when the server holds more than the fetched window, says so explicitly — because
 * the client-side refinements can only see what was loaded.
 */
export function ScopeNote({
  from, to, filtered, loaded, serverTotal, noun,
}: {
  from: number;
  to: number;
  /** Rows surviving the client-side refinements. */
  filtered: number;
  /** Rows actually fetched from the gateway. */
  loaded: number;
  /** The gateway's reported total for the server-side filters. */
  serverTotal: number;
  noun: string;
}) {
  const short = serverTotal > loaded;
  return (
    <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
      {from}–{to} of {filtered} {noun}
      {filtered !== loaded && ` (of ${loaded} loaded)`}
      {short && (
        <span style={{ color: tokens.warn }}>
          {' '}· {serverTotal} on server — narrow the filters for an exact result
        </span>
      )}
    </span>
  );
}

/**
 * Progressive disclosure for the less-frequently-used filters.
 *
 * The toolbar keeps ONE global search plus the two or three filters an operator
 * reaches for daily; everything else lives behind this toggle. `activeCount` is shown
 * on the button so a filter hidden inside the panel can never be silently narrowing
 * the result set — the commonest confusion with collapsed filter UI.
 */
export function MoreFilters({
  open, onToggle, activeCount, children,
}: {
  open: boolean;
  onToggle: () => void;
  activeCount: number;
  children: ReactNode;
}) {
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? 'Hide advanced filters' : 'Show advanced filters'}
        style={{
          ...pagerBtn(false),
          borderColor: activeCount > 0 ? tokens.accent : tokens.border,
          color: activeCount > 0 ? tokens.accent : tokens.text,
          fontWeight: activeCount > 0 ? 600 : 400,
        }}
      >
        More filters {activeCount > 0 ? `(${activeCount})` : open ? '−' : '+'}
      </button>
      {open && (
        <div
          style={{
            flexBasis: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space.md,
            flexWrap: 'wrap',
            padding: tokens.space.sm,
            marginTop: tokens.space.xs,
            background: tokens.panelAlt,
            border: `1px solid ${tokens.border}`,
            borderRadius: tokens.radius.sm,
          }}
        >
          {children}
        </div>
      )}
    </>
  );
}

/** Small labelled wrapper so a bare <select> inside the advanced panel reads clearly. */
export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: tokens.space.xs }}>
      <span style={{ fontSize: 11, color: tokens.textMuted, whiteSpace: 'nowrap' }}>{label}</span>
      {children}
    </span>
  );
}

/**
 * Data-integrity notice. Renders only when the payload carried rows the mapper could
 * not use, or when the server reports a total but nothing survived mapping — the
 * signature of a response-shape mismatch. Making that visible is the whole point: the
 * original bug was a silent empty table on a successful 200.
 */
export function DataNotice({ skipped, serverTotal, loaded }: {
  skipped: number;
  serverTotal: number;
  loaded: number;
}) {
  const shapeMismatch = serverTotal > 0 && loaded === 0;
  if (!skipped && !shapeMismatch) return null;
  return (
    <div
      role="status"
      style={{
        flexBasis: '100%', padding: '6px 8px', fontSize: 11.5,
        borderLeft: `3px solid ${shapeMismatch ? tokens.bad : tokens.warn}`,
        background: tokens.panelAlt, borderRadius: tokens.radius.sm, color: tokens.text,
      }}
    >
      {shapeMismatch
        ? `The server reported ${serverTotal} record(s) but none could be read from the response — likely a response-shape mismatch. Check the browser console/network payload.`
        : `${skipped} row(s) in the response could not be read and are not shown.`}
    </div>
  );
}

/** Status pill using the UC-1 status ramp. `tone` picks the colour. */
export function StatusChip({ label, tone }: { label: string; tone: 'good' | 'warn' | 'bad' | 'muted' }) {
  const color =
    tone === 'good' ? tokens.good : tone === 'warn' ? tokens.warn : tone === 'bad' ? tokens.bad : tokens.textMuted;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px',
        fontSize: 11, lineHeight: 1.3, borderRadius: tokens.radius.sm,
        background: tokens.panelAlt, border: `1px solid ${color}66`, color: tokens.text,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: color }} />
      {label || '—'}
    </span>
  );
}

/**
 * The scrolling table viewport with the three non-table states resolved in one place,
 * so every Shipping Lines table handles loading / error / empty identically.
 *
 * `emptyMessage` covers "the backend has nothing yet"; `noMatchMessage` covers "rows
 * exist but the refinements exclude them all" — distinguishing the two is what stops
 * an active filter reading as an empty database.
 */
export function TableFrame({
  loading, error, loadedCount, visibleCount, loadingLabel, emptyMessage, noMatchMessage, children,
}: {
  loading: boolean;
  error: string | null;
  loadedCount: number;
  visibleCount: number;
  loadingLabel: string;
  emptyMessage: string;
  noMatchMessage: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        flex: 1, overflow: 'auto', minHeight: 0,
        border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm,
      }}
    >
      {loading ? (
        <PanelLoading label={loadingLabel} />
      ) : error ? (
        <PanelError message={error} />
      ) : loadedCount === 0 ? (
        <div style={{ padding: 12 }}><PanelEmpty message={emptyMessage} /></div>
      ) : visibleCount === 0 ? (
        <div style={{ padding: 12 }}><PanelEmpty message={noMatchMessage} /></div>
      ) : (
        children
      )}
    </div>
  );
}

/** Standard flex-column shell every table sits in. */
export function TableShell({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>{children}</div>;
}
