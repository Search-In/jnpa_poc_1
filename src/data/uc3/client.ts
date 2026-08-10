/**
 * UC-3 shared-backend transport — the ONE place a UC-1 request resolves the /api
 * prefix, acquires a bearer, and turns a non-2xx into a descriptive Error.
 *
 * Mirrors the thin fetch helper the UC-3 dashboard uses against the same
 * gateway, and follows the UC-1 connector conventions in weather.ts / aishub.ts:
 * plain `fetch`, throw on non-2xx, no dependency, pure URL building exported
 * separately so it is unit-testable without I/O.
 *
 * Paths are RELATIVE to `env.uc3.apiBase` (default '/api'), which is itself a
 * relative prefix so the browser stays same-origin behind the Vite dev proxy or
 * nginx — no CORS, no preflight. Callers therefore pass the SUFFIX only
 * (`/shipping-lines/lines`), never the full `/api/shipping-lines/lines`.
 *
 * Expiry: the gateway's JWT lives 8 hours. Rather than decode `exp`, a 401
 * clears the cached token, logs in again and replays the request EXACTLY ONCE.
 * That covers both a genuine expiry and a rotated server secret; a second 401
 * surfaces, so a bad credential can never become a retry loop against /auth.
 */

import { env } from '../config';
import { getDataSourceMode } from '../dataSourceMode';
import { clearAuthToken, endSession, getAuthToken } from './token';

/**
 * Join `env.uc3.apiBase` with a path suffix.
 *
 * Defensive about the double-prefix mistake: because the base already ends in
 * `/api`, a caller passing `/api/shipping-lines/lines` would otherwise produce
 * `/api/api/shipping-lines/lines` and a puzzling 404. Such a path is normalised
 * rather than silently broken. Pure — mirrors `aisHubUrl()` in aishub.ts.
 */
export function uc3Url(path: string, base: string = env.uc3.apiBase): string {
  const root = base.replace(/\/+$/, '');
  let suffix = path.startsWith('/') ? path : `/${path}`;
  if (root && (suffix === root || suffix.startsWith(`${root}/`))) {
    suffix = suffix.slice(root.length) || '/';
  }
  return `${root}${suffix}`;
}

/** Build the descriptive message thrown on a non-2xx. Pure, so it is testable. */
export function httpErrorMessage(
  path: string,
  status: number,
  statusText: string,
  detail?: unknown,
): string {
  const tail =
    detail === undefined || detail === null ? '' : ` — ${safeStringify(detail)}`;
  return `[UC3] ${path} → HTTP ${status} ${statusText}${tail}`;
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Read a JSON error body without letting a non-JSON body mask the real status. */
async function readErrorDetail(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

async function send(path: string, init: RequestInit | undefined, token: string): Promise<Response> {
  return fetch(uc3Url(path), {
    ...init,
    headers: {
      'content-type': 'application/json',
      // Data-source provenance filter (LIVE = JNPA-API rows, DEMO = pre-loaded).
      // Callers may override via init.headers (e.g. bathymetry charts are always
      // MANUAL uploads — pin DEMO so LIVE toggle does not hide them).
      'x-data-mode': getDataSourceMode(),
      ...(init?.headers || {}),
      authorization: `Bearer ${token}`,
    },
  });
}

/**
 * Authenticated JSON request against the UC-3 gateway.
 *
 * @param path suffix relative to `env.uc3.apiBase`, e.g. '/shipping-lines/lines'
 * @throws when UC-3 is disabled, the login fails, or the response is non-2xx
 */
export async function http<T>(path: string, init?: RequestInit): Promise<T> {
  // Hard gate: with UC-3 switched off the app must make NO backend call at all,
  // so mock mode stays provably offline no matter which caller reaches here.
  if (!env.uc3.enabled) {
    throw new Error(`[UC3] ${path} — UC-3 integration is disabled (VITE_UC3_ENABLED=false)`);
  }

  let res = await send(path, init, await getAuthToken());

  // One retry, and only for 401: the cached token expired (8 h TTL) or the
  // gateway secret rotated. Any second failure is surfaced.
  if (res.status === 401) {
    clearAuthToken();
    res = await send(path, init, await getAuthToken());
    // Still 401 with a freshly-read bearer: the SESSION is dead, not just this
    // module's cache. Drop it so AuthGate returns the user to the sign-in screen
    // instead of every panel failing against a token that can never work again.
    if (res.status === 401) endSession();
  }

  if (!res.ok) {
    throw new Error(httpErrorMessage(path, res.status, res.statusText, await readErrorDetail(res)));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Multipart sender. Deliberately sets NO `content-type`: the browser must write
 * it itself so the generated multipart boundary matches the body. Setting it by
 * hand (as `send()` does for JSON) produces a boundary-less header and the
 * gateway rejects the part. Everything else — URL resolution, bearer — matches
 * `send()`.
 */
async function sendForm(path: string, form: FormData, token: string): Promise<Response> {
  return fetch(uc3Url(path), {
    method: 'POST',
    body: form,
    headers: {
      authorization: `Bearer ${token}`,
      // Data-source provenance filter (LIVE = JNPA-API rows, DEMO = pre-loaded).
      'x-data-mode': getDataSourceMode(),
    },
  });
}

/**
 * Authenticated multipart POST against the UC-3 gateway — the file-upload
 * counterpart to `http()`, used by the Marine Data-Upload endpoints
 * (`/marine/validate`, `/marine/upload`).
 *
 * Identical control flow to `http()`: the disabled-gate, one 401 retry, the same
 * descriptive error. Re-sending is safe because a browser `FormData` holding a
 * `File` is serialised per request, not consumed like a stream.
 *
 * @param path suffix relative to `env.uc3.apiBase`, e.g. '/marine/validate'
 * @throws when UC-3 is disabled, the login fails, or the response is non-2xx
 */
export async function postForm<T>(path: string, form: FormData): Promise<T> {
  if (!env.uc3.enabled) {
    throw new Error(`[UC3] ${path} — UC-3 integration is disabled (VITE_UC3_ENABLED=false)`);
  }

  let res = await sendForm(path, form, await getAuthToken());

  if (res.status === 401) {
    clearAuthToken();
    res = await sendForm(path, form, await getAuthToken());
  }

  if (!res.ok) {
    throw new Error(httpErrorMessage(path, res.status, res.statusText, await readErrorDetail(res)));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
