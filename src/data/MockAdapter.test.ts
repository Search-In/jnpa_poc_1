import { describe, it, expect, vi, afterEach } from 'vitest';
import { MockAdapter, bucketArrivalsDepartures, computeWhatIf } from './MockAdapter';
import { SHIPPING_LINES } from './mock/fixtures';
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

  /**
   * The note used to list the scenario inputs but never the model, leaving a
   * reader free to assume the deltas came from a recompute over the plan. They
   * come from a linear stub, and every result must say so — including the
   * no-input case, where the numbers look most authoritative.
   */
  it('always discloses the model, not just the scenario inputs', () => {
    for (const r of [computeWhatIf({}, 80, 24, T0), computeWhatIf({ delayHours: 2 }, 80, 24, T0)]) {
      expect(r.note).toMatch(/linear stub/i);
      expect(r.note).toMatch(/5 pp JIT/);
      expect(r.note).toMatch(/[Nn]ot a queueing/);
    }
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

  it('returns the seven JNPA berths across all five terminals', async () => {
    const berths = await new MockAdapter().getBerths();
    expect(berths).toHaveLength(7);
    // One berth per terminal at minimum — shared naming NSICT/NSIGT/GTI/BMCT/JNPCT.
    const terminals = new Set(berths.map((b) => b.TERMINAL));
    expect(terminals).toEqual(new Set(['NSICT', 'NSIGT', 'GTI', 'BMCT', 'JNPCT']));
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

describe('MockAdapter.getShippingLines', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('serves the local fixture, busiest first', async () => {
    const lines = await new MockAdapter().getShippingLines();
    expect(lines).toEqual(SHIPPING_LINES);
    expect(lines.length).toBeGreaterThan(0);
    // Same ordering contract as the live endpoint (container_count DESC).
    const counts = lines.map((l) => l.containerCount);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('makes NO network call — mock mode stays fully offline', async () => {
    // The whole point of the mock driver: zero credentials, zero I/O. If this
    // ever reaches the UC-3 backend the offline demo is broken.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await new MockAdapter().getShippingLines();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('every fixture row satisfies the domain contract', async () => {
    for (const l of await new MockAdapter().getShippingLines()) {
      expect(l.lineCode).toBeTruthy();
      // lineName is never null: it falls back to the code, exactly as the live
      // mapper does for the backend's always-null line_name.
      expect(l.lineName).toBe(l.lineCode);
      expect(Number.isFinite(l.firstSeen)).toBe(true);
      expect(Number.isFinite(l.lastSeen)).toBe(true);
      expect(l.containerCount).toBeGreaterThanOrEqual(0);
    }
  });

  it('is deterministic across calls and instances', async () => {
    const a = await new MockAdapter().getShippingLines();
    const b = await new MockAdapter().getShippingLines();
    expect(a).toEqual(b);
  });
});
