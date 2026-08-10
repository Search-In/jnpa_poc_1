/**
 * Single lightweight global store (Zustand). Holds the live vessel set,
 * connection state, and the latest KPI bundle. All data arrives via the
 * `DataAdapter` — the store never touches AIS/Feature APIs directly.
 */

import { create } from 'zustand';
import type { Vessel } from '@/types/domain';
import type { KpiBundle } from '@/types/kpi';
import { getAdapter, type ConnectionState, type Unsubscribe } from '@/data';
import { applyLiveKpis, fetchLiveKpis } from '@/data/uc3/dashboardKpis';

interface AppState {
  mode: 'mock' | 'live';
  vessels: Vessel[];
  connection: ConnectionState;
  /** Epoch ms of the last vessel batch, for the "updated Ns ago" indicator. */
  lastUpdate: number | null;
  kpis: KpiBundle | null;
  kpiError: string | null;

  /** Begin streaming + initial KPI load. Returns a teardown function. */
  start: () => Unsubscribe;
  refreshKpis: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  mode: getAdapter().mode,
  vessels: [],
  connection: 'connecting',
  lastUpdate: null,
  kpis: null,
  kpiError: null,

  start: () => {
    const adapter = getAdapter();
    const unsub = adapter.subscribeVessels(
      (vessels) => set({ vessels, lastUpdate: Date.now() }),
      (connection) => {
        set({ connection });
        // UC1-042: refresh on connection events (connected / reconnecting recovery).
        if (connection === 'connected') void get().refreshKpis();
      },
    );
    void get().refreshKpis();
    // UC1-042 / UI-041: KPI strip refresh cadence is 60 s (and on connection event).
    const timer = setInterval(() => void get().refreshKpis(), 60_000);
    return () => {
      unsub();
      clearInterval(timer);
    };
  },

  refreshKpis: async () => {
    try {
      const kpis = await getAdapter().getKPIs();
      // Overlay the cards that have a real corpus source (Avg TAT, Berth Occupancy) from
      // the EXISTING /marine/calls/stats and /marine/state/berths endpoints. Cards with no
      // corpus source keep the adapter's value rather than being fabricated, and a failed
      // fetch resolves to null so the Wall renders exactly as it did before.
      set({ kpis: applyLiveKpis(kpis, await fetchLiveKpis()), kpiError: null });
    } catch (err) {
      set({ kpiError: err instanceof Error ? err.message : String(err) });
    }
  },
}));
