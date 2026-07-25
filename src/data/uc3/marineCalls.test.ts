import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MARINE_CALLS_PATH,
  fetchMarineStats,
  fetchVesselCall,
  fetchVesselCalls,
  fetchVesselCallsPage,
  fetchVesselCallTimeline,
  mapVesselCall,
  mapVesselCallEvent,
  marineCallsQuery,
  marineStatsQuery,
  parseMarineStats,
  parseVesselCallsPage,
  parseVesselCallTimeline,
  type MarineStatsWire,
  type VesselCallEventWire,
  type VesselCallWire,
} from './marineCalls';
import { clearAuthToken } from './token';

/**
 * A call row in the shape the gateway's CallOut model emits. Kept deliberately
 * "unhelpful" where reality is: terminal_id/berth_id are null (the CSV upload
 * path does not resolve reference dimensions yet) and imo_no is null (resolved
 * against core.vessel, which is empty until vessel-master ingestion exists).
 */
const CALL: VesselCallWire = {
  call_id: 12,
  vcn: 'INNSA1BM0R3119',
  via_no: 'S0561',
  imo_no: null,
  vessel_name: 'MAERSK SENTOSA',
  voyage_no: '0561W',
  rotation_no: '3119',
  terminal_id: null,
  berth_id: null,
  purpose: 'Cargo',
  status: 'BERTHED',
  igm_no: null,
  source_note: 'calls.csv',
  eta: '2026-06-05T06:00:00+05:30',
  etb: '2026-06-05T09:00:00+05:30',
  etd: null,
  ata: '2026-06-05T08:30:00+05:30',
  atc: null,
  atd: null,
  created_at: '2026-06-05T10:00:00Z',
  updated_at: '2026-06-05T10:05:00Z',
};

const page = (items: VesselCallWire[], total = items.length) => ({
  items,
  total,
  limit: 100,
  offset: 0,
  count: items.length,
});

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

const loginBody = {
  access_token: 'T1',
  token_type: 'bearer',
  role: 'DTCCC_ADMIN',
  auth_enabled: true,
};

beforeEach(() => {
  clearAuthToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthToken();
});

describe('mapVesselCall (wire → domain)', () => {
  it('maps a full row onto the domain model', () => {
    const c = mapVesselCall(CALL)!;
    expect(c.callId).toBe(12);
    expect(c.vcn).toBe('INNSA1BM0R3119');
    expect(c.viaNo).toBe('S0561');
    expect(c.vesselName).toBe('MAERSK SENTOSA');
    expect(c.status).toBe('BERTHED');
    expect(c.eta).toBe(Date.parse('2026-06-05T06:00:00+05:30'));
    expect(c.ata).toBe(Date.parse('2026-06-05T08:30:00+05:30'));
  });

  it('drops a row with no call_id (the key the UI addresses rows by)', () => {
    expect(mapVesselCall({ ...CALL, call_id: null })).toBeNull();
  });

  it('turns absent timestamps into 0, never NaN', () => {
    const c = mapVesselCall(CALL)!;
    expect(c.etd).toBe(0);
    expect(c.atc).toBe(0);
    expect(c.atd).toBe(0);
  });

  it('turns null text into empty strings, so the UI needs no null guards', () => {
    const c = mapVesselCall({ ...CALL, imo_no: null, purpose: null, source_note: null })!;
    expect(c.imoNo).toBe('');
    expect(c.purpose).toBe('');
    expect(c.sourceNote).toBe('');
  });

  it('preserves null FKs as null — absent is not terminal 0', () => {
    const c = mapVesselCall(CALL)!;
    expect(c.terminalId).toBeNull();
    expect(c.berthId).toBeNull();
    expect(c.igmNo).toBeNull();
  });

  it('keeps a pre-VCN call: vcn is empty, not a reason to drop the row', () => {
    const c = mapVesselCall({ ...CALL, vcn: null })!;
    expect(c.vcn).toBe('');
    expect(c.callId).toBe(12);
  });
});

describe('mapVesselCallEvent', () => {
  const EV: VesselCallEventWire = {
    event_id: 5,
    call_id: 12,
    event_type: 'ANCHORED',
    event_ts: '2026-06-05T04:00:00+05:30',
    berth_id: null,
    source_file: null,
    created_at: '2026-06-05T10:00:00Z',
  };

  it('maps a row onto the domain model', () => {
    const e = mapVesselCallEvent(EV)!;
    expect(e).toMatchObject({ eventId: 5, callId: 12, eventType: 'ANCHORED' });
    expect(e.eventTs).toBe(Date.parse('2026-06-05T04:00:00+05:30'));
  });

  it('drops a row with no event_id', () => {
    expect(mapVesselCallEvent({ ...EV, event_id: null })).toBeNull();
  });
});

describe('parseVesselCallsPage', () => {
  it('maps every row and preserves the server ordering', () => {
    const rows = parseVesselCallsPage(page([CALL, { ...CALL, call_id: 13, vcn: 'X2' }]));
    expect(rows.map((r) => r.callId)).toEqual([12, 13]);
  });

  it('skips unusable rows without losing the good ones', () => {
    const rows = parseVesselCallsPage(page([{ ...CALL, call_id: null }, CALL]));
    expect(rows).toHaveLength(1);
    expect(rows[0].callId).toBe(12);
  });

  it('returns [] for a malformed or empty payload', () => {
    expect(parseVesselCallsPage(null)).toEqual([]);
    expect(parseVesselCallsPage({})).toEqual([]);
    expect(parseVesselCallsPage({ items: 'nope' })).toEqual([]);
  });
});

describe('parseVesselCallTimeline', () => {
  const ev = (id: number, ts: string, type = 'ANCHORED'): VesselCallEventWire => ({
    event_id: id,
    call_id: 12,
    event_type: type,
    event_ts: ts,
    berth_id: null,
    source_file: null,
    created_at: null,
  });

  it('orders actuals chronologically regardless of server order', () => {
    const { call, events } = parseVesselCallTimeline({
      ...CALL,
      events: [ev(2, '2026-06-05T09:00:00Z'), ev(1, '2026-06-05T04:00:00Z')],
    });
    expect(call?.callId).toBe(12);
    expect(events.map((e) => e.eventId)).toEqual([1, 2]);
  });

  it('keeps REPEATED event types — the schema permits a second anchoring', () => {
    const { events } = parseVesselCallTimeline({
      ...CALL,
      events: [ev(1, '2026-06-05T04:00:00Z'), ev(2, '2026-06-06T04:00:00Z')],
    });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.eventType === 'ANCHORED')).toBe(true);
  });

  it('tolerates a call with no events array', () => {
    expect(parseVesselCallTimeline(CALL).events).toEqual([]);
    expect(parseVesselCallTimeline(null)).toEqual({ call: null, events: [] });
  });
});

describe('parseMarineStats', () => {
  const STATS: MarineStatsWire = {
    total: 3,
    with_vcn: 3,
    without_vcn: 0,
    arrived: 2,
    in_port: 1,
    ops_completed: 1,
    departed: 1,
    terminals: 0,
    avg_turnaround_hours: 26.5,
    avg_pre_berth_delay_hours: -1.5,
    by_status: [{ status: 'BERTHED', count: 2 }],
    by_terminal: [{ terminal_id: null, count: 3, in_port: 1 }],
  };

  it('maps the full envelope', () => {
    const s = parseMarineStats(STATS);
    expect(s.total).toBe(3);
    expect(s.avgTurnaroundHours).toBe(26.5);
    expect(s.byStatus).toEqual([{ status: 'BERTHED', count: 2 }]);
    expect(s.byTerminal).toEqual([{ terminalId: null, count: 3, inPort: 1 }]);
  });

  it('keeps a NEGATIVE pre-berth delay — early arrival is real signal', () => {
    expect(parseMarineStats(STATS).avgPreBerthDelayHours).toBe(-1.5);
  });

  it('keeps null averages null — "no completed call" is not "zero hours"', () => {
    const s = parseMarineStats({ ...STATS, avg_turnaround_hours: null });
    expect(s.avgTurnaroundHours).toBeNull();
  });

  it('yields zeroes for an empty payload (the state before any upload)', () => {
    const s = parseMarineStats(null);
    expect(s.total).toBe(0);
    expect(s.byStatus).toEqual([]);
    expect(s.avgTurnaroundHours).toBeNull();
  });
});

describe('marineCallsQuery', () => {
  it('emits only the page window when no filter is set', () => {
    expect(marineCallsQuery()).toBe(`${MARINE_CALLS_PATH}?limit=100&offset=0`);
  });

  it('emits set filters and omits undefined ones', () => {
    const q = marineCallsQuery({ vessel: 'MAERSK', status: 'BERTHED' }, 25, 50);
    expect(q).toContain('vessel=MAERSK');
    expect(q).toContain('status=BERTHED');
    expect(q).toContain('limit=25');
    expect(q).toContain('offset=50');
    expect(q).not.toContain('vcn=');
  });

  it('treats has_vcn as TRI-state: false is sent, undefined is omitted', () => {
    expect(marineCallsQuery({ hasVcn: false })).toContain('has_vcn=false');
    expect(marineCallsQuery({ hasVcn: true })).toContain('has_vcn=true');
    expect(marineCallsQuery({})).not.toContain('has_vcn');
  });

  it('sends in_port only when true', () => {
    expect(marineCallsQuery({ inPort: true })).toContain('in_port=true');
    expect(marineCallsQuery({ inPort: false })).not.toContain('in_port');
  });

  it('url-encodes filter values', () => {
    expect(marineCallsQuery({ vessel: 'MSC ISABELLA' })).toContain('vessel=MSC+ISABELLA');
  });
});

describe('marineStatsQuery', () => {
  it('is bare when unfiltered', () => {
    expect(marineStatsQuery()).toBe('/marine/calls/stats');
  });

  it('appends only the filters it supports', () => {
    expect(marineStatsQuery({ status: 'BERTHED' })).toBe('/marine/calls/stats?status=BERTHED');
  });
});

describe('fetch* (end to end over a stubbed transport)', () => {
  it('logs in, calls the endpoint with the bearer, and returns domain models', async () => {
    const spy = vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse(page([CALL])),
    );
    vi.stubGlobal('fetch', spy);

    const calls = await fetchVesselCalls();

    expect(calls).toHaveLength(1);
    expect(calls[0].vcn).toBe('INNSA1BM0R3119');

    const [url, init] = spy.mock.calls[1];
    expect(url).toBe('/api/marine/calls?limit=100&offset=0');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer T1');
  });

  it('fetchVesselCallsPage passes the envelope through for the pager', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse(page([CALL], 137)),
      ),
    );
    const res = await fetchVesselCallsPage({}, 100, 0);
    expect(res.total).toBe(137);
    expect(res.items).toHaveLength(1);
  });

  it('fetchVesselCall maps a single row', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse(CALL),
      ),
    );
    expect((await fetchVesselCall(12))?.callId).toBe(12);
  });

  it('fetchVesselCallTimeline returns the call plus ordered actuals', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse({
              ...CALL,
              events: [
                {
                  event_id: 9,
                  call_id: 12,
                  event_type: 'SAILED',
                  event_ts: '2026-06-06T20:00:00Z',
                  berth_id: null,
                  source_file: null,
                  created_at: null,
                },
              ],
            }),
      ),
    );
    const { call, events } = await fetchVesselCallTimeline(12);
    expect(call?.callId).toBe(12);
    expect(events[0].eventType).toBe('SAILED');
  });

  it('fetchMarineStats returns zeroes against an empty backend', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse({ total: 0, by_status: [], by_terminal: [] }),
      ),
    );
    const s = await fetchMarineStats();
    expect(s.total).toBe(0);
    expect(s.byStatus).toEqual([]);
  });

  it('rejects (does not throw synchronously) when the endpoint fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse({ error: 'forbidden' }, 403, 'Forbidden'),
      ),
    );
    // A rejected promise is what useAdapterQuery surfaces as `error`.
    await expect(fetchVesselCalls()).rejects.toThrow(/HTTP 403/);
  });
});
