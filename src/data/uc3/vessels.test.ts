import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  VESSELS_PATH,
  fetchVessel,
  fetchVesselStats,
  fetchVesselsPage,
  mapVessel,
  mapVesselStats,
  parseVesselPage,
  vesselsQuery,
  type VesselWire,
} from './vessels';
import { clearAuthToken } from './token';

/** Modelled on a real corpus row (XT FORTUNE, IMO 9815628). */
const ROW: VesselWire = {
  imo_no: '9815628',
  vessel_name: 'XT FORTUNE',
  call_sign: 'VRTE6',
  flag: 'HK',
  vessel_type: '1534',
  mtmv: 'MT',
  loa_m: 133.23,
  beam_m: 21.5,
  lbp_m: 130.43,
  max_draft_m: 8.5,
  grt: 8944.0,
  nrt: 4228.0,
  dwt: 13121.3,
  teu_capacity: 7092,
  mmsi: '413167000',
  engine_type: 'WINGDW6X36B',
  num_engines: 1,
  propulsion_type: 'RIGHT HAND PROPELLER',
  num_propellers: 1,
  max_speed_kn: 12.5,
  bow_thruster: false,
  stern_thruster: null,
  built_date: '2020-11-12',
  reg_port: 'HKHKG1',
  owner_name: 'HK XINGYAO SHIPPING CO LIMITED',
  email: 'ops@mnkship.com',
  vespro_ref: '2026021195965490',
  updated_at: '2026-07-27T10:00:00+05:30',
  insurance: [{ pi_club: 'GARD', valid_until: '2027-02-20' }],
};

const page = (items: VesselWire[], total = items.length) => ({
  items, total, limit: 100, offset: 0, count: items.length,
});

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body } as unknown as Response;
}
const loginBody = { access_token: 'T1', token_type: 'bearer', role: 'DTCCC_ADMIN', auth_enabled: true };

beforeEach(() => clearAuthToken());
afterEach(() => { vi.unstubAllGlobals(); clearAuthToken(); });

describe('mapVessel (wire → domain)', () => {
  it('maps every particular', () => {
    const v = mapVessel(ROW)!;
    expect(v.imoNo).toBe('9815628');
    expect(v.vesselName).toBe('XT FORTUNE');
    expect(v.loaM).toBe(133.23);
    expect(v.maxDraftM).toBe(8.5);
    expect(v.grt).toBe(8944.0);
  });

  it('maps TEU and MMSI — the two newly-mapped VESPRO tags', () => {
    const v = mapVessel(ROW)!;
    expect(v.teuCapacity).toBe(7092);
    expect(v.mmsi).toBe('413167000');
  });

  it('keeps MMSI a string so leading zeros survive', () => {
    const v = mapVessel({ ...ROW, mmsi: '004131670' })!;
    expect(v.mmsi).toBe('004131670');
  });

  it('preserves a false thruster flag rather than collapsing it to null', () => {
    const v = mapVessel(ROW)!;
    expect(v.bowThruster).toBe(false);
  });

  it('keeps an unstated thruster fit as null (tri-state, not false)', () => {
    const v = mapVessel(ROW)!;
    expect(v.sternThruster).toBeNull();
  });

  it('keeps an absent particular null rather than 0', () => {
    const v = mapVessel({ ...ROW, teu_capacity: null, max_draft_m: null })!;
    expect(v.teuCapacity).toBeNull();
    expect(v.maxDraftM).toBeNull();
  });

  it('maps P&I cover on the detail shape', () => {
    const v = mapVessel(ROW)!;
    expect(v.insurance).toEqual([{ piClub: 'GARD', validUntil: '2027-02-20' }]);
  });

  it('defaults insurance to [] when the list read omits it', () => {
    // List rows carry no `insurance` key at all (it is detail-only), so drop it rather
    // than setting it null — this asserts the absent-key path, not the null path.
    const noCover: VesselWire = { ...ROW };
    delete (noCover as Partial<VesselWire>).insurance;
    expect(mapVessel(noCover)!.insurance).toEqual([]);
  });

  it('drops a cover block with no club name', () => {
    const v = mapVessel({ ...ROW, insurance: [{ pi_club: null, valid_until: '2027-01-01' }] })!;
    expect(v.insurance).toEqual([]);
  });

  it('drops a row with no IMO (the natural key)', () => {
    expect(mapVessel({ ...ROW, imo_no: null })).toBeNull();
    expect(mapVessel({ ...ROW, imo_no: '  ' })).toBeNull();
  });

  it('coerces absent text to empty string, never undefined', () => {
    const v = mapVessel({ ...ROW, call_sign: null, owner_name: null })!;
    expect(v.callSign).toBe('');
    expect(v.ownerName).toBe('');
  });
});

describe('parseVesselPage', () => {
  it('preserves server order and drops unusable rows', () => {
    const rows = [ROW, { ...ROW, imo_no: null }, { ...ROW, imo_no: '9320477' }];
    const out = parseVesselPage(page(rows as VesselWire[]));
    expect(out.map((v) => v.imoNo)).toEqual(['9815628', '9320477']);
  });

  it('returns [] for a malformed payload', () => {
    expect(parseVesselPage(null)).toEqual([]);
    expect(parseVesselPage({})).toEqual([]);
    expect(parseVesselPage({ items: 'nope' })).toEqual([]);
  });
});

describe('mapVesselStats', () => {
  it('maps the completeness counters', () => {
    const s = mapVesselStats({
      total: 9, with_dimensions: 9, with_teu: 6, with_mmsi: 2,
      avg_loa_m: 210.4, max_draft_m: 15.6,
      by_flag: [{ flag: 'HK', count: 4 }, { flag: null, count: 1 }],
    });
    expect(s.total).toBe(9);
    expect(s.withTeu).toBe(6);
    expect(s.withMmsi).toBe(2);
    expect(s.avgLoaM).toBe(210.4);
    expect(s.byFlag).toEqual([{ flag: 'HK', count: 4 }]);
  });

  it('is tolerant of a partial payload', () => {
    const s = mapVesselStats({});
    expect(s.total).toBe(0);
    expect(s.byFlag).toEqual([]);
    expect(s.avgLoaM).toBeNull();
  });
});

describe('vesselsQuery', () => {
  it('always carries limit and offset', () => {
    expect(vesselsQuery()).toBe(`${VESSELS_PATH}?limit=100&offset=0`);
  });

  it('maps camelCase filters onto snake_case params', () => {
    const q = vesselsQuery({ vesselType: '1534', callSign: 'VRTE6', name: 'FORTUNE' });
    expect(q).toContain('vessel_type=1534');
    expect(q).toContain('call_sign=VRTE6');
    expect(q).toContain('name=FORTUNE');
  });

  it('omits blank filters entirely', () => {
    expect(vesselsQuery({ flag: '', name: '   ' })).toBe(`${VESSELS_PATH}?limit=100&offset=0`);
  });
});

describe('I/O', () => {
  it('fetchVesselsPage returns mapped rows with the envelope', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(loginBody))
      .mockResolvedValueOnce(jsonResponse(page([ROW], 9)));
    vi.stubGlobal('fetch', fetchMock);
    const res = await fetchVesselsPage();
    expect(res.total).toBe(9);
    expect(res.items[0].vesselName).toBe('XT FORTUNE');
  });

  it('fetchVesselStats maps the counters', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(loginBody))
      .mockResolvedValueOnce(jsonResponse({ total: 9, with_teu: 6, by_flag: [] }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await fetchVesselStats()).withTeu).toBe(6);
  });

  it('fetchVessel URL-encodes the IMO path segment', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(loginBody))
      .mockResolvedValueOnce(jsonResponse(ROW));
    vi.stubGlobal('fetch', fetchMock);
    await fetchVessel('9815628');
    const url = String(fetchMock.mock.calls[1][0]);
    expect(url).toContain('/marine/vessels/9815628');
  });

  it('rejects (not throws) when the gateway errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(loginBody))
      .mockResolvedValueOnce(jsonResponse({ detail: 'boom' }, 500, 'Server Error'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchVesselsPage()).rejects.toThrow(/500/);
  });
});
