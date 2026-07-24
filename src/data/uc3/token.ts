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

let token: string | null = null;
let inflight: Promise<string> | null = null;

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
    throw new Error(`[UC3] login failed — HTTP ${res.status} ${res.statusText}`);
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
 */
export function getAuthToken(): Promise<string> {
  if (token) return Promise.resolve(token);
  if (inflight) return inflight;

  inflight = login()
    .then((r) => {
      token = r.token;
      return r.token;
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
 */
export function clearAuthToken(): void {
  token = null;
}

/** True when a bearer is cached. Diagnostics/tests only. */
export function hasAuthToken(): boolean {
  return token !== null;
}
