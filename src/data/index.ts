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
import { LiveOverlayAdapter } from './LiveOverlayAdapter';
import { Uc3Adapter } from './Uc3Adapter';
import { SimAdapter } from '@/sim/SimAdapter';
import type { DataAdapter } from './types';

type DataMode = 'mock' | 'live' | 'hybrid' | 'uc3';

let singleton: DataAdapter | null = null;

/**
 * Build the base adapter for the mode (without the simulator overlay).
 *   mock   → MockAdapter (offline).
 *   live   → ArcGISAdapter (Stream/Feature Layers only).
 *   hybrid → MockAdapter with real aisstream.io vessels composited on top.
 *   uc3    → Uc3Adapter (ingested JNPA corpus via the UC-3 gateway) with the
 *            aisstream.io overlay on top — real records below, real AIS above.
 */
export function createBaseAdapter(mode: DataMode = env.dataMode): DataAdapter {
  if (mode === 'live') return new ArcGISAdapter();
  if (mode === 'hybrid') return new LiveOverlayAdapter(new MockAdapter());
  if (mode === 'uc3') return new LiveOverlayAdapter(new Uc3Adapter());
  return new MockAdapter();
}

/**
 * Build the app adapter: the mode's base adapter wrapped in `SimAdapter` so the
 * Simulator page's controls overlay every read. The wrapper is transparent when
 * no override is set, so this is safe as the app-wide default.
 */
export function createAdapter(mode: DataMode = env.dataMode): DataAdapter {
  return new SimAdapter(createBaseAdapter(mode));
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
