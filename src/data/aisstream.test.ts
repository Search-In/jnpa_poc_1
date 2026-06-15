import { describe, it, expect } from 'vitest';
import { mapAisMessage, mapNavStatus } from './aisstream';

describe('mapNavStatus', () => {
  it('maps known AIS status codes', () => {
    expect(mapNavStatus(1)).toBe('anchored');
    expect(mapNavStatus(5)).toBe('moored');
    expect(mapNavStatus(0)).toBe('underway');
    expect(mapNavStatus(8)).toBe('underway');
    expect(mapNavStatus(99)).toBe('underway');
    expect(mapNavStatus(undefined)).toBe('underway');
  });
});

describe('mapAisMessage', () => {
  it('maps a PositionReport to a Vessel', () => {
    const v = mapAisMessage({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 419000123, ShipName: ' BHARAT ', time_utc: '2023-11-14T00:00:00Z' },
      Message: {
        PositionReport: {
          Sog: 12.3,
          Cog: 270,
          TrueHeading: 268,
          NavigationalStatus: 1,
          Latitude: 18.95,
          Longitude: 72.95,
        },
      },
    });
    expect(v).not.toBeNull();
    expect(v!.MMSI).toBe('419000123');
    expect(v!.VESSEL_NAME).toBe('BHARAT');
    expect(v!.NAV_STATUS).toBe('anchored');
    expect(v!.SOG).toBe(12.3);
    expect(v!.HEADING).toBe(268);
    expect(v!.LAT).toBe(18.95);
  });

  it('falls back to MMSI label when name is blank', () => {
    const v = mapAisMessage({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 123, ShipName: '   ' },
      Message: { PositionReport: { Latitude: 1, Longitude: 2 } },
    });
    expect(v!.VESSEL_NAME).toBe('MMSI 123');
  });

  it('returns null for non-position messages and missing MMSI', () => {
    expect(mapAisMessage({ MessageType: 'ShipStaticData' })).toBeNull();
    expect(
      mapAisMessage({ MessageType: 'PositionReport', Message: { PositionReport: {} } })
    ).toBeNull();
  });
});
