import { describe, expect, it } from 'vitest';
import { mapTrackResponse, unwrapTrackData } from './mapper';
import { sampleContainerTrack } from './sample';
import { ldbTrackUrl } from './track';

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

describe('ldb mapper', () => {
  it('unwraps a SeaRates envelope', () => {
    const data = unwrapTrackData(SEARATES_WIRE);
    expect(data?.metadata?.number).toBe('CCLU7468361');
    expect(data?.containers).toHaveLength(1);
  });

  it('maps wire → domain with origin/destination and vessel leg', () => {
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
    expect(track!.milestones[0].description).toBe('Vessel arrival at final POD');
    expect(track!.fromSample).toBe(false);
  });

  it('returns null for empty payloads', () => {
    expect(mapTrackResponse({ status: 'success', data: {} }, 'X')).toBeNull();
  });
});

describe('ldb sample + url', () => {
  it('builds a demo track matching the NLDS UI fixture', () => {
    const s = sampleContainerTrack('CCLU7468361');
    expect(s.fromSample).toBe(true);
    expect(s.vessel?.voyage).toBe('162E');
    expect(s.demurrage.freeDays).toBe('TBA');
  });

  it('builds the proxied track URL', () => {
    expect(ldbTrackUrl('cclu7468361', '7875425008', '/ldb-proxy')).toBe(
      '/ldb-proxy/apigateway/track/cntr/?cntrNo=CCLU7468361&mobileNo=7875425008',
    );
  });
});
