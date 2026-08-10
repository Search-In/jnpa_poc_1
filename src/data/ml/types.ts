/**
 * Domain types for the UC-1 AI/ML prediction service (`ml/`, FastAPI :8100).
 *
 * The service answers with the `uc1-dashboard/1.0.0` document its own pipeline
 * produces — the same shape as `ml/out/predictions_dashboard.json` — wrapped in
 * an `adapter` envelope. Two properties of that document drive the typing here:
 *
 *  • **The model blocks are open.** Each of the eight models publishes five to
 *    nine fields, and the set differs per model (M1 carries `net_ukc_m`, M7
 *    carries `pilots_tugs_mooring`). A closed interface per model would have to
 *    be edited every time a model gains a field, and would silently DROP the new
 *    one in the meantime. So a block is `Record<string, ModelFieldValue>` and the
 *    UI renders whatever it is handed.
 *
 *  • **The glossary travels inside the document.** Every non-obvious key has a
 *    one-line explanation in `glossary`, and the service's own self-test fails
 *    the build if a key is added without one. That is what makes generic
 *    rendering honest rather than lazy: no field can reach the screen without a
 *    definition the operator can read.
 *
 * Nothing here is optional-by-convenience: a field is optional only when the
 * service genuinely may omit it (a model that did not run, a port summary block
 * whose model was not requested).
 */

/** A leaf value in a model block. `null` means "the model returned no value". */
export type ModelFieldValue =
  | string
  | number
  | boolean
  | null
  | ModelFieldValue[]
  | { [key: string]: ModelFieldValue };

/** One model's answer for one vessel. Keys vary by model — see the note above. */
export type ModelBlock = Record<string, ModelFieldValue>;

/**
 * How one model input was arrived at. `observed: false` means the adapter
 * SUBSTITUTED a named constant because the AIS feed could not supply the value.
 */
export interface MappingEntry {
  model_input: string;
  value: ModelFieldValue;
  /** 'AIS.DRAUGHT', 'context', 'ASSUMED', … */
  source: string;
  raw: string | null;
  /** The rule that produced the value, in words. */
  rule: string;
  observed: boolean;
}

/**
 * The per-vessel translation ledger.
 *
 * This is the honesty contract of the whole feature: an AIS **position report**
 * carries no draught, no cargo and no ATA, so a prediction from it rests on
 * estimates. `assumptions` names each one. The UI must show it — a NO-GO
 * under-keel clearance computed from an estimated draft is advice, not a
 * clearance.
 */
export interface VesselMapping {
  adapter_version: string;
  mmsi: string;
  vessel: string;
  degraded: boolean;
  derived: MappingEntry[];
  assumptions: string[];
  warnings: string[];
  inputs_observed: number;
  inputs_assumed: number;
}

/** One vessel's full prediction set. */
export interface VesselPrediction {
  /** Adapter-assigned id for this row of the request ("C-0001"). */
  call_id: string;
  vessel: string;
  imo: string;
  voyage: string;
  terminal: string;
  /** Echoed from the request so the UI can join back to the AIS feed. */
  mmsi: string;
  /** 'live' | 'mock' — provenance of the AIS row the prediction was built from. */
  source: string;
  /** True when any model input had to be assumed. */
  degraded: boolean;
  /** The inputs the models actually used, after translation. */
  input: Record<string, ModelFieldValue>;
  /** Where each environmental input came from (tide, depth, queue, distance). */
  data_quality: Record<string, string>;
  /** Row-level caveats, e.g. WAIT_IS_LOWER_BOUND, TIDE_SYNTHETIC. */
  flags: string[];
  /** One entry per model that ran, keyed 'm1_under_keel_clearance' etc. */
  models: Record<string, ModelBlock>;
  mapping: VesselMapping | null;
}

/** Run metadata — what was asked for, what ran, what failed. */
export interface PredictionRun {
  generated_at_utc: string;
  input_file: string;
  vessels: number;
  models_run: string[];
  models_failed: Array<{ model: string; error: string }>;
  wait_model: string | null;
  tide_policy: string | null;
  source?: string;
  vessels_requested?: number;
  vessels_dropped?: number;
  dropped_reason?: string;
}

/** The `uc1-dashboard/1.0.0` document. */
export interface PredictionDashboard {
  schema: string;
  run: PredictionRun;
  /** Model block id → the plain-English question that model answers. */
  model_questions: Record<string, string>;
  /** Field key → one-line definition. Shipped inside the document. */
  glossary: Record<string, string>;
  vessels: VesselPrediction[];
  /** Fleet-level numbers (occupancy, berth plan, JIT savings, craft, risk). */
  port_summary: Record<string, Record<string, ModelFieldValue>>;
}

/** The adapter envelope around the dashboard document. */
export interface PredictionAdapterInfo {
  moduleId: string;
  version: string;
  /** FLEET when the whole feed was scored; SINGLE_VESSEL for a one-hull call. */
  scope: string;
  models_requested: string[];
  max_fleet: number;
  note: string;
}

/** The complete `POST /uc1/webapp/predictions` response. */
export interface PredictionResponse {
  schema: string;
  adapter: PredictionAdapterInfo;
  dashboard: PredictionDashboard;
}

/**
 * Optional port context. Every field is genuinely optional: when one is absent
 * the service applies its own documented fallback (synthetic harmonic tide,
 * anchorage queue derived from occupancy) and reports it in `data_quality`,
 * which is strictly better than the UI inventing a value here.
 */
export interface PredictionContext {
  tide_m?: number;
  wind_kn?: number;
  rain_mm_hr?: number;
  weather?: string;
  channel_depth_m?: number;
  berth_occupancy_pct?: number;
  anchorage_queue?: number;
  distance_nm?: number;
}
