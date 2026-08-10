/**
 * Transport for the UC-1 AI/ML model service (`ml/`, FastAPI).
 *
 * Same posture as the UC-3 client (`src/data/uc3/client.ts`): plain `fetch`,
 * throw on non-2xx, pure URL building exported separately so it is testable
 * without I/O. Two deliberate differences:
 *
 *  • **No bearer.** The model service is stateless and holds no port data — it
 *    computes from the payload it is given. It carries no auth of its own, so
 *    the deployment must not expose it publicly; nginx proxies `/ml-api` to it
 *    on the private network, exactly as it does `/api` for the gateway.
 *
 *  • **A timeout.** M5's optimiser and M3's learned engine are real computation,
 *    not a database read. A wedged request must fail the panel with a message,
 *    not hang the operator's session — so every call carries an AbortController
 *    deadline (`VITE_ML_TIMEOUT_MS`, default 30 s).
 *
 * Paths are RELATIVE to `env.ml.apiBase` (default '/ml-api'), a relative prefix
 * so the browser stays same-origin behind the Vite dev proxy or nginx: no CORS,
 * no preflight. Callers pass the SUFFIX only ('/uc1/webapp/predictions').
 */

import { env } from '../config';

/**
 * Join `env.ml.apiBase` with a path suffix.
 *
 * Defensive about the double-prefix mistake in the same way `uc3Url` is: a
 * caller passing the already-prefixed path gets the right URL rather than a
 * puzzling 404. Pure.
 */
export function mlUrl(path: string, base: string = env.ml.apiBase): string {
  const root = base.replace(/\/+$/, '');
  let suffix = path.startsWith('/') ? path : `/${path}`;
  if (root && (suffix === root || suffix.startsWith(`${root}/`))) {
    suffix = suffix.slice(root.length) || '/';
  }
  return `${root}${suffix}`;
}

/** Build the message thrown on a non-2xx. Pure, so it is testable. */
export function httpErrorMessage(
  path: string,
  status: number,
  statusText: string,
  detail?: unknown,
): string {
  const tail = detail === undefined || detail === null ? '' : ` — ${safeStringify(detail)}`;
  return `[ML] ${path} → HTTP ${status} ${statusText}${tail}`;
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Marker every failure from this module carries.
 *
 * `friendlyError.ts` keys on it to pick model-service wording. Without it an ML
 * failure is classified by status alone and reads as *"The JNPA gateway hit an
 * internal error"* — a different system, a different team, and the wrong thing
 * for an operator to chase.
 */
export const ML_PREFIX = '[ML]';

/** Substring that marks "the request never reached the service". */
export const ML_UNREACHABLE = 'is not reachable';

/** How to start it. One string, so the message and the docs cannot drift. */
const START_HINT =
  'Start it with `cd ml && JNPA_PORT=8100 python run.py serve`, or point ' +
  'VITE_ML_API_URL at a running instance.';

export function unreachableMessage(path: string): string {
  return `${ML_PREFIX} The UC-1 model service ${ML_UNREACHABLE} at ${mlUrl(path)}. ${START_HINT}`;
}

/**
 * Turn a thrown transport error into something an operator can act on. Pure.
 *
 * Handles only the cases where `fetch` REJECTS. A dead service behind the dev
 * proxy does not reject — see `looksLikeProxyFailure`.
 */
export function friendlyMlError(err: unknown, path: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (err instanceof DOMException && err.name === 'AbortError') {
    return (
      `${ML_PREFIX} The model service did not answer within ` +
      `${Math.round(env.ml.timeoutMs / 1000)} s (${path}). The berth optimiser and the TAT ` +
      `engine are real computation — a large fleet can exceed the deadline. Try again, or ` +
      `raise VITE_ML_TIMEOUT_MS.`
    );
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
    return unreachableMessage(path);
  }
  return raw.startsWith(ML_PREFIX) ? raw : `${ML_PREFIX} ${raw}`;
}

/**
 * True when a non-2xx looks like the PROXY failing, not the service answering.
 *
 * This is the case that shipped broken. With the model service stopped, the Vite
 * dev proxy answers `500 Internal Server Error` with an **empty text/plain
 * body** (nginx does the same with a 502), so `fetch` RESOLVES and the
 * network-error branch above never runs. The message then read as a generic 5xx
 * and the panel blamed the JNPA gateway — a system that was not involved.
 *
 * The discriminator is the body, not the status: FastAPI always answers JSON,
 * so a 5xx with no JSON body did not come from the model service. Pure.
 */
export function looksLikeProxyFailure(status: number, body: unknown): boolean {
  return status >= 500 && (body === undefined || body === null);
}

/** Health path. Declared here so the liveness probe has no import cycle. */
export const ML_HEALTH_PATH = '/health';

/**
 * Ask the service whether it is alive at all.
 *
 * Needed because a 5xx with a non-JSON body has two causes that call for
 * opposite actions: the service is DOWN (start it), or the service is UP and
 * crashed on this request (read the traceback). Only used on the error path, so
 * a healthy request never pays for it. Never throws.
 */
async function isServiceAlive(): Promise<boolean> {
  try {
    const res = await fetch(mlUrl(ML_HEALTH_PATH), {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    // A 503 from /health is still an ANSWER: the app is up and reporting itself
    // degraded, which is very different from nothing listening on the port.
    return res.status < 500 || res.headers.get('content-type')?.includes('json') === true;
  } catch {
    return false;
  }
}

async function readErrorDetail(res: Response): Promise<unknown> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return body?.detail ?? body;
  } catch {
    return undefined;
  }
}

/**
 * JSON request against the model service.
 *
 * @param path suffix relative to `env.ml.apiBase`, e.g. '/uc1/webapp/predictions'
 * @throws when the service is disabled, unreachable, slow, or answers non-2xx
 */
export async function mlHttp<T>(path: string, init?: RequestInit): Promise<T> {
  // Hard gate, same as the UC-3 client: with the integration switched off the
  // app must make NO call at all, so mock mode stays provably offline.
  if (!env.ml.enabled) {
    throw new Error(
      `${ML_PREFIX} ${path} — the AI/ML model service is disabled (VITE_ML_ENABLED=false)`,
    );
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), env.ml.timeoutMs);
  try {
    const res = await fetch(mlUrl(path), {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
    });
    if (!res.ok) {
      const detail = await readErrorDetail(res);
      // A 5xx with no JSON body did not come from FastAPI. Confirm against
      // /health before blaming the models: down and crashed need opposite
      // actions from whoever reads this.
      if (looksLikeProxyFailure(res.status, detail) && !(await isServiceAlive())) {
        throw new Error(unreachableMessage(path));
      }
      throw new Error(httpErrorMessage(path, res.status, res.statusText, detail));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    // A non-2xx already carries a descriptive message; only transport failures
    // need translating, and re-wrapping the former would double the prefix.
    if (err instanceof Error && err.message.startsWith(ML_PREFIX)) throw err;
    throw new Error(friendlyMlError(err, path));
  } finally {
    clearTimeout(deadline);
  }
}
