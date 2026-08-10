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
 *  • **The credentials come from the USER, not the build.** `login()` is called
 *    once, by the sign-in form (src/auth/LoginGate.tsx → src/auth/session.ts),
 *    with what was typed. It used to default to `VITE_UC3_USERNAME` /
 *    `VITE_UC3_PASSWORD`, which Vite inlines at build time — the credentials
 *    shipped inside the JS bundle, readable by anyone with devtools. Those
 *    variables and their GitHub Actions secrets are gone.
 *
 *  • **The token is persisted by the session layer**, under UC-3's own
 *    localStorage keys, so a reload does not need to re-authenticate and a
 *    browser signed into UC-3 on the same origin is already signed in here.
 *    This module keeps a process-lifetime cache in front of it.
 *
 *  • **No proactive expiry check.** The 8-hour `exp` is not decoded client-side;
 *    `client.ts` reacts to a 401 by calling `clearAuthToken()` and retrying once.
 *    That single path covers both a genuine expiry and a rotated server secret.
 */

import { env } from '../config';
import { clearSession, getToken as getSessionToken } from '../../auth/sessionStore';

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
 * Rejection message when no one is signed in. Distinct and stable so the error
 * surface (friendlyError.ts) and tests can recognise it.
 */
export const UNAUTHENTICATED = '[UC3] not signed in';

/**
 * The login-storm guard that used to live here (rejection cooldown + transient
 * backoff + single-flight) is gone with the auto-login it protected. It existed
 * because every connector called getAuthToken(), and each miss re-attempted a
 * login with the build-time credentials — a wrong password produced a failing
 * POST every few seconds for as long as the page was open. getAuthToken() now
 * only reads an already-issued session token and never performs a network call,
 * so there is no storm to prevent. The one login per session is the user
 * pressing "Sign in".
 */
let token: string | null = null;

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
export async function login(username: string, password: string): Promise<LoginResult> {
  const url = `${env.uc3.apiBase.replace(/\/+$/, '')}${LOGIN_PATH}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const err: HttpError = new Error(`[UC3] login failed — HTTP ${res.status} ${res.statusText}`);
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
 * The bearer for the signed-in session. Never performs a network call: it reads
 * the token the sign-in form already obtained, or rejects with UNAUTHENTICATED.
 */
export function getAuthToken(): Promise<string> {
  if (token) return Promise.resolve(token);

  // The signed-in user's own bearer, stored by src/auth/session.ts when they
  // completed the login form. This is now the ONLY source of a token.
  const session = getSessionToken();
  if (session) {
    token = session;
    return Promise.resolve(session);
  }

  // No session: the caller is a data panel that ran before sign-in, or after the
  // session was cleared by a 401. Fail fast — do NOT attempt a login here. It
  // used to auto-submit VITE_UC3_USERNAME / VITE_UC3_PASSWORD, which Vite inlined
  // into the bundle where anyone with devtools could read them; those variables
  // are gone. AuthGate is what puts the user back on the sign-in screen.
  return Promise.reject(new Error(UNAUTHENTICATED));
}

/**
 * Drop this module's cached bearer, so the next `getAuthToken()` re-reads the
 * stored session. The reset seam for tests, and the first half of the 401 path.
 *
 * Deliberately does NOT touch the stored session — that is `endSession()`, which
 * client.ts calls only once a retry has also failed. Keeping the two apart means
 * a transient 401 costs a re-read, not a sign-out.
 */
export function clearAuthToken(): void {
  token = null;
}

/**
 * Abandon the signed-in session entirely: a retried request was still rejected,
 * so the bearer is genuinely dead (expired, or the account was disabled) and
 * re-presenting it would fail every subsequent call. Dropping it makes
 * AuthGate's next verifySession() fail and return the user to the sign-in
 * screen — the same posture as UC-3's `onUnauthorized()`.
 */
export function endSession(): void {
  token = null;
  clearSession();
}

/** True when a bearer is cached. Diagnostics/tests only. */
export function hasAuthToken(): boolean {
  return token !== null;
}
