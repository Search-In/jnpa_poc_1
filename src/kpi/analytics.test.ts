import { describe, it, expect } from 'vitest';
import {
  etaDistribution,
  occupancyCalendar,
  waitingTimeDistribution,
  terminalTat,
} from './analytics';
import type { Berth, BerthingPlanEntry } from '@/types/domain';

const H = 3_600_000;
const DAY = 86_400_000;
const T0 = Math.floor(1_700_000_000_000 / DAY) * DAY; // day-aligned

function berth(id: string, terminal: string): Berth {
  return { BERTH_ID: id, BERTH_NAME: id, TERMINAL: terminal, LENGTH_M: 350, DRAFT_M: 16, STATUS: 'available', GEOM: [] };
}
function entry(over: Partial<BerthingPlanEntry>): BerthingPlanEntry {
  return {
    PLAN_ID: 'P',
    BERTH_ID: 'B1',
    MMSI: 'M',
    VESSEL_NAME: 'V',
    PLANNED_START: T0,
    PLANNED_END: T0 + 12 * H,
    ACTUAL_START: null,
    ACTUAL_END: null,
    STATUS: 'scheduled',
    ...over,
  };
}

describe('etaDistribution', () => {
  it('widens with horizon and staleness, centred on the point', () => {
    const near = etaDistribution(T0, 2, 0);
    const far = etaDistribution(T0, 24, 0);
    expect(near.p50Ms).toBe(T0);
    expect(far.spreadH).toBeGreaterThan(near.spreadH);
    const stale = etaDistribution(T0, 2, 30);
    expect(stale.spreadH).toBeGreaterThan(near.spreadH);
    // band is symmetric
    expect(far.p90Ms - far.p50Ms).toBe(far.p50Ms - far.p10Ms);
  });
});

describe('occupancyCalendar', () => {
  it('computes per-berth per-day occupied fraction', () => {
    const berths = [berth('B1', 'T1')];
    // 12h of occupancy on day 0 → 0.5.
    const cells = occupancyCalendar([entry({ PLANNED_START: T0, PLANNED_END: T0 + 12 * H })], berths, T0, 2);
    expect(cells).toHaveLength(2); // 1 berth × 2 days
    expect(cells[0].fraction).toBeCloseTo(0.5, 2);
    expect(cells[1].fraction).toBe(0);
  });

  it('caps a fully-occupied day at 1', () => {
    const berths = [berth('B1', 'T1')];
    const cells = occupancyCalendar([entry({ PLANNED_START: T0 - H, PLANNED_END: T0 + 26 * H })], berths, T0, 1);
    expect(cells[0].fraction).toBe(1);
  });
});

describe('waitingTimeDistribution', () => {
  it('buckets pre-berth waits and computes percentiles', () => {
    const plan = [
      entry({ PLAN_ID: 'A', PLANNED_START: T0, ACTUAL_START: T0 + 1 * H }), // 1h → 0-2
      entry({ PLAN_ID: 'B', PLANNED_START: T0, ACTUAL_START: T0 + 3 * H }), // 3h → 2-4
      entry({ PLAN_ID: 'C', PLANNED_START: T0, ACTUAL_START: T0 + 10 * H }), // 10h → 8-12
    ];
    const d = waitingTimeDistribution(plan);
    expect(d.n).toBe(3);
    expect(d.buckets.find((b) => b.label === '0–2h')!.count).toBe(1);
    expect(d.buckets.find((b) => b.label === '8–12h')!.count).toBe(1);
    expect(d.meanH).toBeCloseTo(4.7, 1);
  });

  it('returns a defined empty distribution when no actuals', () => {
    const d = waitingTimeDistribution([entry({})]);
    expect(d.n).toBe(0);
    expect(d.p50H).toBe(0);
  });
});

describe('terminalTat', () => {
  it('computes mean TAT per terminal', () => {
    const berths = [berth('B1', 'NSICT'), berth('B2', 'BMCT')];
    const plan = [
      entry({ BERTH_ID: 'B1', ACTUAL_START: T0, ACTUAL_END: T0 + 20 * H }),
      entry({ BERTH_ID: 'B1', ACTUAL_START: T0, ACTUAL_END: T0 + 24 * H }),
      entry({ BERTH_ID: 'B2', ACTUAL_START: T0, ACTUAL_END: T0 + 30 * H }),
    ];
    const t = terminalTat(plan, berths);
    expect(t.find((x) => x.terminal === 'NSICT')!.meanTatH).toBeCloseTo(22, 1);
    expect(t.find((x) => x.terminal === 'BMCT')!.meanTatH).toBeCloseTo(30, 1);
  });
});
