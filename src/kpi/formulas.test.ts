import { describe, it, expect } from 'vitest';
import {
  preBerthingDelay,
  avgPreBerthingDelay,
  preSailingDelay,
  avgPreSailingDelay,
  avgVesselTAT,
  justInTimePct,
  forecastAccuracyPct,
  berthOccupancyPct,
  craftPerformance,
} from './formulas';

const H = 3_600_000;
const MIN = 60_000;
// Fixed reference clock so every test is deterministic (no Date.now()).
const T0 = 1_700_000_000_000;

describe('preBerthingDelay', () => {
  it('is ATB − (ATA + pilotage lead), clamped at 0', () => {
    // ATA at T0, default lead 1.5h → expected berth at T0+1.5h.
    // ATB at T0+4h → delay = 4 − 1.5 = 2.5h.
    expect(preBerthingDelay({ ata: T0, atb: T0 + 4 * H })).toBeCloseTo(2.5, 5);
  });

  it('clamps negative delay (berthed faster than lead) to 0', () => {
    expect(preBerthingDelay({ ata: T0, atb: T0 + 0.5 * H })).toBe(0);
  });

  it('honours a custom pilotage lead', () => {
    // lead 2h, ATB at +5h → 3h.
    expect(preBerthingDelay({ ata: T0, atb: T0 + 5 * H }, 2)).toBeCloseTo(3, 5);
  });

  it('averages across vessels', () => {
    const events = [
      { ata: T0, atb: T0 + 4 * H }, // 2.5
      { ata: T0, atb: T0 + 6 * H }, // 4.5
    ];
    expect(avgPreBerthingDelay(events)).toBeCloseTo(3.5, 5);
    expect(avgPreBerthingDelay([])).toBe(0);
  });
});

describe('preSailingDelay', () => {
  it('is ATD − (cargo-complete + clearance), clamped at 0', () => {
    // clearance default 2h. cargoComplete T0, ATD T0+5h → 3h.
    expect(preSailingDelay({ cargoComplete: T0, atd: T0 + 5 * H })).toBeCloseTo(3, 5);
  });

  it('clamps and averages', () => {
    expect(preSailingDelay({ cargoComplete: T0, atd: T0 + 1 * H })).toBe(0);
    expect(
      avgPreSailingDelay([
        { cargoComplete: T0, atd: T0 + 5 * H }, // 3
        { cargoComplete: T0, atd: T0 + 7 * H }, // 5
      ])
    ).toBeCloseTo(4, 5);
  });
});

describe('avgVesselTAT', () => {
  it('averages ATD − ATA over completed calls only', () => {
    const calls = [
      { ata: T0, atd: T0 + 24 * H }, // 24
      { ata: T0, atd: T0 + 30 * H }, // 30
      { ata: T0, atd: null }, // excluded (still in port)
    ];
    expect(avgVesselTAT(calls)).toBeCloseTo(27, 5);
  });

  it('returns 0 when nothing is completed', () => {
    expect(avgVesselTAT([{ ata: T0, atd: null }])).toBe(0);
    expect(avgVesselTAT([])).toBe(0);
  });
});

describe('justInTimePct', () => {
  it('counts arrivals within tolerance of the recommended slot', () => {
    const arrivals = [
      { ata: T0, recommendedSlot: T0 }, // 0 min → on time
      { ata: T0 + 30 * MIN, recommendedSlot: T0 }, // 30 min → on time (≤60)
      { ata: T0 + 90 * MIN, recommendedSlot: T0 }, // 90 min → late
      { ata: T0 - 120 * MIN, recommendedSlot: T0 }, // early 120 min → late
    ];
    // 2 of 4 on time = 50%.
    expect(justInTimePct(arrivals)).toBeCloseTo(50, 5);
  });

  it('respects a custom tolerance and handles empty', () => {
    const arrivals = [{ ata: T0 + 90 * MIN, recommendedSlot: T0 }];
    expect(justInTimePct(arrivals, 120)).toBe(100);
    expect(justInTimePct([])).toBe(0);
  });
});

describe('forecastAccuracyPct', () => {
  it('returns 100% when predicted lead equals actual lead', () => {
    const ref = T0;
    const eta = T0 + 10 * H;
    const acc = forecastAccuracyPct([{ reference: ref, predictedEta: eta, actualAta: eta }]);
    expect(acc).toBeCloseTo(100, 5);
  });

  it('drops below 100% when prediction misses (MAPE on lead time)', () => {
    const ref = T0;
    // predicted lead 10h, actual lead 11h → MAPE = |(11-10)/11| ≈ 0.0909
    const acc = forecastAccuracyPct([
      { reference: ref, predictedEta: T0 + 10 * H, actualAta: T0 + 11 * H },
    ]);
    expect(acc).toBeCloseTo((1 - 1 / 11) * 100, 4);
  });

  it('ignores unresolved predictions and returns 0 when none resolved', () => {
    expect(
      forecastAccuracyPct([{ reference: T0, predictedEta: T0 + 5 * H, actualAta: null }])
    ).toBe(0);
  });
});

describe('berthOccupancyPct', () => {
  it('is occupied-hours / (berths * windowHours), clipped to window', () => {
    const start = T0;
    const end = T0 + 10 * H; // 10h window
    // 2 berths → available = 20 berth-hours.
    // One interval occupies a single berth for 10h (full window) = 10 occupied-hours.
    const occ = berthOccupancyPct([{ start, end }], 2, start, end);
    expect(occ).toBeCloseTo(50, 5);
  });

  it('clips intervals overhanging the window and caps at 100%', () => {
    const start = T0;
    const end = T0 + 10 * H;
    // Interval runs before and after the window; only 10h count. 1 berth → 100%.
    const occ = berthOccupancyPct([{ start: T0 - 5 * H, end: T0 + 20 * H }], 1, start, end);
    expect(occ).toBe(100);
  });

  it('treats a null end as occupied to window end', () => {
    const start = T0;
    const end = T0 + 10 * H;
    const occ = berthOccupancyPct([{ start: T0 + 5 * H, end: null }], 1, start, end);
    expect(occ).toBeCloseTo(50, 5);
  });

  it('returns 0 for zero berths or zero window', () => {
    expect(berthOccupancyPct([{ start: T0, end: T0 + H }], 0, T0, T0 + H)).toBe(0);
    expect(berthOccupancyPct([], 2, T0, T0)).toBe(0);
  });
});

describe('craftPerformance', () => {
  it('computes utilisation % and average response per type', () => {
    const stats = craftPerformance([
      { type: 'pilot', deployed: true, responseMin: 20 },
      { type: 'pilot', deployed: false, responseMin: 30 },
      { type: 'tug', deployed: true, responseMin: 10 },
      { type: 'tug', deployed: true, responseMin: null },
    ]);
    const pilot = stats.find((s) => s.type === 'pilot')!;
    const tug = stats.find((s) => s.type === 'tug')!;
    const mooring = stats.find((s) => s.type === 'mooring')!;

    expect(pilot.utilisationPct).toBeCloseTo(50, 5);
    expect(pilot.avgResponseMin).toBeCloseTo(25, 5);
    expect(tug.utilisationPct).toBeCloseTo(100, 5);
    expect(tug.avgResponseMin).toBeCloseTo(10, 5); // null response skipped
    expect(mooring.count).toBe(0);
    expect(mooring.utilisationPct).toBe(0);
  });
});
