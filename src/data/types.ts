/**
 * The single data-access contract for the whole UI.
 *
 * HARD RULE: the UI must never call AIS / Feature Service APIs directly. Every
 * component talks only to a `DataAdapter`. Two interchangeable implementations
 * sit behind this interface — `MockAdapter` (offline) and `ArcGISAdapter`
 * (live) — selected at runtime by `VITE_DATA_MODE`.
 */

import type {
  ArrivalsDeparturesBlock,
  Berth,
  BerthingPlanEntry,
  KpiSnapshot,
  PortCraftUnit,
  PredictionPoint,
  TideStationsReading,
  Vessel,
  WeatherReading,
} from '@/types/domain';
import type { KpiBundle } from '@/types/kpi';

/** Unsubscribe handle returned by streaming subscriptions. */
export type Unsubscribe = () => void;

/** A batch of vessel positions delivered to a stream subscriber. */
export type VesselBatch = Vessel[];

export type VesselListener = (vessels: VesselBatch) => void;

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error';

export type ConnectionListener = (state: ConnectionState) => void;

/**
 * Window selector for time-series queries. Either an explicit [from, to]
 * (epoch ms) or a rolling lookback in hours ending "now".
 */
export interface TimeWindow {
  from?: number;
  to?: number;
  /** Rolling lookback in hours; ignored if `from` is set. */
  lastHours?: number;
}

/** Inputs for the What-If recompute stub. */
export interface WhatIfScenario {
  /** Delay a specific vessel's arrival by N hours. */
  delayVesselMmsi?: string;
  delayHours?: number;
  /** Reassign a vessel to a different berth. */
  shiftToBerthId?: string;
  /** Apply a weather penalty (0–1) that scales delays. */
  weatherSeverity?: number;
}

/** Result of a What-If recompute — the affected KPIs, before/after. */
export interface WhatIfResult {
  jitPctBefore: number;
  jitPctAfter: number;
  avgTatBefore: number;
  avgTatAfter: number;
  note: string;
}

/**
 * The data adapter every screen depends on. Implementations must be safe to
 * construct without credentials (mock) and must surface errors as rejected
 * promises / `error` connection state rather than throwing synchronously.
 */
export interface DataAdapter {
  /** Human label for the active mode, shown in the header. */
  readonly mode: 'mock' | 'live';

  /**
   * Subscribe to live vessel positions. Calls `onBatch` with the full current
   * set on each tick. Returns an unsubscribe handle. `onState` (optional)
   * reports connection lifecycle for the live status dot.
   */
  subscribeVessels(onBatch: VesselListener, onState?: ConnectionListener): Unsubscribe;

  /** Current berths (one-shot). */
  getBerths(): Promise<Berth[]>;

  /** Berthing plan entries overlapping the window (defaults to next 24h). */
  getBerthPlan(window?: TimeWindow): Promise<BerthingPlanEntry[]>;

  /** Computed headline KPI bundle (8 cards). */
  getKPIs(): Promise<KpiBundle>;

  /** Arrivals/departures grouped into time blocks over the window. */
  getArrivalsDepartures(window?: TimeWindow): Promise<ArrivalsDeparturesBlock[]>;

  /** Delay trend series (pre-berthing or pre-sailing) over the window. */
  getDelaySeries(
    kind: 'preBerthing' | 'preSailing',
    window?: TimeWindow
  ): Promise<KpiSnapshot[]>;

  /** ETA prediction-vs-actual points for the accuracy overlay. */
  getPrediction(window?: TimeWindow): Promise<PredictionPoint[]>;

  /** Pilot/tug/mooring craft for the utilisation widget. */
  getPortCraft(): Promise<PortCraftUnit[]>;

  /** Latest weather/sea-state reading. */
  getWeather(): Promise<WeatherReading>;

  /**
   * Per-station tide + sea-state readings for the Tide & Sea State overlay/table.
   * Production source INCOIS OSF; interim live source Open-Meteo Marine.
   */
  getTideStations(): Promise<TideStationsReading>;

  /** Persisted KPI snapshots for trend charts over the window. */
  getKpiHistory(window?: TimeWindow): Promise<KpiSnapshot[]>;

  /** Recompute KPIs under a hypothetical scenario (What-If stub). */
  runWhatIf(scenario: WhatIfScenario): Promise<WhatIfResult>;
}
