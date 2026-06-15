/** Small formatting helpers shared across widgets. */

const IST_OFFSET_MS = 5.5 * 3_600_000;

/** "HH:MM" in IST for an epoch-ms timestamp. */
export function istTime(ts: number): string {
  const d = new Date(ts + IST_OFFSET_MS);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** "DD Mon HH:MM" in IST. */
export function istDateTime(ts: number): string {
  const d = new Date(ts + IST_OFFSET_MS);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${day} ${months[d.getUTCMonth()]} ${istTime(ts)}`;
}

/** Compact human duration from hours, e.g. 26.5 → "26h 30m". */
export function durationFromHours(h: number): string {
  const whole = Math.floor(h);
  const mins = Math.round((h - whole) * 60);
  return mins === 0 ? `${whole}h` : `${whole}h ${mins}m`;
}

/** "+12.3%" / "−4.0%" signed string. */
export function signedPct(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}
