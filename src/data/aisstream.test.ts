import { describe, it, expect } from 'vitest';
import {
  mapAisMessage,
  mapNavStatus,
  mapVesselType,
  mapStaticData,
  isPlottablePosition,
} from './aisstream';

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

describe('mapVesselType', () => {
  it('maps AIS ship-type codes to categories', () => {
    expect(mapVesselType(70)).toBe('Container Ship'); // cargo range
    expect(mapVesselType(79)).toBe('Container Ship');
    expect(mapVesselType(80)).toBe('Tanker');
    expect(mapVesselType(89)).toBe('Tanker');
    expect(mapVesselType(52)).toBe('Tug');
    expect(mapVesselType(50)).toBe('Pilot Vessel');
    expect(mapVesselType(60)).toBe('Passenger Ship');
    expect(mapVesselType(0)).toBe('Unknown');
    expect(mapVesselType(undefined)).toBe('Unknown');
  });
});

describe('mapStaticData', () => {
  it('extracts name + type from ShipStaticData', () => {
    const s = mapStaticData({
      MessageType: 'ShipStaticData',
      MetaData: { MMSI: 244000000, ShipName: ' STENA  ' },
      Message: { ShipStaticData: { Name: 'STENA GERMANICA', Type: 81 } },
    });
    expect(s).toEqual({ MMSI: '244000000', VESSEL_NAME: 'STENA GERMANICA', VESSEL_TYPE: 'Tanker' });
  });

  it('returns null for non-static messages', () => {
    expect(mapStaticData({ MessageType: 'PositionReport' })).toBeNull();
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

  it('drops a report with no position instead of fabricating (0,0)', () => {
    // MMSI present, but neither the report nor MetaData carries a fix.
    const v = mapAisMessage({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 419000123, ShipName: 'GHOST' },
      Message: { PositionReport: { Sog: 3, Cog: 90 } },
    });
    expect(v).toBeNull();
  });

  it('drops the AIS "null island" (0,0) no-fix sentinel', () => {
    const v = mapAisMessage({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 419000123 },
      Message: { PositionReport: { Latitude: 0, Longitude: 0 } },
    });
    expect(v).toBeNull();
  });

  it('drops out-of-range / non-finite coordinates', () => {
    const bad = (lat: number, lon: number) =>
      mapAisMessage({
        MessageType: 'PositionReport',
        MetaData: { MMSI: 419000123 },
        Message: { PositionReport: { Latitude: lat, Longitude: lon } },
      });
    expect(bad(91, 72.95)).toBeNull(); // lat > 90
    expect(bad(18.95, 181)).toBeNull(); // lon > 180
    expect(bad(NaN, 72.95)).toBeNull(); // non-finite
  });

  it('accepts a valid MetaData-only position', () => {
    const v = mapAisMessage({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 419000123, latitude: 18.95, longitude: 72.95 },
      Message: { PositionReport: { Sog: 5 } },
    });
    expect(v).not.toBeNull();
    expect(v!.LAT).toBe(18.95);
    expect(v!.LON).toBe(72.95);
  });
});

describe('isPlottablePosition', () => {
  it('accepts real WGS84 positions', () => {
    expect(isPlottablePosition(18.95, 72.95)).toBe(true);
    expect(isPlottablePosition(-33.9, 151.2)).toBe(true);
    expect(isPlottablePosition(0, 72.95)).toBe(true); // equator with a real lon
  });

  it('rejects the (0,0) no-fix sentinel, out-of-range, and non-finite', () => {
    expect(isPlottablePosition(0, 0)).toBe(false);
    expect(isPlottablePosition(90.1, 0)).toBe(false);
    expect(isPlottablePosition(0, -180.1)).toBe(false);
    expect(isPlottablePosition(NaN, 10)).toBe(false);
    expect(isPlottablePosition(10, Infinity)).toBe(false);
    expect(isPlottablePosition(undefined, 10)).toBe(false);
    expect(isPlottablePosition(10, undefined)).toBe(false);
  });
});
