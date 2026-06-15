/**
 * ArcGIS OAuth 2.0 (named-user) identity — lets the app load PRIVATE org items
 * (your WebMap, private Feature Layers) without embedding any secret.
 *
 * Uses `OAuthInfo` + `IdentityManager` (the supported 4.x flow). The OAuth app
 * id (`VITE_OAUTH_APPID`) is a PUBLIC client id — safe to ship in the bundle;
 * the user authenticates against the portal, and the token lives only in the
 * browser session. No client secret is ever used (PKCE public-client flow).
 *
 * If no app id is configured, all calls are no-ops so public items / the
 * AISStream feed still work without sign-in.
 */

import OAuthInfo from '@arcgis/core/identity/OAuthInfo';
import esriId from '@arcgis/core/identity/IdentityManager';
import Portal from '@arcgis/core/portal/Portal';
import { env } from '@/data/config';

export interface AuthUser {
  username: string;
  fullName: string;
}

let configured = false;
let oauthInfo: OAuthInfo | null = null;

/** True when an OAuth app id is set (otherwise sign-in is unavailable). */
export function isAuthConfigured(): boolean {
  return Boolean(env.oauthAppId);
}

/**
 * Register the OAuth app with IdentityManager. Idempotent; safe to call early.
 *
 * Uses the REDIRECT flow (popup:false): clicking sign-in navigates to the
 * portal, which redirects back to this app's own URL with `?code=…`; the SDK
 * reads it on load and `checkSignInStatus()` completes the exchange. This is
 * simpler and far more robust than the pop-up + callback-page handshake (which
 * is prone to the white-screen / stuck pop-up you hit). The redirect URI you
 * register in ArcGIS is just the app origin (e.g. https://localhost:5173/).
 */
export function configureAuth(): void {
  if (configured || !env.oauthAppId) return;
  oauthInfo = new OAuthInfo({
    appId: env.oauthAppId,
    portalUrl: env.portalUrl,
    popup: false,
  });
  esriId.registerOAuthInfos([oauthInfo]);
  configured = true;
}

/**
 * Resolve to the signed-in user if a valid session already exists (silent),
 * else null. Does NOT prompt. Call at startup to restore a session.
 */
export async function checkSignInStatus(): Promise<AuthUser | null> {
  if (!env.oauthAppId) return null;
  configureAuth();
  try {
    await esriId.checkSignInStatus(`${env.portalUrl}/sharing`);
    return await currentUser();
  } catch {
    return null;
  }
}

/**
 * Start sign-in. With the redirect flow this navigates the page to the portal
 * and does NOT return here — the app reloads on the redirect back, where
 * `checkSignInStatus()` (run at startup) completes the exchange. Resolves only
 * in the rare case a credential is already cached.
 */
export async function signIn(): Promise<AuthUser | null> {
  if (!env.oauthAppId) {
    throw new Error('OAuth not configured: set VITE_OAUTH_APPID to enable sign-in.');
  }
  configureAuth();
  await esriId.getCredential(`${env.portalUrl}/sharing`);
  return currentUser();
}

/** Clear the local session. */
export function signOut(): void {
  esriId.destroyCredentials();
}

/** The current portal user, or null if not signed in. */
export async function currentUser(): Promise<AuthUser | null> {
  try {
    const portal = new Portal({ url: env.portalUrl });
    await portal.load();
    if (!portal.user) return null;
    return {
      username: portal.user.username ?? '',
      fullName: portal.user.fullName || portal.user.username || '',
    };
  } catch {
    return null;
  }
}
