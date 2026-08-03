/**
 * Shared UI state for the live-AIS overlay: whether it is on, and the status of
 * the last poll (so the toolbar chip, the 2D map and the 3D scene all agree).
 *
 * Store-driven for the same reason as tideFieldStore: only ONE of the two map
 * renderers is mounted at a time, and the toggle must survive flipping between
 * them — a local useState in either component would reset on every 2D/3D switch.
 *
 * The polling itself lives in `useLiveVessels`, which writes the status fields
 * here; nothing else should call the setters.
 */
import { create } from 'zustand';

interface LiveVesselState {
  /** Operator toggle — when true the map replaces the simulated fleet. */
  enabled: boolean;
  /** A fetch is in flight (only the FIRST is shown as loading; polls are silent). */
  loading: boolean;
  /** Vessels rendered by the last successful poll. */
  count: number;
  /** `Date.now()` of the last successful poll; null before the first. */
  lastUpdated: number | null;
  /** Message from the last failed poll; null while healthy. */
  error: string | null;
  setEnabled: (v: boolean) => void;
  toggle: () => void;
  setLoading: (v: boolean) => void;
  /** Record a successful poll (clears any previous error). */
  setResult: (count: number, at: number) => void;
  setError: (message: string) => void;
}

export const useLiveVesselStore = create<LiveVesselState>((set) => ({
  // Off by default: the live feed is a deliberate operator action, and leaving
  // it off keeps first load fully offline-capable (spec: mock mode makes no
  // backend call unless asked).
  enabled: false,
  loading: false,
  count: 0,
  lastUpdated: null,
  error: null,
  setEnabled: (enabled) =>
    // Turning it off resets the status so a stale count/error can never be shown
    // next to a hidden layer.
    set(enabled ? { enabled } : { enabled, loading: false, count: 0, lastUpdated: null, error: null }),
  toggle: () =>
    set((s) =>
      s.enabled
        ? { enabled: false, loading: false, count: 0, lastUpdated: null, error: null }
        : { enabled: true },
    ),
  setLoading: (loading) => set({ loading }),
  setResult: (count, at) => set({ count, lastUpdated: at, error: null, loading: false }),
  setError: (error) => set({ error, loading: false }),
}));

// Dev only. A Vite hot update re-executes the CHANGED modules; everything else,
// including this store, keeps its state — so an overlay switched on before an
// edit stays on afterwards, across what looks like a fresh start, and the
// feature appears to default to on. (React Fast Refresh preserves component
// state too, so App's mount-time reset does not necessarily re-run.) Turning it
// off with each update keeps "off unless the operator asked for it" true in dev
// as well as in a real page load. No-op in a production build: `import.meta.hot`
// is undefined and this is dropped.
if (import.meta.hot) {
  import.meta.hot.on('vite:beforeUpdate', () => {
    useLiveVesselStore.getState().setEnabled(false);
  });
}
