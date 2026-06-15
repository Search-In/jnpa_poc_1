/**
 * Adapter selector — the one place the app obtains its `DataAdapter`.
 *
 * `VITE_DATA_MODE=mock` (default) → MockAdapter, zero credentials.
 * `VITE_DATA_MODE=live`           → ArcGISAdapter (Stream/Feature Layers).
 *
 * The whole UI imports `getAdapter()` from here and nothing else from `data/`,
 * so swapping modes never touches a component.
 */

import { env } from './config';
import { MockAdapter } from './MockAdapter';
import { ArcGISAdapter } from './ArcGISAdapter';
import type { DataAdapter } from './types';

let singleton: DataAdapter | null = null;

export function createAdapter(mode: 'mock' | 'live' = env.dataMode): DataAdapter {
  return mode === 'live' ? new ArcGISAdapter() : new MockAdapter();
}

/** Shared adapter instance for the running app. */
export function getAdapter(): DataAdapter {
  if (!singleton) singleton = createAdapter();
  return singleton;
}

export type {
  DataAdapter,
  ConnectionState,
  TimeWindow,
  WhatIfScenario,
  WhatIfResult,
  Unsubscribe,
} from './types';
