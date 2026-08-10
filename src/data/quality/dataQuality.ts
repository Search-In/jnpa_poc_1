/**
 * Data Quality Validation — one implementation, shared by every imported dataset.
 *
 * BUSINESS RULE
 * -------------
 * An imported record carrying more than `threshold` missing business-field values is an
 * ANOMALY. The threshold is configurable (currently 2) so a rule change is one constant,
 * not a sweep through the codebase.
 *
 * WHERE THIS RUNS
 * ---------------
 * The VIEW-MODEL layer only. Every UC-3 dataset already passes through a pure `map*`
 * function in `src/data/uc3/` that turns a wire row into a domain object; anomaly status
 * is computed from that domain object on read. Nothing is persisted, no DTO changes, no
 * API changes, and an anomaly can never be written back to the source.
 *
 * WHY FIELD SETS ARE CONFIGURED PER DATASET, NOT INFERRED
 * ------------------------------------------------------
 * This is the whole correctness question. Counting every empty field would classify
 * normal operations as bad data: measured against the live corpus, an identity-only field
 * set flags 941 of 1691 vessel calls, while adding lifecycle actuals (ATA/ATD/ATC/berth)
 * flags 1691 of 1691 — a badge on every row, carrying no information.
 *
 * A field belongs in a set ONLY IF the source document should always carry it. Lifecycle
 * actuals must never be included: a blank ATD on a vessel still alongside is a normal
 * stage, not a defect. That rule is stated in <AnomalyMark> and is preserved here.
 *
 * RELATIONSHIP TO <AnomalyMark>
 * -----------------------------
 * AnomalyMark marks ONE FIELD for a backend-reported correlation failure. This module
 * classifies a WHOLE RECORD on import completeness. Different questions, different marks;
 * neither replaces the other.
 */

/** Strings a source document uses to mean "no value". Compared case-insensitively. */
export const MISSING_PLACEHOLDERS: ReadonlySet<string> = new Set([
  '', '-', '--', '---', 'n/a', 'na', 'null', 'none', 'nil', 'undefined', '#n/a',
]);

/** More than THIS many missing fields makes a record an anomaly. */
export const DEFAULT_ANOMALY_THRESHOLD = 2;

/**
 * Is one value missing?
 *
 * Null, undefined, blank and placeholder strings count. A numeric 0 does NOT — it is a
 * legitimate value (zero moves, zero draft), and treating it as absent would misclassify
 * real data. Epoch-ms 0 is handled by not listing timestamps as business fields at all.
 */
export function isMissingValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return MISSING_PLACEHOLDERS.has(v.trim().toLowerCase());
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** One business field of a dataset: the property to read and how to name it to a user. */
export interface QualityField<T> {
  key: keyof T & string;
  label: string;
}

/** The quality rule for one dataset. */
export interface QualityConfig<T> {
  /** Dataset name, used in the badge tooltip. */
  dataset: string;
  /** Business fields only — never derived, computed, internal or lifecycle-dependent. */
  fields: readonly QualityField<T>[];
  /** Overrides the default when a dataset needs its own tolerance. */
  threshold?: number;
}

/** What was found, for the badge tooltip and for tests. */
export interface QualityResult {
  isAnomaly: boolean;
  missingCount: number;
  /** Human-readable names of the missing fields, in configured order. */
  missingFields: string[];
  threshold: number;
}

/**
 * Assess one record against its dataset's rule.
 *
 * Pure and total: an unknown key simply reads as missing, so a config that drifts from a
 * type shows up as a louder anomaly rather than a crash.
 */
export function assessRecord<T extends object>(
  record: T | null | undefined,
  config: QualityConfig<T>,
): QualityResult {
  const threshold = config.threshold ?? DEFAULT_ANOMALY_THRESHOLD;
  if (!record) {
    return { isAnomaly: true, missingCount: config.fields.length, threshold,
             missingFields: config.fields.map((f) => f.label) };
  }
  const missingFields: string[] = [];
  for (const f of config.fields) {
    if (isMissingValue((record as Record<string, unknown>)[f.key])) {
      missingFields.push(f.label);
    }
  }
  return {
    isAnomaly: missingFields.length > threshold,
    missingCount: missingFields.length,
    missingFields,
    threshold,
  };
}

/** Convenience predicate — the common case. */
export function isAnomalyRecord<T extends object>(
  record: T | null | undefined,
  config: QualityConfig<T>,
): boolean {
  return assessRecord(record, config).isAnomaly;
}

/**
 * Apply the "Show ANOMALY Data" toggle to a list.
 *
 * `show = true` (the default everywhere) returns the list UNCHANGED — same order, same
 * length, same object identities — so enabling the feature cannot alter existing search,
 * sort or pagination behaviour.
 */
export function applyAnomalyFilter<T extends object>(
  rows: readonly T[],
  config: QualityConfig<T>,
  show: boolean,
): T[] {
  if (show) return rows as T[];
  return rows.filter((r) => !isAnomalyRecord(r, config));
}

/** Tooltip text for the badge. Names the fields rather than just counting them. */
export function describeAnomaly(result: QualityResult, dataset: string): string {
  return `${dataset}: ${result.missingCount} required fields missing `
       + `(more than ${result.threshold}) — ${result.missingFields.join(', ')}`;
}
