/**
 * Signed-in session for UC-1 — the port of UC-3's `web/src/lib/auth.ts`.
 *
 * Same contract as UC-3, not a parallel one:
 *   • the same endpoint      POST {apiBase}/auth/login, GET {apiBase}/auth/me
 *   • the same credentials   core.app_user (admin / operator / gate / transport)
 *   • the same storage keys  jnpa_uc3_*  (see ./sessionStore.ts)
 *   • the same 8 h HS256 JWT, presented as `Authorization: Bearer …`
 *
 * The network call is NOT reimplemented. UC-1 already had a `login()` posting to
 * the UC-3 gateway (src/data/uc3/token.ts) — this reuses it verbatim and only
 * adds the session layer UC-1 was missing. What changed is where the credentials
 * come from: the signed-in user, not `VITE_UC3_USERNAME` / `VITE_UC3_PASSWORD`
 * baked into the bundle at build time.
 *
 * Roles are kept as the gateway's own string. UC-1's `src/auth/roles.ts` is a
 * separate concern (client-side view scoping) and is deliberately untouched.
 */

import { env } from '../data/config';
import { login as apiLogin } from '../data/uc3/token';
import { clearSession, getRole, getToken, getUsername, setSession } from './sessionStore';

export {
  authEnabled,
  clearSession,
  getRole,
  getToken,
  getUsername,
  setSession,
} from './sessionStore';

/**
 * Sign out. The JWT is stateless, so this is a client-side action — the gateway
 * cannot revoke an issued token (8 h TTL). Server-side revocation is UC-3's
 * `POST /api/users/{username}/disable`, which fails the next verifySession().
 * Full reload, as in UC-3: it tears down every poller and cached adapter opened
 * under the previous identity's token.
 */
export function logout(): void {
  clearSession();
  try {
    window.location.assign('/');
  } catch {
    /* non-browser environment (unit tests) */
  }
}

/** Sign in against the UC-3 gateway and store the resulting session.
 *
 *  The gateway answers one opaque 401 for every failure (unknown user, wrong
 *  password, disabled account), so there is deliberately nothing here that
 *  could be used to tell those cases apart. */
export async function login(username: string, password: string): Promise<string> {
  const result = await apiLogin(username, password);
  setSession(result.token, result.role, username);
  return result.role;
}

export interface SessionInfo {
  username: string;
  role: string;
  full_name?: string | null;
  must_change_password?: boolean;
}

/** Validate the stored session against the gateway. Returns the live identity,
 *  or null when the token is expired/invalid or the account has been disabled.
 *  Without it the dashboard would keep rendering with an expired token, every
 *  UC-3 panel erroring and no route back to the sign-in screen. */
export async function verifySession(): Promise<SessionInfo | null> {
  const token = getToken();
  if (!token) return null;
  try {
    const base = env.uc3.apiBase.replace(/\/+$/, '');
    const res = await fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data = (await res.json()) as SessionInfo;
    if (!data?.role) return null;
    setSession(token, data.role, data.username, Boolean(data.must_change_password));
    return data;
  } catch {
    // A network failure is not proof the session is bad — keep it and let the
    // normal request path surface the outage. Only when there is no stored role
    // is there nothing worth preserving.
    const role = getRole();
    return role ? { username: getUsername() ?? '', role } : null;
  }
}
