/**
 * Domain types for the JNPA Vessel Traffic Management & Optimisation dashboard.
 *
 * These mirror the Hosted Feature Layer / Stream Layer field schemas one-to-one
 * (see `src/types/schema.ts` for the matching ArcGIS field definitions). Field
 * names are kept UPPER_SNAKE to match what the Feature Service returns so the
 * `ArcGISAdapter` can map attributes with zero renaming.
 */

/** Navigation status drives vessel symbology on the map. */
export type NavStatus =
  | 'underway'
  | 'anchored'
  | 'approaching'
  | 'berthing'
  | 'moored';

/** Port craft categories tracked for utilisation / response KPIs. */
export type CraftType = 'pilot' | 'tug' | 'mooring';

/** Lifecycle state shared by berths and berthing-plan windows. */
export type BerthStatus = 'available' | 'occupied' | 'reserved' | 'maintenance';

export type PlanStatus = 'scheduled' | 'active' | 'completed' | 'cancelled';

export type CraftStatus = 'idle' | 'deployed' | 'returning' | 'maintenance';

/**
 * Live vessel position — one record per AIS update.
 * Maps to the **Vessels (stream)** layer.
 */
export interface Vessel {
  MMSI: string;
  VESSEL_NAME: string;
  VESSEL_TYPE: string;
  NAV_STATUS: NavStatus;
  /** Speed over ground, knots. */
  SOG: number;
  /** Course over ground, degrees true. */
  COG: number;
  /** Heading, degrees true (may differ from COG). */
  HEADING: number;
  LAT: number;
  LON: number;
  /** Estimated time of arrival (epoch ms), if reported / predicted. */
  ETA: number | null;
  /** Assigned berth, if any. */
  BERTH_ID: string | null;
  /** Position fix time (epoch ms). */
  TIMESTAMP: number;
  /**
   * Provenance of this position: 'live' = a real AIS fix from aisstream.io;
   * 'mock' (or undefined) = the deterministic simulated fleet. Lets the map/feed
   * badge real vessels so the twin never passes simulated traffic off as live.
   */
  SOURCE?: 'mock' | 'live';
}

/** A berth (quay position). Maps to the **Berths** layer. */
export interface Berth {
  BERTH_ID: string;
  BERTH_NAME: string;
  TERMINAL: string;
  LENGTH_M: number;
  DRAFT_M: number;
  STATUS: BerthStatus;
  /** Polygon ring [[lon, lat], ...] in WGS84. */
  GEOM: number[][];
}

/**
 * Scheduled vs actual berthing window — the source for the gantt and for
 * pre-berthing / pre-sailing delay computation.
 * Maps to the **BerthingPlan** layer.
 */
export interface BerthingPlanEntry {
  PLAN_ID: string;
  BERTH_ID: string;
  MMSI: string;
  VESSEL_NAME: string;
  /** Planned alongside start (epoch ms). */
  PLANNED_START: number;
  /** Planned departure (epoch ms). */
  PLANNED_END: number;
  /** Actual time berthed / ATB (epoch ms), null until it happens. */
  ACTUAL_START: number | null;
  /** Actual time departed / ATD (epoch ms), null until it happens. */
  ACTUAL_END: number | null;
  STATUS: PlanStatus;
}

/** Pilot / tug / mooring craft. Maps to the **PortCraft** layer. */
export interface PortCraftUnit {
  CRAFT_ID: string;
  TYPE: CraftType;
  STATUS: CraftStatus;
  /** MMSI of the vessel currently served, if any. */
  ASSIGNED_MMSI: string | null;
  /** When the craft was deployed for the current job (epoch ms). */
  DEPLOYED_AT: number | null;
  /** Response time for the current/last job, minutes. */
  RESPONSE_MIN: number | null;
}

/**
 * A persisted KPI snapshot row — feeds trend lines without recomputation.
 * Maps to the **KPISnapshots** layer.
 */
export interface KpiSnapshot {
  /** Snapshot time (epoch ms). */
  TS: number;
  PRE_BERTH_DELAY: number;
  PRE_SAIL_DELAY: number;
  AVG_TAT: number;
  JIT_PCT: number;
  FORECAST_ACC: number;
  BERTH_OCC: number;
  ANCHORED: number;
  APPROACHING: number;
}

/** Weather / sea-state reading for the weather panel + what-if. */
export interface WeatherReading {
  TS: number;
  /** Wind speed, knots. */
  windKt: number;
  /** Wind direction, degrees true. */
  windDir: number;
  /** Significant wave height, metres. */
  seaStateM: number;
  /** Visibility, nautical miles. */
  visibilityNm: number;
  /** Tide height above chart datum, metres. */
  tideM: number;
}

/** An ETA prediction paired with the eventual actual, for accuracy KPI. */
export interface PredictionPoint {
  MMSI: string;
  VESSEL_NAME: string;
  /** Predicted ETA (epoch ms). */
  predictedEta: number;
  /** Actual time of arrival (epoch ms), null until the vessel arrives. */
  actualAta: number | null;
}

/** Arrivals + departures counted into a time block, for the grouped bar. */
export interface ArrivalsDeparturesBlock {
  /** Block start (epoch ms). */
  blockStart: number;
  /** Human label e.g. "00:00–04:00". */
  label: string;
  arrivals: number;
  departures: number;
}
