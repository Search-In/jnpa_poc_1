/**
 * Shared table STYLES and PURE helpers for the Shipping Lines module.
 *
 * Split from dataTable.tsx (which holds the components) because a .tsx file that
 * also exports constants and functions breaks React Fast Refresh — the project lints
 * with `--max-warnings 0`, so the split is required rather than stylistic.
 *
 * The styling is lifted verbatim from the existing UC-1 table idiom (PilotageTable /
 * VesselTable / PortCraftRegisterTable): tokens-only colours, a sticky uppercase
 * header, native <select> filters. Nothing new is invented.
 */

import { useMemo, type CSSProperties } from 'react';
import { tokens } from '@/theme/tokens';

/* ── styles ───────────────────────────────────────────────────────────────── */

export const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse' };

export const TH: CSSProperties = {
  textAlign: 'left', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
  textTransform: 'uppercase', color: tokens.textMuted,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderBottom: `1px solid ${tokens.border}`,
  background: tokens.panelAlt, whiteSpace: 'nowrap', position: 'sticky', top: 0,
};

export const TD: CSSProperties = {
  fontSize: 12.5, lineHeight: 1.4, color: tokens.text,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderBottom: `1px solid ${tokens.border}`,
  whiteSpace: 'nowrap',
};

export const SELECT: CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.border}`, background: tokens.panel, color: tokens.text,
};

export const TOOLBAR: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: tokens.space.md,
  paddingBottom: tokens.space.sm, flexWrap: 'wrap',
};

export function pagerBtn(disabled: boolean): CSSProperties {
  return {
    fontSize: 12, padding: '4px 10px', borderRadius: tokens.radius.sm,
    border: `1px solid ${tokens.border}`, background: tokens.panel,
    color: disabled ? tokens.textMuted : tokens.text, cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

/* ── sorting ──────────────────────────────────────────────────────────────── */

export type SortDir = 'asc' | 'desc';
export interface SortState { key: string; dir: SortDir }
/** A sortable value: string, number, or null/'' meaning "unknown". */
export type SortValue = string | number | null;

/**
 * Compare two sortable values. Unknowns (null, '') always sink to the bottom
 * regardless of direction, so a column of mostly-blank source data never pushes the
 * real rows off the first page.
 */
export function compareValues(a: SortValue, b: SortValue, dir: SortDir): number {
  const aBlank = a === null || a === '';
  const bBlank = b === null || b === '';
  if (aBlank && bBlank) return 0;
  if (aBlank) return 1;
  if (bBlank) return -1;
  const cmp =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), undefined, { numeric: true });
  return dir === 'asc' ? cmp : -cmp;
}

/** Stable sort by one accessor. Returns a new array; never mutates the input. */
export function sortRows<T>(rows: T[], get: (r: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => compareValues(get(x.r), get(y.r), dir) || x.i - y.i)
    .map(({ r }) => r);
}

/** Flip direction when the same column is clicked again, else sort the new one asc. */
export function nextSort(current: SortState, key: string): SortState {
  return current.key === key
    ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
    : { key, dir: 'asc' };
}

/* ── pagination ───────────────────────────────────────────────────────────── */

/** One page of rows plus the label numbers. Pure. */
export function paginate<T>(rows: T[], offset: number, pageSize: number) {
  const total = rows.length;
  const safeOffset = offset >= total ? 0 : offset;
  return {
    page: rows.slice(safeOffset, safeOffset + pageSize),
    total,
    from: total === 0 ? 0 : safeOffset + 1,
    to: Math.min(safeOffset + pageSize, total),
  };
}

/* ── filtering helpers ────────────────────────────────────────────────────── */

/**
 * Inclusive epoch-ms range test against `yyyy-mm-dd` bounds. A row with no timestamp
 * (0) is EXCLUDED once any bound is set — an unknown date cannot be asserted to fall
 * inside a window.
 */
export function inDateRange(ts: number, from: string, to: string): boolean {
  if (!from && !to) return true;
  if (!ts) return false;
  if (from && ts < Date.parse(`${from}T00:00:00`)) return false;
  if (to && ts > Date.parse(`${to}T23:59:59.999`)) return false;
  return true;
}

/** Case-insensitive substring match across several fields (OR). Blank needle passes. */
export function matchesAny(needle: string, ...fields: string[]): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return fields.some((f) => (f || '').toLowerCase().includes(n));
}

/** Distinct, non-blank values sorted naturally — for data-derived filter options. */
export function useOptions<T>(rows: T[], pick: (r: T) => string): string[] {
  return useMemo(() => {
    const seen: string[] = [];
    for (const r of rows) {
      const v = pick(r).trim();
      if (v && !seen.includes(v)) seen.push(v);
    }
    return seen.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    // `pick` is a stable inline accessor at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
}
