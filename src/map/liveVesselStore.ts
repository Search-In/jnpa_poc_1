/**
 * The live-AIS feed: ONE poller, one copy of the data, shared by every consumer.
 *
 * Two surfaces read this feed — the map overlay (2D or 3D, only ever one mounted) and the
 * Vessels ▸ AIS Feed ▸ Live table. They used to poll INDEPENDENTLY: two timers started at
 * different moments, so the in-flight promise in `data/uc3/liveVessels.ts` almost never
 * merged them and the browser made two requests per interval for identical rows.
 *
 * So the polling lives here rather than in a hook, with subscriber counting:
 *
 *   • the FIRST subscriber starts the timer and triggers an immediate fetch;
 *   • every later subscriber joins the same timer and reads the same `vessels` array;
 *   • the LAST to leave stops the timer and clears the picture, so a stale position set
 *     can never outlive the feed that produced it.
 *
 * WHAT SUBSCRIBES, AND WHEN. The map subscribes only while its overlay is `enabled`; the
 * Live table subscribes for as long as it is mounted. That is what makes the two
 * independent: switching the overlay off stops the polling ONLY if nobody has the table
 * open, and having the table open keeps real data flowing with the overlay off.
 *
 * Module-level state, not React state, because it must outlive any single component — a
 * 2D↔3D flip unmounts one renderer and mounts the other, and the feed must not restart.
 */
import { create } from 'zustand';
import { env } from '@/data/config';
import { fetchLiveVessels, isTrackedVessel } from '@/data/uc3/liveVessels';
import type { LiveVessel } from '@/types/domain';

interface LiveVesselState {
  /** Operator toggle — when true the map replaces the simulated fleet. */
  enabled: boolean;
  /** Positions from the last successful poll. Empty until one lands. */
  vessels: LiveVessel[];
  /** A fetch is in flight (only the FIRST is shown as loading; polls are silent). */
  loading: boolean;
  /** `vessels.length`, kept in state so a label can read it without the array. */
  count: number;
  /** `Date.now()` of the last successful poll; null before the first. */
  lastUpdated: number | null;
  /** Message from the last failed poll; null while healthy. */
  error: string | null;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
  setLoading: (v: boolean) => void;
  /** Record a successful poll (clears any previous error). */
  setResult: (vessels: LiveVessel[], at: number) => void;
  setError: (message: string) => void;
  /** Drop the picture — the feed has stopped and nothing may claim it is current. */
  clearFeed: () => void;
}

export const useLiveVesselStore = create<LiveVesselState>((set) => ({
  // Off until something sets it. App decides the session default from env
  // (`liveAisAvailable`); leaving the store itself inert keeps it free of config and
  // makes its behaviour identical under test.
  enabled: false,
  vessels: [],
  loading: false,
  count: 0,
  lastUpdated: null,
  error: null,

  // NOTE the toggle no longer clears the picture. It used to, because the overlay was the
  // only consumer and a hidden layer must not leave a stale count behind. Now the table
  // can still be reading the same feed, so the picture is cleared by the POLLER when its
  // last subscriber leaves (`clearFeed`), not by one consumer changing its mind.
  setEnabled: (enabled) => set({ enabled }),
  toggle: () => set((s) => ({ enabled: !s.enabled })),

  setLoading: (loading) => set({ loading }),
  setResult: (vessels, at) =>
    set({ vessels, count: vessels.length, lastUpdated: at, error: null, loading: false }),
  setError: (error) => set({ error, loading: false }),
  clearFeed: () =>
    set({ vessels: [], count: 0, lastUpdated: null, error: null, loading: false }),
}));

/* ------------------------------------------------------------------ the shared poller */

let timer: ReturnType<typeof setInterval> | null = null;
const subscribers = new Set<symbol>();

/** One poll. Never throws — a failure is reported through the store, not raised. */
async function poll(): Promise<void> {
  try {
    // Aids to navigation and other non-vessel transponders are dropped here, once, so
    // the map and the AIS Feed table cannot disagree about what the feed holds.
    // See isTrackedVessel for what the 'Other' bucket actually contains.
    const vessels = (await fetchLiveVessels()).filter(isTrackedVessel);
    // The feed may have been dropped while this was in flight; writing the result then
    // would repopulate a picture that is meant to be gone.
    if (subscribers.size === 0) return;
    useLiveVesselStore.getState().setResult(vessels, Date.now());
  } catch (err) {
    if (subscribers.size === 0) return;
    useLiveVesselStore
      .getState()
      .setError(err instanceof Error ? err.message : 'Live AIS fetch failed');
  }
}

/**
 * Join the shared feed. Returns the release function — call it on unmount.
 *
 * The first caller starts the timer and fetches immediately, so a newly opened table or a
 * freshly enabled overlay does not wait a full interval for its first picture.
 */
export function acquireLiveFeed(): () => void {
  const key = Symbol('live-feed-subscriber');
  subscribers.add(key);

  if (subscribers.size === 1) {
    useLiveVesselStore.getState().setLoading(true);
    void poll();
    timer = setInterval(() => void poll(), env.liveAis.pollMs);
  }

  return () => {
    subscribers.delete(key);
    if (subscribers.size > 0) return;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    useLiveVesselStore.getState().clearFeed();
  };
}

/** Live subscriber count. Diagnostics and tests only. */
export function liveFeedSubscriberCount(): number {
  return subscribers.size;
}

/** Stop the feed and forget every subscriber. Test seam only. */
export function resetLiveFeed(): void {
  subscribers.clear();
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  useLiveVesselStore.getState().clearFeed();
}
