import { describe, it, expect } from 'vitest';
import {
  aisHubMmsi,
  aisHubUrl,
  mapAisHubPosition,
  mapAisHubType,
  navStatusFromSpeed,
  parseAisHubResponse,
  type AisHubMapResponse,
  type AisHubPosition,
} from './aishub';
import sample from './mock/aishub.sample.json';

const base: AisHubPosition = {
  tst: '1784052125',
  ship_name: 'GRANDE SHANGHAI',
  mmsi: 'fa76ca858c02cf1ba15da978839b3294',
  lat: '18.84989',
  lon: '72.52982',
  cog: 270,
  sog: 1,
  type: 'Cargo',
  class: '1',
  eta: '491776',
  sources: 0,
  unique: false,
  icon: 1,
};

describe('aishub type mapping', () => {
  it('maps cargo → container ship (container-port default)', () => {
    expect(mapAisHubType('Cargo', 1)).toBe('Container Ship');
  });
  it('maps tankers → Tanker', () => {
    expect(mapAisHubType('Tankers', 2)).toBe('Tanker');
  });
  it('falls back to icon code when text is unknown', () => {
    expect(mapAisHubType('Unknown', 2)).toBe('Tanker');
    expect(mapAisHubType('Unknown', 1)).toBe('Container Ship');
    expect(mapAisHubType('Unknown', 256)).toBe('Unknown');
  });
});

describe('navStatusFromSpeed', () => {
  it('treats near-zero speed as anchored, else underway', () => {
    expect(navStatusFromSpeed(0)).toBe('anchored');
    expect(navStatusFromSpeed(0.4)).toBe('anchored');
    expect(navStatusFromSpeed(5)).toBe('underway');
  });
});

describe('aisHubMmsi', () => {
  it('prefixes the anonymised hash so it never collides with a numeric MMSI', () => {
    const key = aisHubMmsi('fa76ca858c02cf1ba15da978839b3294');
    expect(key).toBe('AISHUB-fa76ca858c02cf1ba15da978839b3294');
    expect(key).not.toMatch(/^\d+$/); // not a real MMSI
  });
});

describe('mapAisHubPosition', () => {
  it('maps a full record onto a live Vessel', () => {
    const v = mapAisHubPosition(base)!;
    expect(v).not.toBeNull();
    expect(v.MMSI).toBe('AISHUB-fa76ca858c02cf1ba15da978839b3294');
    expect(v.VESSEL_NAME).toBe('GRANDE SHANGHAI');
    expect(v.VESSEL_TYPE).toBe('Container Ship');
    expect(v.LAT).toBeCloseTo(18.84989, 5);
    expect(v.LON).toBeCloseTo(72.52982, 5);
    expect(v.COG).toBe(270);
    expect(v.HEADING).toBe(270); // COG used as heading (no true heading in feed)
    expect(v.SOURCE).toBe('live');
    expect(v.TIMESTAMP).toBe(1784052125 * 1000);
  });

  it('drops records with an unplottable position', () => {
    expect(mapAisHubPosition({ ...base, lat: '0', lon: '0' })).toBeNull();
    expect(mapAisHubPosition({ ...base, lat: 'x', lon: 'y' })).toBeNull();
  });

  it('drops records with no key', () => {
    expect(mapAisHubPosition({ ...base, mmsi: '' })).toBeNull();
  });
});

describe('parseAisHubResponse', () => {
  it('parses the bundled JNPA station sample into real vessels', () => {
    const vessels = parseAisHubResponse(sample as AisHubMapResponse);
    expect(vessels.length).toBe(38);
    // Every parsed vessel is a live fix with a plottable position near JNPA.
    for (const v of vessels) {
      expect(v.SOURCE).toBe('live');
      expect(v.MMSI.startsWith('AISHUB-')).toBe(true);
      expect(v.LAT).toBeGreaterThan(18);
      expect(v.LAT).toBeLessThan(20);
      expect(v.LON).toBeGreaterThan(72);
      expect(v.LON).toBeLessThan(74);
    }
    // A known vessel from the sample is present with its real name.
    expect(vessels.some((v) => v.VESSEL_NAME === 'HMM LEAF')).toBe(true);
  });

  it('returns empty for a malformed / empty payload', () => {
    expect(parseAisHubResponse(null)).toEqual([]);
    expect(parseAisHubResponse({})).toEqual([]);
    expect(parseAisHubResponse({ extent: [], positions: [] })).toEqual([]);
  });
});

describe('aisHubUrl', () => {
  it('builds the proxied station map.json path', () => {
    expect(aisHubUrl('2387')).toBe('/aishub-proxy/station/2387/map.json');
    expect(aisHubUrl('2387', '/x')).toBe('/x/station/2387/map.json');
  });
});
