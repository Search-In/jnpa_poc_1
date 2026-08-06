/**
 * <PilotRegisterTable> — Pilotage ▸ Pilot Register.
 *
 * One row per pilot, folded from the movements `/api/marine/pilotage` already returns.
 * There is no roster endpoint and no availability column anywhere in the backend, so
 * this view derives exactly one thing — whether a pilot has an OPEN movement (boarded,
 * not yet disembarked) — and says nothing it cannot support:
 *
 *   Busy   a movement of theirs is unfinished, per the backend's own timestamps
 *   Free   no open movement  — NOT 'on shift', which the corpus cannot tell us
 *
 * Unavailable / Maintenance are deliberately absent: no field in core.pilot or
 * core.pilotage records leave, shift or maintenance, and inventing them would put
 * fictional operational state in front of an operator.
 */

import { useState, type CSSProperties } from 'react';
import { CalciteInput } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { useMarineStateVersion } from '@/data/uc3/marineStateBus';
import { fetchPilotagePage } from '@/data/uc3/pilotage';
import { fetchManualPilotAssignments } from '@/data/uc3/manualPilot';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { istDateTime } from '@/util/format';
import { StatusChip } from '@/components/shipping/dataTable';
import { lifecycleTone } from '@/components/marine/lifecycleTone';
import { availabilityLabel, buildPilotRegister } from '@/components/marine/pilotLifecycle';
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

/** The register folds the whole movement set, so it reads one large page, not a slice. */
const SCAN = 500;

function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

export function PilotRegisterTable() {
  // Refetch whenever a manual pilot/craft action changes backend lifecycle state.
  const marineVersion = useMarineStateVersion();
  const [q, setQ] = useState('');
  const query = useAdapterQuery(() => fetchPilotagePage({}, SCAN, 0), [marineVersion]);
  // The second half of the operational picture. Imported movements alone cannot say a
  // pilot is working when the job came from a manual assignment, which is why this
  // register read Available for a pilot who had just been assigned a vessel.
  const manualQ = useAdapterQuery(() => fetchManualPilotAssignments({}), [marineVersion]);

  const rows = buildPilotRegister(query.data?.items ?? [], manualQ.data?.items ?? []);
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? rows.filter((r) => r.pilotId.toLowerCase().includes(needle)
                      || r.name.toLowerCase().includes(needle)
                      || r.vessel.toLowerCase().includes(needle))
    : rows;
  const busy = rows.filter((r) => r.status === 'Busy').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md, paddingBottom: tokens.space.sm, flexWrap: 'wrap' }}>
        <CalciteInput
          scale="s"
          clearable
          placeholder="Search pilot or vessel…"
          value={q}
          style={{ maxWidth: 240 }}
          onCalciteInputChange={(e) => setQ((e.target as unknown as { value: string }).value)}
        />
        <span style={{ marginLeft: 'auto', fontSize: 12, color: tokens.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {busy} on a movement · {rows.length - busy} free · {rows.length} pilots
        </span>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {query.loading && !query.data ? (
          <PanelLoading label="Loading pilots…" />
        ) : query.error ? (
          <PanelError message={query.error} />
        ) : shown.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No pilots yet. Import a pilot card or a PCS pilot memo on the Data Upload sub-tab." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>
                {['Pilot', 'Pilot Code', 'Current Status', 'Assigned Vessel', 'VIA',
                  'Movement', 'Current Stage', 'Source', 'Last Updated',
                  'Availability'].map((h) => (
                  <th key={h} style={TH}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.pilotId}>
                  {/* Roster-coded pilots have no name in the corpus — the code stands in
                      for it rather than showing a blank where a person should be. */}
                  <td style={{ ...TD, fontWeight: 600 }}>{r.name || r.pilotId}</td>
                  <td style={TD}>{r.pilotId}</td>
                  <td style={TD}>
                    <StatusChip label={r.status} tone={lifecycleTone(r.status)} />
                  </td>
                  <td style={TD}>{r.vessel || '—'}</td>
                  <td style={TD}>{r.via || '—'}</td>
                  <td style={TD}>{r.movement || '—'}</td>
                  <td style={TD}>{r.stage || '—'}</td>
                  {/* Which record decided the status on this row — imported movement or
                      operator assignment. Never inferred: the fold sets it. */}
                  <td style={TD}>
                    {r.source
                      ? <StatusChip label={r.source}
                                    tone={r.source === 'Imported' ? 'info' : 'warn'} />
                      : '—'}
                  </td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmt(r.lastUpdated)}</td>
                  <td style={{ ...TD, color: tokens.textMuted }}>{availabilityLabel(r.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
