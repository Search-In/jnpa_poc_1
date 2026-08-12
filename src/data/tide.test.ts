import { describe, it, expect, vi, afterEach } from 'vitest';
import { TIDE_STATIONS, trendFromSeries, fetchTideStations } from './tide';
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

describe('trendFromSeries (tide trend)', () => {
  // Open-Meteo returns the WHOLE forecast day hourly, so the last samples are in
  // the future. The trend must be read from the sample ~1 h BEFORE now.
  const day = Array.from({ length: 24 }, (_, h) => `2026-08-12T${String(h).padStart(2, '0')}:00`);
  const at = (h: number, m = 0) => Date.parse(`2026-08-12T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);

  it('reads rising from the previous hour, not the end of the series', () => {
    // Flooding through the afternoon, ebbing late — the old code compared 17:45
    // against 22:00 and called a rising tide "falling".
    const heights = day.map((_, h) => (h <= 18 ? h * 0.1 : 3.0 - (h - 18) * 0.5));
    expect(trendFromSeries(at(17, 45), day, heights, heights[17] + 0.05)).toBe('rising');
  });

  it('reads falling when the previous hour was higher', () => {
    const heights = day.map((_, h) => 3.0 - h * 0.1);
    expect(trendFromSeries(at(17, 45), day, heights, heights[17] - 0.2)).toBe('falling');
  });

  it('reports slack inside the ±0.05 m dead band', () => {
    const heights = day.map(() => 2.0);
    expect(trendFromSeries(at(17, 45), day, heights, 2.02)).toBe('slack');
  });

  it('never invents a direction without a usable past sample', () => {
    expect(trendFromSeries(at(17, 45), [], [], 2.0)).toBe('slack');
    expect(trendFromSeries(at(17, 45), day, [], 2.0)).toBe('slack');
    // Current height unknown → no trend, whatever the series says.
    expect(trendFromSeries(at(17, 45), day, day.map((_, h) => h * 0.1), null)).toBe('slack');
  });

  it('ignores future samples entirely', () => {
    // Only 23:00 carries a value; at 06:00 that sample is in the future, so the
    // trend must abstain rather than compare against it.
    const heights = day.map((_, h) => (h === 23 ? 9 : NaN));
    expect(trendFromSeries(at(6, 0), day, heights, 2.0)).toBe('slack');
  });
});

describe('fetchTideStations (live Open-Meteo shape)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Stub both upstreams; `marine` may omit fields to model a partial answer. */
  const stubFetch = (marine: Record<string, unknown>, wind: Record<string, unknown> | null) =>
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url.includes('marine-api')
        ? { ok: true, json: async () => marine }
        : wind === null
          ? { ok: false, json: async () => ({}) }
          : { ok: true, json: async () => wind },
    ));

  const MARINE = {
    // The grid cell Open-Meteo actually resolves JNPA berth coordinates to: it
    // is ~8 km west of the terminals, and every berth station lands in it.
    latitude: 18.958336,
    longitude: 72.875015,
    current: { wave_height: 1.62, swell_wave_height: 1.5, sea_level_height_msl: 1.62 },
    hourly: { time: ['2026-08-12T16:00', '2026-08-12T17:00'], sea_level_height_msl: [1.2, 1.4] },
  };
  const WIND = { current: { wind_speed_10m: 7.4, wind_direction_10m: 226 } };

  it('carries real readings through with no missing markers', async () => {
    stubFetch(MARINE, WIND);
    const { stations } = await fetchTideStations(Date.parse('2026-08-12T17:45:00Z'));
    expect(stations).toHaveLength(TIDE_STATIONS.length);
    const s = stations[0];
    expect(s.tideM).toBe(1.62);
    expect(s.seaStateM).toBe(1.6);
    expect(s.windKt).toBe(7.4);
    expect(s.missing).toBeUndefined();
  });

  it('records the resolved grid cell, which is NOT the station coordinate', async () => {
    stubFetch(MARINE, WIND);
    const { stations } = await fetchTideStations(0);
    expect(stations[0].cell).toEqual({ LAT: 18.958336, LON: 72.875015 });
    expect(stations[0].cell!.LON).not.toBeCloseTo(stations[0].LON, 2);
    // All stations share the one cell here — the panel must be able to say so.
    expect(new Set(stations.map((s) => `${s.cell!.LAT},${s.cell!.LON}`)).size).toBe(1);
  });

  it('marks a withheld measurement instead of reporting it as 0', async () => {
    // No wave/swell in the answer, and the wind upstream is down.
    stubFetch({ ...MARINE, current: { sea_level_height_msl: 1.62 } }, null);
    const { stations } = await fetchTideStations(0);
    const s = stations[0];
    expect(s.missing).toEqual(['seaStateM', 'swellM', 'windKt']);
    expect(s.tideM).toBe(1.62); // the one real reading survives
  });
});
