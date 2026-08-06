/** KPI result types — the shape every KPI function returns. */

/** A single point in a KPI trend series. */
export interface TrendPoint {
  /** Time of the point (epoch ms). */
  ts: number;
  value: number;
}

/**
 * The canonical KPI value object rendered by every KPI card.
 * `deltaPct` is the signed % difference of `value` vs `target`
 * ((value - target) / target * 100); whether higher or lower is "good"
 * is decided by the card via the target's `lowerIsBetter` flag.
 */
export interface KpiValue {
  /** Stable key, e.g. "preBerthingDelay". */
  key: string;
  /** Display label. */
  label: string;
  value: number;
  /** Unit suffix, e.g. "h", "%", "vessels". */
  unit: string;
  target: number;
  /** Signed % delta of value vs target. */
  deltaPct: number;
  /** Recent trend for sparkline. */
  trend: TrendPoint[];
  /**
   * KPI card anatomy (spec UI-041) — optional, populated by corpus-backed
   * adapters. `definition` is the exact definition line rendered on the card;
   * `basis` names which arrival-time definition the value uses; `baselineSource`
   * is the honest answer to "improvement vs what baseline?" (never a bare
   * percentage); `note` carries a measurability caveat (e.g. "not measurable
   * from this corpus slice") that must be shown instead of a fabricated value.
   */
  definition?: string;
  basis?: string;
  baselineSource?: string;
  note?: string;
  /** Sample size behind `value`, when the source reports it. */
  sampleN?: number;
  /**
   * JNPA-PUBLISHED baseline figure (jnport.gov.in ▸ Reports ▸ Operating
   * Performance Profile), when the reference register carries one for this KPI.
   * `vsBaselinePct` is the signed % of the measured value against it — the
   * tender's "improvement vs current baseline operations" framing, computed
   * against a real published number, never an assumed one.
   */
  baselineValue?: number;
  baselinePeriod?: string;
  vsBaselinePct?: number;
}

/** All eight headline KPIs, keyed for the KPI strip. */
export interface KpiBundle {
  preBerthingDelay: KpiValue;
  preSailingDelay: KpiValue;
  avgTat: KpiValue;
  jitPct: KpiValue;
  forecastAccuracy: KpiValue;
  berthOccupancy: KpiValue;
  anchored: KpiValue;
  approaching: KpiValue;
}

export type KpiKey = keyof KpiBundle;
