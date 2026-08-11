import { describe, it, expect } from 'vitest';
import {
  buildCallPilotView,
  callLabel,
  indexImportedByCall,
  indexManualByCall,
  isCallIdentifiable,
} from '@/components/marine/pilotDesk';
import type { ManualPilotAssignment } from '@/data/uc3/manualPilot';
import type { CallLifecycle, Pilotage, VesselCall } from '@/types/domain';

const lifecycle = (over: Partial<CallLifecycle> = {}): CallLifecycle => ({
  status: 'Planned', arrivalState: 'Pending', berthState: 'Pending', pilotState: 'Pending',
  departureState: 'Pending', shippingState: 'Pending', portcraftState: 'Idle',
  craftState: 'Idle', craftCommitted: 0, isInPort: false, isAtBerth: false, latestEvent: '',
  ...over,
});

const call = (over: Partial<VesselCall> = {}): VesselCall => ({
  callId: 12, vcn: 'INNSA1BM0R3119', viaNo: 'S0561', imoNo: '', vesselName: 'MAERSK SENTOSA',
  voyageNo: '0561W', rotationNo: '3119', terminalId: null, terminalCode: '', berthId: null,
  berthCode: '', purpose: 'Cargo', status: 'Planned', lifecycle: lifecycle(), igmNo: null,
  sourceNote: '', eta: 0, etb: 0, etd: 0, ata: 0, atc: 0, atd: 0, createdAt: 0, updatedAt: 0,
  ...over,
});

const manual = (over: Partial<ManualPilotAssignment> = {}): ManualPilotAssignment => ({
  id: 1, callId: 12, vcn: '', viaNo: '', imoNo: '', vesselName: '', pilotCode: 'JP91',
  pilotName: 'J PATEL', status: 'Assigned', assignedAt: 1000, boardedAt: 0, releasedAt: 0,
  createdBy: 'operator', active: true, supersededAt: 0,
  ...over,
});

const pilotage = (over: Partial<Pilotage> = {}): Pilotage => ({
  pilotageId: 1, movementType: 'INWARD', callId: 12, viaNo: 'S0561', imoNo: '',
  vesselName: 'MAERSK SENTOSA', pilotCode: 'JP 07', vesselCondition: '',
  fromBerthId: null, toBerthId: null, draftFwdM: null, draftAftM: null,
  pilotBoardedAt: 0, firstLineAt: 0, allFastAt: 0, pilotDisembarkedAt: 0,
  berthVacatedAt: 0, anchorDownAt: 0, anchorUpAt: 0, submittedAt: 0,
  extras: {}, importFileId: null, lifecycle: null,
  ...over,
});

describe('indexManualByCall', () => {
  it('skips superseded rows — the backend retired them, so no action is legal', () => {
    expect(indexManualByCall([manual({ active: false })]).size).toBe(0);
  });

  it('keeps the most recently started row when a call somehow has two live ones', () => {
    const older = manual({ id: 1, assignedAt: 1000 });
    const newer = manual({ id: 2, assignedAt: 5000 });
    expect(indexManualByCall([older, newer]).get(12)?.id).toBe(2);
    expect(indexManualByCall([newer, older]).get(12)?.id).toBe(2);
  });
});

describe('indexImportedByCall', () => {
  it('ignores rows with no call to attach to', () => {
    expect(indexImportedByCall([pilotage({ callId: null })]).size).toBe(0);
  });

  it('prefers an OPEN movement over a finished one — the current pilot, not the last', () => {
    const finished = pilotage({ pilotageId: 1, pilotBoardedAt: 9000, pilotDisembarkedAt: 9500 });
    const open = pilotage({ pilotageId: 2, pilotBoardedAt: 100, pilotDisembarkedAt: 0 });
    expect(indexImportedByCall([finished, open]).get(12)?.pilotageId).toBe(2);
  });
});

describe('buildCallPilotView', () => {
  const none = new Map();

  it('offers Assign when the projection says a pilot is awaited', () => {
    const v = buildCallPilotView(call(), none, none);
    expect(v.action).toBe('assign');
    expect(v.label).toBe('Awaiting pilot');
    expect(v.pilot).toBe('');
  });

  it('offers NOTHING when the projection has no opinion — never guesses from columns', () => {
    const v = buildCallPilotView(call({ lifecycle: null }), none, none);
    expect(v.action).toBeNull();
    expect(v.reason).toContain('no opinion');
  });

  it('offers nothing once the vessel has sailed, whatever the pilot state says', () => {
    const c = call({ lifecycle: lifecycle({ pilotState: 'Pending', departureState: 'Completed' }) });
    const v = buildCallPilotView(c, none, none);
    expect(v.action).toBeNull();
    expect(v.reason).toContain('sailed');
  });

  it('makes an IMPORTED row read-only and says why — a button here could only 409', () => {
    const imported = indexImportedByCall([pilotage({ pilotBoardedAt: 500 })]);
    const c = call({ lifecycle: lifecycle({ pilotState: 'Active' }) });
    const v = buildCallPilotView(c, none, imported);
    expect(v.action).toBeNull();
    expect(v.source).toBe('Imported');
    expect(v.pilot).toBe('JP 07');
    expect(v.label).toBe('Pilot onboard');
    expect(v.reason).toContain('Imported');
  });

  it('imported beats manual for the same call, matching buildPilotRegister precedence', () => {
    const v = buildCallPilotView(
      call(),
      indexManualByCall([manual()]),
      indexImportedByCall([pilotage({ pilotBoardedAt: 500 })]),
    );
    expect(v.source).toBe('Imported');
    expect(v.action).toBeNull();
  });

  it('walks the manual workflow: Assigned → Board, Onboard → Release, Released → done', () => {
    const step = (status: string) =>
      buildCallPilotView(call(), indexManualByCall([manual({ status })]), none);

    expect(step('Assigned').action).toBe('board');
    expect(step('Onboard').action).toBe('release');
    expect(step('Released').action).toBeNull();
    expect(step('Released').reason).toContain('finished');
  });

  it('carries the assignment id, since Board/Release PATCH against it', () => {
    const v = buildCallPilotView(call(), indexManualByCall([manual({ id: 77 })]), none);
    expect(v.assignmentId).toBe(77);
  });

  it('names the pilot from the manual record, falling back to the roster code', () => {
    const named = buildCallPilotView(call(), indexManualByCall([manual()]), none);
    expect(named.pilot).toBe('J PATEL');
    const coded = buildCallPilotView(
      call(), indexManualByCall([manual({ pilotName: '' })]), none);
    expect(coded.pilot).toBe('JP91');
  });

  it('labels from the RECORD, so a fresh write is not mislabelled by a stale projection', () => {
    // The row still says Pending because the projection has not refreshed; the assignment
    // already says Onboard. The button and the chip must agree with each other.
    const v = buildCallPilotView(
      call({ lifecycle: lifecycle({ pilotState: 'Pending' }) }),
      indexManualByCall([manual({ status: 'Onboard' })]),
      none,
    );
    expect(v.label).toBe('Pilot onboard');
    expect(v.action).toBe('release');
  });

  it('reads Assigned and Onboard as one situation regardless of which source produced it', () => {
    const importedActive = buildCallPilotView(
      call({ lifecycle: lifecycle({ pilotState: 'Active' }) }),
      none,
      indexImportedByCall([pilotage({ pilotBoardedAt: 1 })]),
    );
    const manualOnboard = buildCallPilotView(
      call(), indexManualByCall([manual({ status: 'Onboard' })]), none);
    expect(importedActive.label).toBe(manualOnboard.label);
  });

  it('passes an unknown pilot state through verbatim rather than blanking it', () => {
    const v = buildCallPilotView(
      call({ lifecycle: lifecycle({ pilotState: 'Quarantined' }) }), none, none);
    expect(v.label).toBe('Quarantined');
    expect(v.action).toBeNull();
  });
});

describe('callLabel / isCallIdentifiable', () => {
  it('prefers the vessel name when there is one', () => {
    expect(callLabel(call())).toBe('MAERSK SENTOSA');
  });

  it('falls back to VCN, then VIA — the identifiers a nameless CALINF actually carries', () => {
    expect(callLabel(call({ vesselName: '' }))).toBe('INNSA1BM0R3119');
    expect(callLabel(call({ vesselName: '', vcn: '' }))).toBe('S0561');
  });

  it('never returns blank, so a nameless call can still be listed in the picker', () => {
    expect(callLabel(call({ vesselName: '', vcn: '', viaNo: '' }))).toBe('Call #12');
  });

  it('accepts a call carrying no identifier but a call id — the backend needs only that', () => {
    expect(isCallIdentifiable(call({ vesselName: '', vcn: '', viaNo: '' }))).toBe(true);
    expect(isCallIdentifiable(call({ callId: 0 }))).toBe(false);
  });
});
