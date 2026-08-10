import { describe, it, expect } from 'vitest';
import {
  M5_BOUNDS,
  buildM5OptimiseBody,
  clampForM5,
  mapM5OptimiseResponse,
} from './m5Optimise';
import type { Berth } from '@/types/domain';
import type { BerthRequest } from '@/planning/optimiser';

function berth(over: Partial<Berth> & Pick<Berth, 'BERTH_ID'>): Berth {
  return {
    BERTH_NAME: over.BERTH_ID,
    TERMINAL: 'BMCT',
    LENGTH_M: 350,
    DRAFT_M: 15,
    STATUS: 'available',
    GEOM: [],
    ...over,
  };
}

describe('m5Optimise', () => {
  it('clamps quay-total lengths into M5 schema (le 600)', () => {
    const c = clampForM5({ lengthM: 1000, draftM: 16.5, loaM: 300, serviceHours: 12 });
    expect(c.length_m).toBe(M5_BOUNDS.lengthM.max);
    expect(c.max_draft_m).toBe(16.5);
  });

  it('builds a body that keeps berth ids but clamps GTI/BMCT quay lengths', () => {
    const berths = [
      berth({ BERTH_ID: 'GTI-1', TERMINAL: 'GTI', LENGTH_M: 712, DRAFT_M: 16.5 }),
      berth({ BERTH_ID: 'BMCT-1', TERMINAL: 'BMCT', LENGTH_M: 1000, DRAFT_M: 16.5 }),
    ];
    const requests: BerthRequest[] = [
      {
        planId: 'P1',
        mmsi: '1',
        vesselName: 'TEST',
        requestedBerthId: 'BMCT-1',
        requestedStartMs: Date.parse('2026-06-05T08:30:00Z'),
        durationMs: 24 * 3_600_000,
        loaM: 300,
        draftM: 13.5,
      },
    ];
    const body = buildM5OptimiseBody(requests, berths, 'auto');
    const wireBerths = body.berths as Array<{ berth_id: string; length_m: number }>;
    expect(wireBerths.map((b) => b.berth_id)).toEqual(['GTI-1', 'BMCT-1']);
    expect(wireBerths.every((b) => b.length_m <= 600)).toBe(true);
  });

  it('maps total_cost and berth_shifts from the wire payload', () => {
    const mapped = mapM5OptimiseResponse({
      algorithm: 'cpsat',
      solve_ms: 12.3,
      unassigned_request_ids: ['X'],
      assignments: [{ request_id: 'P1', vessel_name: 'A', berth_id: 'B1', wait_hours: 1.5 }],
      cost: {
        wait_hours_total: 1.5,
        tide_misses: 2,
        berth_shifts: 1,
        total_cost: 6.0,
        weights: { wait_hour: 1, tide_miss: 2, berth_shift: 0.5 },
      },
    });
    expect(mapped.algorithm).toBe('cpsat');
    expect(mapped.cost).toBe(6);
    expect(mapped.breakdown).toEqual({ waitH: 1.5, tideMisses: 2, shifts: 1 });
    expect(mapped.unplaced).toBe(1);
  });
});
