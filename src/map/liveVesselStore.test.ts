import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  acquireLiveFeed,
  liveFeedSubscriberCount,
  resetLiveFeed,
  useLiveVesselStore,
} from './liveVesselStore';
import { resetLiveVesselsInflight } from '@/data/uc3/liveVessels';
import type { LiveVessel } from '@/types/domain';

const vessel = (mmsi: string): LiveVessel => ({
  mmsi,
  vesselName: `V-${mmsi}`,
  imoNo: null,
  lat: 18.9,
  lon: 72.9,
  speedKnots: 8,
  course: 90,
  heading: 90,
  shipTypeCode: 70,
  shipTypeLabel: 'Cargo',
  destination: 'JNPT',
  flag: 'IN',
  length: 200,
  elapsedSeconds: 12,
});

beforeEach(() => {
  resetLiveFeed();
  resetLiveVesselsInflight();
  useLiveVesselStore.getState().setEnabled(false);
  vi.unstubAllGlobals();
});

afterEach(() => {
  resetLiveFeed();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the overlay toggle', () => {
  /**
   * The toggle is the MAP's own concern. It decides whether the overlay draws, and no
   * longer whether the feed runs — the Live table can be reading the same feed with the
   * overlay off, which is why the polling is subscriber-driven instead.
   */
  it('is inert until something sets it, so App owns the session default', () => {
    expect(useLiveVesselStore.getState().enabled).toBe(false);
  });

  it('is shared, so a 2D↔3D flip keeps ONE state rather than two defaults', () => {
    useLiveVesselStore.getState().toggle();
    expect(useLiveVesselStore.getState().enabled).toBe(true);
    expect(useLiveVesselStore.getState().enabled).toBe(true);
  });

  it('turning it off no longer discards the picture', () => {
    // It used to, when the overlay was the only consumer. Clearing here would now blank
    // a table that is still subscribed and still being polled for.
    useLiveVesselStore.getState().setEnabled(true);
    useLiveVesselStore.getState().setResult([vessel('1'), vessel('2')], 1_700_000_000_000);
    useLiveVesselStore.getState().toggle();

    const s = useLiveVesselStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.count).toBe(2);
    expect(s.lastUpdated).toBe(1_700_000_000_000);
  });

  it('a failed poll leaves the overlay on, with the error surfaced', () => {
    useLiveVesselStore.getState().setEnabled(true);
    useLiveVesselStore.getState().setError('502 marinetraffic_fetch_failed');

    const s = useLiveVesselStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.error).toMatch(/502/);
  });
});

describe('the shared poller', () => {
  /** Stub the transport so acquiring the feed performs a real (fake) fetch. */
  const stubFetch = (rows: LiveVessel[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        ({
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () =>
            String(url).endsWith('/auth/login')
              ? { access_token: 'T', role: 'DTCCC_ADMIN', auth_enabled: true }
              : rows.map((v) => ({
                  mmsi: v.mmsi, vessel_name: v.vesselName, imo_no: v.imoNo,
                  lat: v.lat, lon: v.lon, speed_knots: v.speedKnots, course: v.course,
                  heading: v.heading, ship_type_code: v.shipTypeCode,
                  ship_type_label: v.shipTypeLabel, destination: v.destination,
                  flag: v.flag, length: v.length, elapsed_seconds: v.elapsedSeconds,
                })),
        }) as unknown as Response,
      ),
    );

  it('counts subscribers rather than starting a timer per consumer', () => {
    stubFetch([]);
    const releaseMap = acquireLiveFeed();
    const releaseTable = acquireLiveFeed();
    expect(liveFeedSubscriberCount()).toBe(2);

    releaseMap();
    expect(liveFeedSubscriberCount()).toBe(1);
    releaseTable();
    expect(liveFeedSubscriberCount()).toBe(0);
  });

  it('fetches ONCE for two consumers — the bug that motivated the shared poller', async () => {
    stubFetch([vessel('1')]);
    const releaseA = acquireLiveFeed();
    const releaseB = acquireLiveFeed();
    await vi.waitFor(() => expect(useLiveVesselStore.getState().count).toBe(1));

    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(([u]) => !String(u).endsWith('/auth/login'));
    expect(calls).toHaveLength(1);

    releaseA();
    releaseB();
  });

  it('fetches immediately on the first subscribe, not after a full interval', async () => {
    stubFetch([vessel('1'), vessel('2')]);
    const release = acquireLiveFeed();
    await vi.waitFor(() => expect(useLiveVesselStore.getState().vessels).toHaveLength(2));
    expect(useLiveVesselStore.getState().lastUpdated).not.toBeNull();
    release();
  });

  it('keeps polling while ANY subscriber remains — the table outliving the overlay', async () => {
    stubFetch([vessel('1')]);
    const releaseMap = acquireLiveFeed();
    const releaseTable = acquireLiveFeed();
    await vi.waitFor(() => expect(useLiveVesselStore.getState().count).toBe(1));

    releaseMap();                       // operator switches the overlay off
    expect(liveFeedSubscriberCount()).toBe(1);
    expect(useLiveVesselStore.getState().count).toBe(1);   // table still has its data

    releaseTable();
    expect(useLiveVesselStore.getState().count).toBe(0);   // now the feed is gone
  });

  it('clears the picture when the LAST subscriber leaves', async () => {
    stubFetch([vessel('1')]);
    const release = acquireLiveFeed();
    await vi.waitFor(() => expect(useLiveVesselStore.getState().count).toBe(1));

    release();
    const s = useLiveVesselStore.getState();
    expect(s.vessels).toEqual([]);
    expect(s.lastUpdated).toBeNull();
    expect(s.error).toBeNull();
  });

  it('reports a failure through the store rather than throwing at the subscriber', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      ({
        ok: String(url).endsWith('/auth/login'),
        status: String(url).endsWith('/auth/login') ? 200 : 502,
        statusText: 'Bad Gateway',
        json: async () => ({ access_token: 'T', role: 'DTCCC_ADMIN', auth_enabled: true }),
      }) as unknown as Response));

    const release = acquireLiveFeed();
    await vi.waitFor(() => expect(useLiveVesselStore.getState().error).not.toBeNull());
    expect(useLiveVesselStore.getState().loading).toBe(false);
    release();
  });
});
