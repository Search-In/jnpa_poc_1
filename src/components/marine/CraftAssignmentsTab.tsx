/**
 * <CraftAssignmentsTab> — Port Craft ▸ Craft Assignments.
 *
 * The craft half of the fallback workflow. Once a vessel has a pilot — imported OR
 * manually assigned — an operator can also commit the launches, tugs and mooring craft
 * the movement needs.
 *
 * It assigns craft the Fleet Register (core.port_craft) already holds; it never creates
 * one. As with pilots, nothing here reaches the backend and every control is badged
 * Demo Action.
 *
 * GATING
 * ------
 * Craft follow the pilot: a launch carries him out, tugs and mooring boats work the
 * movement he is running. So the picker offers a vessel once a pilot is ENGAGED and stops
 * once that job ends or the vessel sails — `isCraftAssignable`, the projection-driven
 * sibling of the pilot picker's `isPilotAssignable`.
 *
 * Imported and manual are not told apart: the lifecycle reports 'Active' for an imported
 * boarding and 'Assigned'/'Onboard' for a manual one, and all three mean a pilot is on
 * the job. This screen reads no pilotage or assignment table of its own.
 */

import { useCallback, useMemo, useState, type CSSProperties } from 'react';
import { CalciteButton, CalciteNotice } from '@esri/calcite-components-react';
import { InfoPopover } from '@/components/common/InfoPopover';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { propagateMarineStateUpdate, useMarineStateVersion }
  from '@/data/uc3/marineStateBus';
import { fetchVesselCallsPage } from '@/data/uc3/marineCalls';
import { fetchPortCraft } from '@/data/uc3/portCraft';
import { PanelEmpty, PanelError, PanelLoading } from '@/components/common/Panel';
import { StatusChip } from '@/components/shipping/dataTable';
import { lifecycleTone } from '@/components/marine/lifecycleTone';
import { isCraftAssignable } from '@/components/marine/pilotLifecycle';
import {
  advanceCraft, assignCraft, fetchManualCraftAssignments,
  type CraftTransition,
} from '@/data/uc3/manualCraft';
import { istDateTime } from '@/util/format';
import { tokens } from '@/theme/tokens';

const TABLE: CSSProperties = { width: '100%', borderCollapse: 'collapse' };
const TH: CSSProperties = {
  textAlign: 'left', fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
  textTransform: 'uppercase', color: tokens.textMuted,
  padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderBottom: `1px solid ${tokens.border}`,
  background: tokens.panelAlt, whiteSpace: 'nowrap', position: 'sticky', top: 0,
  // Positioned elements in the rows below (the Board/Release buttons) would
  // otherwise paint over this header as they scroll under it — sticky sets
  // `z-index: auto`, which loses to any later positioned sibling.
  zIndex: 1,
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

/** Current status -> the next transition an operator can take, and its button label.
 *  Mirrors services/marine/manual_craft.LADDER; a Released commitment has no next rung. */
const NEXT: Record<string, { to: CraftTransition; label: string } | undefined> = {
  Assigned: { to: 'dispatch', label: 'Dispatch' },
  Dispatched: { to: 'arrive', label: 'On scene' },
  'On Scene': { to: 'assist', label: 'Assisting' },
  Assisting: { to: 'release', label: 'Release' },
};

function fmt(ms: number): string {
  return ms ? istDateTime(ms) : '—';
}

export function CraftAssignmentsTab() {
  // Refetch whenever a manual pilot/craft action changes backend lifecycle state.
  const marineVersion = useMarineStateVersion();
  const calls = useAdapterQuery(() => fetchVesselCallsPage({}, SCAN, 0), [marineVersion]);
  const fleet = useAdapterQuery(() => fetchPortCraft(), [marineVersion]);

  const craftQ = useAdapterQuery(() => fetchManualCraftAssignments({}), [marineVersion]);
  const craft = useMemo(() => craftQ.data?.items ?? [], [craftQ.data]);
  const [busyAction, setBusyAction] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /** Run a mutation, then announce. Identical contract to the pilot screen's `mutate`:
      never optimistic, so a refused 409 cannot make other screens re-render around a
      change that did not happen. */
  const mutate = useCallback(async (fn: () => Promise<unknown>) => {
    setBusyAction(true);
    setActionError(null);
    try {
      await fn();
      propagateMarineStateUpdate();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(false);
    }
  }, []);

  const [callId, setCallId] = useState('');
  const [craftKey, setCraftKey] = useState('');



  // Eligibility comes from the PROJECTION — see isCraftAssignable, the sibling of the
  // pilot picker's isPilotAssignable. Craft follow the pilot, and the lifecycle already
  // says whether one is engaged, from EITHER source: an imported boarding reads 'Active',
  // a manual one 'Assigned'/'Onboard'. Nothing here reads a stored vessel_call column,
  // and the two sources are not told apart.
  const candidates = (calls.data?.items ?? []).filter(isCraftAssignable);

  /** Fleet Register minus craft already out on a live assignment. */
  const busy = new Set(craft.filter((c) => c.active && c.status !== 'Released')
    .map((c) => c.craftId));
  const availableCraft = (fleet.data ?? []).filter((c) => !busy.has(c.craftId));

  const chosenCall = candidates.find((c) => String(c.callId) === callId);
  const chosenCraft = availableCraft.find((c) => String(c.craftId) === craftKey);
  const canAssign = !!chosenCall && !!chosenCraft && !busyAction;

  const onAssign = () => {
    if (!chosenCall || !chosenCraft) return;
    void mutate(async () => {
      await assignCraft({
        callId: chosenCall.callId,
        vcn: chosenCall.vcn || undefined,
        viaNo: chosenCall.viaNo || undefined,
        vesselName: chosenCall.vesselName || undefined,
        craftId: chosenCraft.craftId,
        craftName: chosenCraft.name || `Craft ${chosenCraft.craftId}`,
        craftType: chosenCraft.craftType || undefined,
      });
      setCallId('');
      setCraftKey('');
    });
    // Craft assignments are still browser-held, but the views that show craft demand read
    // the BACKEND, and eligibility depends on the pilot state those views also render.
    // Announcing keeps Port Craft Overview, the demand strip and the Timeline in step
    // with this screen instead of one action behind.
    propagateMarineStateUpdate();
  };

  const live = craft.filter((c) => c.active);
  const superseded = craft.filter((c) => !c.active);
  const loading = (calls.loading && !calls.data) || (fleet.loading && !fleet.data);
  const error = calls.error || fleet.error || craftQ.error;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: tokens.space.sm }}>
      <InfoPopover
        heading="Fallback workflow — for movements with no imported craft roster"
        label="About this workflow"
      >
        Craft commitments are stored in the backend and drive Marine State, Vessel
        Calls, the Timeline and the Fleet Register. The imported fleet register is never
        altered. Only vessels that already have a pilot can be selected.
      </InfoPopover>

      {actionError && (
        <CalciteNotice open kind="danger" scale="s" icon="exclamation-mark-triangle" closable>
          <div slot="title">Action refused</div>
          <div slot="message">{actionError}</div>
        </CalciteNotice>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: tokens.space.md,
        flexWrap: 'wrap', padding: tokens.space.sm,
        background: tokens.panelAlt, borderRadius: tokens.radius.sm,
        border: `1px solid ${tokens.border}`,
      }}>
        <select
          value={callId} onChange={(e) => setCallId(e.target.value)}
          style={SELECT} aria-label="Select a vessel that has a pilot"
        >
          <option value="">Select vessel ({candidates.length} with a pilot)</option>
          {candidates.slice(0, 200).map((c) => (
            <option key={c.callId} value={c.callId}>
              {c.vesselName || '(unnamed)'} · {c.viaNo || c.vcn}
            </option>
          ))}
        </select>
        <select
          value={craftKey} onChange={(e) => setCraftKey(e.target.value)}
          style={SELECT} aria-label="Select craft from the fleet register"
        >
          <option value="">Select craft ({availableCraft.length} free)</option>
          {availableCraft.map((c) => (
            <option key={c.craftId} value={c.craftId}>
              {c.name} — {c.craftType}
            </option>
          ))}
        </select>
        <CalciteButton
          scale="s" iconStart="plus" disabled={!canAssign || undefined}
          onClick={onAssign}
        >
          Assign craft
        </CalciteButton>
      </div>

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, border: `1px solid ${tokens.border}`, borderRadius: tokens.radius.sm }}>
        {loading ? (
          <PanelLoading label="Loading vessels and fleet…" />
        ) : error ? (
          <PanelError message={error} />
        ) : craft.length === 0 ? (
          <div style={{ padding: 12 }}>
            <PanelEmpty message="No manual craft assignments. Assign a pilot first, then commit the launches and tugs the movement needs." />
          </div>
        ) : (
          <table style={TABLE}>
            <thead>
              <tr>
                {['Vessel', 'VIA', 'Craft', 'Type', 'Status', 'Assigned', 'Released',
                  'Action'].map((h) => <th key={h} style={TH}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...live, ...superseded].map((c) => (
                <tr key={c.id} style={{ opacity: c.active ? 1 : 0.55 }}>
                  <td style={{ ...TD, fontWeight: 600 }}>{c.vesselName || '—'}</td>
                  <td style={TD}>{c.viaNo || '—'}</td>
                  <td style={TD}>{c.craftName}</td>
                  <td style={TD}>{c.craftType || '—'}</td>
                  <td style={TD}>
                    {/* The backend's own ladder position, shown verbatim — Assigned,
                        Dispatched, On Scene, Assisting or Released. */}
                    {c.active
                      ? <StatusChip label={c.status}
                                    tone={lifecycleTone(c.status === 'Released' ? 'Released' : 'Busy')} />
                      : <StatusChip label="Superseded by import" tone="muted" />}
                  </td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmt(c.assignedAt)}</td>
                  <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{fmt(c.releasedAt)}</td>
                  <td style={TD}>
                    {/* Next rung of the dispatch ladder. One control, driven by the
                        record's own state, so adding a rung needs no new button. */}
                    {c.active && NEXT[c.status] ? (
                      <CalciteButton scale="s" appearance="outline" disabled={busyAction || undefined}
                        onClick={() => void mutate(() => advanceCraft(c.id, NEXT[c.status]!.to))}>
                        {NEXT[c.status]!.label}
                      </CalciteButton>
                    ) : <span style={{ color: tokens.textMuted }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ fontSize: 11.5, color: tokens.textMuted }}>
        {live.length} active · {superseded.length} retired · craft come from the imported
        Fleet Register; this screen creates none.
      </div>
    </div>
  );
}
