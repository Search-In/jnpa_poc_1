/**
 * <VesselRegisterTable> — the UC-3 VESSEL MASTER register, shown on the Vessels tab
 * under the Vessel Register internal sub-tab.
 *
 * Reads `/api/marine/vessels` via the UC-3 connector and renders the same table idiom as
 * <PortCraftRegisterTable> (tokens-styled <table>, filter row + pager, PanelEmpty on no
 * rows). Static hull particulars from VESPRO — distinct from the live AIS feed on the
 * "All vessels" sub-tab (keyed on MMSI) and from vessel CALLS (keyed on VCN). Empty until
 * a VESPRO XML is uploaded through the marine Data Upload flow.
 *
 * FILTERING — client-side, for the same reason the port-craft register is: the gateway
 * ANDs its `name`, `imo` and `owner` ILIKE filters (services/marine/vessel.py `_where`),
 * so one box matching name OR IMO OR owner cannot be expressed as a single server query.
 * The registry is a small reference table (9 hulls in the shared corpus; the gateway caps
 * a page at 500), so this reads it ONCE through `fetchVesselsPage` and filters, sorts and
 * pages in memory. The flag dropdown is therefore derived from the COMPLETE registry and
 * never collapses to the current selection. If the registry ever outgrows one page the
 * shortfall is stated on screen, never hidden.
 *
 * SPARSE BY DESIGN: VESPRO omits TEU on 3 of 9 corpus hulls and MMSI on 7. An absent
 * particular renders as '—', never 0 — a fabricated zero would read as "no capacity".
 * Thrusters are tri-state, so "—" and "No" are deliberately different cells.
 *
 * The API contract, response envelope, field names and connector are untouched.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchVesselsPage, type VesselFilters } from '@/data/uc3/vessels';
import type { VesselMaster } from '@/types/domain';
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
const SELECT: CSSProperties = {
  fontSize: 12, padding: '5px 8px', borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.border}`, background: tokens.panel, color: tokens.text,
};

/** One server read for the whole registry. 500 is the gateway's own page ceiling
 *  (marine_vessel.list_vessels: `limit … le=500`) — not a new limit. */
const FETCH_LIMIT = 500;
/** Rows per client page — wide rows, keeps the panel readable. */
const PAGE_SIZE = 10;
/** Server-side ordering only; every filter below is applied in memory (see header). */
const REGISTRY_QUERY: VesselFilters = { sort: 'vessel_name', direction: 'asc' };
/** Stable identity so the memos don't rerun while the query is still loading. */
const NO_ROWS: VesselMaster[] = [];

function n2(v: number | null, unit = ''): string {
  return v === null ? '—' : `${v.toFixed(2)}${unit}`;
}
function int(v: number | null): string {
  return v === null ? '—' : v.toLocaleString('en-IN');
}
/** Tri-state renderer: '—' (not stated) is deliberately distinct from 'No' (not fitted). */
function tri(v: boolean | null): string {
  return v === null ? '—' : v ? 'Yes' : 'No';
}

/** Distinct, non-blank values in first-seen (server `vessel_name asc`) order. */
function options(rows: VesselMaster[], pick: (v: VesselMaster) => string): string[] {
  const seen: string[] = [];
  for (const r of rows) {
    const v = pick(r).trim();
    if (v && !seen.includes(v)) seen.push(v);
  }
  return seen;
}

const COLUMNS: { key: string; label: string; render: (v: VesselMaster) => string }[] = [
  { key: 'name', label: 'Vessel', render: (v) => v.vesselName || '—' },
  { key: 'imo', label: 'IMO', render: (v) => v.imoNo },
  { key: 'callsign', label: 'Call Sign', render: (v) => v.callSign || '—' },
  { key: 'flag', label: 'Flag', render: (v) => v.flag || '—' },
  { key: 'loa', label: 'LOA', render: (v) => n2(v.loaM, ' m') },
  { key: 'beam', label: 'Beam', render: (v) => n2(v.beamM, ' m') },
  { key: 'draft', label: 'Max Draft', render: (v) => n2(v.maxDraftM, ' m') },
  { key: 'grt', label: 'GRT', render: (v) => int(v.grt) },
  { key: 'dwt', label: 'DWT', render: (v) => int(v.dwt) },
  { key: 'teu', label: 'TEU', render: (v) => int(v.teuCapacity) },
  { key: 'mmsi', label: 'MMSI', render: (v) => v.mmsi || '—' },
  { key: 'bow', label: 'Bow Thr.', render: (v) => tri(v.bowThruster) },
  { key: 'owner', label: 'Owner', render: (v) => v.ownerName || '—' },
];

export function VesselRegisterTable() {
  const [search, setSearch] = useState('');
  const [flag, setFlag] = useState('');
  const [offset, setOffset] = useState(0);

  // Read the registry once per mount. The parent remounts this component (via `key`)
  // after a successful upload, which is what triggers the post-import refetch.
  const q = useAdapterQuery(() => fetchVesselsPage(REGISTRY_QUERY, FETCH_LIMIT, 0), []);

  const all = q.data?.items ?? NO_ROWS;
  const serverTotal = q.data?.total ?? 0;
  // The gateway reported more hulls than one page returned — say so rather than
  // silently presenting a partial registry as the whole fleet.
  const missing = Math.max(0, serverTotal - all.length);

  const flagOptions = useMemo(() => options(all, (v) => v.flag), [all]);

  // Search spans vessel name, IMO and owner (OR) — flag has its own dropdown (AND), so it
  // is deliberately not folded into the free-text box. Filters reset the pager, so
  // `offset` is always in range.
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return all.filter((v) => {
      if (flag && v.flag !== flag) return false;
      if (!needle) return true;
      return `${v.vesselName} ${v.imoNo} ${v.ownerName}`.toLowerCase().includes(needle);
    });
  }, [all, search, flag]);

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
          placeholder="Search vessel / IMO / owner…"
          value={search}
          style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) => { setOffset(0); setSearch((e.target as unknown as { value: string }).value); }}
        />
        <select
          value={flag}
          onChange={(e) => { setOffset(0); setFlag(e.target.value); }}
          style={SELECT}
          aria-label="Filter by flag"
        >
          <option value="">All flags</option>
          {flagOptions.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {from}–{to} of {total} vessel{total === 1 ? '' : 's'}
          {missing > 0 && ` · ${missing} more on the server`}
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {q.loading && !q.data ? (
          <PanelLoading label="Loading vessel register…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : all.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No vessel register yet. Upload a VESPRO XML from the Data Upload tab." />
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No vessels match the current search or filters." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>{COLUMNS.map((c) => <th key={c.key} style={TH}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((v) => (
                <tr key={v.imoNo}>
                  {COLUMNS.map((col) => (
                    <td key={col.key} style={{ ...TD, fontWeight: col.key === 'name' ? 600 : undefined }}>
                      {col.render(v)}
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
