/**
 * <LogoutButton> — header control that ends the signed-in UC-1 session.
 *
 * Renders ONLY when auth is enabled AND a session token is present. The
 * credential-free mock/demo build (VITE_AUTH_ENABLED unset) has no session, so
 * nothing is shown there and its behaviour is unchanged.
 *
 * Clicking it calls the EXISTING `session.logout()`: it clears the stored session
 * (sessionStore.clearSession — the same jnpa_uc3_* keys the login writes) and
 * full-reloads to '/', which re-runs AuthGate and lands on LoginGate. The reload
 * also tears down every in-memory poller/adapter opened under the previous token,
 * so no auth/session state survives. No new auth mechanism, no storage of its own.
 */
import { CalciteButton } from '@esri/calcite-components-react';
import { authEnabled, getToken, getUsername, logout } from './session';
import { tokens } from '@/theme/tokens';

export function LogoutButton() {
  // Nothing to sign out of in the credential-free demo build, or before sign-in.
  if (!authEnabled() || !getToken()) return null;
  const user = getUsername();
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      {user && (
        <span aria-hidden style={{ color: tokens.textMuted }} title={`Signed in as ${user}`}>
          {user}
        </span>
      )}
      <CalciteButton
        scale="s"
        appearance="outline"
        iconStart="sign-out"
        title="Sign out and return to the login screen"
        onClick={() => logout()}
      >
        Logout
      </CalciteButton>
    </label>
  );
}
