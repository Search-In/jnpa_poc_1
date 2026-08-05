import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';
import { mapTrackResponse, unwrapTrackData } from './mapper';
import { sampleContainerTrack } from './sample';
import { clearSearateToken, setSearateToken } from './token';
import { isValidContainerNo, ldbTrackUrl, LdbAuthRequiredError, trackContainerById } from './track';

const SEARATES_WIRE = {
  status: 'success',
  message: 'OK',
  data: {
    metadata: {
      type: 'CT',
      number: 'CCLU7468361',
      sealine: 'OOLU',
      sealine_name: 'Orient Overseas Container Line (OOCL)',
      status: 'IN_TRANSIT',
    },
    locations: [
      {
        id: 1,
        name: 'Jawaharlal Nehru',
        country_code: 'IN',
        lat: 18.95,
        lng: 72.95,
      },
      {
        id: 2,
        name: 'Shanghai',
        country_code: 'CN',
        lat: 31.23,
        lng: 121.47,
      },
    ],
    vessels: [{ id: 1, name: 'XIN SHANGHAI' }],
    route: {
      pol: { location: 1, date: '2026-08-03 01:00:00', actual: true },
      pod: { location: 2, date: '2026-08-28 11:00:00', actual: false },
    },
    containers: [
      {
        number: 'CCLU7468361',
        size_type: "40' High Cube Dry",
        status: 'IN_TRANSIT',
        events: [
          {
            order_id: 1,
            location: 1,
            description: 'Empty Container to shipper',
            date: '2026-07-28 06:00:00',
            actual: true,
            transport_type: 'TRUCK',
            vessel: null,
            voyage: null,
          },
          {
            order_id: 2,
            location: 1,
            description: 'Vessel departure from first POL',
            date: '2026-08-03 01:00:00',
            actual: true,
            transport_type: 'VESSEL',
            vessel: 1,
            voyage: '162E',
          },
          {
            order_id: 3,
            location: 2,
            description: 'Vessel arrival at final POD',
            date: '2026-08-28 11:00:00',
            actual: false,
            transport_type: 'VESSEL',
            vessel: 1,
            voyage: '162E',
          },
        ],
      },
    ],
    route_data: {
      route: [
        {
          path: [
            [18.95, 72.95],
            [8.1, 77.5],
            [31.23, 121.47],
          ],
        },
      ],
    },
  },
};

/** Shape returned by live LDB guest searate after OTP. */
const LDB_RESPONSE_DATA = {
  responseData: {
    is_valid: 1,
    cntr_info_data: {
      number: 'OOLU9340457',
      size_type: "40' High Cube Dry",
      status: 'IN_TRANSIT',
      sealine_name: 'OOCL',
      source_name: 'Jawaharlal Nehru, IN',
      dest_name: 'Shanghai, CN',
      source_etd_or_atd: '2026-08-03 01:00:00',
      dest_eta_ata: '2026-08-28 11:00:00',
    },
    event_detail_info: [
      {
        location_name: 'Jawaharlal Nehru',
        event_details: [
          { id: 1, event: 'Vessel departure from first POL', event_time: '2026-08-03 01:00:00' },
        ],
      },
    ],
    vessel_event_details: [
      {
        vessel_name: 'XIN SHANGHAI',
        voyage_name: '162E',
        loading: 'Jawaharlal Nehru',
        discharge: 'Shanghai',
        vessel_etd_atd: '2026-08-03 01:00:00',
        vessel_eta_ata: '2026-08-28 11:00:00',
      },
    ],
    route_details: [
      {
        transport_type: 'VESSEL',
        path: [
          [18.95, 72.95],
          [31.23, 121.47],
        ],
      },
    ],
    demurrage: { free_days: 'TBA', days_in_charge: '—' },
  },
};

function fakeJwt(mobileNo: string): string {
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ mobileNo }));
  return `${header}.${payload}.sig`;
}

describe('ldb mapper', () => {
  it('unwraps a SeaRates envelope', () => {
    const data = unwrapTrackData(SEARATES_WIRE);
    expect(data?.metadata?.number).toBe('CCLU7468361');
    expect(data?.containers).toHaveLength(1);
  });

  it('maps SeaRates wire → domain', () => {
    const track = mapTrackResponse(SEARATES_WIRE, 'cclu7468361');
    expect(track).not.toBeNull();
    expect(track!.containerNo).toBe('CCLU7468361');
    expect(track!.status).toBe('In-Transit');
    expect(track!.carrierName).toContain('OOCL');
    expect(track!.originName).toBe('Jawaharlal Nehru');
    expect(track!.destinationName).toBe('Shanghai');
    expect(track!.vessel?.vessel).toBe('XIN SHANGHAI');
    expect(track!.vessel?.voyage).toBe('162E');
    expect(track!.routePath).toHaveLength(3);
    expect(track!.fromSample).toBe(false);
  });

  it('maps live LDB responseData for any container id', () => {
    const track = mapTrackResponse(LDB_RESPONSE_DATA, 'oolu9340457');
    expect(track).not.toBeNull();
    expect(track!.containerNo).toBe('OOLU9340457');
    expect(track!.carrierName).toContain('OOCL');
    expect(track!.originName).toBe('Jawaharlal Nehru');
    expect(track!.destinationName).toBe('Shanghai');
    expect(track!.vessel?.vessel).toBe('XIN SHANGHAI');
    expect(track!.milestones.length).toBeGreaterThan(0);
  });

  it('returns null for empty payloads', () => {
    expect(mapTrackResponse({ status: 'success', data: {} }, 'X')).toBeNull();
  });
});

describe('ldb sample + url', () => {
  it('builds a demo track matching the NLDS UI fixture', () => {
    const s = sampleContainerTrack();
    expect(s.fromSample).toBe(true);
    expect(s.containerNo).toBe('CCLU7468361');
    expect(s.vessel?.voyage).toBe('162E');
    expect(s.demurrage.freeDays).toBe('TBA');
  });

  it('builds the proxied track URL', () => {
    expect(ldbTrackUrl('cclu7468361', '7875425008', '/ldb-proxy')).toBe(
      '/ldb-proxy/apigateway/track/cntr/?cntrNo=CCLU7468361&mobileNo=7875425008'
    );
  });

  it('accepts ISO 6346 container numbers', () => {
    expect(isValidContainerNo('CCLU7468361')).toBe(true);
    expect(isValidContainerNo('cclu7468361')).toBe(true);
    expect(isValidContainerNo('BAD')).toBe(false);
    expect(isValidContainerNo('')).toBe(false);
  });
});

describe('trackContainerById OTP session', () => {
  beforeEach(() => {
    clearSearateToken();
  });

  afterEach(() => {
    clearSearateToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rejects malformed container numbers without calling LDB', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(trackContainerById('NOT-A-CONTAINER')).rejects.toThrow(/valid container number/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires OTP session before track', async () => {
    await expect(trackContainerById('OOLU9340457', '9876543210')).rejects.toBeInstanceOf(
      LdbAuthRequiredError
    );
  });

  it('POSTs track with Bearer searateToken and JWT mobileNo', async () => {
    setSearateToken(fakeJwt('9876543210'));
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify(LDB_RESPONSE_DATA), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const track = await trackContainerById('OOLU9340457', '1111111111');
    expect(track.containerNo).toBe('OOLU9340457');
    expect(track.fromSample).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain('cntrNo=OOLU9340457');
    expect(String(url)).toContain('mobileNo=9876543210');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer /);
  });

  it('clears session and demands re-OTP on 401', async () => {
    setSearateToken(fakeJwt('9876543210'));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ statusCode: 'UNAUTHORIZED' }), { status: 401 })
      )
    );
    await expect(trackContainerById('OOLU9340457')).rejects.toBeInstanceOf(LdbAuthRequiredError);
  });

  it('does not stamp the CCLU sample onto a different container id', async () => {
    setSearateToken(fakeJwt('9876543210'));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 }))
    );
    await expect(trackContainerById('OOLU9340457')).rejects.toThrow(
      /Couldn’t track OOLU9340457|Couldn’t look up/
    );
  });
});
