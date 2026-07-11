/** Small numeric helpers shared by the KPI formulas. Pure + unit-tested. */

export const MS_PER_HOUR = 3_600_000;
export const MS_PER_MIN = 60_000;

/** Hours between two epoch-ms timestamps (b − a). */
export function hoursBetween(a: number, b: number): number {
  return (b - a) / MS_PER_HOUR;
}

/** Arithmetic mean; returns 0 for an empty array (never NaN). */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Round to `dp` decimal places (default 1). */
export function round(x: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/** Clamp x into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Signed % delta of `value` vs `target`: (value − target) / target * 100.
 * Returns 0 when target is 0 (avoids divide-by-zero / Infinity).
 */
export function deltaPct(value: number, target: number): number {
  if (target === 0) return 0;
  return round(((value - target) / target) * 100, 1);
}

/**
 * Population variance; returns 0 for arrays of length < 2 (variance is undefined
 * for a single sample — we return 0 rather than NaN, per the empty-state rule).
 */
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length;
}

/** Standard deviation (sqrt of population variance); 0 for n < 2. */
export function stddev(xs: number[]): number {
  return Math.sqrt(variance(xs));
}

/**
 * Linear-interpolation percentile (0..100). Returns 0 for an empty array and the
 * single value for n === 1. Guards small-n (n < 4) gracefully rather than
 * throwing, so day-one / sparse datasets render a defined value.
 */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  if (xs.length === 1) return xs[0];
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = (clamp(p, 0, 100) / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/**
 * Mean Absolute Percentage Error of predictions vs actuals, as a fraction
 * (0 = perfect). Pairs with a null actual are skipped. Pairs whose actual is
 * 0 are skipped to avoid divide-by-zero. Returns 0 when no usable pairs.
 */
export function mape(pairs: { predicted: number; actual: number | null }[]): number {
  const usable = pairs.filter(
    (p): p is { predicted: number; actual: number } => p.actual !== null && p.actual !== 0
  );
  if (usable.length === 0) return 0;
  const errs = usable.map((p) => Math.abs((p.actual - p.predicted) / p.actual));
  return mean(errs);
}
