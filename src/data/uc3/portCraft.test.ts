import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PORT_CRAFT_PATH,
  fetchPortCraft,
  fetchPortCraftPage,
  mapPortCraft,
  parsePortCraftPage,
  portCraftQuery,
  type PortCraftWire,
} from './portCraft';
import { clearAuthToken } from './token';

const ROW: PortCraftWire = {
  craft_id: 1,
  name: 'Ocean Divine',
  craft_type: 'Tug',
  owned_or_hired: 'Hired',
  owner_name: 'M/s Ocean Sparkle Ltd.',
  year_built: 'Apr-18',
  loa_m: 30.31,
  breadth_m: 12.0,
  draft_m: 4.3,
  main_engines: '2 x NIGATA, 6L28HX 2 X 1654 KW/ ASD',
  bollard_pull_t: 50.0,
  design_speed_kn: 12.0,
  import_file_id: 3,
  extras: { raw: 'Ocean Divine Tug Hired …', serial: '1' },
};

const page = (items: PortCraftWire[], total = items.length) => ({ items, total, limit: 100, offset: 0, count: items.length });

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body } as unknown as Response;
}
const loginBody = { access_token: 'T1', token_type: 'bearer', role: 'DTCCC_ADMIN', auth_enabled: true };

beforeEach(() => clearAuthToken());
afterEach(() => { vi.unstubAllGlobals(); clearAuthToken(); });

describe('mapPortCraft (wire → domain)', () => {
  it('maps a full row', () => {
    const c = mapPortCraft(ROW)!;
    expect(c).toMatchObject({
      craftId: 1, name: 'Ocean Divine', craftType: 'Tug', ownedOrHired: 'Hired',
      ownerName: 'M/s Ocean Sparkle Ltd.', yearBuilt: 'Apr-18', loaM: 30.31,
      bollardPullT: 50, designSpeedKn: 12,
    });
    expect(c.extras).toEqual({ raw: 'Ocean Divine Tug Hired …', serial: '1' });
  });

  it('drops a row with no craft_id', () => {
    expect(mapPortCraft({ ...ROW, craft_id: null })).toBeNull();
  });

  it('keeps null numeric particulars as null (a launch with no bollard pull)', () => {
    const c = mapPortCraft({ ...ROW, bollard_pull_t: null, loa_m: null })!;
    expect(c.bollardPullT).toBeNull();
    expect(c.loaM).toBeNull();
  });

  it('tolerates a missing extras object', () => {
    expect(mapPortCraft({ ...ROW, extras: null })!.extras).toEqual({});
  });
});

describe('parsePortCraftPage', () => {
  it('maps rows, preserves order', () => {
    const rows = parsePortCraftPage(page([ROW, { ...ROW, craft_id: 2, name: 'Ocean Freedom' }]));
    expect(rows.map((r) => r.name)).toEqual(['Ocean Divine', 'Ocean Freedom']);
  });
  it('[] for malformed payload', () => {
    expect(parsePortCraftPage(null)).toEqual([]);
    expect(parsePortCraftPage({ items: 'nope' })).toEqual([]);
  });
});

describe('portCraftQuery', () => {
  it('page window only when unfiltered', () => {
    expect(portCraftQuery()).toBe(`${PORT_CRAFT_PATH}?limit=100&offset=0`);
  });
  it('emits filters, omits empties', () => {
    const q = portCraftQuery({ craftType: 'Tug', owner: 'Ocean Sparkle' });
    expect(q).toContain('craft_type=Tug');
    expect(q).toContain('owner=Ocean+Sparkle');
    expect(q).not.toContain('name=');
  });
});

describe('fetch* (end to end over a stubbed transport)', () => {
  it('lists the register with the bearer', async () => {
    const spy = vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse(page([ROW], 18)));
    vi.stubGlobal('fetch', spy);
    const rows = await fetchPortCraft({ craftType: 'Tug' });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Ocean Divine');
    const [url, init] = spy.mock.calls[1];
    expect(url).toBe('/api/marine/port-craft?craft_type=Tug&limit=100&offset=0');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer T1');
  });

  it('fetchPortCraftPage passes the envelope through', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse(page([ROW], 18))));
    const res = await fetchPortCraftPage();
    expect(res.total).toBe(18);
  });

  it('rejects on transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse({ error: 'x' }, 403, 'Forbidden')));
    await expect(fetchPortCraft()).rejects.toThrow(/HTTP 403/);
  });
});
