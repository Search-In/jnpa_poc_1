/**
 * <PilotMemoTable> — Pilotage ▸ Pilot Memo / Acknowledgements.
 *
 * The ACKPLM movements only. Acknowledgement is NOT missing from the backend: every
 * message-sourced row carries `extras.approval_status` (PCS 'A' = approved), alongside
 * the requested and readiness times and the boarding place. All of it is already in the
 * `/api/marine/pilotage` response and none of it was rendered anywhere.
 *
 * Because the backend supplies the acknowledgement, there is no 'Acknowledge' demo
 * button here — a control that wrote nothing while the real state sat next to it would
 * misrepresent the system. Rows the corpus never acknowledged simply read 'Not
 * acknowledged'.
 */

import { useState, type CSSProperties } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { useMarineStateVersion } from '@/data/uc3/marineStateBus';
import { fetchPilotagePage } from '@/data/uc3/pilotage';
import type { Pilotage } from '@/types/domain';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { StatusChip } from '@/components/shipping/dataTable';
import { lifecycleTone } from '@/components/marine/lifecycleTone';
import { movementStage, operationalStatus, pilotName } from '@/components/marine/pilotLifecycle';
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

const SCAN = 500;

function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

function str(p: Pilotage, key: string): string {
  const v = p.extras?.[key];
  return typeof v === 'string' ? v.trim() : '';
}

/** Epoch ms for an ISO string parked in `extras`, 0 when absent or unparseable. */
function extrasTime(p: Pilotage, key: string): number {
  const v = str(p, key);
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/** PCS approval flag → words. 'A' is the only value the corpus uses. */
function ackLabel(p: Pilotage): string {
  const a = str(p, 'approval_status').toUpperCase();
  if (a === 'A') return 'Acknowledged';
  if (a === 'R') return 'Rejected';
  return a ? a : 'Not acknowledged';
}

function ackTone(label: string) {
  if (label === 'Acknowledged') return 'good' as const;
  if (label === 'Rejected') return 'bad' as const;
  return 'muted' as const;
}

export function PilotMemoTable() {
  // Refetch whenever a manual pilot/craft action changes backend lifecycle state.
  const marineVersion = useMarineStateVersion();
  const [q, setQ] = useState('');
  const query = useAdapterQuery(() => fetchPilotagePage({}, SCAN, 0), [marineVersion]);

  // A memo row is one the PCS pilot-memo message produced; the parser stamps `_message`.
  const memos = (query.data?.items ?? []).filter((p) => str(p, '_message') === 'ACKPLM');
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? memos.filter((p) => (p.viaNo || '').toLowerCase().includes(needle)
                       || pilotName(p).toLowerCase().includes(needle))
    : memos;
  const acked = memos.filter((p) => ackLabel(p) === 'Acknowledged').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search VIA or pilot…"
          value={q}
          style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) => setQ((e.target as unknown as { value: string }).value)}
        />
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {acked} acknowledged of {memos.length} memos
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {query.loading && !query.data ? (
          <PanelLoading label="Loading pilot memos…" />
        ) : query.error ? (
          <PanelError message={query.error} />
        ) : shown.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No pilot memos yet. Import a PCS pilot memo (ACKPLM) on the Data Upload sub-tab." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>
                {['VIA', 'Pilot', 'Movement', 'Pilot Requested', 'Ready', 'Boarding Time',
                  'Boarding Place', 'Acknowledgement', 'Status'].map((h) => (
                  <th key={h} style={TH}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const ack = ackLabel(p);
                return (
                  <tr key={p.pilotageId}>
                    <td style={{ ...TD, fontWeight: 600 }}>{p.viaNo || '—'}</td>
                    <td style={TD}>{pilotName(p) || '—'}</td>
                    <td style={TD}>{movementStage(p.movementType) || '—'}</td>
                    <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmt(extrasTime(p, 'pilot_required_at'))}</td>
                    <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmt(extrasTime(p, 'readiness_at'))}</td>
                    <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmt(p.pilotBoardedAt)}</td>
                    <td style={TD}>{str(p, 'place_of_pilot_boarding') || '—'}</td>
                    <td style={TD}><StatusChip label={ack} tone={ackTone(ack)} /></td>
                    <td style={TD}>
                      {p.lifecycle?.pilotStatus
                        ? <StatusChip label={operationalStatus(p.lifecycle.pilotStatus)}
                                      tone={lifecycleTone(p.lifecycle.pilotStatus)} />
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
