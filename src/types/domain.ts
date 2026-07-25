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
  /**
   * Rainfall intensity, mm/hour (optional — additive, UC-1 weather enhancement).
   * Absent on legacy/mock readings that predate rain support; consumers must
   * treat `undefined` as "no rain data" and never as 0 mm/h implicitly.
   */
  rainMmHr?: number;
}

/**
 * Per-station tide + sea-state reading, keyed to a fixed monitoring point
 * (terminal, pilot boarding ground, anchorage). One row per station in the
 * Tide & Sea State overlay/table. Production source is INCOIS OSF; the interim
 * live source is Open-Meteo Marine (labelled as such via the TIDE SourceBadge).
 */
export interface TideStation {
  /** Stable station id, e.g. 'TS-NSICT'. */
  STATION_ID: string;
  /** Human label, e.g. 'NSICT Terminal'. */
  NAME: string;
  LAT: number;
  LON: number;
  /** Tide height above chart datum, metres. */
  tideM: number;
  /** Tide trend at the reading time — rising / falling / slack. */
  tideTrend: 'rising' | 'falling' | 'slack';
  /** Significant wave height (sea state), metres. */
  seaStateM: number;
  /** Swell height, metres (0 when the source doesn't report it). */
  swellM: number;
  /** Wind speed at the station, knots. */
  windKt: number;
  /** Wind direction, degrees true. */
  windDir: number;
  /** Reading time (epoch ms). */
  TS: number;
}

/** The full set of tide/sea-state stations for one poll of the overlay + table. */
export interface TideStationsReading {
  TS: number;
  stations: TideStation[];
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

/**
 * A shipping line (ocean carrier) in the shared JNPA registry — the master list
 * behind `GET /api/shipping-lines/lines` on the UC-3 backend.
 *
 * Unlike `Vessel` / `Berth` / `BerthingPlanEntry` above, this does NOT mirror an
 * ArcGIS Feature Service schema, so it follows the camelCase convention used by
 * the other non-Feature-Service types here (`WeatherReading`,
 * `ArrivalsDeparturesBlock`, the prediction fields) rather than UPPER_SNAKE.
 * Timestamps are epoch ms, matching every other time field in this file.
 */
export interface ShippingLine {
  /** Carrier code as it appears in the source advance lists, e.g. 'KMD'. */
  lineCode: string;
  /**
   * Display name. The backend column `line_name` is currently ALWAYS null — the
   * importer upserts `line_code` only — so this falls back to `lineCode`. It is
   * therefore never null here, and a code showing where a name is expected is
   * correct behaviour, not missing data.
   */
  lineName: string;
  /** How the code was discovered, e.g. 'ADVANCE_LIST'. */
  source: string;
  /** First import that produced this code (epoch ms; 0 when unparseable). */
  firstSeen: number;
  /** Most recent import touching this code (epoch ms; 0 when unparseable). */
  lastSeen: number;
  /** Advance-list container rows attributed to this carrier. */
  containerCount: number;
}

/**
 * Dashboard counts for the Shipping Lines layer, from `GET /api/shipping-lines/summary`
 * (the `totals` block). Every field is a count (0 against an empty backend). camelCase +
 * epoch-agnostic, matching the ShippingLine convention above.
 */
export interface ShippingLinesSummary {
  /** Import-ledger files processed. */
  files: number;
  /** IAL/EAL advance-list line items. */
  advanceContainers: number;
  /** Distinct container numbers across the advance lists. */
  distinctContainers: number;
  /** EDO / CODECO delivery orders. */
  deliveryOrders: number;
  /** Carrier codes in the registry. */
  shippingLines: number;
  /** Advance-list rows carrying a Bill of Lading. */
  withBl: number;
  /** Import files that failed. */
  failedFiles: number;
}

/* ==========================================================================
 * UC-1 Marine — vessel CALLS (UC-3 backed, `core.vessel_call`).
 *
 * A vessel CALL is a port VISIT (one row per arrival→departure), sourced from
 * the NLP-Marine PCS message family (CALINF → BERMAN → BERALT/PLTMEM → VESARR →
 * VESDEP → CALINV) and normalised by the UC-3 backend.
 *
 * This is a DIFFERENT entity from `Vessel` above: `Vessel` is live AIS/simulated
 * telemetry (position, SOG/COG, nav status) driving the 3D scene and the
 * simulator; `VesselCall` is scheduling/actuals reference data with no position.
 * They are NOT joinable today — a call carries IMO/VCN, a Vessel carries MMSI —
 * so the two must never be merged into one table or one feed.
 *
 * Convention (same as ShippingLine): camelCase fields, timestamps as epoch ms
 * with 0 meaning "unknown/absent", never null.
 * ========================================================================== */

/** One vessel call (port visit). Mirrors `core.vessel_call`. */
export interface VesselCall {
  /** Surrogate key; the only field the UI can reliably key on. */
  callId: number;
  /** Full PCS Vessel Call Number, e.g. 'INNSA1BM0R3119'. '' when not yet assigned. */
  vcn: string;
  /** Short VIA form, e.g. 'S0561'. Recycles across years — NOT unique. */
  viaNo: string;
  /** IMO number. '' when the call is not yet linked to a vessel master row. */
  imoNo: string;
  vesselName: string;
  voyageNo: string;
  rotationNo: string;
  /** FK to the terminal dimension; null until reference resolution runs. */
  terminalId: number | null;
  /** FK to the berth dimension; null until a berth is allotted/resolved. */
  berthId: number | null;
  purpose: string;
  /** Free-text lifecycle state — the backend deliberately imposes no vocabulary. */
  status: string;
  /** Linked customs manifest number, when known. */
  igmNo: number | null;
  sourceNote: string;
  /** Estimated: arrival / berthing / departure (epoch ms; 0 = unknown). */
  eta: number;
  etb: number;
  etd: number;
  /** Actual: arrival / completion-of-ops / departure (epoch ms; 0 = unknown). */
  ata: number;
  atc: number;
  atd: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * One fine-grained actual on a call (anchored, pilot boarded, all fast, sailed…).
 * The backend permits REPEATED event types at different timestamps (shifting, a
 * second anchoring), so consumers must order by `eventTs` and never assume a
 * milestone appears at most once.
 */
export interface VesselCallEvent {
  eventId: number;
  callId: number;
  /** e.g. 'ANCHORED' | 'PILOT_BOARDED' | 'ALL_FAST' | 'SAILED'. Free-text. */
  eventType: string;
  /** Epoch ms; 0 = unparseable (the backend requires this column, so 0 is a red flag). */
  eventTs: number;
  berthId: number | null;
  sourceFile: number | null;
  createdAt: number;
}

/** Aggregate KPIs over the vessel-call set (UC-1 turnaround / pre-berthing delay). */
export interface MarineCallStats {
  total: number;
  withVcn: number;
  withoutVcn: number;
  arrived: number;
  inPort: number;
  opsCompleted: number;
  departed: number;
  terminals: number;
  /** Mean (atd − ata) in hours; null when no call has both actuals. */
  avgTurnaroundHours: number | null;
  /**
   * Mean (ata − eta) in hours; null when unavailable. MAY BE NEGATIVE — a vessel
   * arriving ahead of its ETA is real signal, not an error.
   */
  avgPreBerthDelayHours: number | null;
  byStatus: { status: string; count: number }[];
  byTerminal: { terminalId: number | null; count: number; inPort: number }[];
}

/** One row of the Marine CSV import ledger (`core.marine_import_files`). */
export interface MarineUploadFile {
  id: number;
  filename: string;
  fileHash: string;
  /** 'CSV' today; the ledger allows XLS/XLSX/PDF for later formats. */
  physicalFormat: string;
  uploadedBy: string;
  /** 'PENDING' | 'SUCCESS' | 'PARTIAL' | 'FAILED' | 'SKIPPED_DUPLICATE'. */
  status: string;
  totalRows: number;
  successRows: number;
  failedRows: number;
  duplicateRows: number;
  /** 'UPLOAD' (interactive) | 'DIRECTORY' (CLI importer). */
  source: string;
  errorDetail: string;
  createdAt: number;
  updatedAt: number;
}

/** One per-row parse/validation error attached to an upload. */
export interface MarineUploadRowError {
  id: number;
  /** 1-based source row; null for file-level (structural) errors. */
  rowNumber: number | null;
  errorMessage: string;
  rawData: string;
  createdAt: number;
}

/* ==========================================================================
 * UC-1 Marine — PILOTAGE movements (UC-3 backed, `core.pilotage`).
 *
 * One pilot-card movement (INWARD / OUTWARD / SHIFTING) from Pilot_card_data.xlsx,
 * ingested through the shared marine upload endpoints. Marine-side ACTUALS (pilot
 * boarded / first line / all fast / disembark), distinct from the vessel-call spine
 * and from live AIS. camelCase + epoch-ms (0 = unknown), never null, matching the
 * other UC-3 connectors. Sheet-specific columns are preserved verbatim in `extras`.
 * ========================================================================== */
export interface Pilotage {
  pilotageId: number;
  /** INWARD | OUTWARD | SHIFTING (the source sheet name). */
  movementType: string;
  /** Linked vessel call when resolvable by VIA; null otherwise. */
  callId: number | null;
  viaNo: string;
  imoNo: string;
  vesselName: string;
  /** Pilot roster code (e.g. 'JP 91'). */
  pilotCode: string;
  vesselCondition: string;
  fromBerthId: number | null;
  toBerthId: number | null;
  draftFwdM: number | null;
  draftAftM: number | null;
  /** Marine actuals (epoch ms; 0 = unknown). */
  pilotBoardedAt: number;
  firstLineAt: number;
  allFastAt: number;
  pilotDisembarkedAt: number;
  berthVacatedAt: number;
  anchorDownAt: number;
  anchorUpAt: number;
  submittedAt: number;
  /** Sheet-specific columns not promoted to canonical fields (verbatim). */
  extras: Record<string, unknown>;
  importFileId: number | null;
}

/* ==========================================================================
 * UC-1 Marine — PORT CRAFT register (UC-3 backed, `core.port_craft`).
 *
 * The static tug/launch fleet REGISTER from Details_of_Port_Crafts.pdf (particulars:
 * LOA, bollard pull, owner, engines), ingested via the shared marine upload endpoints.
 * DISTINCT from `PortCraftUnit` above — that is live-ops telemetry (status / assigned
 * MMSI / response time) from the mock adapter; this is the reference register. The two
 * are never merged. camelCase; numeric particulars are null when the PDF omits them.
 * ========================================================================== */
export interface PortCraft {
  craftId: number;
  name: string;
  /** Tug | Launch | Pilot Launch | VIP Launch | … */
  craftType: string;
  ownedOrHired: string;
  ownerName: string;
  /** As printed — mixed 'Apr-18' / '2020'. */
  yearBuilt: string;
  loaM: number | null;
  breadthM: number | null;
  draftM: number | null;
  mainEngines: string;
  bollardPullT: number | null;
  designSpeedKn: number | null;
  /** Raw parsed row + any unparsed remainder (never-drop-client-data). */
  extras: Record<string, unknown>;
}

/* ==========================================================================
 * UC-1 Marine — SEA CHANNEL geometry (UC-3 backed, `core.sea_channel`).
 *
 * A JNPA navigation channel / anchorage / berth-pocket polygon from the
 * JNPA_Sea_Channels ESRI shapefile, ingested via the shared marine upload endpoints.
 * Geometry is GeoJSON reprojected to WGS84 (EPSG:4326) at parse time — the DUKC /
 * tidal-window static overlay. camelCase; numeric fields null when the source omits.
 * ========================================================================== */
export interface SeaChannelGeometry {
  type: 'Polygon';
  /** WGS84 rings: [[[lon, lat], …], …]. */
  coordinates: number[][][];
}

export interface SeaChannel {
  channelId: number;
  name: string;
  sectionLabel: string;
  areaHa: number | null;
  lengthM: number | null;
  /** GeoJSON Polygon (WGS84), or null if the record carried no geometry. */
  geometry: SeaChannelGeometry | null;
}

/* ==========================================================================
 * Berthing Reports (UC-III module 7, UC-3 backed, `jnpa.berthing_reports`).
 *
 * The reported per-terminal berthing vessel-call for the five JNPA container terminals
 * (APMT / BMCT / NSFT / NSICT / NSIGT), parsed from the daily terminal reports and
 * ingested through the Berthing Data-Upload endpoints. This is the ACTUALS layer
 * (EXPECTED → … → DEPARTED), DISTINCT from the forward-looking `BerthingPlanEntry`
 * 5-Day plan above — the two are never merged. camelCase; timestamps are epoch ms
 * (0 = unknown), text fields '' rather than null, matching the other UC-3 connectors.
 * ========================================================================== */
export interface BerthingReport {
  id: number;
  /** APMT | BMCT | NSFT | NSICT | NSIGT. */
  terminal: string;
  vesselName: string;
  /** Absent in every source file today — kept for forward-compatibility ('' when unknown). */
  imoNumber: string;
  /** JNPA rotation / VIA no (e.g. S0561). */
  voyageNumber: string;
  shippingLine: string;
  /** NSFT reports carry no berth column → '' there. */
  berthNumber: string;
  /** EXPECTED | ARRIVED | BERTH_ASSIGNED | BERTHING_STARTED | CARGO_OPERATION | COMPLETED | DEPARTED. */
  status: string;
  sourceFile: string;
  /** Lifecycle timestamps (epoch ms; 0 = unknown). */
  eta: number;
  ata: number;
  berthingTime: number;
  departureTime: number;
  cargoOperationStart: number;
  cargoOperationEnd: number;
  createdAt: number;
  updatedAt: number;
}

/** Aggregate KPIs over the berthing-report set (per-terminal counts + berth time). */
export interface BerthingStats {
  total: number;
  expected: number;
  arrived: number;
  berthed: number;
  completed: number;
  departed: number;
  terminals: number;
  /** Mean (departure − ata) in hours; null when no call has both. */
  avgBerthHours: number | null;
  byTerminal: { terminal: string; count: number; berthed: number }[];
}
