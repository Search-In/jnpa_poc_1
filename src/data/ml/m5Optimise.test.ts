import { describe, expect, it } from 'vitest';
import type { BerthRequest } from '@/planning/optimiser';
import { BERTHS } from '@/data/mock/fixtures';
import { M5_OPTIMISE_PATH, toBerthWire, toRequestWire } from './m5Optimise';

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

describe('toRequestWire', () => {
  it('targets the documented endpoint suffix', () => {
    expect(M5_OPTIMISE_PATH).toBe('/uc1/m5/optimise');
  });

  it('maps a request onto the service schema', () => {
    const r = toRequestWire(req());
    expect(r.request_id).toBe('PLAN-1000');
    expect(r.vessel_id).toBe('419000123');
    expect(r.vessel_name).toBe('MV BHARAT EXPRESS');
    expect(r.requested_berth_id).toBe('GTI-1');
    expect(r.service_hours).toBe(8);
    expect(r.requested_start_utc).toBe(new Date(START).toISOString());
  });

  it('sends an empty preference when none is supplied', () => {
    expect(toRequestWire(req({ requestedBerthId: undefined })).requested_berth_id).toBe('');
  });

  it('floors a zero-length call so service_hours stays > 0', () => {
    // `BerthRequestModel.service_hours` is `gt=0`; 0 would be rejected outright.
    expect(toRequestWire(req({ durationMs: 0 })).service_hours).toBe(0.5);
  });

  it('clamps an over-long window and an over-large hull to the service bounds', () => {
    const r = toRequestWire(req({ durationMs: 1000 * H, loaM: 9999, draftM: 99 }));
    expect(r.service_hours).toBe(240);
    expect(r.loa_m).toBe(500);
    expect(r.draft_m).toBe(25);
  });
});

describe('toBerthWire', () => {
  it('clamps berth length to the service maximum', () => {
    // REGRESSION GUARD. `BerthModel.length_m` is `le=600`, but GTI-1 is 712 m and
    // BMCT-1/BMCT-2 are 1000 m in the fixtures. Unclamped, every optimise call
    // 422s on real data and the panel's optimiser is dead on arrival.
    const overLong = BERTHS.filter((b) => b.LENGTH_M > 600);
    expect(overLong.length, 'fixtures still contain an over-long berth to guard').toBeGreaterThan(
      0
    );

    for (const b of BERTHS) {
      const w = toBerthWire(b);
      expect(w.length_m, b.BERTH_ID).toBeLessThanOrEqual(600);
      expect(w.length_m).toBeGreaterThan(0);
      expect(w.max_draft_m).toBeLessThanOrEqual(25);
      expect(w.max_draft_m).toBeGreaterThan(0);
    }
  });

  it('preserves a berth that is already inside the bounds', () => {
    const short = BERTHS.find((b) => b.LENGTH_M <= 600)!;
    expect(toBerthWire(short).length_m).toBe(short.LENGTH_M);
  });

  it('flags only maintenance berths as out of service', () => {
    for (const b of BERTHS) {
      expect(toBerthWire(b).out_of_service, b.BERTH_ID).toBe(b.STATUS === 'maintenance');
    }
  });

  it('carries the berth identity through unchanged', () => {
    const w = toBerthWire(BERTHS[0]);
    expect(w.berth_id).toBe(BERTHS[0].BERTH_ID);
    expect(w.terminal).toBe(BERTHS[0].TERMINAL);
  });
});
