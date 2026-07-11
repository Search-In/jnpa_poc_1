import { describe, it, expect } from 'vitest';
import {
  vesselDims,
  validateBerthFit,
  detectBerthTimeConflicts,
  detectUnknownVessels,
  detectPilotDoubleBooking,
  checkTidalWindowFits,
  intervalsOverlap,
  validatePlan,
} from './constraints';
import type { BerthingPlanEntry, Berth, PortCraftUnit, Vessel } from '@/types/domain';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

function berth(over: Partial<Berth> = {}): Berth {
  return {
    BERTH_ID: 'B1',
    BERTH_NAME: 'NSICT-1',
    TERMINAL: 'NSICT',
    LENGTH_M: 350,
    DRAFT_M: 15,
    STATUS: 'available',
    GEOM: [],
    ...over,
  };
}

function entry(over: Partial<BerthingPlanEntry> = {}): BerthingPlanEntry {
  return {
    PLAN_ID: 'P1',
    BERTH_ID: 'B1',
    MMSI: '419000001',
    VESSEL_NAME: 'ALPHA',
    PLANNED_START: T0,
    PLANNED_END: T0 + 12 * H,
    ACTUAL_START: null,
    ACTUAL_END: null,
    STATUS: 'scheduled',
    ...over,
  };
}

function vessel(over: Partial<Vessel> = {}): Vessel {
  return {
    MMSI: '419000001',
    VESSEL_NAME: 'ALPHA',
    VESSEL_TYPE: 'Container Ship',
    NAV_STATUS: 'underway',
    SOG: 8,
    COG: 90,
    HEADING: 90,
    LAT: 18.95,
    LON: 72.95,
    ETA: null,
    BERTH_ID: null,
    TIMESTAMP: T0,
    ...over,
  };
}

describe('intervalsOverlap', () => {
  it('detects overlap and treats touching endpoints as non-overlap', () => {
    expect(intervalsOverlap(0, 10, 5, 15)).toBe(true);
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
    expect(intervalsOverlap(0, 10, 20, 30)).toBe(false);
  });
});

describe('validateBerthFit', () => {
  it('flags LOA exceeding berth length', () => {
    const vs = detectFit({ LENGTH_M: 250 }, 'Container Ship'); // container LOA 300 > 250
    expect(vs.some((v) => v.code === 'LOA_EXCEEDS_BERTH')).toBe(true);
  });

  it('flags draft exceeding berth depth', () => {
    const vs = detectFit({ DRAFT_M: 12 }, 'Tanker'); // tanker draft 14.5 > 12
    expect(vs.some((v) => v.code === 'DRAFT_EXCEEDS_BERTH')).toBe(true);
  });

  it('flags a maintenance berth', () => {
    const vs = detectFit({ STATUS: 'maintenance' }, 'Container Ship');
    expect(vs.some((v) => v.code === 'BERTH_MAINTENANCE')).toBe(true);
  });

  it('passes a well-fitting vessel', () => {
    const vs = detectFit({ LENGTH_M: 350, DRAFT_M: 15 }, 'Container Ship');
    expect(vs.filter((v) => v.code !== 'BEAM_EXCEEDS_POCKET')).toHaveLength(0);
  });

  function detectFit(bOver: Partial<Berth>, type: string) {
    return validateBerthFit(entry(), berth(bOver), vesselDims({ VESSEL_TYPE: type }));
  }
});

describe('detectBerthTimeConflicts', () => {
  it('flags two entries overlapping on the same berth', () => {
    const vs = detectBerthTimeConflicts([
      entry({ PLAN_ID: 'A', PLANNED_START: T0, PLANNED_END: T0 + 10 * H }),
      entry({ PLAN_ID: 'B', VESSEL_NAME: 'BRAVO', PLANNED_START: T0 + 5 * H, PLANNED_END: T0 + 15 * H }),
    ]);
    expect(vs).toHaveLength(1);
    expect(vs[0].code).toBe('BERTH_TIME_OVERLAP');
    expect(vs[0].planId).toBe('B');
  });

  it('does not flag back-to-back entries on the same berth', () => {
    const vs = detectBerthTimeConflicts([
      entry({ PLAN_ID: 'A', PLANNED_START: T0, PLANNED_END: T0 + 10 * H }),
      entry({ PLAN_ID: 'B', PLANNED_START: T0 + 10 * H, PLANNED_END: T0 + 20 * H }),
    ]);
    expect(vs).toHaveLength(0);
  });

  it('does not flag overlap across different berths', () => {
    const vs = detectBerthTimeConflicts([
      entry({ PLAN_ID: 'A', BERTH_ID: 'B1', PLANNED_START: T0, PLANNED_END: T0 + 10 * H }),
      entry({ PLAN_ID: 'B', BERTH_ID: 'B2', PLANNED_START: T0, PLANNED_END: T0 + 10 * H }),
    ]);
    expect(vs).toHaveLength(0);
  });
});

describe('detectUnknownVessels', () => {
  it('flags a plan entry whose MMSI is not acquired', () => {
    const vs = detectUnknownVessels([entry({ MMSI: '999' })], new Set(['419000001']));
    expect(vs).toHaveLength(1);
    expect(vs[0].code).toBe('UNKNOWN_VESSEL');
  });

  it('passes when the vessel is known', () => {
    const vs = detectUnknownVessels([entry({ MMSI: '419000001' })], new Set(['419000001']));
    expect(vs).toHaveLength(0);
  });
});

describe('detectPilotDoubleBooking', () => {
  it('flags one craft serving two overlapping vessel windows', () => {
    const craft: PortCraftUnit[] = [
      { CRAFT_ID: 'PIL-1', TYPE: 'pilot', STATUS: 'deployed', ASSIGNED_MMSI: '111', DEPLOYED_AT: T0, RESPONSE_MIN: 20 },
      { CRAFT_ID: 'PIL-1', TYPE: 'pilot', STATUS: 'deployed', ASSIGNED_MMSI: '222', DEPLOYED_AT: T0, RESPONSE_MIN: 20 },
    ];
    const plan = [
      entry({ PLAN_ID: 'A', MMSI: '111', PLANNED_START: T0, PLANNED_END: T0 + 6 * H }),
      entry({ PLAN_ID: 'B', MMSI: '222', PLANNED_START: T0 + 3 * H, PLANNED_END: T0 + 9 * H }),
    ];
    const vs = detectPilotDoubleBooking(craft, plan);
    expect(vs).toHaveLength(1);
    expect(vs[0].code).toBe('PILOT_DOUBLE_BOOKED');
  });
});

describe('checkTidalWindowFits', () => {
  it('flags a window shorter than the transit', () => {
    expect(checkTidalWindowFits('P1', 1.0, 2.5)?.code).toBe('TIDAL_WINDOW_TOO_SHORT');
  });
  it('passes a sufficient window', () => {
    expect(checkTidalWindowFits('P1', 3.0, 2.5)).toBeNull();
  });
});

describe('validatePlan (aggregate)', () => {
  it('rolls up fit + overlap + unknown-vessel violations', () => {
    const vs = validatePlan({
      plan: [
        entry({ PLAN_ID: 'A', MMSI: '419000001', PLANNED_START: T0, PLANNED_END: T0 + 10 * H }),
        entry({ PLAN_ID: 'B', MMSI: '999', VESSEL_NAME: 'GHOST', PLANNED_START: T0 + 5 * H, PLANNED_END: T0 + 15 * H }),
      ],
      berths: [berth({ BERTH_ID: 'B1', LENGTH_M: 250 })], // container 300 > 250 → LOA violation
      craft: [],
      vessels: [vessel({ MMSI: '419000001' })],
    });
    const codes = vs.map((v) => v.code);
    expect(codes).toContain('LOA_EXCEEDS_BERTH');
    expect(codes).toContain('BERTH_TIME_OVERLAP');
    expect(codes).toContain('UNKNOWN_VESSEL');
  });
});
