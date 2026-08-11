import { describe, expect, it } from 'vitest';
import { buildPilotRegister } from '@/components/marine/pilotLifecycle';
import type { Pilotage } from '@/types/domain';
import type { ManualPilotAssignment } from '@/data/uc3/manualPilot';

/** An imported movement carrying only the fields the fold reads. */
function mv(over: Partial<Pilotage> = {}): Pilotage {
  return {
    pilotageId: 1, movementType: 'INWARD', callId: 1, viaNo: 'S0001', imoNo: '9000001',
    vesselName: 'IMPORTED VESSEL', pilotCode: '', vesselCondition: '',
    fromBerthId: null, toBerthId: null, draftFwdM: null, draftAftM: null,
    pilotBoardedAt: 0, firstLineAt: 0, allFastAt: 0, pilotDisembarkedAt: 0,
    berthVacatedAt: 0, anchorDownAt: 0, anchorUpAt: 0, submittedAt: 0,
    extras: {}, importFileId: null, lifecycle: null, ...over,
  } as Pilotage;
}

function ma(over: Partial<ManualPilotAssignment> = {}): ManualPilotAssignment {
  return {
    id: 1, callId: 2, vcn: '', viaNo: 'S0999', imoNo: '', vesselName: 'MANUAL VESSEL',
    pilotCode: 'JP 91', pilotName: '', status: 'Assigned', movementType: 'INWARD',
    berthId: null, assignedAt: 500, boardedAt: 0, releasedAt: 0, createdBy: 'operator',
    active: true, supersededAt: 0,
    ...over,
  };
}

describe('imported only', () => {
  it('is Busy on an open movement, sourced Imported', () => {
    const [r] = buildPilotRegister([mv({ pilotCode: 'JP 91', pilotBoardedAt: 1000 })]);
    expect([r.status, r.source, r.vessel]).toEqual(['Busy', 'Imported', 'IMPORTED VESSEL']);
  });

  it('is Available once the movement closed', () => {
    const [r] = buildPilotRegister([
      mv({ pilotCode: 'JP 91', pilotBoardedAt: 1000, pilotDisembarkedAt: 2000 })]);
    expect(r.status).toBe('Available');
  });

  it('reports the movement leg in plain language', () => {
    const [r] = buildPilotRegister([
      mv({ pilotCode: 'JP 91', movementType: 'OUTWARD', pilotBoardedAt: 1000 })]);
    expect(r.movement).toBe('Departing');
  });
});

describe('manual only', () => {
  it('is Busy when Assigned', () => {
    const [r] = buildPilotRegister([], [ma({ status: 'Assigned' })]);
    expect([r.status, r.source, r.stage]).toEqual(['Busy', 'Manual', 'Assigned']);
  });

  it('is Busy when Onboard', () => {
    const [r] = buildPilotRegister([], [ma({ status: 'Onboard', boardedAt: 900 })]);
    expect([r.status, r.stage]).toEqual(['Busy', 'Pilot Onboard']);
  });

  it('is Available once Released', () => {
    const [r] = buildPilotRegister([], [ma({ status: 'Released', releasedAt: 1200 })]);
    expect([r.status, r.stage]).toEqual(['Available', 'Completed']);
  });

  it('carries the assigned vessel and VIA', () => {
    const [r] = buildPilotRegister([], [ma()]);
    expect([r.vessel, r.via]).toEqual(['MANUAL VESSEL', 'S0999']);
  });

  it('ignores a superseded assignment entirely — no row at all', () => {
    /* A pilot whose ONLY record is an assignment an import already retired has no
       current operational standing, so the live register does not list them. The
       imported movement that superseded it names whoever actually did the job. */
    expect(buildPilotRegister([], [ma({ active: false, supersededAt: 5000 })])).toEqual([]);
  });

  it('a superseded assignment does not disturb a pilot who also has movements', () => {
    const [r] = buildPilotRegister(
      [mv({ pilotCode: 'JP 91', pilotBoardedAt: 1000 })],
      [ma({ pilotCode: 'JP 91', active: false, supersededAt: 5000 })]);
    expect([r.status, r.source]).toEqual(['Busy', 'Imported']);
  });
});

describe('imported + manual — precedence', () => {
  it('an OPEN imported movement outranks a manual assignment', () => {
    const rows = buildPilotRegister(
      [mv({ pilotCode: 'JP 91', pilotBoardedAt: 1000 })],
      [ma({ pilotCode: 'JP 91', status: 'Onboard', boardedAt: 9999 })]);
    expect(rows).toHaveLength(1);
    expect([rows[0].source, rows[0].vessel]).toEqual(['Imported', 'IMPORTED VESSEL']);
  });

  it('a CLOSED imported movement leaves the pilot free for a manual job', () => {
    const [r] = buildPilotRegister(
      [mv({ pilotCode: 'JP 91', pilotBoardedAt: 100, pilotDisembarkedAt: 200 })],
      [ma({ pilotCode: 'JP 91', status: 'Onboard', boardedAt: 900 })]);
    expect([r.status, r.source, r.vessel]).toEqual(['Busy', 'Manual', 'MANUAL VESSEL']);
  });
});

describe('no duplicates', () => {
  it('one pilot appears once even with both record types', () => {
    const rows = buildPilotRegister(
      [mv({ pilotCode: 'JP 91', pilotBoardedAt: 1000 })],
      [ma({ pilotCode: 'JP 91' })]);
    expect(rows.map((r) => r.pilotId)).toEqual(['JP 91']);
  });

  it('one pilot appears once across many imported movements', () => {
    const rows = buildPilotRegister([
      mv({ pilotageId: 1, pilotCode: 'JP 91', pilotBoardedAt: 1, pilotDisembarkedAt: 2 }),
      mv({ pilotageId: 2, pilotCode: 'JP 91', pilotBoardedAt: 3, pilotDisembarkedAt: 4 })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].movements).toBe(2);
  });

  it('distinct pilots stay distinct', () => {
    const rows = buildPilotRegister([], [ma({ pilotCode: 'JP 91' }), ma({ id: 2, pilotCode: 'JP 92' })]);
    expect(rows).toHaveLength(2);
  });
});

describe('register housekeeping', () => {
  it('sorts busy pilots above free ones', () => {
    const rows = buildPilotRegister(
      [mv({ pilotCode: 'JP 10', pilotBoardedAt: 5, pilotDisembarkedAt: 6 })],
      [ma({ pilotCode: 'JP 20', status: 'Onboard', boardedAt: 5 })]);
    expect(rows.map((r) => r.pilotId)).toEqual(['JP 20', 'JP 10']);
  });

  it('Last Updated tracks the most recent activity of either kind', () => {
    const [r] = buildPilotRegister(
      [mv({ pilotCode: 'JP 91', pilotBoardedAt: 100 })],
      [ma({ pilotCode: 'JP 91', status: 'Released', releasedAt: 7000 })]);
    expect(r.lastUpdated).toBe(7000);
  });

  it('remains callable with imported movements alone — no existing caller breaks', () => {
    expect(buildPilotRegister([mv({ pilotCode: 'JP 91' })])).toHaveLength(1);
  });

  it('names a manual-only pilot from the assignment', () => {
    const [r] = buildPilotRegister([], [ma({ pilotCode: 'X', pilotName: 'CAPT AZAD KHAN' })]);
    expect(r.name).toBe('CAPT AZAD KHAN');
  });
});
