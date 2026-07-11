import { describe, it, expect } from 'vitest';
import { optimiseBerthPlan, type BerthRequest, type GoWindow } from './optimiser';
import type { Berth } from '@/types/domain';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

function berth(id: string, over: Partial<Berth> = {}): Berth {
  return { BERTH_ID: id, BERTH_NAME: id, TERMINAL: 'T', LENGTH_M: 350, DRAFT_M: 16, STATUS: 'available', GEOM: [], ...over };
}
function req(planId: string, over: Partial<BerthRequest> = {}): BerthRequest {
  return {
    planId,
    mmsi: `M-${planId}`,
    vesselName: `V-${planId}`,
    requestedStartMs: T0,
    durationMs: 10 * H,
    loaM: 300,
    draftM: 13.5,
    ...over,
  };
}

describe('optimiseBerthPlan', () => {
  it('produces a conflict-free assignment (no overlaps on a berth)', () => {
    const berths = [berth('B1')];
    const requests = [
      req('A', { requestedStartMs: T0 }),
      req('B', { requestedStartMs: T0 + 2 * H }), // would overlap A on B1
    ];
    const res = optimiseBerthPlan(requests, berths);
    expect(res.assignments).toHaveLength(2);
    const [a, b] = res.assignments.sort((x, y) => x.startMs - y.startMs);
    expect(a.endMs).toBeLessThanOrEqual(b.startMs); // B pushed after A
    expect(res.breakdown.waitH).toBeGreaterThan(0);
  });

  it('spreads calls across berths to avoid waiting', () => {
    const berths = [berth('B1'), berth('B2')];
    const requests = [req('A', { requestedStartMs: T0 }), req('B', { requestedStartMs: T0 })];
    const res = optimiseBerthPlan(requests, berths);
    const usedBerths = new Set(res.assignments.map((a) => a.berthId));
    expect(usedBerths.size).toBe(2); // one each, no wait
    expect(res.breakdown.waitH).toBe(0);
  });

  it('rejects a vessel too large for any berth (unplaced)', () => {
    const berths = [berth('B1', { LENGTH_M: 200 })];
    const res = optimiseBerthPlan([req('A', { loaM: 300 })], berths);
    expect(res.assignments).toHaveLength(0);
    expect(res.unplaced.map((r) => r.planId)).toEqual(['A']);
  });

  it('aligns a start to the next go window and counts tide misses in the objective', () => {
    const berths = [berth('B1')];
    const windows: GoWindow[] = [{ fromMs: T0 + 3 * H, toMs: T0 + 20 * H }];
    const res = optimiseBerthPlan(
      [req('A', { requestedStartMs: T0 })],
      berths,
      new Map([['B1', windows]])
    );
    expect(res.assignments[0].startMs).toBe(T0 + 3 * H); // snapped into window
    expect(res.assignments[0].inGoWindow).toBe(true);
    expect(res.breakdown.tideMisses).toBe(0);
  });

  it('is deterministic (same input → same cost)', () => {
    const berths = [berth('B1'), berth('B2')];
    const requests = [req('A'), req('B', { requestedStartMs: T0 + H })];
    const c1 = optimiseBerthPlan(requests, berths).cost;
    const c2 = optimiseBerthPlan(requests, berths).cost;
    expect(c1).toBe(c2);
  });
});
