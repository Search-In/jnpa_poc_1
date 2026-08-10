import { describe, expect, it } from 'vitest';
import {
  availabilityLabel,
  berthCode,
  buildPilotRegister,
  movementStage,
  operationalStatus,
  pilotLabel,
  pilotName,
} from '@/components/marine/pilotLifecycle';
import type { Pilotage } from '@/types/domain';

/** A pilotage row with only the fields these helpers read. */
function row(over: Partial<Pilotage> = {}): Pilotage {
  return {
    pilotageId: 1, movementType: 'INWARD', callId: null, viaNo: 'S0001', imoNo: '9000001',
    vesselName: 'TEST VESSEL', pilotCode: '', vesselCondition: '',
    fromBerthId: null, toBerthId: null, draftFwdM: null, draftAftM: null,
    pilotBoardedAt: 0, firstLineAt: 0, allFastAt: 0, pilotDisembarkedAt: 0,
    berthVacatedAt: 0, anchorDownAt: 0, anchorUpAt: 0, submittedAt: 0,
    extras: {}, importFileId: null, lifecycle: null,
    ...over,
  } as Pilotage;
}

describe('operationalStatus', () => {
  it('renames every engine value into operator language', () => {
    expect(operationalStatus('Planned')).toBe('Waiting Assignment');
    expect(operationalStatus('Pilot Requested')).toBe('Assigned');
    expect(operationalStatus('Pilot Boarded')).toBe('Pilot Onboard');
  });

  it('collapses both completion values — the movement column says which leg it was', () => {
    expect(operationalStatus('Pilot Completed')).toBe('Completed');
    expect(operationalStatus('Departure Pilot Completed')).toBe('Completed');
  });

  it('passes an unknown engine value through verbatim rather than blanking it', () => {
    expect(operationalStatus('Some New State')).toBe('Some New State');
  });

  it('is empty for no status', () => {
    expect(operationalStatus(null)).toBe('');
    expect(operationalStatus(undefined)).toBe('');
  });
});

describe('movementStage', () => {
  it('maps the three movement types', () => {
    expect(movementStage('INWARD')).toBe('Arriving');
    expect(movementStage('OUTWARD')).toBe('Departing');
    expect(movementStage('SHIFTING')).toBe('Shifting Berth');
  });

  it('is case-insensitive and passes unknowns through', () => {
    expect(movementStage('inward')).toBe('Arriving');
    expect(movementStage('TOWAGE')).toBe('TOWAGE');
  });
});

describe('pilot identity', () => {
  it('prefers the roster code, falling back to the acknowledged name', () => {
    expect(pilotLabel(row({ pilotCode: 'JP 91' }))).toBe('JP 91');
    expect(pilotLabel(row({ extras: { pilot_name: 'CAPT AZAD KHAN' } }))).toBe('CAPT AZAD KHAN');
  });

  it('is empty when the movement names nobody', () => {
    expect(pilotLabel(row())).toBe('');
    expect(pilotName(row({ extras: { pilot_name: '   ' } }))).toBe('');
  });
});

describe('berthCode', () => {
  it('reads the raw sheet berth — inward takes one, outward leaves one', () => {
    expect(berthCode(row({ extras: { raw_to_berth: 'SWB-2' } }))).toBe('SWB-2');
    expect(berthCode(row({ extras: { raw_from_berth: 'APMT-2' } }))).toBe('APMT-2');
  });

  it('is empty when the parser recorded neither', () => {
    expect(berthCode(row({ extras: { raw_from_berth: '', raw_to_berth: '' } }))).toBe('');
  });
});

describe('buildPilotRegister', () => {
  it('marks a pilot Busy only while a movement is open (boarded, not disembarked)', () => {
    const [r] = buildPilotRegister([
      row({ pilotCode: 'JP 91', pilotBoardedAt: 1000, pilotDisembarkedAt: 0 }),
    ]);
    expect(r.status).toBe('Busy');
    expect(r.vessel).toBe('TEST VESSEL');
    expect(r.since).toBe(1000);
  });

  it('shows a pilot whose movements all closed as free, with no vessel', () => {
    const [r] = buildPilotRegister([
      row({ pilotCode: 'JP 91', pilotBoardedAt: 1000, pilotDisembarkedAt: 2000 }),
    ]);
    expect(r.status).toBe('Available');
    expect(r.vessel).toBe('');
    expect(r.since).toBe(0);
  });

  it('folds many movements into one row and counts them', () => {
    const rows = buildPilotRegister([
      row({ pilotageId: 1, pilotCode: 'JP 91', pilotBoardedAt: 1, pilotDisembarkedAt: 2 }),
      row({ pilotageId: 2, pilotCode: 'JP 91', pilotBoardedAt: 3, pilotDisembarkedAt: 4 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].movements).toBe(2);
  });

  it('keeps the most recent open movement when a pilot has more than one', () => {
    const [r] = buildPilotRegister([
      row({ pilotageId: 1, pilotCode: 'JP 91', pilotBoardedAt: 100, viaNo: 'S0001' }),
      row({ pilotageId: 2, pilotCode: 'JP 91', pilotBoardedAt: 900, viaNo: 'S0999' }),
    ]);
    expect(r.via).toBe('S0999');
    expect(r.since).toBe(900);
  });

  it('sorts busy pilots above free ones', () => {
    const rows = buildPilotRegister([
      row({ pilotageId: 1, pilotCode: 'JP 10', pilotBoardedAt: 5, pilotDisembarkedAt: 6 }),
      row({ pilotageId: 2, pilotCode: 'JP 20', pilotBoardedAt: 5, pilotDisembarkedAt: 0 }),
    ]);
    expect(rows.map((r) => r.pilotId)).toEqual(['JP 20', 'JP 10']);
  });

  it('ignores movements that name no pilot', () => {
    expect(buildPilotRegister([row()])).toHaveLength(0);
  });

  it('carries the name across from whichever movement has one', () => {
    const [r] = buildPilotRegister([
      row({ pilotageId: 1, extras: { pilot_name: 'CAPT AZAD KHAN' } }),
    ]);
    expect(r.name).toBe('CAPT AZAD KHAN');
    expect(r.pilotId).toBe('CAPT AZAD KHAN');
  });
});

describe('availabilityLabel', () => {
  it('says only what the backend supports — on a movement, or not', () => {
    expect(availabilityLabel('Busy')).toBe('On a movement');
    expect(availabilityLabel('Available')).toBe('Free');
  });
});
