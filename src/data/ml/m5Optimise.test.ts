import { describe, expect, it } from 'vitest';
import type { Berth } from '@/types/domain';
import type { BerthRequest } from '@/planning/optimiser';
import { BERTHS } from '@/data/mock/fixtures';
import {
  M5_OPTIMISE_PATH,
  toM5Result,
  toOptimiseRequest,
  type M5PlanWire,
} from './m5Optimise';

const H = 3_600_000;
const START = Date.UTC(2026, 5, 16, 6, 0, 0);

function req(over: Partial<BerthRequest> = {}): BerthRequest {
  return {
    planId: 'PLAN-1000',
    mmsi: '419000123',
    vesselName: 'MV BHARAT EXPRESS',
    requestedBerthId: 'GTI-1',
    requestedStartMs: START,
    durationMs: 8 * H,
    loaM: 330,
    draftM: 14,
    ...over,
  };
}

describe('toOptimiseRequest', () => {
  it('targets the documented endpoint suffix', () => {
    expect(M5_OPTIMISE_PATH).toBe('/uc1/m5/optimise');
  });

  it('maps a request onto the service schema', () => {
    const { body } = toOptimiseRequest([req()], BERTHS);
    const r = body.requests[0];
    expect(r.request_id).toBe('PLAN-1000');
    expect(r.vessel_id).toBe('419000123');
    expect(r.requested_berth_id).toBe('GTI-1');
    expect(r.service_hours).toBe(8);
    expect(r.requested_start_utc).toBe(new Date(START).toISOString());
    expect(body.algorithm).toBe('auto');
  });

  it('clamps berth length to the service maximum', () => {
    // Regression guard: BMCT-1/BMCT-2 are 1000 m and GTI-1 is 712 m, but
    // `BerthModel.length_m` is `le=600` — unclamped this call 422s on real data.
    const long = BERTHS.filter((b) => b.LENGTH_M > 600);
    expect(long.length, 'fixture still has an over-long berth to guard').toBeGreaterThan(0);

    const { body } = toOptimiseRequest([req()], BERTHS);
    for (const b of body.berths) {
      expect(b.length_m).toBeLessThanOrEqual(600);
      expect(b.length_m).toBeGreaterThan(0);
      expect(b.max_draft_m).toBeLessThanOrEqual(25);
    }
  });

  it('flags only maintenance berths as out of service', () => {
    const { body } = toOptimiseRequest([req()], BERTHS);
    for (const wire of body.berths) {
      const src = BERTHS.find((b) => b.BERTH_ID === wire.berth_id)!;
      expect(wire.out_of_service).toBe(src.STATUS === 'maintenance');
    }
  });

  it('floors a zero-length call so service_hours stays > 0', () => {
    const { body } = toOptimiseRequest([req({ durationMs: 0 })], BERTHS);
    expect(body.requests[0].service_hours).toBe(0.5);
  });

  it('clamps an over-long service window and an over-large hull', () => {
    const { body } = toOptimiseRequest(
      [req({ durationMs: 1000 * H, loaM: 9999, draftM: 99 })],
      BERTHS
    );
    expect(body.requests[0].service_hours).toBe(240);
    expect(body.requests[0].loa_m).toBe(500);
    expect(body.requests[0].draft_m).toBe(25);
  });

  it('sends an empty preference when none is supplied', () => {
    const { body } = toOptimiseRequest([req({ requestedBerthId: undefined })], BERTHS);
    expect(body.requests[0].requested_berth_id).toBe('');
  });

  it('caps the fleet and reports how many were left out', () => {
    const many = Array.from({ length: 12 }, (_, i) => req({ planId: `PLAN-${i}` }));
    const { body, omitted } = toOptimiseRequest(many, BERTHS, 'greedy', 5);
    expect(body.requests).toHaveLength(5);
    expect(omitted).toBe(7);
    expect(body.requests.map((r) => r.request_id)).toEqual([
      'PLAN-0',
      'PLAN-1',
      'PLAN-2',
      'PLAN-3',
      'PLAN-4',
    ]);
  });

  it('keeps priority inside the service range for a large fleet', () => {
    const many = Array.from({ length: 20 }, (_, i) => req({ planId: `PLAN-${i}` }));
    const { body } = toOptimiseRequest(many, BERTHS);
    for (const r of body.requests) {
      expect(r.priority).toBeGreaterThanOrEqual(1);
      expect(r.priority).toBeLessThanOrEqual(9);
    }
  });

  it('handles an empty berth roster without throwing', () => {
    const { body } = toOptimiseRequest([req()], [] as Berth[]);
    expect(body.berths).toEqual([]);
  });
});

const PLAN: M5PlanWire = {
  plan_id: 'PLAN-XYZ',
  algorithm: 'greedy',
  generated_at_utc: '2026-06-16T06:00:00+00:00',
  assignments: [
    {
      request_id: 'PLAN-1000',
      vessel_id: '419000123',
      vessel_name: 'MV BHARAT EXPRESS',
      berth_id: 'GTI-1',
      start_utc: '2026-06-16T07:00:00+00:00',
      end_utc: '2026-06-16T15:00:00+00:00',
      wait_hours: 1.5,
      is_berth_shift: false,
      tide_window_id: 'W1',
      tide_miss: false,
      feasible: true,
      infeasible_reason: null,
      marginal_cost: 1.5,
      rationale: 'first feasible slot',
    },
  ],
  unassigned_request_ids: ['PLAN-1007'],
  cost: {
    wait_hours_total: 3.456,
    wait_cost: 3.456,
    tide_misses: 2,
    tide_cost: 4,
    berth_shifts: 1,
    shift_cost: 0.5,
    total_cost: 7.9561,
    weights: {},
    per_request: [],
  },
  solve_ms: 12.34,
  tide_policy: 'soft',
  explanation: ['placed 1 of 2'],
};

describe('toM5Result', () => {
  it('maps the plan into the panel vocabulary', () => {
    const r = toM5Result(PLAN, 3);
    expect(r.algorithm).toBe('greedy');
    expect(r.cost).toBe(7.96);
    expect(r.breakdown).toEqual({ waitH: 3.46, tideMisses: 2, shifts: 1 });
    expect(r.assignments).toHaveLength(1);
    expect(r.unplaced).toBe(1);
    expect(r.unplacedIds).toEqual(['PLAN-1007']);
    expect(r.solveMs).toBe(12.34);
    expect(r.omitted).toBe(3);
    expect(r.explanation).toEqual(['placed 1 of 2']);
  });

  it('parses assignment timestamps into epoch ms', () => {
    const a = toM5Result(PLAN).assignments[0];
    expect(a.startMs).toBe(Date.parse('2026-06-16T07:00:00Z'));
    expect(a.endMs).toBe(Date.parse('2026-06-16T15:00:00Z'));
    expect(a.endMs - a.startMs).toBe(8 * H);
    expect(a.berthId).toBe('GTI-1');
    expect(a.waitH).toBe(1.5);
  });

  it('survives a sparse response without throwing', () => {
    const r = toM5Result({} as M5PlanWire);
    expect(r.cost).toBe(0);
    expect(r.assignments).toEqual([]);
    expect(r.unplaced).toBe(0);
    expect(r.breakdown).toEqual({ waitH: 0, tideMisses: 0, shifts: 0 });
    expect(r.algorithm).toBe('unknown');
  });
});
