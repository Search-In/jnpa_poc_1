/**
 * <PortCraftActiveOperations> — the "Active Marine Operations" tab: every vessel
 * currently requiring marine support, in one filterable, paged table.
 *
 * PRESENTATION ONLY. Every column is a value the backend projection already returned on
 * `/api/marine/state/port-craft`; nothing is computed, combined or predicted here. The one
 * derived column, Next Expected Stage, is a lookup on the engine's own ladder — see
 * craftDemandLabels.ts — and is blank when the ladder has no successor.
 *
 * Follows <PortCraftRegisterTable> exactly: filter row + right-aligned range counter, a
 * bordered scroll viewport, the shared PanelLoading / PanelError / PanelEmpty states, and
 * the same ‹ Prev / Next › pager. Any filter change resets the pager, so `offset` is
 * always in range.
 *
 * Berth: the berth CODE when `/marine/state/berths` (an endpoint the dashboard already
 * reads) can resolve it, else the berth STATE the row already carries. The raw numeric
 * berth_id is never displayed — it means nothing to an operator.
 */

import { useMemo, useState, type CSSProperties } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import {
  fetchBerthCodes, fetchPortCraftDemand, type CraftMovement,
} from '@/data/uc3/portCraftState';
import {
  berthLabel, craftLabel, nextStageLabel, pilotLabel, stageLabel,
} from '@/components/marine/craftDemandLabels';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';

/** Matches <PortCraftDemandStrip> and <PortCraftBoard>, so the panes never disagree. */
const REFRESH_MS = 30_000;

/** Rows per client page — same idiom as the fleet register. */
const PAGE_SIZE = 10;

const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse' };
const TH: CSSProperties = {
  textAlign: 'left', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
  textTransform: 'uppercase', color: tokens.textMuted,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  borderBottom: `1px solid ${tokens.border}`, background: tokens.panelAlt,
  whiteSpace: 'nowrap', position: 'sticky', top: 0,
};
const TD: CSSProperties = {
  fontSize: 12.5, lineHeight: 1.4, color: tokens.text,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  borderBottom: `1px solid ${tokens.border}`, whiteSpace: 'nowrap',
};
const SELECT: CSSProperties = {
  fontSize: 12, padding: '4px 8px', borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.border}`, background: tokens.panel, color: tokens.text,
};

const MOVEMENTS = ['Inbound', 'Alongside', 'Outbound'] as const;
const STATUSES = ['Busy', 'Idle', 'Completed'] as const;

/** A demand row plus the berth code, when one could be resolved. */
interface Row extends CraftMovement {
  berthDisplay: string;
}

function Chip({ text }: { text: string }) {
  if (!text) return <>—</>;
  return (
    <span style={{
      display: 'inline-block', fontSize: 11.5, fontWeight: 700,
      padding: '1px 7px', borderRadius: tokens.radius.sm,
      background: tokens.panel, border: `1px solid ${tokens.border}`, color: tokens.text,
    }}>
      {text}
    </span>
  );
}

function btn(disabled: boolean): CSSProperties {
  return {
    fontSize: 12, padding: '4px 10px', borderRadius: tokens.radius.sm,
    border: `1px solid ${tokens.border}`, background: tokens.panel,
    color: disabled ? tokens.textMuted : tokens.text,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  };
}

export function PortCraftActiveOperations() {
  const q = useAdapterQuery(() => fetchPortCraftDemand(), [], REFRESH_MS);
  // Separate query: resolving a berth id to its code must never delay or break the table.
  // It resolves to an empty map on failure, and the Berth column falls back to state.
  const berths = useAdapterQuery(() => fetchBerthCodes(), [], REFRESH_MS);

  const [search, setSearch] = useState('');
  const [movement, setMovement] = useState('');
  const [status, setStatus] = useState('');
  const [offset, setOffset] = useState(0);

  const filtered = useMemo<Row[]>(() => {
    const d = q.data;
    if (!d) return [];
    const codes = berths.data ?? new Map<number, string>();
    const needle = search.trim().toLowerCase();
    return [...d.inbound, ...d.alongside, ...d.outbound]
      .filter((m) => !movement || m.movementPhase === movement)
      .filter((m) => !status || m.portcraftState === status)
      .filter((m) => !needle
        || m.vesselName.toLowerCase().includes(needle)
        || m.vcn.toLowerCase().includes(needle)
        || m.viaNo.toLowerCase().includes(needle))
      .map((m) => ({
        ...m,
        berthDisplay: (m.berthId !== null && codes.get(m.berthId)) || berthLabel(m.berthState),
      }));
  }, [q.data, berths.data, search, movement, status]);

  const total = filtered.length;
  const rows = filtered.slice(offset, offset + PAGE_SIZE);
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  const reset = <T,>(set: (v: T) => void) => (v: T) => { setOffset(0); set(v); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: tokens.space.md,
        paddingBottom: tokens.space.sm, flexWrap: 'wrap',
      }}>
        <CalciteInput
          scale="s" clearable placeholder="Search vessel / VCN / VIA…"
          value={search} style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) =>
            reset(setSearch)((e.target as unknown as { value: string }).value)}
        />
        <select
          value={movement} onChange={(e) => reset(setMovement)(e.target.value)}
          style={SELECT} aria-label="Filter by movement"
        >
          <option value="">All movements</option>
          {MOVEMENTS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <select
          value={status} onChange={(e) => reset(setStatus)(e.target.value)}
          style={SELECT} aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <span style={{
          marginLeft: 'auto', fontSize: 12, color: tokens.textMuted,
          fontVariantNumeric: 'tabular-nums',
        }}>
          {from}–{to} of {total} vessel{total === 1 ? '' : 's'}
        </span>
      </div>

      <div style={{
        flex: 1, overflow: 'auto', minHeight: 0,
        border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm,
      }}>
        {q.loading && !q.data ? (
          <PanelLoading label="Loading active marine operations…" />
        ) : !q.data ? (
          <PanelError message="Marine operations are unavailable — the state service did not respond." />
        ) : total === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty
              message={
                status === 'Idle' || status === 'Completed'
                  // Not a bug, and not an empty database: a vessel appears here only
                  // while it requires support, so these two states never occur.
                  ? `No vessels are ${status.toLowerCase()} in active operations — a vessel `
                    + 'appears here only while it requires marine support.'
                  : 'No vessels match the current search or filters.'
              }
            />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>
                <th style={TH}>Vessel</th>
                <th style={TH}>VCN</th>
                <th style={TH}>Current Stage</th>
                <th style={TH}>Marine Support</th>
                <th style={TH}>Pilot Status</th>
                <th style={TH}>Berth</th>
                <th style={TH}>Latest Event</th>
                <th style={TH}>Last Updated</th>
                <th style={TH}>Next Expected Stage</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.callId ?? `${m.vcn}-${m.viaNo}`}>
                  {/* Vessel name is null on calls known only from CALINV/BERALT — those
                      messages carry none — so the VIA keeps the row identifiable. */}
                  <td style={{ ...TD, fontWeight: 600 }}>{m.vesselName || m.viaNo || '—'}</td>
                  <td style={{ ...TD, color: tokens.textMuted }}>{m.vcn || m.viaNo || '—'}</td>
                  <td style={TD}><Chip text={stageLabel(m.status)} /></td>
                  <td style={TD}>{craftLabel(m.portcraftState) || '—'}</td>
                  <td style={TD}>{pilotLabel(m.pilotState) || '—'}</td>
                  <td style={TD}>{m.berthDisplay || '—'}</td>
                  <td style={{ ...TD, color: tokens.textMuted }}>{m.latestEvent || '—'}</td>
                  <td style={{ ...TD, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                    {m.latestEventTime ? istDateTime(m.latestEventTime) : '—'}
                  </td>
                  <td style={TD}>{nextStageLabel(m.status) || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: tokens.space.sm,
        paddingTop: tokens.space.sm,
      }}>
        <button style={btn(offset === 0)} disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>‹ Prev</button>
        <button style={btn(to >= total)} disabled={to >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}>Next ›</button>
      </div>
    </div>
  );
}
