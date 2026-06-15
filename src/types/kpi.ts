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
