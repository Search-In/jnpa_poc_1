/**
 * Session storage primitives — no network, no imports.
 *
 * A leaf module on purpose. `session.ts` reuses UC-1's existing `login()` from
 * `data/uc3/token.ts`, and `token.ts` needs to read the stored bearer; putting
 * the keys here keeps that a one-way dependency instead of a cycle, and keeps
 * ONE definition of the key names.
 *
 * The keys are UC-3's own (`web/src/lib/auth.ts`), deliberately: a browser
 * signed into UC-3 on the same origin is already signed into UC-1, and signing
 * out of either clears both.
 */

const TOKEN_KEY = 'jnpa_uc3_token';
const ROLE_KEY = 'jnpa_uc3_role';
const USER_KEY = 'jnpa_uc3_user';
const PWD_CHANGE_KEY = 'jnpa_uc3_must_change_password';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getRole(): string | null {
  try {
    return localStorage.getItem(ROLE_KEY);
  } catch {
    return null;
  }
}

/** The signed-in account name, for display in the header. */
export function getUsername(): string | null {
  try {
    return localStorage.getItem(USER_KEY);
  } catch {
    return null;
  }
}

export function setSession(
  token: string,
  role: string,
  username?: string | null,
  needsPasswordChange = false,
): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ROLE_KEY, role);
    if (username) localStorage.setItem(USER_KEY, username);
    localStorage.setItem(PWD_CHANGE_KEY, needsPasswordChange ? 'true' : 'false');
  } catch {
    /* storage unavailable; session is in-memory only for this load */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(PWD_CHANGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Master switch, same variable and semantics as UC-3's console.
 * Unset/false = no sign-in step, so the existing credential-free mock/demo
 * build behaves exactly as it does today. Deployed builds set it to "true".
 */
export function authEnabled(): boolean {
  return import.meta.env.VITE_AUTH_ENABLED === 'true';
}
