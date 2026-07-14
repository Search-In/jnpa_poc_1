import { describe, it, expect } from 'vitest';
import { TIDE_STATIONS } from './tide';
import { makeTideStations } from './mock/fixtures';
import { applyTideStations } from '@/sim/applySim';
import type { SimSnapshot } from '@/sim/applySim';
import type { SimLevers } from '@/sim/simStore';

const NEUTRAL_LEVERS = {
  weatherSeverity: 0,
  tideOffsetM: 0,
  channelDepthDeltaM: 0,
  pilotsDown: 0,
  tugsDown: 0,
  berthsOut: [],
} as unknown as SimLevers;

const snap = (levers: Partial<SimLevers>): SimSnapshot =>
  ({ clockH: 0, levers: { ...NEUTRAL_LEVERS, ...levers } }) as unknown as SimSnapshot;

describe('makeTideStations (mock)', () => {
  it('returns one reading per configured station, deterministically', () => {
    const a = makeTideStations(1000, 3);
    const b = makeTideStations(1000, 3);
    expect(a.stations).toHaveLength(TIDE_STATIONS.length);
    expect(a).toEqual(b); // seeded → reproducible
  });

  it('every station carries a sane tide + sea-state reading', () => {
    const { stations } = makeTideStations(0, 0);
    for (const s of stations) {
      expect(s.tideM).toBeGreaterThan(0);
      expect(s.seaStateM).toBeGreaterThanOrEqual(0);
      expect(['rising', 'falling', 'slack']).toContain(s.tideTrend);
    }
  });
});

describe('applyTideStations (what-if consistency)', () => {
  it('passes the base reading through unchanged when levers are neutral', () => {
    const base = makeTideStations(0, 2);
    expect(applyTideStations(base, snap({}))).toEqual(base);
  });

  it('shifts every station tide height by the tide offset', () => {
    const base = makeTideStations(0, 2);
    const out = applyTideStations(base, snap({ tideOffsetM: -0.8 }));
    out.stations.forEach((s, i) => {
      expect(s.tideM).toBeCloseTo(base.stations[i].tideM - 0.8, 2);
    });
  });

  it('lifts sea state under weather severity (a storm hits the whole port)', () => {
    const base = makeTideStations(0, 2);
    const out = applyTideStations(base, snap({ weatherSeverity: 1 }));
    out.stations.forEach((s, i) => {
      expect(s.seaStateM).toBeGreaterThan(base.stations[i].seaStateM);
    });
  });
});
