import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PILOTAGE_PATH,
  fetchPilotage,
  fetchPilotagePage,
  mapPilotage,
  mapPilotageLifecycle,
  parsePilotagePage,
  pilotageQuery,
  type PilotageWire,
} from './pilotage';
import { clearAuthToken } from './token';

const ROW: PilotageWire = {
  pilotage_id: 7,
  movement_type: 'INWARD',
  call_id: null,
  via_no: 'S6259',
  imo_no: '9974292',
  vessel_name: 'BHOLENATH',
  pilot_code: 'JP 91',
  vessel_condition: 'LOADED',
  from_berth_id: null,
  to_berth_id: 12,
  draft_fwd_m: 5.2,
  draft_aft_m: 6.1,
  pilot_boarded_at: '2026-05-10T02:45:00',
  first_line_at: null,
  all_fast_at: null,
  pilot_disembarked_at: null,
  berth_vacated_at: null,
  anchor_down_at: null,
  anchor_up_at: null,
  submitted_at: '2026-05-10T05:00:00',
  extras: { loa: 190, grt: 25000 },
  import_file_id: 3,
};

const page = (items: PilotageWire[], total = items.length) => ({ items, total, limit: 50, offset: 0, count: items.length });

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body } as unknown as Response;
}
const loginBody = { access_token: 'T1', token_type: 'bearer', role: 'DTCCC_ADMIN', auth_enabled: true };

beforeEach(() => clearAuthToken());
afterEach(() => { vi.unstubAllGlobals(); clearAuthToken(); });

describe('mapPilotage (wire → domain)', () => {
  it('maps a full row', () => {
    const p = mapPilotage(ROW)!;
    expect(p).toMatchObject({
      pilotageId: 7, movementType: 'INWARD', viaNo: 'S6259', imoNo: '9974292',
      vesselName: 'BHOLENATH', pilotCode: 'JP 91', toBerthId: 12,
    });
    expect(p.pilotBoardedAt).toBe(Date.parse('2026-05-10T02:45:00'));
    expect(p.extras).toEqual({ loa: 190, grt: 25000 });
  });

  it('drops a row with no pilotage_id', () => {
    expect(mapPilotage({ ...ROW, pilotage_id: null })).toBeNull();
  });

  it('null timestamps → 0, null berths → null, null text → ""', () => {
    const p = mapPilotage({ ...ROW, first_line_at: null, from_berth_id: null, vessel_condition: null })!;
    expect(p.firstLineAt).toBe(0);
    expect(p.fromBerthId).toBeNull();
    expect(p.vesselCondition).toBe('');
  });

  it('tolerates a missing extras object', () => {
    expect(mapPilotage({ ...ROW, extras: null })!.extras).toEqual({});
  });
});

describe('parsePilotagePage', () => {
  it('maps rows and preserves order', () => {
    const rows = parsePilotagePage(page([ROW, { ...ROW, pilotage_id: 8 }]));
    expect(rows.map((r) => r.pilotageId)).toEqual([7, 8]);
  });
  it('skips unusable rows; [] on malformed payload', () => {
    expect(parsePilotagePage(page([{ ...ROW, pilotage_id: null }, ROW]))).toHaveLength(1);
    expect(parsePilotagePage(null)).toEqual([]);
    expect(parsePilotagePage({ items: 'nope' })).toEqual([]);
  });
});

describe('pilotageQuery', () => {
  it('emits page window only when unfiltered', () => {
    expect(pilotageQuery()).toBe(`${PILOTAGE_PATH}?limit=50&offset=0`);
  });
  it('emits set filters, omits empties, url-encodes', () => {
    const q = pilotageQuery({ movement: 'INWARD', vessel: 'MSC ISABELLA' }, 10, 20);
    expect(q).toContain('movement=INWARD');
    expect(q).toContain('vessel=MSC+ISABELLA');
    expect(q).toContain('limit=10');
    expect(q).toContain('offset=20');
    expect(q).not.toContain('imo_no=');
  });
});

describe('fetch* (end to end over a stubbed transport)', () => {
  it('lists with the bearer at the right URL', async () => {
    const spy = vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse(page([ROW], 336)));
    vi.stubGlobal('fetch', spy);
    const res = await fetchPilotagePage({ movement: 'INWARD' });
    expect(res.total).toBe(336);
    expect(res.items[0].pilotCode).toBe('JP 91');
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/marine/pilotage?movement=INWARD&limit=50&offset=0');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test.jwt.token');
  });

  it('fetchPilotage maps a single row', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse(ROW)));
    expect((await fetchPilotage(7))?.pilotageId).toBe(7);
  });

  it('rejects on transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse({ error: 'x' }, 403, 'Forbidden')));
    await expect(fetchPilotagePage()).rejects.toThrow(/HTTP 403/);
  });
});

describe('mapPilotageLifecycle (extras.lifecycle → domain)', () => {
  const LIFECYCLE = {
    pilot_status: 'Departure Pilot Completed',
    pilot_boarded_at: '2026-06-30T13:00:00Z',
    all_fast_at: '2026-07-29T15:54:00Z',
    call_id: 48,
    call_status: 'At Berth',
  };

  it('lifts the block the gateway nests under extras', () => {
    const lc = mapPilotageLifecycle({ lifecycle: LIFECYCLE });
    expect(lc?.pilotStatus).toBe('Departure Pilot Completed');
    expect(lc?.callId).toBe(48);
    expect(lc?.callStatus).toBe('At Berth');
    expect(lc?.allFastAt).toBeGreaterThan(0);
  });

  // A pilot card can be imported before its PCS call exists — a real state, not an error.
  it('yields null when the movement has no linked call', () => {
    expect(mapPilotageLifecycle(null)).toBeNull();
    expect(mapPilotageLifecycle(undefined)).toBeNull();
    expect(mapPilotageLifecycle({})).toBeNull();
    expect(mapPilotageLifecycle({ lifecycle: null })).toBeNull();
  });

  it('tolerates a malformed block rather than throwing', () => {
    expect(mapPilotageLifecycle({ lifecycle: 'nope' })).toBeNull();
    const lc = mapPilotageLifecycle({ lifecycle: {} });
    expect(lc?.pilotStatus).toBe('');
    expect(lc?.callId).toBeNull();
  });

  it('mapPilotage attaches it, and leaves extras untouched', () => {
    const p = mapPilotage({ ...ROW, extras: { lifecycle: LIFECYCLE, sheet_col: 'x' } });
    expect(p?.lifecycle?.pilotStatus).toBe('Departure Pilot Completed');
    // extras is still passed through verbatim — no existing consumer changes.
    expect(p?.extras.sheet_col).toBe('x');
    expect(p?.extras.lifecycle).toEqual(LIFECYCLE);
  });

  it('a row with no lifecycle still maps, with lifecycle null', () => {
    const p = mapPilotage(ROW);
    expect(p?.pilotageId).toBe(7);
    expect(p?.lifecycle).toBeNull();
  });
});
