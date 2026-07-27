/**
 * <PortCraftRegisterTable> — the UC-3 port-craft fleet REGISTER, shown on the
 * Port Craft tab under the Fleet Register internal tab (below the analysis section).
 *
 * Reads `/api/marine/port-craft` via the UC-3 connector and renders the VesselTable
 * table idiom (tokens-styled <table>, filter row + pager, PanelEmpty on no rows).
 * Static particulars from Details_of_Port_Crafts.pdf — distinct from the mock live-ops
 * board. Empty until the PDF is uploaded through the marine Data Upload flow.
 *
 * FILTERING — why it is client-side. The gateway ANDs its `name` and `owner` ILIKE
 * filters (services/marine/port_craft.py `_where`), so a single box that matches craft
 * name OR owner name cannot be expressed as one server query, and the backend is out
 * of scope for this change. The register is a
 * small static reference table (~18 craft; the gateway caps a page at 500), so this
 * reads the whole register ONCE through the existing `fetchPortCraftPage` connector and
 * filters, sorts and pages in memory. Two further benefits: the craft-type / ownership
 * dropdown options can be derived from the complete register (they never collapse to
 * the current selection), and typing no longer fires a request per keystroke. If the
 * register ever outgrows one page the shortfall is stated on screen, never hidden.
 *
 * The API contract, response envelope, field names and connector are untouched.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchPortCraftPage, type PortCraftFilters } from '@/data/uc3/portCraft';
import type { PortCraft } from '@/types/domain';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { tokens } from '@/theme/tokens';

const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse' };
const TH: CSSProperties = {
  textAlign: 'left', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
  textTransform: 'uppercase', color: tokens.textMuted,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderBottom: `1px solid ${tokens.border}`,
  background: tokens.panelAlt, whiteSpace: 'nowrap', position: 'sticky', top: 0,
};
const TD: CSSProperties = {
  fontSize: 12.5, lineHeight: 1.4, color: tokens.text,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderBottom: `1px solid ${tokens.border}`,
  whiteSpace: 'nowrap',
};

/** One server read for the whole register. 500 is the gateway's own page ceiling
 *  (marine_port_craft.list_craft: `limit … le=500`) — not a new limit. */
const FETCH_LIMIT = 500;
/** Rows per client page. Small register, wide rows — keeps the 420px panel readable. */
const PAGE_SIZE = 10;
/** Server-side ordering only; every filter below is applied in memory (see header). */
const REGISTER_QUERY: PortCraftFilters = { sort: 'name', direction: 'asc' };
/** Stable identity so the memos below don't rerun while the query is still loading. */
const NO_ROWS: PortCraft[] = [];

function n2(v: number | null, unit = ''): string {
  return v === null ? '—' : `${v.toFixed(2)}${unit}`;
}

/** Distinct, non-blank values in first-seen (server `name asc`) order. */
function options(rows: PortCraft[], pick: (c: PortCraft) => string): string[] {
  const seen: string[] = [];
  for (const r of rows) {
    const v = pick(r).trim();
    if (v && !seen.includes(v)) seen.push(v);
  }
  return seen;
}

const COLUMNS: { key: string; label: string; render: (c: PortCraft) => string; wrap?: boolean }[] = [
  { key: 'name', label: 'Name', render: (c) => c.name || '—' },
  { key: 'type', label: 'Type', render: (c) => c.craftType || '—' },
  { key: 'oh', label: 'Owned/Hired', render: (c) => c.ownedOrHired || '—' },
  { key: 'owner', label: 'Owner', render: (c) => c.ownerName || '—' },
  { key: 'year', label: 'Year Built', render: (c) => c.yearBuilt || '—' },
  { key: 'loa', label: 'LOA', render: (c) => n2(c.loaM, ' m') },
  { key: 'breadth', label: 'Breadth', render: (c) => n2(c.breadthM, ' m') },
  { key: 'draft', label: 'Draft', render: (c) => n2(c.draftM, ' m') },
  { key: 'engines', label: 'Engines', render: (c) => c.mainEngines || '—', wrap: true },
  { key: 'bollard', label: 'Bollard Pull', render: (c) => (c.bollardPullT === null ? '—' : `${c.bollardPullT} T`) },
  { key: 'speed', label: 'Speed', render: (c) => (c.designSpeedKn === null ? '—' : `${c.designSpeedKn.toFixed(2)} kn`) },
];

const SELECT: CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.border}`, background: tokens.panel, color: tokens.text,
};

export function PortCraftRegisterTable() {
  const [search, setSearch] = useState('');
  const [craftType, setCraftType] = useState('');
  const [ownership, setOwnership] = useState('');
  const [offset, setOffset] = useState(0);

  // Read the register once per mount. The parent remounts this component (via `key`)
  // after a successful upload, which is what triggers the post-import refetch.
  const q = useAdapterQuery(() => fetchPortCraftPage(REGISTER_QUERY, FETCH_LIMIT, 0), []);

  const all = q.data?.items ?? NO_ROWS;
  const serverTotal = q.data?.total ?? 0;
  // The gateway reported more rows than one page returned — say so rather than
  // silently presenting a partial register as the whole fleet.
  const missing = Math.max(0, serverTotal - all.length);

  const typeOptions = useMemo(() => options(all, (c) => c.craftType), [all]);
  const ownershipOptions = useMemo(() => options(all, (c) => c.ownedOrHired), [all]);

  // Search spans craft name and owner name (OR) — craft type has its own dropdown, so
  // it is deliberately not folded into the free-text box. The two dropdowns are exact
  // matches (AND). Filters reset the pager, so `offset` is always in range.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((c) => {
      if (craftType && c.craftType !== craftType) return false;
      if (ownership && c.ownedOrHired !== ownership) return false;
      if (!needle) return true;
      return `${c.name} ${c.ownerName}`.toLowerCase().includes(needle);
    });
  }, [all, search, craftType, ownership]);

  const total = filtered.length;
  const rows = filtered.slice(offset, offset + PAGE_SIZE);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search craft name / owner…"
          value={search}
          style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) => { setOffset(0); setSearch((e.target as unknown as { value: string }).value); }}
        />
        <select
          value={craftType}
          onChange={(e) => { setOffset(0); setCraftType(e.target.value); }}
          style={SELECT}
          aria-label="Filter by craft type"
        >
          <option value="">All types</option>
          {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select
          value={ownership}
          onChange={(e) => { setOffset(0); setOwnership(e.target.value); }}
          style={SELECT}
          aria-label="Filter by ownership"
        >
          <option value="">All ownership</option>
          {ownershipOptions.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {from}–{to} of {total} craft{total === 1 ? '' : 's'}
          {missing > 0 && ` · ${missing} more on the server`}
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {q.loading && !q.data ? (
          <PanelLoading label="Loading port-craft register…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : all.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No port-craft register yet. Upload Details_of_Port_Crafts.pdf from the Data Upload tab." />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No craft match the current search or filters." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>{COLUMNS.map((c) => <th key={c.key} style={TH}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.craftId}>
                  {COLUMNS.map((col) => (
                    <td
                      key={col.key}
                      style={{ ...TD, fontWeight: col.key === 'name' ? 600 : undefined, whiteSpace: col.wrap ? 'normal' : 'nowrap', maxWidth: col.wrap ? 260 : undefined }}
                    >
                      {col.render(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm, paddingTop: tokens.space.sm }}>
        <button style={btn(offset === 0)} disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹ Prev</button>
        <button style={btn(to >= total)} disabled={to >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Next ›</button>
      </div>
    </div>
  );
}

function btn(disabled: boolean): CSSProperties {
  return {
    fontSize: 12, padding: '4px 10px', borderRadius: tokens.radius.sm,
    border: `1px solid ${tokens.border}`, background: tokens.panel,
    color: disabled ? tokens.textMuted : tokens.text, cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}
