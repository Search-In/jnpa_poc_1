/**
 * Selected AS-OF date — the header date-pin control's reactive store. The UC-3
 * corpus is historical (May-Jul 2026), so picking a date re-anchors every
 * marine read (vessels, berths, KPIs, plan) to that day's "latest actual"
 * instead of wall-clock now (spec UI-001/UI-002: one authoritative clock).
 *
 * A tiny framework-free store (get / set / subscribe), same shape as
 * `dataSourceMode.ts`, persisted in localStorage so the pin survives a
 * reload. `Uc3Adapter` reads `getAsOfEpoch()` on every fetch instead of
 * freezing the pin at construction, so switching dates updates the
 * dashboard in place — no page reload needed.
 */

export const AS_OF_DATE_KEY = 'jnpa.asOfDate';

/** Date portion of VITE_UC3_AS_OF ("2026-06-09T23:59:59+05:30" -> "2026-06-09"),
 * so the picker starts pre-pinned to the same demo date the env var names. */
function envDefaultDate(): string {
  const pinned = (import.meta.env.VITE_UC3_AS_OF as string | undefined) ?? '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(pinned);
  return m ? m[1] : '';
}

function read(): string {
  try {
    const v = localStorage.getItem(AS_OF_DATE_KEY);
    // An explicit '' means the user cleared the pin (live/latest) — keep that,
    // don't fall back to the env default on every reload.
    if (v !== null) return v;
  } catch {
    /* private-mode / disabled storage — keep the in-memory default */
  }
  return envDefaultDate();
}

let current: string = read();
const listeners = new Set<() => void>();

/** The pinned date ("yyyy-MM-dd"), or '' when unpinned (backend anchors live). */
export function getAsOfDate(): string {
  return current;
}

/** Persist + broadcast a new pin. No-op when unchanged. */
export function setAsOfDate(date: string): void {
  if (date === current) return;
  current = date;
  try {
    localStorage.setItem(AS_OF_DATE_KEY, date);
  } catch {
    /* private-mode / disabled storage — keep the in-memory value */
  }
  for (const l of listeners) l();
}

/** Subscribe to pin changes (for React's useSyncExternalStore). Returns unsubscribe. */
export function subscribeAsOfDate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Anchor instant (epoch ms) for the pinned date, end-of-day IST — matching the
 * `VITE_UC3_AS_OF` convention. 0 = unpinned, let the backend anchor to latest. */
export function getAsOfEpoch(): number {
  if (!current) return 0;
  const parsed = Date.parse(`${current}T23:59:59+05:30`);
  return Number.isFinite(parsed) ? parsed : 0;
}

const DAY_MS = 24 * 3_600_000;

/**
 * [from, to] ISO instants spanning the pinned IST calendar day — for endpoints
 * that filter by a date RANGE (e.g. `/marine/calls`'s `eta` window) rather than
 * a single as-of instant. `null` when unpinned, so callers can spread `{}` and
 * leave the request unfiltered.
 */
export function getAsOfDayRange(): { from: string; to: string } | null {
  if (!current) return null;
  const start = Date.parse(`${current}T00:00:00+05:30`);
  if (!Number.isFinite(start)) return null;
  return { from: new Date(start).toISOString(), to: new Date(start + DAY_MS - 1).toISOString() };
}
