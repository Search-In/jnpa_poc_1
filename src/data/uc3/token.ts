/**
 * UC-3 authentication — the ONLY module that knows how a UC-1 session obtains a
 * bearer token for the shared JNPA backend.
 *
 * The gateway issues an HS256 JWT from `POST {apiBase}/auth/login` with an
 * **8-hour** TTL. Everything else in UC-1 goes through `getAuthToken()`, so the
 * login endpoint, the credential source and the cache live in exactly one place.
 *
 * Design notes:
 *
 *  • **In-memory only — never persisted.** The credential is already a
 *    build-time value baked into the bundle (see the scope-honesty note on
 *    `env.uc3` in src/data/config.ts), so a page reload can silently re-login in
 *    one round trip. Writing the token to session/localStorage would therefore
 *    buy no UX and only widen the XSS surface. This is deliberately *unlike*
 *    UC-1's UI stores (roleStore / planStore / simStore), which persist to
 *    sessionStorage because their state is operator input that cannot be
 *    re-derived.
 *
 *  • **Single-flight.** Concurrent callers share ONE in-flight login promise, so
 *    N simultaneous requests never trigger N logins.
 *
 *  • **No proactive expiry check.** The 8-hour `exp` is not decoded client-side;
 *    `client.ts` reacts to a 401 by calling `clearAuthToken()` and retrying once.
 *    That single path covers both a genuine expiry and a rotated server secret.
 *
 * Credentials come from `env.uc3` — never from a component. The optional
 * parameters on `login()` exist for tests and are not an invitation to pass
 * credentials down from the UI.
 */

import { env } from '../config';

/** The gateway's `TokenResponse`, minus fields UC-1 has no use for. */
export interface LoginResult {
  /** The bearer. NOTE the field is `access_token`, NOT `token`. */
  token: string;
  /** Gateway role granted, e.g. 'DTCCC_ADMIN'. */
  role: string;
  /** Whether the gateway is actually enforcing auth (AUTH_ENABLED). */
  authEnabled: boolean;
}

/** Path of the login endpoint, relative to `env.uc3.apiBase`. */
export const LOGIN_PATH = '/auth/login';

/**
 * Cooldown after a REJECTED credential (HTTP 401). Deterministic: the same
 * credentials cannot start working a second later, so this is the full window.
 */
export const AUTH_REJECTION_COOLDOWN_MS = 60_000;

/**
 * Backoff after a TRANSIENT login failure — a 5xx, a dead gateway, a dev proxy
 * that cannot reach its target (Vite answers ECONNREFUSED with a 500), DNS. It
 * doubles per consecutive failure up to the cap, and resets on the first
 * success, so a gateway coming back up is picked up within seconds while an
 * unreachable one is polled once a minute rather than continuously.
 */
export const AUTH_BACKOFF_BASE_MS = 5_000;
export const AUTH_BACKOFF_MAX_MS = 60_000;

let token: string | null = null;
let inflight: Promise<string> | null = null;

/**
 * The last login failure, while it is still inside its cooldown.
 *
 * Without this, ANY failing login produces a LOGIN STORM: all 11 connectors call
 * getAuthToken(), each miss re-attempts the login, and because App mounts every
 * tab's children at once — several of which poll on an interval — the gateway
 * sees a failing POST /auth/login every few seconds for as long as the page is
 * open. Retrying at that rate cannot fix a wrong password or a down gateway; it
 * only buries the real error in noise.
 */
let failure: { message: string; until: number } | null = null;
/** Consecutive failed logins, for the transient backoff. Reset on success. */
let failureCount = 0;

/** How long to wait before the next attempt, given the failure's HTTP status. */
function cooldownFor(status: number | undefined, consecutive: number): number {
  if (status === 401) return AUTH_REJECTION_COOLDOWN_MS;
  const backoff = AUTH_BACKOFF_BASE_MS * 2 ** Math.max(0, consecutive - 1);
  return Math.min(backoff, AUTH_BACKOFF_MAX_MS);
}

/** The live failure message, or null once its cooldown has elapsed. */
function activeFailure(): string | null {
  if (!failure) return null;
  if (Date.now() >= failure.until) {
    failure = null;
    return null;
  }
  return failure.message;
}

/** An Error carrying the HTTP status, so callers can tell 401 from a 5xx blip. */
interface HttpError extends Error {
  status?: number;
}

/**
 * Exchange credentials for a JWT. Performs a RAW fetch rather than going through
 * `client.http()` — that helper requires a token, which is what this produces.
 *
 * Throws on any non-2xx (a 401 means the credentials are wrong; the gateway
 * seeds admin/admin by default but AUTH_USERS can replace the whole table).
 */
export async function login(
  username: string = env.uc3.username,
  password: string = env.uc3.password,
): Promise<LoginResult> {
  const url = `${env.uc3.apiBase.replace(/\/+$/, '')}${LOGIN_PATH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    // Name the most common cause of a 401 here: an unset credential is silently
    // an empty string in the bundle, which the gateway rejects like any other
    // wrong password — with no hint as to why.
    const hint =
      res.status === 401 && (!username || !password)
        ? ' — no credentials configured (set VITE_UC3_USERNAME / VITE_UC3_PASSWORD, then restart the dev server)'
        : '';
    const err: HttpError = new Error(
      `[UC3] login failed — HTTP ${res.status} ${res.statusText}${hint}`,
    );
    err.status = res.status;
    throw err;
  }
  const body = (await res.json()) as {
    access_token?: string;
    role?: string;
    auth_enabled?: boolean;
  };
  if (!body?.access_token) {
    throw new Error('[UC3] login response carried no access_token');
  }
  return {
    token: body.access_token,
    role: body.role ?? '',
    authEnabled: body.auth_enabled ?? false,
  };
}

/**
 * The cached bearer, logging in on first use. Concurrent callers await the SAME
 * login promise, so a burst of requests still produces exactly one login.
 *
 * After a failed login, callers fail fast WITHOUT a network call until the
 * cooldown elapses — see `failure`.
 */
export function getAuthToken(): Promise<string> {
  if (token) return Promise.resolve(token);

  const failed = activeFailure();
  if (failed) return Promise.reject(new Error(failed));

  if (inflight) return inflight;

  inflight = login()
    .then((r) => {
      token = r.token;
      failure = null;
      failureCount = 0;
      return r.token;
    })
    .catch((err: unknown) => {
      failureCount += 1;
      const message = err instanceof Error ? err.message : String(err);
      failure = {
        message,
        until: Date.now() + cooldownFor((err as HttpError)?.status, failureCount),
      };
      throw err;
    })
    .finally(() => {
      // Clear the guard whether the login resolved or rejected, so a failed
      // attempt never wedges every later caller onto the same rejected promise.
      inflight = null;
    });
  return inflight;
}

/**
 * Drop the cached token so the next `getAuthToken()` logs in again. Called by
 * the 401 handler in client.ts; also the reset seam for tests.
 *
 * This also clears a remembered failure, deliberately: the caller is telling us
 * the session is stale, which is worth ONE fresh login attempt. If that attempt
 * fails too, the memo is set again and the storm still cannot restart — reaching
 * this path at all requires a token that once worked.
 */
export function clearAuthToken(): void {
  token = null;
  failure = null;
  failureCount = 0;
}

/** True when a bearer is cached. Diagnostics/tests only. */
export function hasAuthToken(): boolean {
  return token !== null;
}
