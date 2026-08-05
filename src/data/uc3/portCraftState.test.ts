import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PORT_CRAFT_STATE_PATH,
  fetchPortCraftDemand,
  mapCraftMovement,
  parsePortCraftDemand,
  type PortCraftDemandWire,
} from './portCraftState';
import { clearAuthToken } from './token';

/** Shape verbatim from the live gateway (GET /api/marine/state/port-craft). */
const WIRE: PortCraftDemandWire = {
  fleet: {
    total: 18,
    by_type: [
      { craft_type: 'Tug', count: 10 },
      { craft_type: 'Pilot Launch', count: 4 },
      { craft_type: 'Security Launch', count: 2 },
      { craft_type: 'Multi- Purpose Utility Launch', count: 1 },
      { craft_type: 'VIP Launch', count: 1 },
    ],
  },
  demand: { total: 561, inbound_movement: 25, alongside: 536, outbound_movement: 0 },
  inbound_movement: [
    { call_id: 310, vcn: 'INNSA1NF0S0874', via_no: 'S0874', vessel_name: null,
      berth_id: 2, latest_event: 'PILOT_BOARDED' },
  ],
  alongside: [
    { call_id: 48, vcn: 'INNSA1NF0S0776', via_no: 'S0776', vessel_name: 'TSS AMBER',
      berth_id: 2, latest_event: 'ARRIVED',
      imo_no: '9241918', status: 'At Berth', arrival_state: 'Completed',
      pilot_state: 'Completed', berth_state: 'Occupied', departure_state: 'Pending',
      shipping_state: 'In Port', portcraft_state: 'Busy',
      latest_event_time: '2026-07-29T15:54:00Z', movement_phase: 'Alongside' },
  ],
  outbound_movement: [],
  active_calls: 1230,
};

describe('parsePortCraftDemand (wire → domain)', () => {
  it('maps fleet capacity from the register', () => {
    const d = parsePortCraftDemand(WIRE);
    expect(d.fleetTotal).toBe(18);
    expect(d.fleetByType).toHaveLength(5);
    expect(d.fleetByType[0]).toEqual({ craftType: 'Tug', count: 10 });
  });

  it('maps the phase counts the backend reported', () => {
    const d = parsePortCraftDemand(WIRE);
    expect(d.totalDemand).toBe(561);
    expect(d.inboundCount).toBe(25);
    expect(d.alongsideCount).toBe(536);
    expect(d.outboundCount).toBe(0);
    expect(d.activeCalls).toBe(1230);
  });

  it('carries the calls behind each count', () => {
    const d = parsePortCraftDemand(WIRE);
    expect(d.alongside[0].vesselName).toBe('TSS AMBER');
    expect(d.alongside[0].viaNo).toBe('S0776');
    expect(d.alongside[0].latestEvent).toBe('ARRIVED');
    expect(d.outbound).toEqual([]);
  });

  // Counts come from the backend, NOT from array length — the two are computed
  // server-side as len(rows) and must be reported as sent, never recomputed here.
  it('never recomputes a count from the rows it received', () => {
    const partial = { ...WIRE, alongside: [] };
    expect(parsePortCraftDemand(partial).alongsideCount).toBe(536);
  });

  it('a call with no vessel name still maps — CALINV/BERALT carry none', () => {
    const d = parsePortCraftDemand(WIRE);
    expect(d.inbound[0].vesselName).toBe('');
    expect(d.inbound[0].viaNo).toBe('S0874');
  });

  it('tolerates a malformed payload rather than throwing', () => {
    for (const bad of [null, undefined, {}, { fleet: null, demand: null }, 'nope', 42]) {
      const d = parsePortCraftDemand(bad);
      expect(d.fleetTotal).toBe(0);
      expect(d.fleetByType).toEqual([]);
      expect(d.alongside).toEqual([]);
    }
  });

  it('drops a craft-type row with no type rather than rendering a blank chip', () => {
    const d = parsePortCraftDemand({
      ...WIRE,
      fleet: { total: 1, by_type: [{ craft_type: null, count: 3 }] },
    });
    expect(d.fleetByType).toEqual([]);
  });
});

describe('mapCraftMovement', () => {
  it('keeps berth_id numeric and unresolved', () => {
    const m = mapCraftMovement(WIRE.alongside![0]);
    expect(m.berthId).toBe(2);
    expect(m.callId).toBe(48);
  });

  it('nulls an absent berth rather than coercing it to 0', () => {
    const m = mapCraftMovement({ call_id: 1, vcn: null, via_no: null,
                                 vessel_name: null, berth_id: null, latest_event: null });
    expect(m.berthId).toBeNull();
    expect(m.latestEvent).toBe('');
  });
});

describe('the connector exposes NO inferred value', () => {
  const d = parsePortCraftDemand(WIRE);

  // These are the four things the schema cannot support. If any ever appears in the
  // domain object, something is being invented — see state_service.py.
  it.each(['utilisation', 'utilization', 'assignedCraft', 'craftStatus',
           'busyCraft', 'availableCraft', 'estimated'])(
    'has no %s field', (banned) => {
      expect(Object.keys(d)).not.toContain(banned);
    });

  it('exposes no per-craft record at all — only fleet counts and per-CALL demand', () => {
    // fleetByType is a count per TYPE, never a list of individual craft.
    expect(d.fleetByType.every((t) => typeof t.count === 'number')).toBe(true);
    expect(d.fleetByType).not.toHaveProperty('0.craftId');
  });

  // `latestEventTime` IS exposed now — it is the projection's own milestone timestamp,
  // an approved lifecycle field. What must never appear is a CRAFT timestamp: nothing
  // records when a craft was deployed or released, so `deployedAt` would be invented.
  it('exposes no per-craft timestamp', () => {
    for (const m of [...d.inbound, ...d.alongside, ...d.outbound]) {
      expect(Object.keys(m)).not.toContain('deployedAt');
      expect(Object.keys(m)).not.toContain('releasedAt');
      expect(Object.keys(m)).not.toContain('responseMin');
    }
  });
});

describe('fetchPortCraftDemand', () => {
  const loginBody = { access_token: 'tok', token_type: 'bearer' };
  const jsonResponse = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

  beforeEach(() => clearAuthToken());
  afterEach(() => { vi.unstubAllGlobals(); clearAuthToken(); });

  it('requests the state endpoint and maps the envelope', async () => {
    const fetchMock = vi.fn((url: string) =>
      String(url).endsWith('/auth/login') ? jsonResponse(loginBody) : jsonResponse(WIRE));
    vi.stubGlobal('fetch', fetchMock);

    const d = await fetchPortCraftDemand();
    expect(d?.fleetTotal).toBe(18);
    expect(d?.alongsideCount).toBe(536);

    const dataCalls = fetchMock.mock.calls.filter(([u]) => !String(u).endsWith('/auth/login'));
    expect(dataCalls).toHaveLength(1);
    expect(String(dataCalls[0][0])).toContain(PORT_CRAFT_STATE_PATH);
  });

  // The strip renders null on null, so the Port Craft tab degrades to the board alone.
  it('resolves to null on transport failure instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('gateway down'))));
    await expect(fetchPortCraftDemand()).resolves.toBeNull();
  });

  it('resolves to null on an HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) =>
      String(url).endsWith('/auth/login')
        ? jsonResponse(loginBody)
        : Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) } as Response)));
    await expect(fetchPortCraftDemand()).resolves.toBeNull();
  });
});

describe('demand rows carry the call lifecycle', () => {
  const d = parsePortCraftDemand(WIRE);
  const amber = d.alongside[0];

  it('exposes the lifecycle the backend projection reported', () => {
    expect(amber.status).toBe('At Berth');
    expect(amber.portcraftState).toBe('Busy');
    expect(amber.arrivalState).toBe('Completed');
    expect(amber.pilotState).toBe('Completed');
    expect(amber.berthState).toBe('Occupied');
    expect(amber.departureState).toBe('Pending');
    expect(amber.shippingState).toBe('In Port');
    expect(amber.imoNo).toBe('9241918');
  });

  it('names the bucket the backend already sorted it into', () => {
    expect(amber.movementPhase).toBe('Alongside');
  });

  it('maps the milestone timestamp', () => {
    expect(amber.latestEventTime).toBe(Date.parse('2026-07-29T15:54:00Z'));
  });

  // Additive: a gateway predating these fields must still yield a usable row.
  it('degrades to empty strings on an older gateway', () => {
    const legacy = mapCraftMovement({
      call_id: 7, vcn: 'V', via_no: 'S0001', vessel_name: 'X',
      berth_id: null, latest_event: 'BERTHED',
    });
    expect(legacy.status).toBe('');
    expect(legacy.movementPhase).toBe('');
    expect(legacy.latestEventTime).toBe(0);
    expect(legacy.latestEvent).toBe('BERTHED');   // pre-existing field unaffected
  });

  it('still exposes no craft identity or requires_* flag', () => {
    for (const banned of ['requiresTug', 'requiresPilot', 'requiresLaunch',
                          'assignedCraft', 'craftName']) {
      expect(Object.keys(amber)).not.toContain(banned);
    }
  });
});
