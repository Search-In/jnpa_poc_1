/**
 * Single lightweight global store (Zustand). Holds the live vessel set,
 * connection state, and the latest KPI bundle. All data arrives via the
 * `DataAdapter` — the store never touches AIS/Feature APIs directly.
 */

import { create } from 'zustand';
import type { Vessel } from '@/types/domain';
import type { KpiBundle } from '@/types/kpi';
import { getAdapter, type ConnectionState, type Unsubscribe } from '@/data';

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
      (connection) => set({ connection })
    );
    void get().refreshKpis();
    // Recompute KPIs periodically; mock + live both support repeated calls.
    const timer = setInterval(() => void get().refreshKpis(), 15_000);
    return () => {
      unsub();
      clearInterval(timer);
    };
  },

  refreshKpis: async () => {
    try {
      const kpis = await getAdapter().getKPIs();
      set({ kpis, kpiError: null });
    } catch (err) {
      set({ kpiError: err instanceof Error ? err.message : String(err) });
    }
  },
}));
