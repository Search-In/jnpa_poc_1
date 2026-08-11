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
  mergeVesselCalls,
  searchVesselCallsPage,
  sortVesselCalls,
  CALL_SEARCH_FIELDS,
  SEARCH_FETCH_LIMIT,
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

  it('maps the resolved terminal code alongside the FK', () => {
    const c = mapVesselCall({ ...CALL, terminal_id: 5, terminal_code: 'BMCT' })!;
    expect(c.terminalId).toBe(5);
    expect(c.terminalCode).toBe('BMCT');
  });

  it('maps the allotted berth code alongside the FK', () => {
    const c = mapVesselCall({ ...CALL, berth_id: 12, berth_code: 'CB05' })!;
    expect(c.berthId).toBe(12);
    expect(c.berthCode).toBe('CB05');
  });

  it('leaves berthCode empty before BERALT allots a berth', () => {
    // A planned or berth-applied call genuinely has no berth yet — a stage, not a gap.
    const c = mapVesselCall(CALL)!;
    expect(c.berthId).toBeNull();
    expect(c.berthCode).toBe('');
  });

  it('leaves terminalCode empty when the PCS code did not resolve', () => {
    // 12 of 20 corpus CALINFs declare only the port (INJNP1), which is not a terminal.
    const c = mapVesselCall({ ...CALL, terminal_id: null, terminal_code: null })!;
    expect(c.terminalCode).toBe('');
  });

  it('tolerates a gateway response predating the terminal_code field', () => {
    const c = mapVesselCall(CALL)!;
    expect(c.terminalCode).toBe('');
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
    expect(parseVesselCallTimeline(null)).toEqual({ call: null, events: [], lifecycle: null });
  });

  it('maps the lifecycle that rides along in the SAME payload', () => {
    const { lifecycle } = parseVesselCallTimeline({
      ...CALL,
      events: [],
      lifecycle: {
        status: 'At Berth',
        arrival_state: 'Arrived',
        berth_state: 'Occupied',
        pilot_state: 'Pilot Onboard',
        departure_state: 'In Port',
        shipping_state: 'At Berth',
        portcraft_state: 'Assigned',
        is_in_port: true,
        is_at_berth: true,
        latest_event: 'BERTHED',
        latest_event_time: '2026-06-05T09:00:00Z',
      },
    });
    expect(lifecycle?.status).toBe('At Berth');
    expect(lifecycle?.berthState).toBe('Occupied');
    expect(lifecycle?.isInPort).toBe(true);
    expect(lifecycle?.latestEvent).toBe('BERTHED');
  });

  // Backward compatibility: the field is additive, so a gateway that predates it must
  // still yield a usable timeline — the pane then renders the stored fields alone.
  it('yields a null lifecycle when the gateway does not send one', () => {
    expect(parseVesselCallTimeline({ ...CALL, events: [] }).lifecycle).toBeNull();
    expect(parseVesselCallTimeline({ ...CALL, lifecycle: null }).lifecycle).toBeNull();
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

    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/marine/calls?limit=100&offset=0');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test.jwt.token');
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

  it('fetchVesselCallTimeline returns call, actuals AND lifecycle in ONE request', async () => {
    const fetchMock = vi.fn((url: string) =>
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
            lifecycle: {
              status: 'Departed',
              arrival_state: 'Arrived',
              berth_state: 'Vacated',
              pilot_state: 'Pilot Onboard',
              departure_state: 'Sailed',
              shipping_state: 'Departed',
              portcraft_state: 'Released',
              is_in_port: false,
              is_at_berth: false,
              latest_event: 'SAILED',
              latest_event_time: '2026-06-06T20:00:00Z',
            },
          }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { call, events, lifecycle } = await fetchVesselCallTimeline(12);
    expect(call?.callId).toBe(12);
    expect(events[0].eventType).toBe('SAILED');
    expect(lifecycle?.status).toBe('Departed');

    // The whole point of the refactor: the lifecycle costs no extra round trip. Only
    // the timeline itself is requested — anything else here means a second call crept back.
    const dataCalls = fetchMock.mock.calls.filter(
      ([url]) => !String(url).endsWith('/auth/login'),
    );
    expect(dataCalls).toHaveLength(1);
    expect(String(dataCalls[0][0])).toContain('/marine/calls/12/timeline');
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

describe('mapVesselCall — derived lifecycle beside the stored stage', () => {
  const LIFECYCLE = {
    status: 'At Berth',
    arrival_state: 'Completed',
    berth_state: 'Occupied',
    pilot_state: 'Completed',
    departure_state: 'Pending',
    shipping_state: 'In Port',
    portcraft_state: 'Busy',
    is_in_port: true,
    is_at_berth: true,
    latest_event: 'ARRIVED',
    latest_event_time: '2026-07-29T15:54:00Z',
  };

  it('attaches the derived state the list endpoint now returns', () => {
    const c = mapVesselCall({ ...CALL, status: 'Berth Allotted', lifecycle: LIFECYCLE });
    expect(c?.lifecycle?.status).toBe('At Berth');
    expect(c?.lifecycle?.isAtBerth).toBe(true);
  });

  // Two different facts: the message stage and the operational state. Both are returned
  // and neither overwrites the other, so the source-vs-derived comparison stays visible.
  it('leaves the stored parser status untouched', () => {
    const c = mapVesselCall({ ...CALL, status: 'Berth Allotted', lifecycle: LIFECYCLE });
    expect(c?.status).toBe('Berth Allotted');
    expect(c?.lifecycle?.status).toBe('At Berth');
  });

  it('is null when the gateway sends none — old gateway, or nothing ingested', () => {
    expect(mapVesselCall(CALL)?.lifecycle).toBeNull();
    expect(mapVesselCall({ ...CALL, lifecycle: null })?.lifecycle).toBeNull();
  });

  it('a page maps every row, lifecycle included', () => {
    const page = parseVesselCallsPage({
      items: [{ ...CALL, call_id: 48, lifecycle: LIFECYCLE },
              { ...CALL, call_id: 51, lifecycle: null }],
    });
    expect(page).toHaveLength(2);
    expect(page[0].lifecycle?.status).toBe('At Berth');
    expect(page[1].lifecycle).toBeNull();
  });
});

describe('mergeVesselCalls', () => {
  it('dedupes on callId — a row matched by two identifiers is counted once', () => {
    // Realistic: 'S0561' hits both the VIA request and the VCN that embeds it.
    const a = mapVesselCall(CALL)!;
    const b = mapVesselCall({ ...CALL, call_id: 13 })!;
    expect(mergeVesselCalls([[a, b], [a]]).map((c) => c.callId)).toEqual([12, 13]);
  });

  it('is empty for no pages and tolerates empty ones', () => {
    expect(mergeVesselCalls([])).toEqual([]);
    expect(mergeVesselCalls([[], []])).toEqual([]);
  });
});

describe('sortVesselCalls', () => {
  const withEta = (callId: number, eta: number) =>
    mapVesselCall({ ...CALL, call_id: callId, eta: eta ? new Date(eta).toISOString() : null })!;

  it('orders ascending and descending on a timestamp column', () => {
    const rows = [withEta(1, 3000), withEta(2, 1000), withEta(3, 2000)];
    expect(sortVesselCalls(rows, 'eta', 'asc').map((c) => c.callId)).toEqual([2, 3, 1]);
    expect(sortVesselCalls(rows, 'eta', 'desc').map((c) => c.callId)).toEqual([1, 3, 2]);
  });

  it('keeps unknowns LAST in BOTH directions, mirroring the gateway NULLS LAST', () => {
    // The mapper turns an absent ETA into 0. Sorted naively, ascending would put
    // every unparsed row above the real schedule — the opposite of useful.
    const rows = [withEta(1, 0), withEta(2, 2000), withEta(3, 1000)];
    expect(sortVesselCalls(rows, 'eta', 'asc').map((c) => c.callId)).toEqual([3, 2, 1]);
    expect(sortVesselCalls(rows, 'eta', 'desc').map((c) => c.callId)).toEqual([2, 3, 1]);
  });

  it('sorts text columns and pushes blank names last', () => {
    const named = (callId: number, name: string | null) =>
      mapVesselCall({ ...CALL, call_id: callId, vessel_name: name })!;
    const rows = [named(1, null), named(2, 'MAERSK'), named(3, 'APL')];
    expect(sortVesselCalls(rows, 'vessel_name', 'asc').map((c) => c.callId)).toEqual([3, 2, 1]);
  });

  it('breaks ties on callId DESC, as the gateway ORDER BY does', () => {
    const rows = [withEta(7, 1000), withEta(9, 1000), withEta(8, 1000)];
    expect(sortVesselCalls(rows, 'eta', 'asc').map((c) => c.callId)).toEqual([9, 8, 7]);
  });

  it('falls back to updated_at for an unknown sort key and does not mutate its input', () => {
    const rows = [withEta(1, 1000), withEta(2, 2000)];
    const before = rows.map((c) => c.callId);
    sortVesselCalls(rows, 'no_such_column', 'asc');
    expect(rows.map((c) => c.callId)).toEqual(before);
  });
});

describe('searchVesselCallsPage (the OR the gateway cannot do)', () => {
  /** Stub that answers each fanned-out request with the rows that field would match. */
  const routed = (byField: Record<string, VesselCallWire[]>) =>
    vi.fn((url: string) => {
      if (String(url).endsWith('/auth/login')) return jsonResponse(loginBody);
      const q = new URLSearchParams(String(url).split('?')[1] ?? '');
      for (const f of CALL_SEARCH_FIELDS) {
        if (q.has(f)) return jsonResponse(page(byField[f] ?? []));
      }
      return jsonResponse(page([]));
    });

  it('asks the gateway once per identifier, each carrying the same term', async () => {
    const spy = routed({});
    vi.stubGlobal('fetch', spy);
    await searchVesselCallsPage('S0561');

    const urls = spy.mock.calls
      .map(([u]) => String(u))
      .filter((u) => u.includes(MARINE_CALLS_PATH));
    expect(urls).toHaveLength(CALL_SEARCH_FIELDS.length);
    for (const field of CALL_SEARCH_FIELDS) {
      expect(urls.some((u) => u.includes(`${field}=S0561`))).toBe(true);
    }
  });

  it('finds a NAMELESS call by its VIA — the case a name-only box could not reach', async () => {
    const nameless = { ...CALL, call_id: 40, vessel_name: null, via_no: 'S0814' };
    vi.stubGlobal('fetch', routed({ via: [nameless] }));

    const res = await searchVesselCallsPage('S0814');
    expect(res.items.map((c) => c.callId)).toEqual([40]);
    expect(res.items[0].vesselName).toBe('');
  });

  it('unions across fields and counts a doubly-matched row once', async () => {
    const byVia = { ...CALL, call_id: 12 };
    const byVoyage = { ...CALL, call_id: 41 };
    vi.stubGlobal('fetch', routed({ via: [byVia], vcn: [byVia], voyage: [byVoyage] }));

    const res = await searchVesselCallsPage('S0561');
    expect(res.total).toBe(2);
    expect(res.items.map((c) => c.callId).sort()).toEqual([12, 41]);
  });

  it('keeps the caller other filters but never lets a stale identifier AND the term away', async () => {
    const spy = routed({});
    vi.stubGlobal('fetch', spy);
    // `vessel` here is what the previous single-field design would have sent. If it
    // survived, `?vessel=OLD&via=S0561` would mean "name OLD *and* VIA S0561" — zero rows.
    await searchVesselCallsPage('S0561', { vessel: 'OLD', inPort: true, sort: 'eta' });

    const viaUrl = spy.mock.calls
      .map(([u]) => String(u))
      .find((u) => u.includes('via=S0561'))!;
    expect(viaUrl).toContain('in_port=true');
    expect(viaUrl).toContain('sort=eta');
    expect(viaUrl).not.toContain('vessel=OLD');
  });

  it('pages and sorts the merged set in the browser', async () => {
    const rows = [40, 41, 42].map((call_id) => ({ ...CALL, call_id, eta: null }));
    vi.stubGlobal('fetch', routed({ via: rows }));

    const first = await searchVesselCallsPage('S', { sort: 'call_id', direction: 'asc' }, 2, 0);
    expect(first.items.map((c) => c.callId)).toEqual([40, 41]);
    expect(first.total).toBe(3);

    const second = await searchVesselCallsPage('S', { sort: 'call_id', direction: 'asc' }, 2, 2);
    expect(second.items.map((c) => c.callId)).toEqual([42]);
    expect(second.offset).toBe(2);
  });

  it('flags truncated when a field returns its full ceiling', async () => {
    const many = Array.from({ length: SEARCH_FETCH_LIMIT }, (_, i) => ({ ...CALL, call_id: i + 1 }));
    vi.stubGlobal('fetch', routed({ via: many }));

    const res = await searchVesselCallsPage('S');
    expect(res.truncated).toBe(true);
  });

  it('is not truncated when every field answered under the ceiling', async () => {
    vi.stubGlobal('fetch', routed({ via: [CALL] }));
    expect((await searchVesselCallsPage('S0561')).truncated).toBe(false);
  });

  it('returns the fields that answered when one fails, and marks the result partial', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url).endsWith('/auth/login')) return jsonResponse(loginBody);
        if (String(url).includes('vcn=')) return jsonResponse({ error: 'boom' }, 500, 'Server Error');
        return jsonResponse(page(String(url).includes('via=') ? [CALL] : []));
      }),
    );

    const res = await searchVesselCallsPage('S0561');
    expect(res.items.map((c) => c.callId)).toEqual([12]);
    // The VCN identifier contributed nothing, so the count is a floor — say so
    // rather than letting a half-answered search read as exhaustive.
    expect(res.truncated).toBe(true);
  });

  it('rejects when EVERY field fails — a dead gateway is not "no matches"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).endsWith('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse({ error: 'boom' }, 500, 'Server Error'),
      ),
    );
    await expect(searchVesselCallsPage('S0561')).rejects.toThrow();
  });
});
