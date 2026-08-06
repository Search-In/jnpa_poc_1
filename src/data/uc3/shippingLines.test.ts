import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SHIPPING_LINES_PATH,
  fetchShippingLines,
  mapShippingLine,
  parseShippingLinesPage,
  shippingLinesQuery,
  toEpochMs,
  type ShippingLinesPage,
  type ShippingLineWire,
} from './shippingLines';
import { clearAuthToken } from './token';

/**
 * Rows exactly as the live gateway returned them (probe against the shared
 * backend, 62 carriers). Kept verbatim — including `line_name: null` on every
 * row — so the fixture cannot drift into being more convenient than reality.
 */
const WIRE: ShippingLineWire[] = [
  {
    line_code: 'ESA',
    line_name: null,
    source: 'ADVANCE_LIST',
    first_seen: '2026-07-21T05:40:28.758738Z',
    last_seen: '2026-07-21T05:41:20.600896Z',
    container_count: 1534,
  },
  {
    line_code: 'KMD',
    line_name: null,
    source: 'ADVANCE_LIST',
    first_seen: '2026-07-21T05:40:28.758738Z',
    last_seen: '2026-07-21T05:41:20.600896Z',
    container_count: 1417,
  },
  {
    line_code: 'RCL',
    line_name: null,
    source: 'ADVANCE_LIST',
    first_seen: '2026-07-21T05:40:28.758738Z',
    last_seen: '2026-07-21T05:41:20.600896Z',
    container_count: 959,
  },
];

const page = (items: ShippingLineWire[]): ShippingLinesPage => ({
  items,
  total: 62,
  limit: 1000,
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

describe('toEpochMs', () => {
  it('parses an ISO-8601 timestamp (microsecond precision) to epoch ms', () => {
    expect(toEpochMs('2026-07-21T05:41:20.600896Z')).toBe(
      Date.parse('2026-07-21T05:41:20.600896Z'),
    );
  });

  it('returns 0 rather than NaN for absent or unparseable input', () => {
    // NaN would silently poison every downstream date format.
    expect(toEpochMs(null)).toBe(0);
    expect(toEpochMs(undefined)).toBe(0);
    expect(toEpochMs('')).toBe(0);
    expect(toEpochMs('not-a-date')).toBe(0);
  });
});

describe('mapShippingLine (wire → domain)', () => {
  it('maps a full row onto the domain model', () => {
    const l = mapShippingLine(WIRE[0])!;
    expect(l).not.toBeNull();
    expect(l.lineCode).toBe('ESA');
    expect(l.source).toBe('ADVANCE_LIST');
    expect(l.containerCount).toBe(1534);
    expect(l.lastSeen).toBe(Date.parse('2026-07-21T05:41:20.600896Z'));
    expect(l.firstSeen).toBe(Date.parse('2026-07-21T05:40:28.758738Z'));
  });

  it('drops a row with no line_code (the primary key)', () => {
    expect(mapShippingLine({ ...WIRE[0], line_code: '' })).toBeNull();
    expect(mapShippingLine({ ...WIRE[0], line_code: '   ' })).toBeNull();
  });

  it('defaults a missing container_count to 0', () => {
    expect(mapShippingLine({ ...WIRE[0], container_count: null })!.containerCount).toBe(0);
  });

  it('defaults a missing source to an empty string', () => {
    expect(mapShippingLine({ ...WIRE[0], source: null })!.source).toBe('');
  });
});

describe('line_name null fallback', () => {
  it('falls back to line_code when line_name is null (every live row today)', () => {
    // The importer upserts line_code only, so line_name is null for all 62 rows.
    // A UI showing "ESA" where a carrier name belongs is correct, not missing data.
    const l = mapShippingLine(WIRE[0])!;
    expect(WIRE[0].line_name).toBeNull();
    expect(l.lineName).toBe('ESA');
  });

  it('falls back for an empty or whitespace-only name too', () => {
    expect(mapShippingLine({ ...WIRE[0], line_name: '' })!.lineName).toBe('ESA');
    expect(mapShippingLine({ ...WIRE[0], line_name: '   ' })!.lineName).toBe('ESA');
  });

  it('uses the real name once the backend starts populating it', () => {
    const l = mapShippingLine({ ...WIRE[0], line_name: 'Emirates Shipping Line' })!;
    expect(l.lineName).toBe('Emirates Shipping Line');
    expect(l.lineCode).toBe('ESA'); // the code is still available for keying
  });

  it('lineName is never null, so the UI needs no null guard', () => {
    for (const w of WIRE) {
      expect(mapShippingLine(w)!.lineName).toBeTruthy();
    }
  });
});

describe('parseShippingLinesPage', () => {
  it('maps every row and preserves the server ordering (busiest first)', () => {
    const lines = parseShippingLinesPage(page(WIRE));
    expect(lines.map((l) => l.lineCode)).toEqual(['ESA', 'KMD', 'RCL']);
    // ORDER BY container_count DESC — so no client-side sort is needed.
    expect(lines.map((l) => l.containerCount)).toEqual([1534, 1417, 959]);
  });

  it('skips unusable rows without losing the good ones', () => {
    const lines = parseShippingLinesPage(page([WIRE[0], { ...WIRE[1], line_code: '' }, WIRE[2]]));
    expect(lines.map((l) => l.lineCode)).toEqual(['ESA', 'RCL']);
  });

  it('returns [] for a malformed or empty payload', () => {
    expect(parseShippingLinesPage(null)).toEqual([]);
    expect(parseShippingLinesPage(undefined)).toEqual([]);
    expect(parseShippingLinesPage({})).toEqual([]);
    expect(parseShippingLinesPage({ items: 'nope' })).toEqual([]);
    expect(parseShippingLinesPage(page([]))).toEqual([]);
  });
});

describe('shippingLinesQuery', () => {
  it('requests the whole registry in one page by default', () => {
    // total is 62 and the gateway caps limit at 1000 — no pagination loop needed.
    expect(shippingLinesQuery()).toBe(`${SHIPPING_LINES_PATH}?limit=1000&offset=0`);
  });

  it('honours an explicit page window', () => {
    expect(shippingLinesQuery(5, 10)).toBe(`${SHIPPING_LINES_PATH}?limit=5&offset=10`);
  });
});

describe('fetchShippingLines (end to end over a stubbed transport)', () => {
  it('logs in, calls the endpoint with the bearer, and returns domain models', async () => {
    const spy = vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse(page(WIRE)),
    );
    vi.stubGlobal('fetch', spy);

    const lines = await fetchShippingLines();

    expect(lines).toHaveLength(3);
    expect(lines[0]).toEqual({
      lineCode: 'ESA',
      lineName: 'ESA', // null name → code
      source: 'ADVANCE_LIST',
      firstSeen: Date.parse('2026-07-21T05:40:28.758738Z'),
      lastSeen: Date.parse('2026-07-21T05:41:20.600896Z'),
      containerCount: 1534,
    });

    const [url, init] = spy.mock.calls[1];
    expect(url).toBe('/api/shipping-lines/lines?limit=1000&offset=0');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer T1');
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
    await expect(fetchShippingLines()).rejects.toThrow(/HTTP 403/);
  });
});
