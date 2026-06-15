import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockAdapter, bucketArrivalsDepartures, computeWhatIf } from './MockAdapter';
import type { BerthingPlanEntry } from '@/types/domain';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

function entry(over: Partial<BerthingPlanEntry>): BerthingPlanEntry {
  return {
    PLAN_ID: 'P',
    BERTH_ID: 'B',
    MMSI: '1',
    VESSEL_NAME: 'V',
    PLANNED_START: T0,
    PLANNED_END: T0 + 8 * H,
    ACTUAL_START: null,
    ACTUAL_END: null,
    STATUS: 'scheduled',
    ...over,
  };
}

describe('bucketArrivalsDepartures', () => {
  it('buckets actual starts/ends into 4h blocks', () => {
    const from = T0;
    const to = T0 + 8 * H; // two 4h blocks
    const plan = [
      entry({ ACTUAL_START: T0 + 1 * H }), // block 0 arrival
      entry({ ACTUAL_START: T0 + 5 * H }), // block 1 arrival
      entry({ ACTUAL_END: T0 + 2 * H }), // block 0 departure
    ];
    const blocks = bucketArrivalsDepartures(plan, from, to);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].arrivals).toBe(1);
    expect(blocks[0].departures).toBe(1);
    expect(blocks[1].arrivals).toBe(1);
    expect(blocks[1].departures).toBe(0);
  });

  it('ignores null actuals', () => {
    const blocks = bucketArrivalsDepartures([entry({})], T0, T0 + 4 * H);
    expect(blocks[0].arrivals).toBe(0);
    expect(blocks[0].departures).toBe(0);
  });
});

describe('computeWhatIf', () => {
  it('drops JIT and raises TAT proportional to delay and weather severity', () => {
    const r = computeWhatIf(
      { delayVesselMmsi: '1', delayHours: 2, weatherSeverity: 0.5 },
      80,
      24,
      T0
    );
    // penaltyFactor = 1.5; jitDrop = 2*5*1.5 = 15 → 65; tatRise = 2*1.5 = 3 → 27.
    expect(r.jitPctAfter).toBeCloseTo(65, 5);
    expect(r.avgTatAfter).toBeCloseTo(27, 5);
    expect(r.jitPctBefore).toBe(80);
    expect(r.note).toContain('Delaying 1');
  });

  it('leaves baseline unchanged with no inputs', () => {
    const r = computeWhatIf({}, 80, 24, T0);
    expect(r.jitPctAfter).toBe(80);
    expect(r.avgTatAfter).toBe(24);
    expect(r.note).toContain('baseline unchanged');
  });

  it('never drives JIT below 0', () => {
    const r = computeWhatIf({ delayHours: 100 }, 80, 24, T0);
    expect(r.jitPctAfter).toBe(0);
  });
});

describe('MockAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports mock mode', () => {
    expect(new MockAdapter().mode).toBe('mock');
  });

  it('returns the six JNPA berths', async () => {
    const berths = await new MockAdapter().getBerths();
    expect(berths).toHaveLength(6);
    expect(berths.every((b) => b.GEOM.length >= 4)).toBe(true);
  });

  it('builds a full 8-card KPI bundle in mock mode', async () => {
    const b = await new MockAdapter().getKPIs();
    expect(Object.keys(b)).toHaveLength(8);
    expect(b.jitPct.unit).toBe('%');
    expect(b.anchored.value).toBeGreaterThanOrEqual(0);
  });

  it('streams an initial vessel batch then ticks on the interval', async () => {
    vi.useFakeTimers();
    const adapter = new MockAdapter();
    const batches: number[] = [];
    const unsub = adapter.subscribeVessels((v) => batches.push(v.length));

    // Flush the queued microtask that emits the initial batch.
    await vi.advanceTimersByTimeAsync(0);
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(batches[0]).toBe(10);

    // Advance one stream interval → one more batch.
    const before = batches.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(batches.length).toBe(before + 1);

    unsub();
    // After unsubscribe, ticks stop.
    const after = batches.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(batches.length).toBe(after);
  });

  it('filters the berthing plan to the requested window', async () => {
    const adapter = new MockAdapter();
    const plan = await adapter.getBerthPlan({ lastHours: 48 });
    expect(plan.length).toBeGreaterThan(0);
  });
});
