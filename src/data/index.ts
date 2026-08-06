/**
 * Adapter selector — the one place the app obtains its `DataAdapter`.
 *
 * `VITE_DATA_MODE=mock` (default) → MockAdapter, zero credentials.
 * `VITE_DATA_MODE=live`           → ArcGISAdapter (Stream/Feature Layers).
 * `VITE_DATA_MODE=hybrid`         → MockAdapter + real AIS composited on top.
 *
 * `createBaseAdapter` falls through to MockAdapter for any other value. That
 * fallback is only safe because `resolveDataMode` (src/data/dataMode.ts) has
 * already rejected unrecognised values — at build time in vite.config.ts, and
 * loudly at runtime via `env.dataModeWarning`. Without that gate the fallthrough
 * silently serves invented vessels as if the configuration had worked.
 *
 * UC-3 gateway data is NOT selected here: it is orthogonal to the data mode and
 * switched by VITE_UC3_ENABLED (see the note on `env.uc3` in ./config).
 *
 * The whole UI imports `getAdapter()` from here and nothing else from `data/`,
 * so swapping modes never touches a component.
 */

import { env } from './config';
import { MockAdapter } from './MockAdapter';
import { ArcGISAdapter } from './ArcGISAdapter';
import { LiveOverlayAdapter } from './LiveOverlayAdapter';
import { SimAdapter } from '@/sim/SimAdapter';
import type { DataAdapter } from './types';
import type { DataMode } from './dataMode';

let singleton: DataAdapter | null = null;

/**
 * Build the base adapter for the mode (without the simulator overlay).
 *   mock   → MockAdapter (offline).
 *   live   → ArcGISAdapter (Stream/Feature Layers only).
 *   hybrid → MockAdapter with real aisstream.io vessels composited on top.
 *
 * THERE IS NO `uc3` MODE, by design. UC-3 gateway data — vessel calls, pilotage,
 * bathymetry, performance, the live-AIS overlay — is ORTHOGONAL to VITE_DATA_MODE and
 * switched by VITE_UC3_ENABLED (README, and the note in dataMode.ts). The two are
 * independent on purpose: gateway records are real whether or not the AIS fleet is
 * simulated, and the marine screens read the `data/uc3/*` connectors directly rather
 * than through this adapter seam.
 */
export function createBaseAdapter(mode: DataMode = env.dataMode): DataAdapter {
  if (mode === 'live') return new ArcGISAdapter();
  if (mode === 'hybrid') return new LiveOverlayAdapter(new MockAdapter());
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
