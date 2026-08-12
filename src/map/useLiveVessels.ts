/**
 * useLiveVessels — the map's view of the shared live-AIS feed.
 *
 * The polling itself no longer lives here. It moved to `liveVesselStore`, which runs ONE
 * timer for every consumer: this hook and the Vessels ▸ AIS Feed ▸ Live table used to hold
 * separate timers started at different moments, so the connector's in-flight promise
 * almost never merged them and the browser fetched the same rows twice per interval.
 *
 * What remains here is the map's SUBSCRIPTION: join the feed while the overlay is on, drop
 * it when the overlay goes off or the renderer unmounts. The store stops the timer once
 * its last subscriber leaves, so switching the overlay off ends the polling only when
 * nobody else — notably the Live table — is still reading it.
 */
import { useEffect } from 'react';
import { env } from '@/data/config';
import { acquireLiveFeed, useLiveVesselStore } from './liveVesselStore';
import type { LiveVessel } from '@/types/domain';

export interface LiveVesselFeed {
  /** Latest positions; empty while off, before the first poll, or after a failure. */
  vessels: LiveVessel[];
  /** True while the overlay is on AND the feed is configured. */
  active: boolean;
}

/**
 * Subscribe the map to the live feed while its overlay is enabled.
 *
 * @returns the current positions and whether the overlay is actually running
 *          (it is not when UC-3 or the feed is switched off in env).
 */
export function useLiveVessels(): LiveVesselFeed {
  const enabled = useLiveVesselStore((s) => s.enabled);
  const vessels = useLiveVesselStore((s) => s.vessels);

  // A toggle the env has disabled must never poll — the button is hidden in
  // that case, but the guard keeps the hook honest for any other caller.
  const active = enabled && env.liveAis.enabled && env.uc3.enabled;

  useEffect(() => {
    if (!active) return;
    return acquireLiveFeed();
  }, [active]);

  // While inactive the map must draw nothing, even though the store may still hold a
  // current picture for the table. The overlay reflects ITS OWN toggle, not the feed's
  // liveness — that separation is the whole point of the shared poller.
  return { vessels: active ? vessels : [], active };
}
