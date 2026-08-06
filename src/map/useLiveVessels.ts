/**
 * useLiveVessels — the one polling loop behind the live-AIS overlay, shared by
 * the 2D map and the 3D scene (only one of which is ever mounted).
 *
 * Deliberately NOT built on useAdapterQuery: that hook polls whatever it is
 * given from mount, and this feed must make no request at all until the operator
 * turns the overlay on. The lifecycle here is toggle-driven — fetch immediately
 * on enable, then every `env.liveAis.pollMs` (≥ the gateway's 60 s cache TTL),
 * and stop dead on disable/unmount.
 *
 * The `cancelled` guard matters: without it, toggling off (or switching 2D↔3D)
 * while a fetch is in flight repopulates a layer that should already be empty.
 */
import { useEffect, useState } from 'react';
import { env } from '@/data/config';
import { fetchLiveVessels } from '@/data/uc3/liveVessels';
import { useLiveVesselStore } from './liveVesselStore';
import type { LiveVessel } from '@/types/domain';

export interface LiveVesselFeed {
  /** Latest positions; empty while off, before the first poll, or after a failure. */
  vessels: LiveVessel[];
  /** True while the overlay is on AND the feed is configured. */
  active: boolean;
}

/**
 * Poll the live feed while the overlay is enabled.
 *
 * @returns the current positions and whether the overlay is actually running
 *          (it is not when UC-3 or the feed is switched off in env).
 */
export function useLiveVessels(): LiveVesselFeed {
  const enabled = useLiveVesselStore((s) => s.enabled);
  const setLoading = useLiveVesselStore((s) => s.setLoading);
  const setResult = useLiveVesselStore((s) => s.setResult);
  const setError = useLiveVesselStore((s) => s.setError);
  const [vessels, setVessels] = useState<LiveVessel[]>([]);

  // A toggle the env has disabled must never poll — the button is hidden in
  // that case, but the guard keeps the hook honest for any other caller.
  const active = enabled && env.liveAis.enabled && env.uc3.enabled;

  useEffect(() => {
    if (!active) {
      // Drop the last picture so a re-enable starts from empty rather than
      // flashing minutes-old positions before the first poll lands. Functional
      // update: returning the same empty array avoids a pointless re-render on
      // every mount with the overlay off.
      setVessels((prev) => (prev.length ? [] : prev));
      return;
    }

    let cancelled = false;
    setLoading(true);

    const load = async () => {
      try {
        const next = await fetchLiveVessels();
        if (cancelled) return;
        setVessels(next);
        setResult(next.length, Date.now());
      } catch (err) {
        if (cancelled) return;
        // Keep the last good picture on screen rather than blanking the layer on
        // a transient 502 — the error chip says the data is stale.
        setError(err instanceof Error ? err.message : 'Live AIS fetch failed');
      }
    };

    void load();
    const timer = setInterval(() => void load(), env.liveAis.pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, setLoading, setResult, setError]);

  return { vessels, active };
}
