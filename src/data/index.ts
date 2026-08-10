/**
 * Adapter selector — the one place the app obtains its `DataAdapter`.
 *
 * `VITE_DATA_MODE=mock` (default) → Uc3Adapter when `VITE_UC3_ENABLED`, else MockAdapter.
 * `VITE_DATA_MODE=live`           → ArcGISAdapter (Stream/Feature Layers).
 * `VITE_DATA_MODE=hybrid`         → MockAdapter + real AIS composited on top.
 *
 * `createBaseAdapter` falls through to MockAdapter for any other value. That
 * fallback is only safe because `resolveDataMode` (src/data/dataMode.ts) has
 * already rejected unrecognised values — at build time in vite.config.ts, and
 * loudly at runtime via `env.dataModeWarning`. Without that gate the fallthrough
 * silently serves invented vessels as if the configuration had worked.
 *
 * THERE IS NO `uc3` DATA_MODE value (rejected by `resolveDataMode`). UC-3 is
 * orthogonal and switched by `VITE_UC3_ENABLED`. The map/feed source is a second
 * switch: `VITE_UC3_DERIVED_VESSELS` (default true) selects corpus DERIVED
 * positions (UC1-011); set false to keep the mock fleet while UC-3 stays on for
 * Live AIS + marine screens — the production-style combo.
 *
 * The whole UI imports `getAdapter()` from here and nothing else from `data/`,
 * so swapping modes never touches a component.
 */

import { env } from './config';
import { MockAdapter } from './MockAdapter';
import { ArcGISAdapter } from './ArcGISAdapter';
import { LiveOverlayAdapter } from './LiveOverlayAdapter';
import { ResilientCorpusAdapter } from './ResilientCorpusAdapter';
import { SimAdapter } from '@/sim/SimAdapter';
import type { DataAdapter } from './types';
import type { DataMode } from './dataMode';

let singleton: DataAdapter | null = null;

/**
 * Build the base adapter for the mode (without the simulator overlay).
 *   mock   → ResilientCorpusAdapter when UC-3 + derived vessels;
 *            otherwise MockAdapter (offline / production-style demo fleet).
 *   live   → ArcGISAdapter (Stream/Feature Layers only).
 *   hybrid → MockAdapter with real aisstream.io vessels composited on top.
 */
export function createBaseAdapter(mode: DataMode = env.dataMode): DataAdapter {
  if (mode === 'live') return new ArcGISAdapter();
  if (mode === 'hybrid') return new LiveOverlayAdapter(new MockAdapter());
  // UC1-011: corpus vessel-states → map with SOURCE:'derived' provenance.
  // Opt out with VITE_UC3_DERIVED_VESSELS=false to keep the mock fleet.
  if (env.uc3.enabled && env.uc3.derivedVessels) return new ResilientCorpusAdapter();
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
