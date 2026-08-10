import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BERTH_STATE_PATH,
  LIVE_KPI_KEYS,
  applyLiveKpis,
  fetchLiveKpis,
  mapLiveKpis,
  type LiveKpis,
} from './dashboardKpis';
import { clearAuthToken } from './token';
import type { KpiBundle, KpiValue } from '@/types/kpi';

const STATS = {
  total: 12, with_vcn: 10, without_vcn: 2, arrived: 7, in_port: 3,
  ops_completed: 0, departed: 4, terminals: 5,
  avg_turnaround_hours: 41.6, avg_pre_berth_delay_hours: -1.2,
  by_status: [], by_terminal: [],
};
const BERTHS = { total: 22, occupied: 11, allotted: 3, free: 8 };

function kpi(key: string, value: number, unit: string, target: number): KpiValue {
  return { key, label: key, value, unit, target, deltaPct: 0, trend: [{ ts: 1, value }] };
}
const BUNDLE = {
  avgTat: kpi('avgTat', 99, 'h', 24),
  berthOccupancy: kpi('berthOccupancy', 99, '%', 75),
  preSailingDelay: kpi('preSailingDelay', 5, 'h', 2),
  anchored: kpi('anchored', 9, '', 5),
} as unknown as KpiBundle;

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body } as unknown as Response;
}
const loginBody = { access_token: 'T1', token_type: 'bearer', role: 'DTCCC_ADMIN', auth_enabled: true };

beforeEach(() => clearAuthToken());
afterEach(() => { vi.unstubAllGlobals(); clearAuthToken(); });

describe('mapLiveKpis (wire → live values)', () => {
  it('takes Avg TAT straight from the stats envelope', () => {
    expect(mapLiveKpis(STATS, BERTHS).avgTat).toBe(41.6);
  });

  it('computes berth occupancy as occupied/total', () => {
    expect(mapLiveKpis(STATS, BERTHS).berthOccupancy).toBeCloseTo(50, 5);
  });

  it('carries the arrived / in-port / departed counts', () => {
    const l = mapLiveKpis(STATS, BERTHS);
    expect([l.arrived, l.inPort, l.departed]).toEqual([7, 3, 4]);
  });

  it('keeps Avg TAT null when no call has completed — not zero hours', () => {
    expect(mapLiveKpis({ ...STATS, avg_turnaround_hours: null }, BERTHS).avgTat).toBeNull();
  });

  it('keeps occupancy null when the berth register is empty', () => {
    expect(mapLiveKpis(STATS, { ...BERTHS, total: 0 }).berthOccupancy).toBeNull();
  });

  it('is tolerant of malformed payloads', () => {
    const l = mapLiveKpis({}, {});
    expect(l.avgTat).toBeNull();
    expect(l.berthOccupancy).toBeNull();
    expect([l.arrived, l.inPort, l.departed]).toEqual([0, 0, 0]);
  });
});

describe('applyLiveKpis (overlay)', () => {
  const live: LiveKpis = { avgTat: 41.6, berthOccupancy: 50, arrived: 7, inPort: 3, departed: 4 };

  it('replaces only the cards that have a corpus source', () => {
    const out = applyLiveKpis(BUNDLE, live);
    expect(out.avgTat.value).toBe(41.6);
    expect(out.berthOccupancy.value).toBe(50);
  });

  it('leaves every other card untouched', () => {
    const out = applyLiveKpis(BUNDLE, live);
    expect(out.preSailingDelay).toBe(BUNDLE.preSailingDelay);
    expect(out.anchored).toBe(BUNDLE.anchored);
  });

  it('preserves label, unit, target and sparkline', () => {
    const out = applyLiveKpis(BUNDLE, live);
    expect(out.avgTat.unit).toBe('h');
    expect(out.avgTat.target).toBe(24);
    expect(out.avgTat.trend).toEqual(BUNDLE.avgTat.trend);
  });

  it('recomputes deltaPct against the card’s own target', () => {
    const out = applyLiveKpis(BUNDLE, live);
    // 41.6 vs target 24 → +73.3%
    expect(out.avgTat.deltaPct).toBeCloseTo(73.3, 1);
  });

  it('rounds counts to whole numbers and hours to 1dp', () => {
    const out = applyLiveKpis(BUNDLE, { ...live, berthOccupancy: 50.44 });
    expect(out.berthOccupancy.value).toBe(50.4);
  });

  it('keeps the adapter value when the corpus cannot answer yet', () => {
    const out = applyLiveKpis(BUNDLE, { ...live, avgTat: null, berthOccupancy: null });
    expect(out.avgTat.value).toBe(99);
    expect(out.berthOccupancy.value).toBe(99);
  });

  it('passes the bundle through untouched when the fetch failed', () => {
    expect(applyLiveKpis(BUNDLE, null)).toBe(BUNDLE);
  });

  it('does not mutate the input bundle', () => {
    applyLiveKpis(BUNDLE, live);
    expect(BUNDLE.avgTat.value).toBe(99);
  });

  it('declares exactly the cards it overlays', () => {
    expect([...LIVE_KPI_KEYS]).toEqual(['avgTat', 'berthOccupancy']);
  });
});

describe('fetchLiveKpis (I/O)', () => {
  it('reads the two EXISTING endpoints — no new API', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(loginBody))
      .mockResolvedValue(jsonResponse(STATS));
    vi.stubGlobal('fetch', fetchMock);
    await fetchLiveKpis();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/marine/calls/stats'))).toBe(true);
    expect(urls.some((u) => u.includes(BERTH_STATE_PATH))).toBe(true);
  });

  it('resolves to null on transport failure so the Wall still renders', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(loginBody))
      .mockResolvedValue(jsonResponse({ detail: 'boom' }, 500, 'Server Error'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchLiveKpis()).resolves.toBeNull();
  });
});
