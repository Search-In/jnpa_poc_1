import { describe, it, expect } from 'vitest';
import {
  buildCallPilotView,
  callLabel,
  defaultMovement,
  indexImportedByCall,
  indexManualByCall,
  isCallIdentifiable,
  movementLabel,
  MOVEMENTS,
  berthRequirement,
  defaultBerthId,
  allowedMovements,
  legalMovements,
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
  movementType: 'INWARD', berthId: null, createdBy: 'operator', active: true,
  supersededAt: 0,
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

describe('movement legs', () => {
  it('offers exactly the gateway vocabulary — anything else fails the 0054 CHECK', () => {
    expect(MOVEMENTS.map((m) => m.value)).toEqual(['INWARD', 'OUTWARD', 'SHIFTING']);
  });

  it('defaults a vessel already alongside to OUTWARD — she is taking a pilot to leave', () => {
    // isAtBerth implies isInPort and a completed arrival: the engine derives
    // `is_in_port = (arrived or berthed) and not departed`, so a berthed-but-not-in-port
    // vessel is a state it cannot produce. The fixture has to be coherent for the
    // legality rules to mean anything.
    const c = call({ lifecycle: lifecycle({ isAtBerth: true, isInPort: true,
                                            arrivalState: 'Completed' }) });
    expect(defaultMovement(c)).toBe('OUTWARD');
  });

  it('defaults everything else to INWARD, including a call with no lifecycle', () => {
    expect(defaultMovement(call())).toBe('INWARD');
    expect(defaultMovement(call({ lifecycle: null }))).toBe('INWARD');
  });

  it('labels a stored leg, and returns blank for one never declared', () => {
    expect(movementLabel('OUTWARD')).toBe('Outward — departing');
    expect(movementLabel('outward')).toBe('Outward — departing');
    expect(movementLabel('')).toBe('');
    expect(movementLabel('INBOUND')).toBe('');
  });

  it('carries the declared leg onto the cell, so Release can say what it will complete', () => {
    const v = buildCallPilotView(
      call(),
      indexManualByCall([manual({ status: 'Onboard', movementType: 'OUTWARD' })]),
      new Map(),
    );
    expect(v.action).toBe('release');
    expect(v.movementType).toBe('OUTWARD');
  });

  it('leaves the leg blank on an imported row — that record declares its own movement', () => {
    const v = buildCallPilotView(
      call(), new Map(), indexImportedByCall([pilotage({ pilotBoardedAt: 500 })]));
    expect(v.movementType).toBe('');
  });

  it('leaves it blank on a pre-0054 assignment, so the UI can warn nothing will advance', () => {
    const v = buildCallPilotView(
      call(), indexManualByCall([manual({ status: 'Onboard', movementType: '' })]), new Map());
    expect(v.movementType).toBe('');
  });
});

describe('destination berth', () => {
  it('requires one for a SHIFT — a shift IS its destination', () => {
    expect(berthRequirement('SHIFTING')).toBe('required');
  });

  it('offers one for INWARD, so a call BERALT never berthed can still be berthed', () => {
    expect(berthRequirement('INWARD')).toBe('optional');
  });

  it('asks for none on OUTWARD — she is leaving, not taking a berth', () => {
    expect(berthRequirement('OUTWARD')).toBe('none');
  });

  it('asks for none when the leg is unknown, so no picker appears on a legacy row', () => {
    expect(berthRequirement('')).toBe('none');
    expect(berthRequirement('INBOUND')).toBe('none');
  });

  it('seeds from the berth the call already holds, so INWARD confirms rather than retypes', () => {
    expect(defaultBerthId(call({ berthId: 19 }))).toBe(19);
    expect(defaultBerthId(call({ berthId: null }))).toBeNull();
  });

  it('carries the declared berth onto the cell so Release can name where she goes', () => {
    const v = buildCallPilotView(
      call(),
      indexManualByCall([manual({ status: 'Onboard', movementType: 'SHIFTING', berthId: 40 })]),
      new Map(),
    );
    expect(v.action).toBe('release');
    expect(v.berthId).toBe(40);
  });

  it('is null on an imported row and on a pre-0055 assignment', () => {
    const imported = buildCallPilotView(
      call(), new Map(), indexImportedByCall([pilotage({ pilotBoardedAt: 500 })]));
    expect(imported.berthId).toBeNull();

    const legacy = buildCallPilotView(
      call(), indexManualByCall([manual({ berthId: null })]), new Map());
    expect(legacy.berthId).toBeNull();
  });
});

describe('movement legality — where she is decides what she can do', () => {
  const atSea = call({ lifecycle: lifecycle({ arrivalState: 'Pending', isAtBerth: false, isInPort: false }) });
  const alongside = call({ lifecycle: lifecycle({ arrivalState: 'Completed', isAtBerth: true, isInPort: true }) });
  const inPortNotBerthed = call({ lifecycle: lifecycle({ arrivalState: 'Completed', isAtBerth: false, isInPort: true }) });

  it('offers ONLY inward to a vessel that has not arrived', () => {
    // 1080 of 1505 assignable calls are in this state. They could previously be sent
    // shifting from a berth they were not at, or sailed without ever arriving.
    expect(allowedMovements(atSea)).toEqual(['INWARD']);
  });

  it('offers shifting and outward to a vessel alongside, but not inward', () => {
    expect(allowedMovements(alongside).sort()).toEqual(['OUTWARD', 'SHIFTING']);
  });

  it('lets an arrived-but-unberthed vessel sail, but not shift', () => {
    expect(allowedMovements(inPortNotBerthed)).toEqual(['OUTWARD']);
  });

  it('allows nothing when the projection has no opinion about where she is', () => {
    expect(allowedMovements(call({ lifecycle: null }))).toEqual([]);
  });

  it('explains every refusal, so a missing option is never silent', () => {
    const byValue = Object.fromEntries(legalMovements(atSea).map((m) => [m.value, m]));
    expect(byValue.SHIFTING.legal).toBe(false);
    expect(byValue.SHIFTING.why).toContain('Not at a berth');
    expect(byValue.OUTWARD.why).toContain('cannot depart before she arrives');
    expect(byValue.INWARD.why).toBe('');
  });

  it('defaults to a leg that is actually legal, never merely preferred', () => {
    // The old default was `isAtBerth ? OUTWARD : INWARD` with no legality check.
    expect(defaultMovement(atSea)).toBe('INWARD');
    expect(defaultMovement(alongside)).toBe('OUTWARD');
    expect(defaultMovement(inPortNotBerthed)).toBe('OUTWARD');
  });

  it('offers no Assign at all when no movement is possible from where she is', () => {
    // Eligible for a pilot by pilot_state, but the projection places her nowhere.
    const nowhere = call({ lifecycle: lifecycle({ pilotState: 'Pending', arrivalState: 'Completed',
                                                  isAtBerth: false, isInPort: false }) });
    const v = buildCallPilotView(nowhere, new Map(), new Map());
    expect(v.action).toBeNull();
    expect(v.reason).toContain('No movement is possible');
  });

  it('still offers Assign where a leg IS possible', () => {
    expect(buildCallPilotView(atSea, new Map(), new Map()).action).toBe('assign');
  });
});
