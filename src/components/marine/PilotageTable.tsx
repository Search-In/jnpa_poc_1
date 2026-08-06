/**
 * <PilotageTable> — the paged pilotage table for the Vessels ▸ Pilotage sub-tab.
 * Reads `/api/marine/pilotage` via the UC-3 connector and renders the VesselTable
 * table idiom (tokens-styled <table>, filter + pager, PanelEmpty on no rows).
 *
 * Pilot-card movements (INWARD/OUTWARD/SHIFTING) — marine-side actuals, distinct from
 * the AIS feed and from the vessel-call spine. Data arrives via the SHARED Data Upload
 * sub-tab (Pilot_card_data.xlsx), so this view is empty until a pilot card is uploaded.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { useMarineStateVersion } from '@/data/uc3/marineStateBus';
import { fetchPilotagePage, type PilotageFilters } from '@/data/uc3/pilotage';
import type { Pilotage } from '@/types/domain';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { StatusChip } from '@/components/shipping/dataTable';
import { lifecycleTone } from '@/components/marine/lifecycleTone';
import { berthCode, movementStage, operationalStatus, pilotLabel, vcnOf }
  from '@/components/marine/pilotLifecycle';
import { matchesIdentity, searchHint } from '@/components/marine/identitySearch';
import { fetchManualPilotAssignments } from '@/data/uc3/manualPilot';
import { assessRecord, applyAnomalyFilter } from '@/data/quality/dataQuality';
import { PILOTAGE_QUALITY } from '@/data/quality/datasets';
import { AnomalyBadge } from '@/components/common/AnomalyBadge';
import { ShowAnomalyToggle } from '@/components/common/ShowAnomalyToggle';
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

const PAGE_SIZE = 50;
/** The pilotage endpoint's maximum page. 423 rows today, so one fetch is the whole set. */
const SCAN = 500;
const MOVEMENTS = ['', 'INWARD', 'OUTWARD', 'SHIFTING'];

function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

const COLUMNS: {
  key: string; label: string; render: (p: Pilotage) => ReactNode; num?: boolean;
}[] = [
  { key: 'vessel', label: 'Vessel',
    render: (p) => (
      <>
        {p.vesselName || '—'}
        <AnomalyBadge result={assessRecord(p, PILOTAGE_QUALITY)}
                      dataset={PILOTAGE_QUALITY.dataset} />
      </>
    ) },
  { key: 'via', label: 'VIA', render: (p) => p.viaNo || '—' },
  { key: 'imo', label: 'IMO', render: (p) => p.imoNo || '—' },
  // Roster code (advance sheets) or acknowledged name (ACKPLM) — the two corpora are
  // disjoint, so a row carries one or the other.
  { key: 'pilot', label: 'Pilot', render: (p) => pilotLabel(p) || '—' },
  // Which leg of the visit this movement is: INWARD/OUTWARD/SHIFTING said plainly.
  { key: 'stage', label: 'Current Stage', render: (p) => movementStage(p.movementType) || '—' },
  { key: 'boarded', label: 'Boarding Time', render: (p) => fmt(p.pilotBoardedAt), num: true },
  // The card's own all-fast time when it has one, else the linked call's BERTHED
  // milestone. The backend already merged the two (pilot_status.effective_times); this
  // renders that merged value and falls back to the raw column if no call is linked.
  { key: 'allfast', label: 'All Fast', render: (p) => fmt(p.lifecycle?.allFastAt || p.allFastAt), num: true },
  // Raw sheet berth string — the typed from/to FKs are unresolved on all but one row.
  { key: 'berth', label: 'Berth', render: (p) => berthCode(p) || '—' },
  // Backend-derived (pilot_status.py) and only RENAMED here. '—' when the movement has
  // no linked call, which is a real state, not an error. The chip keeps its tone from the
  // ENGINE value so the colour cannot drift from the projection.
  { key: 'status', label: 'Status',
    render: (p) => p.lifecycle?.pilotStatus
      ? <StatusChip label={operationalStatus(p.lifecycle.pilotStatus)}
                    tone={lifecycleTone(p.lifecycle.pilotStatus)} />
      : '—' },
];
export function PilotageTable() {
  // Refetch whenever a manual pilot/craft action changes backend lifecycle state.
  const marineVersion = useMarineStateVersion();
  const [movement, setMovement] = useState('');
  const [vessel, setVessel] = useState('');
  const [offset, setOffset] = useState(0);
  const [showAnomalies, setShowAnomalies] = useState(true);
  // Backend, not browser state — the assignment is persisted, so this list agrees
  // with Vessel Calls, Port Craft and the Timeline instead of only with itself.
  const manualQ = useAdapterQuery(() => fetchManualPilotAssignments({ active: true }), [marineVersion]);

  // The MOVEMENT filter stays server-side — it is a real filter the endpoint supports.
  // The search box does not: the gateway can only match vessel_name, and this screen has
  // to find a movement by VCN, VIA or IMO too. So the page is fetched whole (SCAN is the
  // endpoint's own maximum) and the search runs over what came back. No new endpoint,
  // no contract change; the cost is that search covers SCAN rows, which is stated below.
  const filters: PilotageFilters = {
    movement: movement || undefined,
    sort: 'submitted_at',
    direction: 'desc',
  };
  const q = useAdapterQuery(() => fetchPilotagePage(filters, SCAN, 0), [movement, marineVersion]);

  const page = q.data;
  const loaded = page?.items ?? [];
  // Every identifier this payload actually carries. `extras.vcn` is present on pilot-memo
  // rows only; pilotLabel covers roster code and acknowledged name.
  const matched = loaded.filter((p) =>
    matchesIdentity(vessel, [p.vesselName, p.viaNo, p.imoNo, vcnOf(p), pilotLabel(p)]));

  // Manual assignments appear here too, so an operator sees ONE operational list rather
  // than having to remember which vessels were handled in the fallback screen. They are
  // rendered as a distinct row shape (marked 'Manual') and are dropped the moment real
  // pilot data exists for that call — `isLive` carries the supersede decision, which is
  // made once in the store, not re-derived per view.
  const manual = (manualQ.data?.items ?? [])
    .filter((a) => a.active)
    .filter(() => !movement || movement === 'INWARD')
    .filter((a) => matchesIdentity(vessel,
      [a.vesselName, a.viaNo, a.vcn, a.pilotName, a.pilotCode]));

  // This table fetches the whole set and pages CLIENT-side, so the filter is exact: it
  // runs before slicing, and the counter and pager reflect the filtered set precisely.
  // Manual assignments are operator-entered, not imported, so the import-completeness
  // rule does not apply to them and they are never filtered.
  const visible = applyAnomalyFilter(matched, PILOTAGE_QUALITY, showAnomalies);
  const hiddenCount = matched.length - visible.length;

  const total = visible.length + manual.length;
  // Manual rows sort first: they are the ones still needing operator attention.
  const shownManual = manual.slice(offset, offset + PAGE_SIZE);
  const rows = visible.slice(Math.max(0, offset - manual.length),
                             Math.max(0, offset - manual.length) + PAGE_SIZE - shownManual.length);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  // True only if the corpus outgrew one page — then search is no longer exhaustive and
  // the count below must not be read as 'all pilotage'.
  const truncated = (page?.total ?? 0) > loaded.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <select
          value={movement}
          onChange={(e) => { setOffset(0); setMovement(e.target.value); }}
          style={{
            fontSize: 12, padding: '5px 8px', borderRadius: tokens.radius.sm,
            border: `1px solid ${tokens.border}`, background: tokens.panel, color: tokens.text,
          }}
          aria-label="Filter by movement type"
        >
          {MOVEMENTS.map((m) => <option key={m || 'all'} value={m}>{m || 'All movements'}</option>)}
        </select>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search vessel / VCN / VIA / IMO / pilot…"
          title={`Matches any of: ${searchHint()}`}
          value={vessel}
          style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) => { setOffset(0); setVessel((e.target as unknown as { value: string }).value); }}
        />
        <ShowAnomalyToggle checked={showAnomalies} onChange={setShowAnomalies}
                           hiddenCount={hiddenCount} />
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {from}–{to} of {total}
          {truncated && ' (first 500 loaded)'}
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {q.loading && !page ? (
          <PanelLoading label="Loading pilotage…" />
        ) : q.error ? (
          <PanelError message={q.error} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No pilotage records yet. Upload Pilot_card_data.xlsx from the Data Upload sub-tab." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>{COLUMNS.map((c) => <th key={c.key} style={TH}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {shownManual.map((a) => (
                <tr key={a.id} style={{ background: tokens.panelAlt }}>
                  <td style={{ ...TD, fontWeight: 600 }}>{a.vesselName || '—'}</td>
                  <td style={TD}>{a.viaNo || '—'}</td>
                  <td style={TD}>—</td>
                  <td style={TD}>{a.pilotName || a.pilotCode}</td>
                  <td style={TD}>Arriving</td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>
                    {a.boardedAt ? istDateTime(a.boardedAt) : '—'}
                  </td>
                  <td style={TD}>—</td>
                  <td style={TD}>—</td>
                  <td style={TD}>
                    <StatusChip
                      label={a.status === 'Onboard' ? 'Pilot Onboard'
                             : a.status === 'Released' ? 'Completed' : 'Assigned'}
                      tone={lifecycleTone(a.status === 'Onboard' ? 'Pilot Boarded'
                             : a.status === 'Released' ? 'Completed' : 'Allotted')} />
                    <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 700,
                                   letterSpacing: 0.3, color: tokens.warn }}
                          title="Manual assignment — not imported, not sent to the backend">
                      MANUAL
                    </span>
                  </td>
                </tr>
              ))}
              {rows.map((p) => (
                <tr key={p.pilotageId}>
                  {COLUMNS.map((col) => (
                    <td key={col.key} style={{ ...TD, fontWeight: col.key === 'movement' ? 600 : undefined, fontVariantNumeric: col.num ? 'tabular-nums' : undefined }}>
                      {col.render(p)}
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
