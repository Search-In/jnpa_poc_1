/**
 * The pilot data and mutations the Vessel Calls table needs for its Pilot column.
 *
 * Isolated in a hook because the table itself is a rendering concern and this is three
 * backend reads plus a write path. It is the same triple PilotAssignmentsTab loads —
 * manual assignments, imported pilotage, and the register that says which pilots are free
 * — so the two screens cannot disagree about who is available.
 *
 * WHY THIS COSTS ONLY TWO EXTRA REQUESTS. Pilot STATE is already on every call row: the
 * gateway attaches the projected lifecycle to `GET /marine/calls`. What is fetched here is
 * only what the lifecycle omits — the pilot's identity, and the manual assignment id that
 * Board/Release target. The status half of the column would work with no fetch at all.
 *
 * WRITES ANNOUNCE, NEVER PREDICT. A mutation refetches and then calls
 * propagateMarineStateUpdate() so Port Craft, Marine State and the Timeline re-read the
 * recomputed lifecycle. Nothing is applied optimistically: a 409 (assigning onto a call
 * that already has an imported memo) is a real answer, and other screens must not
 * re-render around a change the backend refused.
 */

import { useCallback, useMemo, useState } from 'react';
import { useAdapterQuery } from '@/hooks/useAdapterQuery';
import { fetchPilotagePage } from '@/data/uc3/pilotage';
import {
  assignPilot, boardPilot, fetchManualPilotAssignments, releasePilot,
} from '@/data/uc3/manualPilot';
import { buildPilotRegister, type PilotRegisterRow } from '@/components/marine/pilotLifecycle';
import { indexImportedByCall, indexManualByCall, callLabel } from '@/components/marine/pilotDesk';
import { propagateMarineStateUpdate, useMarineStateVersion } from '@/data/uc3/marineStateBus';
import type { VesselCall } from '@/types/domain';

/**
 * How much of each register to load. Matches PilotAssignmentsTab's own scan, so the two
 * screens see the same slice; the corpus holds 433 pilotage rows, inside this ceiling.
 */
export const PILOT_SCAN = 500;

export interface PilotDesk {
  manualByCall: ReturnType<typeof indexManualByCall>;
  importedByCall: ReturnType<typeof indexImportedByCall>;
  /** Pilots with no open movement and no live assignment — the Assign dropdown's options. */
  available: PilotRegisterRow[];
  loading: boolean;
  /** A read that failed. The column degrades to status-only rather than erroring the table. */
  error: string | null;
  /** A write that was refused, verbatim. Cleared on the next attempt. */
  actionError: string | null;
  clearActionError: () => void;
  busy: boolean;
  /**
   * Each resolves TRUE when the backend accepted the write. They never reject: a refusal
   * is reported through `actionError`, and the boolean is what lets a caller keep its
   * picker open on a 409 instead of discarding the operator's choice.
   */
  assign: (call: VesselCall, pilot: PilotRegisterRow) => Promise<boolean>;
  board: (assignmentId: number) => Promise<boolean>;
  release: (assignmentId: number) => Promise<boolean>;
}

export function usePilotDesk(): PilotDesk {
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const marineVersion = useMarineStateVersion();

  const assignments = useAdapterQuery(
    () => fetchManualPilotAssignments({ limit: PILOT_SCAN }),
    [refreshKey, marineVersion],
  );
  const pilotage = useAdapterQuery(
    () => fetchPilotagePage({}, PILOT_SCAN, 0),
    [refreshKey, marineVersion],
  );

  const manualRows = useMemo(() => assignments.data?.items ?? [], [assignments.data]);
  const importedRows = useMemo(() => pilotage.data?.items ?? [], [pilotage.data]);

  const manualByCall = useMemo(() => indexManualByCall(manualRows), [manualRows]);
  const importedByCall = useMemo(() => indexImportedByCall(importedRows), [importedRows]);

  const available = useMemo(() => {
    // Fed BOTH sources so a pilot already holding a manual assignment reads Busy here,
    // exactly as on the Pilot Assignments screen — one definition of "free", not two.
    const registry = buildPilotRegister(importedRows, manualRows);
    const engaged = new Set(
      manualRows.filter((a) => a.active && a.status !== 'Released').map((a) => a.pilotCode),
    );
    return registry.filter((r) => r.status !== 'Busy' && !engaged.has(r.pilotId));
  }, [importedRows, manualRows]);

  const mutate = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      setRefreshKey((k) => k + 1);
      propagateMarineStateUpdate();
      return true;
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const assign = useCallback(
    (call: VesselCall, pilot: PilotRegisterRow) =>
      mutate(() =>
        assignPilot({
          callId: call.callId,
          pilotCode: pilot.pilotId,
          pilotName: pilot.name || undefined,
          vcn: call.vcn || undefined,
          viaNo: call.viaNo || undefined,
          imoNo: call.imoNo || undefined,
          // Snapshotted for the ledger's own display. A nameless call sends its VCN/VIA
          // label instead of nothing, so the Pilot Assignments audit table stays readable
          // for exactly the rows that could not be assigned before.
          vesselName: call.vesselName || callLabel(call),
          createdBy: 'operator',
        }),
      ),
    [mutate],
  );

  const board = useCallback((id: number) => mutate(() => boardPilot(id)), [mutate]);
  const release = useCallback((id: number) => mutate(() => releasePilot(id)), [mutate]);

  return {
    manualByCall,
    importedByCall,
    available,
    loading: (assignments.loading && !assignments.data) || (pilotage.loading && !pilotage.data),
    error: assignments.error || pilotage.error,
    actionError,
    clearActionError: useCallback(() => setActionError(null), []),
    busy,
    assign,
    board,
    release,
  };
}
