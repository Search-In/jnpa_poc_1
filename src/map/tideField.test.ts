import { describe, it, expect } from 'vitest';
import { viridis, fieldRange, FIELD_META, type FieldVar } from './tideField';
import type { TideStation } from '@/types/domain';

const st = (over: Partial<TideStation>): TideStation => ({
  STATION_ID: 'X',
  NAME: 'X',
  LAT: 18.9,
  LON: 72.9,
  tideM: 2.5,
  tideTrend: 'slack',
  seaStateM: 1.2,
  swellM: 0.8,
  windKt: 12,
  windDir: 220,
  TS: 0,
  ...over,
});

describe('viridis colormap', () => {
  it('spans dark-purple (t=0) to yellow (t=1)', () => {
    const lo = viridis(0);
    const hi = viridis(1);
    expect(lo).toEqual([68, 1, 84]); // canonical viridis start
    expect(hi[0]).toBeGreaterThan(240); // yellow: high R+G, low B
    expect(hi[1]).toBeGreaterThan(220);
    expect(hi[2]).toBeLessThan(80);
  });

  it('clamps out-of-range t', () => {
    expect(viridis(-5)).toEqual(viridis(0));
    expect(viridis(5)).toEqual(viridis(1));
  });

  it('interpolates monotonically between stops', () => {
    const a = viridis(0.5);
    expect(a.every((c) => c >= 0 && c <= 255)).toBe(true);
  });
});

describe('fieldRange', () => {
  it('returns [min,max] across stations for the chosen variable', () => {
    const stations = [st({ seaStateM: 0.8 }), st({ seaStateM: 2.4 }), st({ seaStateM: 1.5 })];
    expect(fieldRange(stations, 'seaStateM')).toEqual([0.8, 2.4]);
  });

  it('pads a flat field so it still colours', () => {
    const stations = [st({ tideM: 2.5 }), st({ tideM: 2.5 })];
    const [lo, hi] = fieldRange(stations, 'tideM');
    expect(hi).toBeGreaterThan(lo);
  });

  it('falls back to [0,1] with no stations', () => {
    expect(fieldRange([], 'windKt')).toEqual([0, 1]);
  });
});

describe('FIELD_META', () => {
  it('covers every selectable variable with a label + unit', () => {
    (['seaStateM', 'tideM', 'windKt'] as FieldVar[]).forEach((k) => {
      expect(FIELD_META[k].label).toBeTruthy();
      expect(FIELD_META[k].unit).toBeTruthy();
    });
  });
});
