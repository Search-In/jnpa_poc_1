import { describe, it, expect } from 'vitest';
import {
  validateVessel,
  TrackQuality,
  angularDelta,
  haversineNm,
  AOI_BBOX,
  TELEPORT_MAX_KN,
  MAX_SOG_KN,
  MAX_NAME_LEN,
} from './quality';
import type { Vessel } from '@/types/domain';

// A valid Nhava Sheva contact used as the mutation base.
function vessel(over: Partial<Vessel> = {}): Vessel {
  return {
    MMSI: '419000001',
    VESSEL_NAME: 'TEST',
    VESSEL_TYPE: 'Container Ship',
    NAV_STATUS: 'underway',
    SOG: 8,
    COG: 90,
    HEADING: 92,
    LAT: 18.95,
    LON: 72.95,
    ETA: null,
    BERTH_ID: null,
    TIMESTAMP: 1_000_000_000_000,
    ...over,
  };
}

describe('validateVessel — fatal reasons (quarantine)', () => {
  it('drops a record with no MMSI', () => {
    const r = validateVessel(vessel({ MMSI: '' }));
    expect(r.vessel).toBeNull();
    expect(r.reasons[0].code).toBe('NO_MMSI');
  });

  it('drops an unplottable position', () => {
    const r = validateVessel(vessel({ LAT: 0, LON: 0 }));
    expect(r.vessel).toBeNull();
    expect(r.reasons[0].code).toBe('BAD_POSITION');
  });

  it('drops a contact outside the AoI (e.g. mid-ocean)', () => {
    const r = validateVessel(vessel({ LAT: 0, LON: 40 }));
    expect(r.vessel).toBeNull();
    expect(r.reasons[0].code).toBe('OUT_OF_AOI');
  });
});

describe('validateVessel — warn reasons (keep + sanitise)', () => {
  it('clamps absurd SOG and keeps the contact', () => {
    const r = validateVessel(vessel({ SOG: 900 }));
    expect(r.vessel).not.toBeNull();
    expect(r.vessel!.SOG).toBe(MAX_SOG_KN);
    expect(r.reasons.some((x) => x.code === 'ABSURD_SOG')).toBe(true);
  });

  it('floors negative SOG to 0', () => {
    const r = validateVessel(vessel({ SOG: -5 }));
    expect(r.vessel!.SOG).toBe(0);
    expect(r.reasons.some((x) => x.code === 'NEGATIVE_SOG')).toBe(true);
  });

  it('flags heading vs COG contradiction while making way', () => {
    const r = validateVessel(vessel({ SOG: 10, HEADING: 0, COG: 180 }));
    expect(r.vessel).not.toBeNull();
    expect(r.reasons.some((x) => x.code === 'HEADING_COG_CONFLICT')).toBe(true);
  });

  it('does NOT flag heading/COG when nearly stopped', () => {
    const r = validateVessel(vessel({ SOG: 0.5, HEADING: 0, COG: 180 }));
    expect(r.reasons.some((x) => x.code === 'HEADING_COG_CONFLICT')).toBe(false);
  });

  it('truncates an over-long vessel name', () => {
    const long = 'X'.repeat(200);
    const r = validateVessel(vessel({ VESSEL_NAME: long }));
    expect(r.vessel!.VESSEL_NAME.length).toBe(MAX_NAME_LEN);
    expect(r.reasons.some((x) => x.code === 'NAME_TRUNCATED')).toBe(true);
  });

  it('passes a clean contact with no reasons', () => {
    const r = validateVessel(vessel());
    expect(r.vessel).not.toBeNull();
    expect(r.reasons).toHaveLength(0);
  });
});

describe('angularDelta', () => {
  it('computes smallest circular difference', () => {
    expect(angularDelta(10, 350)).toBe(20);
    expect(angularDelta(0, 180)).toBe(180);
    expect(angularDelta(90, 90)).toBe(0);
  });
});

describe('haversineNm', () => {
  it('is ~0 for identical points and positive otherwise', () => {
    expect(haversineNm(18.95, 72.95, 18.95, 72.95)).toBeCloseTo(0, 5);
    expect(haversineNm(18.95, 72.95, 19.05, 73.05)).toBeGreaterThan(0);
  });
});

describe('TrackQuality — teleport / regression / dedup', () => {
  const T0 = 1_000_000_000_000;

  it('accepts a plausible move and advances the track', () => {
    const tq = new TrackQuality();
    expect(tq.vet(vessel({ TIMESTAMP: T0 }), 'ais', T0).vessel).not.toBeNull();
    // ~0.5 nm over 6 min ≈ 5 kn — fine.
    const later = tq.vet(
      vessel({ LAT: 18.9583, LON: 72.95, TIMESTAMP: T0 + 6 * 60_000 }),
      'ais',
      T0 + 6 * 60_000
    );
    expect(later.vessel).not.toBeNull();
    expect(later.reasons).toHaveLength(0);
  });

  it('rejects a teleport and keeps the last good position', () => {
    const tq = new TrackQuality();
    tq.vet(vessel({ TIMESTAMP: T0 }), 'ais', T0);
    // Jump ~6 nm in 1 minute ≈ 360 kn.
    const jump = tq.vet(
      vessel({ LAT: 19.05, LON: 73.05, TIMESTAMP: T0 + 60_000 }),
      'ais',
      T0 + 60_000
    );
    expect(jump.vessel).toBeNull();
    expect(jump.reasons[0].code).toBe('TELEPORT');
  });

  it('rejects a timestamp regression on reconnect', () => {
    const tq = new TrackQuality();
    tq.vet(vessel({ TIMESTAMP: T0 }), 'ais', T0);
    const old = tq.vet(vessel({ TIMESTAMP: T0 - 60_000 }), 'ais', T0);
    expect(old.vessel).toBeNull();
    expect(old.reasons[0].code).toBe('TIMESTAMP_REGRESSION');
  });

  it('drops a cross-source duplicate MMSI, keeping the incumbent', () => {
    const tq = new TrackQuality();
    tq.vet(vessel({ TIMESTAMP: T0 }), 'aisstream', T0);
    const dup = tq.vet(vessel({ TIMESTAMP: T0 + 10_000 }), 'marinetraffic', T0 + 10_000);
    expect(dup.vessel).toBeNull();
    expect(dup.reasons[0].code).toBe('DUPLICATE');
  });

  it('reports stale tracks past the staleness threshold', () => {
    const tq = new TrackQuality();
    tq.vet(vessel({ MMSI: '111', TIMESTAMP: T0 }), 'ais', T0);
    const now = T0 + 20 * 60_000; // 20 min later
    expect(tq.staleTracks(now)).toContain('111');
    expect(tq.ageMin('111', now)).toBeCloseTo(20, 5);
  });

  it('exposes the AoI bbox and teleport threshold as constants', () => {
    expect(AOI_BBOX).toHaveLength(2);
    expect(TELEPORT_MAX_KN).toBe(50);
  });
});
