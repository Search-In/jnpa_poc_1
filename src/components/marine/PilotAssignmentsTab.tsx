/**
 * <PilotAssignmentsTab> — Pilotage ▸ Pilot Assignments.
 *
 * The fallback workflow for a vessel that reached Berth Allotted with no pilot card or
 * pilot memo imported. It assigns pilots the Register already knows to calls the backend
 * already returned, and creates neither.
 *
 * BACKEND-PERSISTED. Assign / Board / Release are `/api/marine/manual-pilot-assignment`
 * calls, so the result is visible to every consumer that reads the backend — Vessel
 * Calls, Port Craft, Marine State and the Timeline all move together. An earlier build
 * kept this in a browser store, which is exactly why Vessel Calls still read
 * `Pilot = Pending` after an assignment.
 *
 * PRECEDENCE is the backend's decision, not this screen's: assigning onto a call that
 * already has imported pilotage returns 409, and a manual record is deactivated as soon
 * as a pilot memo lands for that call. This component only reports what it is told.
 */

import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { CalciteButton, CalciteInput, CalciteNotice } from '@esri/calcite-components-react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchVesselCallsPage } from '@/data/uc3/marineCalls';
import { fetchPilotagePage } from '@/data/uc3/pilotage';
import {
  assignPilot, boardPilot, fetchManualPilotAssignments, releasePilot,
  type ManualPilotAssignment,
} from '@/data/uc3/manualPilot';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { StatusChip } from '@/components/shipping/dataTable';
import { lifecycleTone } from '@/components/marine/lifecycleTone';
import { buildPilotRegister, isPilotAssignable }
  from '@/components/marine/pilotLifecycle';
import { matchesIdentity } from '@/components/marine/identitySearch';
import { propagateMarineStateUpdate, useMarineStateVersion }
  from '@/data/uc3/marineStateBus';
import { istDateTime } from '@/util/format';
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
  maxWidth: 260,
};

const SCAN = 500;

function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

/** Transaction status → chip tone, via the shared lifecycle vocabulary. */
function tone(status: string) {
  return lifecycleTone(status === 'Onboard' ? 'Pilot Boarded'
    : status === 'Released' ? 'Completed' : 'Allotted');
}

export function PilotAssignmentsTab() {
  // `refreshKey` is the invalidation signal: every successful mutation bumps it, and all
  // three queries re-run. Cheaper and more predictable than a cache library for three
  // endpoints, and it matches the remount-on-import pattern used across this app.
  const [refreshKey, setRefreshKey] = useState(0);
  const marineVersion = useMarineStateVersion();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const calls = useAdapterQuery(() => fetchVesselCallsPage({}, SCAN, 0), [refreshKey, marineVersion]);
  const pilotage = useAdapterQuery(() => fetchPilotagePage({}, SCAN, 0), [refreshKey, marineVersion]);
  const assignments = useAdapterQuery(() => fetchManualPilotAssignments({}), [refreshKey, marineVersion]);

  const [vesselQ, setVesselQ] = useState('');
  const [callId, setCallId] = useState('');
  const [pilotId, setPilotId] = useState('');

  const rows = useMemo(() => assignments.data?.items ?? [], [assignments.data]);
  const live = rows.filter((a) => a.active);
  const superseded = rows.filter((a) => !a.active);
  // The search box narrows the ledger below too (not only the assign picker), so an
  // operator can find a specific vessel's assignment. Same identity matcher and fields
  // used elsewhere; an empty query matches everything, so the unfiltered view is
  // unchanged. Display-only — `live`/`superseded` still drive the picker and the counts.
  const matchesQuery = (a: ManualPilotAssignment) =>
    matchesIdentity(vesselQ, [a.vesselName, a.viaNo, a.vcn, a.pilotName, a.pilotCode]);
  const shownLive = live.filter(matchesQuery);
  const shownSuperseded = superseded.filter(matchesQuery);

  /** Calls with IMPORTED pilotage — the backend will refuse these, so never offer them. */
  const importedCallIds = useMemo(
    () => new Set((pilotage.data?.items ?? [])
      .map((p) => p.callId).filter((c): c is number => c !== null)),
    [pilotage.data],
  );
  const alreadyAssigned = new Set(live.map((a) => a.callId));

  const candidates = (calls.data?.items ?? [])
    // Eligibility comes from the PROJECTION — see isPilotAssignable. Nothing here reads
    // a stored vessel_call column to decide whether a pilot is needed.
    .filter(isPilotAssignable)
    // Identity, not lifecycle: the operator must be able to tell the vessels apart, and
    // the backend needs a key to snapshot onto the assignment.
    .filter((c) => !!c.vesselName && (!!c.vcn || !!c.viaNo))
    // Backend rules, mirrored so the picker never offers what POST would refuse with 409.
    // Imported pilotage can coexist with pilot_state Pending (a memo lodged but no
    // boarding), so this is a genuinely separate guard, not a restatement of the above.
    .filter((c) => !importedCallIds.has(c.callId))
    .filter((c) => !alreadyAssigned.has(c.callId))
    .filter((c) => matchesIdentity(vesselQ, [c.vesselName, c.vcn, c.viaNo, c.imoNo]));

  // Fed BOTH sources so a pilot already holding a manual assignment is Busy here too;
  // the separate `engaged` set below then only has to cover the same-render case.
  const registry = buildPilotRegister(pilotage.data?.items ?? [], rows);
  const engaged = new Set(live.filter((a) => a.status !== 'Released').map((a) => a.pilotCode));
  const available = registry.filter((r) => r.status !== 'Busy' && !engaged.has(r.pilotId));

  const chosenCall = candidates.find((c) => String(c.callId) === callId);
  const chosenPilot = available.find((r) => r.pilotId === pilotId);

  /** Run a mutation, then invalidate. Errors surface verbatim — 409 is a real answer. */
  const mutate = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setRefreshKey((k) => k + 1);
      // Announce ONLY after the backend confirmed the write. Every other marine view
      // then refetches and reads the recomputed lifecycle, so a manual assignment
      // propagates exactly the way an imported pilot memo does. Never optimistic: a
      // refused 409 must not make other screens re-render around a change that
      // did not happen.
      propagateMarineStateUpdate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const onAssign = () => {
    if (!chosenCall || !chosenPilot) return;
    void mutate(async () => {
      await assignPilot({
        callId: chosenCall.callId,
        pilotCode: chosenPilot.pilotId,
        pilotName: chosenPilot.name || undefined,
        vcn: chosenCall.vcn || undefined,
        viaNo: chosenCall.viaNo || undefined,
        imoNo: chosenCall.imoNo || undefined,
        vesselName: chosenCall.vesselName || undefined,
        createdBy: 'operator',
      });
      setCallId('');
      setPilotId('');
    });
  };

  const loading = (calls.loading && !calls.data) || (assignments.loading && !assignments.data);
  const queryError = calls.error || pilotage.error || assignments.error;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: tokens.space.sm }}>
      <CalciteNotice open kind="brand" scale="s" icon="information">
        <div slot="title">Fallback workflow — for vessels with no imported pilot data</div>
        <div slot="message">
          Assignments are stored in the backend and drive Vessel Calls, Port Craft, Marine
          State and the Timeline. Imported pilot memos always take priority: a vessel
          disappears from the picker once real pilot data exists, and any manual record
          for it is retired automatically and kept below for audit.
        </div>
      </CalciteNotice>

      {error && (
        <CalciteNotice open kind="danger" scale="s" icon="exclamation-mark-triangle" closable>
          <div slot="title">Action refused</div>
          <div slot="message">{error}</div>
        </CalciteNotice>
      )}

      {/* ---- assign form ---- */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: tokens.space.md,
        flexWrap: 'wrap', padding: tokens.space.sm,
        background: tokens.panelAlt, borderRadius: tokens.radius.sm,
        border: `1px solid ${tokens.border}`,
      }}>
        <CalciteInput
          scale="s" clearable placeholder="Find vessel / VCN / VIA / IMO…"
          style={{ maxWidth: 220 }}
          onCalciteInputInput={(e) => setVesselQ((e.target as unknown as { value: string }).value)}
        />
        <select
          value={callId} onChange={(e) => setCallId(e.target.value)}
          style={SELECT} aria-label="Select vessel awaiting a pilot"
        >
          <option value="">Select vessel ({candidates.length} awaiting)</option>
          {candidates.slice(0, 200).map((c) => (
            <option key={c.callId} value={c.callId}>
              {c.vesselName} · {c.viaNo || c.vcn}
            </option>
          ))}
        </select>
        <select
          value={pilotId} onChange={(e) => setPilotId(e.target.value)}
          style={SELECT} aria-label="Select an available pilot"
        >
          <option value="">Select pilot ({available.length} free)</option>
          {available.map((r) => (
            <option key={r.pilotId} value={r.pilotId}>{r.name || r.pilotId}</option>
          ))}
        </select>
        <CalciteButton
          scale="s" iconStart="plus"
          disabled={!chosenCall || !chosenPilot || busy || undefined}
          onClick={onAssign}
        >
          Assign pilot
        </CalciteButton>
      </div>

      {/* ---- ledger ---- */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {loading ? (
          <PanelLoading label="Loading vessels and assignments…" />
        ) : queryError ? (
          <PanelError message={queryError} />
        ) : rows.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No manual pilot assignments. Use the form above for a vessel that has reached Berth Allotted but has no imported pilot data." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>
                {['Vessel', 'VIA', 'VCN', 'Pilot', 'Status', 'Assigned', 'Boarded',
                  'Released', 'Action'].map((h) => <th key={h} style={TH}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...shownLive, ...shownSuperseded].map((a: ManualPilotAssignment) => (
                <tr key={a.id} style={{ opacity: a.active ? 1 : 0.55 }}>
                  <td style={{ ...TD, fontWeight: 600 }}>{a.vesselName || '—'}</td>
                  <td style={TD}>{a.viaNo || '—'}</td>
                  <td style={TD}>{a.vcn || '—'}</td>
                  <td style={TD}>{a.pilotName || a.pilotCode}</td>
                  <td style={TD}>
                    {a.active
                      ? <StatusChip label={a.status} tone={tone(a.status)} />
                      : <StatusChip label="Superseded by import" tone="muted" />}
                  </td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmt(a.assignedAt)}</td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmt(a.boardedAt)}</td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmt(a.releasedAt)}</td>
                  <td style={TD}>
                    {/* Superseded rows are read-only: imported data owns that call now. */}
                    {!a.active ? <span style={{ color: tokens.textMuted }}>—</span>
                      : a.status === 'Assigned' ? (
                        <CalciteButton scale="s" appearance="outline" disabled={busy || undefined}
                          onClick={() => void mutate(() => boardPilot(a.id))}>Board pilot</CalciteButton>
                      ) : a.status === 'Onboard' ? (
                        <CalciteButton scale="s" appearance="outline" disabled={busy || undefined}
                          onClick={() => void mutate(() => releasePilot(a.id))}>Release</CalciteButton>
                      ) : <span style={{ color: tokens.textMuted }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ fontSize: 11.5, color: tokens.textMuted }}>
        {live.length} active · {superseded.length} retired by import · pilots and vessels
        come from the backend registers; this screen creates neither.
      </div>
    </div>
  );
}
