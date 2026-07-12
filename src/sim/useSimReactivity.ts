/**
 * useSimReactivity — the glue that makes the dashboard react to the Simulator
 * page live. Two jobs:
 *
 *  1. Connect the cross-tab BroadcastChannel so a standalone `#/simulator` tab
 *     drives this (dashboard) tab.
 *  2. Refresh the headline KPI bundle in `useAppStore` whenever the sim
 *     `version` bumps (any lever/override change, local or remote), so the KPI
 *     strip + charts update immediately instead of on the 15 s poll.
 *
 * The vessel stream + berth/craft/weather reads react on their own: `SimAdapter`
 * re-emits the vessel batch on every version change, and `useAdapterQuery`-based
 * panels list `useSimVersion()` in their deps.
 */
import { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import { connectSimBroadcast, useSimStore } from './simStore';

/** The current sim mutation counter — drop into `useAdapterQuery` deps. */
export function useSimVersion(): number {
  return useSimStore((s) => s.version);
}

export function useSimReactivity(): void {
  useEffect(() => connectSimBroadcast(), []);

  const version = useSimStore((s) => s.version);
  useEffect(() => {
    void useAppStore.getState().refreshKpis();
  }, [version]);
}
