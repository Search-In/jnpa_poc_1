/**
 * Marine state propagation bus — one signal, every dependent view.
 *
 * THE PROBLEM IT SOLVES
 * ---------------------
 * A manual pilot or craft action writes to the backend, and the backend recomputes the
 * effective lifecycle for that call. But this app has no query cache: `useAdapterQuery`
 * refetches only when its DEPENDENCY ARRAY changes. So the screen that issued the
 * mutation re-rendered from its own local state while Vessel Calls, the Timeline, Marine
 * State and Port Craft kept showing whatever they last fetched — correct data, fetched
 * before the write. The operator saw two different truths until they hit refresh.
 *
 * HOW IT WORKS
 * ------------
 * A monotonic version counter. Views add `useMarineStateVersion()` to their deps; a
 * mutation calls `propagateMarineStateUpdate()`; every subscribed query re-runs.
 *
 * WHY NOT A CACHE LIBRARY
 * -----------------------
 * React Query / SWR would give per-key invalidation, but adding one means rewriting every
 * marine query and re-testing their loading and error paths. The dependency array is the
 * invalidation mechanism this codebase already has — this makes it addressable instead of
 * replacing it. Nothing about `useAdapterQuery` changes, so no existing view is touched
 * except to add one dep.
 *
 * DELIBERATELY COARSE
 * -------------------
 * One counter invalidates every marine view rather than only the affected call. Marine
 * lifecycle is cross-cutting — a single pilot boarding moves the call's pilot state, its
 * port-craft eligibility, the Timeline and the fleet-wide demand counts — so a per-call
 * key would have to be joined to most views anyway. A handful of refetches on an operator
 * action is the right trade against the risk of a view that silently misses its key.
 *
 * NOT for imported data: uploads already refresh via the App shell's `vesselCallUploadKey`
 * remount, which predates this and is left exactly as it is.
 */
import { create } from 'zustand';

interface MarineStateBus {
  /** Bumped on every mutation. The only value consumers read. */
  version: number;
  bump: () => void;
}

const useBus = create<MarineStateBus>((set, get) => ({
  version: 0,
  bump: () => set({ version: get().version + 1 }),
}));

/**
 * Subscribe a query to marine state changes.
 *
 * Put the result in the `useAdapterQuery` dependency array:
 *
 *     const v = useMarineStateVersion();
 *     const q = useAdapterQuery(() => fetchVesselCallsPage(...), [page, v]);
 *
 * A component that does not call this is simply not refreshed — subscription is opt-in
 * and visible at the call site, so nothing refetches by accident.
 */
export function useMarineStateVersion(): number {
  return useBus((s) => s.version);
}

/**
 * Announce that marine lifecycle state changed on the backend.
 *
 * Call AFTER the mutation has been confirmed — never optimistically. Every subscribed
 * view then refetches and reads the backend's own recomputed lifecycle, so a manual
 * assignment propagates exactly the way an imported pilot memo does. This function is the
 * single place that knowledge lives; callers do not name the views they affect.
 */
export function propagateMarineStateUpdate(): void {
  useBus.getState().bump();
}

/** Test seam — resets the counter between cases. */
export function __resetMarineStateBus(): void {
  useBus.setState({ version: 0 });
}
