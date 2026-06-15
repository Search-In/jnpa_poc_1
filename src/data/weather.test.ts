import { describe, it, expect } from 'vitest';
import { parseLonLat } from './weather';

describe('parseLonLat', () => {
  it('parses "lon,lat" into {lat, lon}', () => {
    expect(parseLonLat('4.15,51.95')).toEqual({ lat: 51.95, lon: 4.15 });
  });

  it('falls back to 0 for malformed input', () => {
    expect(parseLonLat('')).toEqual({ lat: 0, lon: 0 });
    expect(parseLonLat('abc')).toEqual({ lat: 0, lon: 0 });
  });
});
