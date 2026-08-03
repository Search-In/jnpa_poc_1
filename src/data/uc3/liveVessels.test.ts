import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LIVE_VESSELS_PATH,
  fetchLiveVessels,
  mapLiveVessel,
  parseLiveVessels,
  resetLiveVesselsInflight,
  type LiveVesselWire,
} from './liveVessels';
import { clearAuthToken } from './token';

const ROW: LiveVesselWire = {
  mmsi: '571902',
  vessel_name: 'FENG HAI 66',
  imo_no: null,
  lat: 18.9271,
  lon: 72.8954,
  speed_knots: 8.4,
  course: 222,
  heading: 224,
  ship_type_code: 70,
  ship_type_label: 'Cargo',
  destination: 'INNSA',
  flag: 'CN',
  length: 190,
  elapsed_seconds: 45,
};

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body } as unknown as Response;
}
const loginBody = { access_token: 'T1', token_type: 'bearer', role: 'DTCCC_ADMIN', auth_enabled: true };

beforeEach(() => {
  clearAuthToken();
  resetLiveVesselsInflight();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthToken();
  resetLiveVesselsInflight();
});

describe('mapLiveVessel (wire → domain)', () => {
  it('maps a full row', () => {
    expect(mapLiveVessel(ROW)).toEqual({
      mmsi: '571902',
      vesselName: 'FENG HAI 66',
      imoNo: null,
      lat: 18.9271,
      lon: 72.8954,
      speedKnots: 8.4,
      course: 222,
      heading: 224,
      shipTypeCode: 70,
      shipTypeLabel: 'Cargo',
      destination: 'INNSA',
      flag: 'CN',
      length: 190,
      elapsedSeconds: 45,
    });
  });

  it('falls back to course when heading is null (Class B / SAT-AIS rows)', () => {
    expect(mapLiveVessel({ ...ROW, heading: null })?.heading).toBe(222);
  });

  it("treats the feed's '--' flag as unknown", () => {
    expect(mapLiveVessel({ ...ROW, flag: '--' })?.flag).toBeNull();
  });

  it('names an unnamed hull rather than rendering an empty popup title', () => {
    expect(mapLiveVessel({ ...ROW, vessel_name: '' })?.vesselName).toBe('UNKNOWN');
    expect(mapLiveVessel({ ...ROW, vessel_name: null })?.vesselName).toBe('UNKNOWN');
  });

  it('keeps nullable fields null instead of coercing them to 0/""', () => {
    const v = mapLiveVessel({ ...ROW, length: null, elapsed_seconds: null, destination: '', imo_no: null })!;
    expect(v.length).toBeNull();
    expect(v.elapsedSeconds).toBeNull();
    expect(v.destination).toBeNull();
    expect(v.imoNo).toBeNull();
  });

  it('drops a row with no id or an unusable position', () => {
    expect(mapLiveVessel({ ...ROW, mmsi: null })).toBeNull();
    expect(mapLiveVessel({ ...ROW, lat: null })).toBeNull();
    expect(mapLiveVessel({ ...ROW, lon: Number.NaN })).toBeNull();
    expect(mapLiveVessel({ ...ROW, lat: 118 })).toBeNull();
  });

  it('keeps the long base64 SAT-AIS id — it is a valid graphic key', () => {
    const satId = 'TnpVNE1qSTBOelU0TWpJME56VTRNZz09';
    expect(mapLiveVessel({ ...ROW, mmsi: satId })?.mmsi).toBe(satId);
  });
});

describe('parseLiveVessels', () => {
  it('accepts the BARE ARRAY the endpoint actually returns', () => {
    expect(parseLiveVessels([ROW, ROW])).toHaveLength(2);
  });

  it('also tolerates an {items:[…]} envelope', () => {
    expect(parseLiveVessels({ items: [ROW] })).toHaveLength(1);
  });

  it('is empty for anything else', () => {
    expect(parseLiveVessels(null)).toEqual([]);
    expect(parseLiveVessels({})).toEqual([]);
    expect(parseLiveVessels('nope')).toEqual([]);
  });

  it('drops unusable rows but preserves server order', () => {
    const out = parseLiveVessels([{ ...ROW, mmsi: 'A' }, { ...ROW, lat: null }, { ...ROW, mmsi: 'B' }]);
    expect(out.map((v) => v.mmsi)).toEqual(['A', 'B']);
  });
});

describe('fetchLiveVessels', () => {
  it('logs in, then GETs the live path with the bearer', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      return String(url).includes('/auth/login') ? jsonResponse(loginBody) : jsonResponse([ROW]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const vessels = await fetchLiveVessels();
    expect(vessels).toHaveLength(1);
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes(LIVE_VESSELS_PATH))!;
    expect(String(call[0])).toBe(`/api${LIVE_VESSELS_PATH}`);
    expect(call[1]?.headers).toMatchObject({ authorization: 'Bearer T1' });
  });

  it('re-mints the token and retries EXACTLY ONCE on a 401', async () => {
    let liveCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/auth/login')) return jsonResponse(loginBody);
      liveCalls += 1;
      return liveCalls === 1 ? jsonResponse({ detail: 'expired' }, 401, 'Unauthorized') : jsonResponse([ROW]);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchLiveVessels()).resolves.toHaveLength(1);
    expect(liveCalls).toBe(2);
    // Two logins: the initial one, then the re-mint after the 401.
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/auth/login'))).toHaveLength(2);
  });

  it('surfaces a 502 marinetraffic_fetch_failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse({ detail: 'marinetraffic_fetch_failed' }, 502, 'Bad Gateway'),
      ),
    );
    await expect(fetchLiveVessels()).rejects.toThrow(/502/);
  });

  it('de-dupes concurrent calls into ONE request (StrictMode double-fetch)', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('/auth/login') ? jsonResponse(loginBody) : jsonResponse([ROW]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const [a, b] = await Promise.all([fetchLiveVessels(), fetchLiveVessels()]);
    expect(a).toBe(b);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(LIVE_VESSELS_PATH))).toHaveLength(1);
  });

  it('does not wedge later callers after a failure', async () => {
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/auth/login')) return jsonResponse(loginBody);
        attempt += 1;
        return attempt === 1 ? jsonResponse({ detail: 'boom' }, 502, 'Bad Gateway') : jsonResponse([ROW]);
      }),
    );
    await expect(fetchLiveVessels()).rejects.toThrow();
    await expect(fetchLiveVessels()).resolves.toHaveLength(1);
  });
});
