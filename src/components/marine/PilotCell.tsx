/**
 * <PilotCell> — the Pilot column of the Vessel Calls table: current pilot state, who holds
 * the vessel, and the ONE action that is legal from here.
 *
 * The decision of what to show and what to offer is not made in this file — it is
 * `buildCallPilotView` in ./pilotDesk, which reads the projected lifecycle the gateway
 * already attached to the row. This component renders that verdict.
 *
 * ASSIGNING WITHOUT LEAVING THE TABLE. The pilot picker opens INSIDE the cell rather than
 * as a modal: the operator is scanning a list of vessels, and a dialog would hide the row
 * being crewed along with the rest of the fleet. Only one cell can be open at a time — the
 * parent owns that state — so the table never grows two pickers or two pending writes.
 *
 * Clicks are stopped from bubbling. Every row is a click target that changes the timeline
 * selection, and choosing a pilot must not also re-aim the panes beside the table.
 */

import type { CSSProperties } from 'react';
import { CalciteButton } from '@esri/calcite-components-react';
import { StatusChip } from '@/components/shipping/dataTable';
import { lifecycleTone } from '@/components/marine/lifecycleTone';
import {
  berthRequirement, buildCallPilotView, callLabel, legalMovements, movementLabel,
} from '@/components/marine/pilotDesk';
import type { PilotDesk } from '@/components/marine/usePilotDesk';
import { tokens } from '@/theme/tokens';
import type { VesselCall } from '@/types/domain';

const SELECT: CSSProperties = {
  fontSize: 11.5,
  padding: '3px 6px',
  borderRadius: tokens.radius.sm,
  border: `1px solid ${tokens.border}`,
  background: tokens.panel,
  color: tokens.text,
  maxWidth: 150,
};

const ROW: CSSProperties = { display: 'flex', alignItems: 'center', gap: 6 };

export function PilotCell({
  call,
  desk,
  open,
  onOpenChange,
  pilotId,
  onPilotIdChange,
  movement,
  onMovementChange,
  berthId,
  onBerthIdChange,
}: {
  call: VesselCall;
  desk: PilotDesk;
  /** True when THIS cell owns the open picker. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pilotId: string;
  onPilotIdChange: (id: string) => void;
  /** The leg being declared. Preselected by the parent from the call's own lifecycle. */
  movement: string;
  onMovementChange: (m: string) => void;
  /** Destination berth. Seeded from the call's current berth; required for a shift. */
  berthId: number | null;
  onBerthIdChange: (id: number | null) => void;
}) {
  const view = buildCallPilotView(call, desk.manualByCall, desk.importedByCall);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  // A failed read means the imported-pilotage index is incomplete, and an Assign offered
  // against a call whose memo simply did not load would be refused with a 409. The STATE
  // still comes from the row's own lifecycle, so the column degrades to read-only rather
  // than disappearing — a status the operator can trust beats an action they cannot.
  const actionable = !desk.error && !desk.loading;

  const chip = view.label ? (
    <StatusChip
      label={view.label}
      tone={lifecycleTone(view.tone)}
      // The chip alone cannot say why a row offers nothing; the reason rides in the
      // tooltip so "no button" is never silent.
      title={view.reason ? `${view.label} — ${view.reason}` : view.label}
    />
  ) : (
    <span style={{ color: tokens.textMuted }}>—</span>
  );

  const who = view.pilot ? (
    <span
      style={{ color: tokens.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}
      title={`${view.pilot}${view.source ? ` · ${view.source.toLowerCase()}` : ''}`}
    >
      {view.pilot}
    </span>
  ) : null;

  // ---- the open picker ----------------------------------------------------------------
  if (open && view.action === 'assign' && actionable) {
    const chosen = desk.available.find((r) => r.pilotId === pilotId);
    const needsBerth = berthRequirement(movement);
    // Sorted by code so the list reads like the quay, not like insertion order.
    const berthOptions = [...desk.berths.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    // A shift with no destination is the bug this picker exists to prevent, so Confirm
    // stays disabled until one is chosen rather than silently writing a no-op movement.
    const berthOk = needsBerth !== 'required' || berthId !== null;
    return (
      <div style={ROW} onClick={stop}>
        {/* The leg comes FIRST: it is the question the operator answers, and it decides
            what Release will record — BERTHED for an inward or shifting movement,
            SAILED for an outward one. Preselected, so the common case is one click. */}
        <select
          style={{ ...SELECT, maxWidth: 130 }}
          value={movement}
          autoFocus
          onChange={(e) => onMovementChange(e.target.value)}
          aria-label={`Movement leg for ${callLabel(call)}`}
        >
          {/* Impossible legs are DISABLED rather than hidden, and carry the reason: an
              operator who expects to see 'Shifting' should learn why it is unavailable,
              not find the option silently missing. */}
          {legalMovements(call).map((m) => (
            <option key={m.value} value={m.value} disabled={!m.legal} title={m.why}>
              {m.label}{m.legal ? '' : ' — not possible'}
            </option>
          ))}
        </select>
        {/* Destination. A SHIFTING movement IS its destination — releasing without one
            recorded 'she is fast alongside' while the call still named the berth she had
            just left. Hidden for OUTWARD, which frees a berth rather than taking one. */}
        {needsBerth !== 'none' && (
          <select
            style={{ ...SELECT, maxWidth: 110 }}
            value={berthId === null ? '' : String(berthId)}
            onChange={(e) => onBerthIdChange(e.target.value ? Number(e.target.value) : null)}
            aria-label={`Destination berth for ${callLabel(call)}`}
          >
            <option value="">{needsBerth === 'required' ? 'Berth…' : 'No berth'}</option>
            {berthOptions.map(([id, code]) => (
              <option key={id} value={id}>{code}</option>
            ))}
          </select>
        )}
        <select
          style={SELECT}
          value={pilotId}
          onChange={(e) => onPilotIdChange(e.target.value)}
          aria-label={`Select a pilot for ${callLabel(call)}`}
        >
          <option value="">
            {desk.available.length ? `Pilot (${desk.available.length} free)` : 'No pilot free'}
          </option>
          {desk.available.map((r) => (
            <option key={r.pilotId} value={r.pilotId}>{r.name || r.pilotId}</option>
          ))}
        </select>
        <CalciteButton
          scale="s"
          disabled={!chosen || !berthOk || desk.busy || undefined}
          title={berthOk ? undefined : 'Choose the berth she is shifting to'}
          onClick={() => {
            if (!chosen || !berthOk) return;
            // Close ONLY on success. A 409 (the call gained an imported memo since the
            // page loaded) leaves the picker open with the choice intact, so the operator
            // can read the notice and pick another pilot rather than start over.
            void desk.assign(call, chosen, movement, berthId).then((ok) => {
              if (!ok) return;
              onPilotIdChange('');
              onOpenChange(false);
            });
          }}
        >
          Confirm
        </CalciteButton>
        <CalciteButton
          scale="s"
          appearance="transparent"
          kind="neutral"
          iconStart="x"
          label="Cancel"
          title="Cancel"
          disabled={desk.busy || undefined}
          onClick={() => {
            onPilotIdChange('');
            onOpenChange(false);
          }}
        />
      </div>
    );
  }

  // ---- resting state ------------------------------------------------------------------
  return (
    <div style={ROW}>
      {chip}
      {who}
      {actionable && view.action === 'assign' && (
        <CalciteButton
          scale="s"
          appearance="outline"
          iconStart="plus"
          disabled={desk.busy || undefined}
          onClick={(e) => {
            stop(e as unknown as { stopPropagation: () => void });
            onOpenChange(true);
          }}
        >
          Assign
        </CalciteButton>
      )}
      {actionable && view.action === 'board' && view.assignmentId !== null && (
        <CalciteButton
          scale="s"
          appearance="outline"
          disabled={desk.busy || undefined}
          onClick={(e) => {
            stop(e as unknown as { stopPropagation: () => void });
            void desk.board(view.assignmentId!);
          }}
        >
          Board
        </CalciteButton>
      )}
      {actionable && view.action === 'release' && view.assignmentId !== null && (
        <CalciteButton
          scale="s"
          appearance="outline"
          disabled={desk.busy || undefined}
          title={
            view.movementType
              ? `Release the pilot and complete the movement (${movementLabel(view.movementType)})`
                + (view.berthId !== null && desk.berths.get(view.berthId)
                  ? ` → ${desk.berths.get(view.berthId)}`
                  : '')
              : 'Release the pilot. No leg was declared, so the visit will not advance.'
          }
          onClick={(e) => {
            stop(e as unknown as { stopPropagation: () => void });
            void desk.release(view.assignmentId!);
          }}
        >
          Release
        </CalciteButton>
      )}
    </div>
  );
}
