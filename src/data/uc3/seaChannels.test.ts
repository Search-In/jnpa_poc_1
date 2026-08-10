import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SEA_CHANNEL_PATH,
  fetchSeaChannelGeojson,
  fetchSeaChannels,
  mapSeaChannel,
  parseSeaChannelPage,
  seaChannelQuery,
  type SeaChannelWire,
} from './seaChannels';
import { clearAuthToken } from './token';

const ROW: SeaChannelWire = {
  channel_id: 1,
  name: 'JNPA Channel',
  section_label: 'Channel Section E-F',
  area_ha: 103.65,
  length_m: 3609.25,
  geom_geojson: { type: 'Polygon', coordinates: [[[72.8618, 18.8913], [72.86, 18.9], [72.87, 18.9], [72.8618, 18.8913]]] },
  import_file_id: 3,
};

const page = (items: SeaChannelWire[], total = items.length) => ({ items, total, limit: 200, offset: 0, count: items.length });

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body } as unknown as Response;
}
const loginBody = { access_token: 'T1', token_type: 'bearer', role: 'DTCCC_ADMIN', auth_enabled: true };

beforeEach(() => clearAuthToken());
afterEach(() => { vi.unstubAllGlobals(); clearAuthToken(); });

describe('mapSeaChannel (wire → domain)', () => {
  it('maps a full row incl. GeoJSON geometry', () => {
    const c = mapSeaChannel(ROW)!;
    expect(c).toMatchObject({ channelId: 1, name: 'JNPA Channel', areaHa: 103.65, lengthM: 3609.25 });
    expect(c.geometry?.type).toBe('Polygon');
    expect(c.geometry?.coordinates[0][0]).toEqual([72.8618, 18.8913]);
  });

  it('drops a row with no channel_id', () => {
    expect(mapSeaChannel({ ...ROW, channel_id: null })).toBeNull();
  });

  it('null geometry / null numerics tolerated', () => {
    const c = mapSeaChannel({ ...ROW, geom_geojson: null, area_ha: null })!;
    expect(c.geometry).toBeNull();
    expect(c.areaHa).toBeNull();
  });

  it('rejects a non-Polygon geometry to null', () => {
    const c = mapSeaChannel({ ...ROW, geom_geojson: { type: 'Point', coordinates: [] } as never })!;
    expect(c.geometry).toBeNull();
  });
});

describe('parseSeaChannelPage', () => {
  it('maps rows, preserves order; [] on malformed', () => {
    const rows = parseSeaChannelPage(page([ROW, { ...ROW, channel_id: 2, name: 'MbPA Channel' }]));
    expect(rows.map((r) => r.name)).toEqual(['JNPA Channel', 'MbPA Channel']);
    expect(parseSeaChannelPage(null)).toEqual([]);
    expect(parseSeaChannelPage({ items: 'nope' })).toEqual([]);
  });
});

describe('seaChannelQuery', () => {
  it('page window only when unfiltered', () => {
    expect(seaChannelQuery()).toBe(`${SEA_CHANNEL_PATH}?limit=200&offset=0`);
  });
  it('emits name filter', () => {
    expect(seaChannelQuery({ name: 'JNPA' })).toContain('name=JNPA');
  });
});

describe('fetch* (end to end over a stubbed transport)', () => {
  it('lists channels with the bearer', async () => {
    const spy = vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse(page([ROW], 50)));
    vi.stubGlobal('fetch', spy);
    const rows = await fetchSeaChannels({ name: 'JNPA' });
    expect(rows).toHaveLength(1);
    expect(rows[0].geometry?.type).toBe('Polygon');
    expect(spy.mock.calls[0][0]).toBe('/api/marine/sea-channels?name=JNPA&limit=200&offset=0');
  });

  it('fetchSeaChannelGeojson returns a FeatureCollection', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string, _init?: RequestInit) =>
      String(url).endsWith('/auth/login')
        ? jsonResponse(loginBody)
        : jsonResponse({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: ROW.geom_geojson, properties: {} }], count: 1 })));
    const fc = await fetchSeaChannelGeojson();
    expect(fc.type).toBe('FeatureCollection');
    expect(fc.features).toHaveLength(1);
  });

  it('geojson tolerates a malformed payload', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse({ nope: true })));
    const fc = await fetchSeaChannelGeojson();
    expect(fc.features).toEqual([]);
  });

  it('rejects on transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse({ error: 'x' }, 403, 'Forbidden')));
    await expect(fetchSeaChannels()).rejects.toThrow(/HTTP 403/);
  });
});
