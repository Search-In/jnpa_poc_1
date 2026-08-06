/**
 * Carrier ↔ lifecycle tally — grouping and counting only.
 *
 * The guard these tests hold: this module must never DECIDE anything. It groups visits by
 * carrier and counts the engine's own booleans. If a test here ever needs to assert a
 * state transition, a second state engine has appeared and the projection is no longer
 * the single source of truth.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SHIPPING_LINES_STATE_PATH,
  fetchCarrierLifecycleMap,
  parseCarrierLifecycleMap,
  type SlProgressWire,
  type SlVisitWire,
} from './shippingLinesState';
import { clearAuthToken } from './token';

const visit = (o: Partial<SlVisitWire> & { shipping_line: string }): SlVisitWire => ({
  vessel_visit: 'KMIS0276', containers: 1, match: 'composite', lifecycle: null, ...o,
});

const lc = (o: Partial<NonNullable<SlVisitWire['lifecycle']>> = {}) => ({
  call_id: 825, via_no: 'S0276', vessel_name: 'kmtc Mumbai', status: 'At Berth',
  is_in_port: true, is_at_berth: true,
  arrived_at: null, berthed_at: '2026-05-12T15:10:00Z', departed_at: null,
  latest_event: 'BERTHED', ...o,
});

/** Shape verbatim from the live gateway. */
const WIRE: SlProgressWire = {
  items: [
    visit({ shipping_line: 'CCS', containers: 145, lifecycle: lc() }),
    visit({ shipping_line: 'CRT', containers: 18, lifecycle: lc() }),
    visit({ shipping_line: 'CRT', containers: 3, lifecycle: null }),   // unresolved
    visit({ shipping_line: 'BID', containers: 1, lifecycle: null }),   // unresolved only
  ],
};

describe('parseCarrierLifecycleMap', () => {
  it('tallies the engine verdicts per carrier', () => {
    const m = parseCarrierLifecycleMap(WIRE);
    expect(m.get('CCS')).toMatchObject({ activeVessels: 1, inPort: 1, atBerth: 1 });
    expect(m.get('CCS')?.latestActivity).toBe('BERTHED');
  });

  // A carrier with only unresolved visits is PRESENT — so the registry can mark the
  // correlation failure — but contributes no vessel counts, so the lifecycle columns
  // still render '—' rather than a fabricated 0.
  it('keeps a carrier whose visits resolved to no call, with zero vessel counts', () => {
    const m = parseCarrierLifecycleMap(WIRE);
    const bid = m.get('BID');
    expect(bid).toBeDefined();
    expect(bid).toMatchObject({ activeVessels: 0, inPort: 0, atBerth: 0, unmatchedVisits: 1 });
    expect(bid?.latestActivity).toBe('');
  });

  it('counts only the resolved visits of a partially matched carrier', () => {
    const m = parseCarrierLifecycleMap(WIRE);
    expect(m.get('CRT')?.activeVessels).toBe(1);   // 2 visits, 1 resolved
  });

  it('counts in-port and at-berth independently', () => {
    const m = parseCarrierLifecycleMap({
      items: [
        visit({ shipping_line: 'X', lifecycle: lc({ is_in_port: true, is_at_berth: false }) }),
        visit({ shipping_line: 'X', lifecycle: lc({ is_in_port: true, is_at_berth: true }) }),
        visit({ shipping_line: 'X', lifecycle: lc({ is_in_port: false, is_at_berth: false }) }),
      ],
    });
    expect(m.get('X')).toMatchObject({ activeVessels: 3, inPort: 2, atBerth: 1 });
  });

  it('takes the latest activity from the most recently updated visit', () => {
    const m = parseCarrierLifecycleMap({
      items: [
        visit({ shipping_line: 'Y',
                lifecycle: lc({ latest_event: 'BERTHED', berthed_at: '2026-05-10T00:00:00Z' }) }),
        visit({ shipping_line: 'Y',
                lifecycle: lc({ latest_event: 'DEPARTED', departed_at: '2026-06-01T00:00:00Z' }) }),
      ],
    });
    expect(m.get('Y')?.latestActivity).toBe('DEPARTED');
    expect(m.get('Y')?.lastUpdated).toBe(Date.parse('2026-06-01T00:00:00Z'));
  });

  // The wire carries no `latest_event_time`, so the timestamp is the newest milestone the
  // visit DOES carry. Never a fabricated "now".
  it('uses the newest milestone timestamp, not a synthetic one', () => {
    const m = parseCarrierLifecycleMap({
      items: [visit({ shipping_line: 'Z',
                      lifecycle: lc({ arrived_at: '2026-05-01T00:00:00Z',
                                      berthed_at: '2026-05-02T00:00:00Z',
                                      departed_at: null }) })],
    });
    expect(m.get('Z')?.lastUpdated).toBe(Date.parse('2026-05-02T00:00:00Z'));
  });

  it('leaves the timestamp at 0 when no milestone is present', () => {
    const m = parseCarrierLifecycleMap({
      items: [visit({ shipping_line: 'W',
                      lifecycle: lc({ arrived_at: null, berthed_at: null, departed_at: null }) })],
    });
    expect(m.get('W')?.lastUpdated).toBe(0);
  });

  it('tolerates a malformed payload rather than throwing', () => {
    for (const bad of [null, undefined, {}, { items: 'nope' }, 42]) {
      expect(parseCarrierLifecycleMap(bad).size).toBe(0);
    }
  });

  it('skips a visit with no carrier code', () => {
    const m = parseCarrierLifecycleMap({ items: [visit({ shipping_line: '', lifecycle: lc() })] });
    expect(m.size).toBe(0);
  });
});

describe('the tally decides nothing', () => {
  it('exposes no state field — only counts, one event name and one timestamp', () => {
    const v = parseCarrierLifecycleMap(WIRE).get('CCS')!;
    // Counts only. `unmatchedVisits` / `compositeMatches` are the gateway's own
    // correlation outcome tallied per carrier — still counts, still no verdict.
    expect(Object.keys(v).sort()).toEqual(
      ['activeVessels', 'atBerth', 'compositeMatches', 'inPort', 'lastUpdated',
       'latestActivity', 'unmatchedVisits']);
    for (const banned of ['status', 'arrivalState', 'berthState', 'departureState',
                          'expected', 'delayed', 'riskScore', 'etaPrediction',
                          'anomaly', 'severity', 'isAnomalous']) {
      expect(Object.keys(v)).not.toContain(banned);
    }
  });
});

describe('fetchCarrierLifecycleMap', () => {
  const loginBody = { access_token: 'tok', token_type: 'bearer' };
  const ok = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);

  beforeEach(() => clearAuthToken());
  afterEach(() => { vi.unstubAllGlobals(); clearAuthToken(); });

  it('reads the EXISTING state endpoint', async () => {
    const fetchMock = vi.fn((url: string) =>
      String(url).endsWith('/auth/login') ? ok(loginBody) : ok(WIRE));
    vi.stubGlobal('fetch', fetchMock);

    const m = await fetchCarrierLifecycleMap();
    expect(m.get('CCS')?.inPort).toBe(1);

    const dataCalls = fetchMock.mock.calls.filter(([u]) => !String(u).endsWith('/auth/login'));
    expect(dataCalls).toHaveLength(1);
    expect(String(dataCalls[0][0])).toContain(SHIPPING_LINES_STATE_PATH);
  });

  // The registry must keep working with its original six columns.
  it('resolves to an empty map on failure instead of rejecting', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('gateway down'))));
    await expect(fetchCarrierLifecycleMap()).resolves.toEqual(new Map());
  });
});

describe('verified correlation outcome', () => {
  it('tallies unmatched visits per carrier', () => {
    const m = parseCarrierLifecycleMap(WIRE);
    expect(m.get('CRT')).toMatchObject({ activeVessels: 1, unmatchedVisits: 1 });
    expect(m.get('CCS')?.unmatchedVisits).toBe(0);
  });

  // 'composite' is a SUCCESSFUL match by a weaker rule — context, never a warning of its
  // own. It must be counted separately from the failures.
  it('counts composite matches separately from failures', () => {
    const m = parseCarrierLifecycleMap({
      items: [
        visit({ shipping_line: 'Q', match: 'exact', lifecycle: lc() }),
        visit({ shipping_line: 'Q', match: 'composite', lifecycle: lc() }),
        visit({ shipping_line: 'Q', match: null, lifecycle: null }),
      ],
    });
    expect(m.get('Q')).toMatchObject({
      activeVessels: 2, compositeMatches: 1, unmatchedVisits: 1,
    });
  });

  it('reports zero unmatched when every visit correlated', () => {
    const m = parseCarrierLifecycleMap({
      items: [visit({ shipping_line: 'R', match: 'exact', lifecycle: lc() })],
    });
    expect(m.get('R')).toMatchObject({ unmatchedVisits: 0, compositeMatches: 0 });
  });

  // The tally must not invent a correlation verdict — it only reflects `match` and
  // whether the gateway attached a lifecycle.
  it('treats an unknown match value as neither composite nor failed', () => {
    const m = parseCarrierLifecycleMap({
      items: [visit({ shipping_line: 'S', match: 'something-new', lifecycle: lc() })],
    });
    expect(m.get('S')).toMatchObject({
      activeVessels: 1, compositeMatches: 0, unmatchedVisits: 0,
    });
  });
});
