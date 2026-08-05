import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AUTH_BACKOFF_BASE_MS,
  LOGIN_PATH,
  clearAuthToken,
  getAuthToken,
  hasAuthToken,
  login,
} from './token';

/** Minimal Response stand-in — the module only touches ok/status/statusText/json. */
function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

const TOKEN_A = 'header.payload.signature-a';
const TOKEN_B = 'header.payload.signature-b';

const loginBody = (token: string) => ({
  access_token: token,
  token_type: 'bearer',
  role: 'DTCCC_ADMIN',
  auth_enabled: true,
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  clearAuthToken(); // module-level cache is shared across tests
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthToken();
});

describe('login (flow + response contract)', () => {
  it('POSTs JSON credentials to the login path under the api base', async () => {
    const spy = stubFetch(() => jsonResponse(loginBody(TOKEN_A)));

    await login('admin', 'admin');

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    // apiBase defaults to '/api', so the login URL must not double the prefix.
    expect(url).toBe(`/api${LOGIN_PATH}`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ username: 'admin', password: 'admin' });
  });

  it('reads access_token — NOT token — from the response', async () => {
    stubFetch(() => jsonResponse({ ...loginBody(TOKEN_A), token: 'decoy-should-be-ignored' }));

    const r = await login('admin', 'admin');

    expect(r.token).toBe(TOKEN_A);
    expect(r.role).toBe('DTCCC_ADMIN');
    expect(r.authEnabled).toBe(true);
  });

  it('rejects on bad credentials (401)', async () => {
    stubFetch(() => jsonResponse({ detail: 'invalid credentials' }, 401, 'Unauthorized'));

    await expect(login('admin', 'wrong')).rejects.toThrow(/\[UC3\] login failed — HTTP 401/);
  });

  it('rejects when the response carries no access_token', async () => {
    stubFetch(() => jsonResponse({ role: 'DTCCC_ADMIN' }));

    await expect(login('admin', 'admin')).rejects.toThrow(/no access_token/);
  });
});

describe('getAuthToken (caching + single-flight)', () => {
  it('logs in once, then serves the cached token', async () => {
    const spy = stubFetch(() => jsonResponse(loginBody(TOKEN_A)));

    expect(hasAuthToken()).toBe(false);
    expect(await getAuthToken()).toBe(TOKEN_A);
    expect(await getAuthToken()).toBe(TOKEN_A);
    expect(await getAuthToken()).toBe(TOKEN_A);

    expect(spy).toHaveBeenCalledTimes(1); // NOT one login per request
    expect(hasAuthToken()).toBe(true);
  });

  it('collapses concurrent callers onto ONE login (single-flight)', async () => {
    let resolveLogin: (r: Response) => void = () => {};
    const spy = stubFetch(
      () => new Promise<Response>((resolve) => { resolveLogin = resolve; }),
    );

    // Three callers race before any login has completed.
    const all = Promise.all([getAuthToken(), getAuthToken(), getAuthToken()]);
    resolveLogin(jsonResponse(loginBody(TOKEN_A)));

    expect(await all).toEqual([TOKEN_A, TOKEN_A, TOKEN_A]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not wedge every later caller after a failed login', async () => {
    // A rejected in-flight promise must not be cached, or one blip would poison
    // the module for the life of the page. Recovery is now gated by the backoff
    // (see the storm tests below) rather than being immediate — but it must
    // still happen without a reload.
    let attempt = 0;
    const spy = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ detail: 'boom' }, 500, 'Internal Server Error')
        : jsonResponse(loginBody(TOKEN_A));
    });
    vi.useFakeTimers();
    try {
      await expect(getAuthToken()).rejects.toThrow(/HTTP 500/);
      expect(hasAuthToken()).toBe(false);

      vi.advanceTimersByTime(AUTH_BACKOFF_BASE_MS);
      expect(await getAuthToken()).toBe(TOKEN_A); // recovers, no reload needed
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rejected credentials (no login storm)', () => {
  it('attempts the login ONCE, then fails fast without touching the network', async () => {
    const spy = stubFetch(() => jsonResponse({ detail: 'invalid credentials' }, 401, 'Unauthorized'));

    await expect(getAuthToken()).rejects.toThrow(/HTTP 401/);
    // Eleven connectors + polling panels would each retry the login otherwise.
    for (let i = 0; i < 5; i++) await expect(getAuthToken()).rejects.toThrow(/HTTP 401/);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('names the missing env vars when no credential is configured', async () => {
    stubFetch(() => jsonResponse({ detail: 'invalid credentials' }, 401, 'Unauthorized'));
    // env.uc3.username/password are unset in tests — the same shape as a .env
    // that never filled them in.
    await expect(getAuthToken()).rejects.toThrow(/VITE_UC3_USERNAME/);
  });

  it('backs off a TRANSIENT failure too — a dead gateway is not retried per call', async () => {
    // A dev proxy that cannot reach its target answers 500 (Vite's ECONNREFUSED
    // response), which used to retry on every single caller.
    const spy = stubFetch(() => jsonResponse({ detail: 'ECONNREFUSED' }, 500, 'Internal Server Error'));
    vi.useFakeTimers();
    try {
      await expect(getAuthToken()).rejects.toThrow(/HTTP 500/);
      for (let i = 0; i < 5; i++) await expect(getAuthToken()).rejects.toThrow(/HTTP 500/);
      expect(spy).toHaveBeenCalledTimes(1);

      // …but it recovers by itself once the backoff elapses, unlike a 401.
      vi.advanceTimersByTime(AUTH_BACKOFF_BASE_MS);
      await expect(getAuthToken()).rejects.toThrow(/HTTP 500/);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('doubles the transient backoff, capped, and resets it on success', async () => {
    let fail = true;
    const spy = stubFetch(() =>
      fail ? jsonResponse({ detail: 'down' }, 503, 'Service Unavailable') : jsonResponse(loginBody(TOKEN_A)),
    );
    vi.useFakeTimers();
    try {
      await expect(getAuthToken()).rejects.toThrow(); // failure #1 → base
      vi.advanceTimersByTime(AUTH_BACKOFF_BASE_MS);
      await expect(getAuthToken()).rejects.toThrow(); // failure #2 → 2× base
      expect(spy).toHaveBeenCalledTimes(2);

      // Half of the doubled window is not enough to try again.
      vi.advanceTimersByTime(AUTH_BACKOFF_BASE_MS);
      await expect(getAuthToken()).rejects.toThrow();
      expect(spy).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(AUTH_BACKOFF_BASE_MS);
      fail = false;
      expect(await getAuthToken()).toBe(TOKEN_A);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows one fresh attempt after clearAuthToken (the stale-session path)', async () => {
    let attempt = 0;
    const spy = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ detail: 'invalid credentials' }, 401, 'Unauthorized')
        : jsonResponse(loginBody(TOKEN_A));
    });

    await expect(getAuthToken()).rejects.toThrow(/HTTP 401/);
    await expect(getAuthToken()).rejects.toThrow(/HTTP 401/); // memo: no 2nd call
    expect(spy).toHaveBeenCalledTimes(1);

    clearAuthToken();
    expect(await getAuthToken()).toBe(TOKEN_A);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('clearAuthToken', () => {
  it('forces the next call to log in again (the 401 path)', async () => {
    let attempt = 0;
    const spy = stubFetch(() => jsonResponse(loginBody(attempt++ === 0 ? TOKEN_A : TOKEN_B)));

    expect(await getAuthToken()).toBe(TOKEN_A);

    clearAuthToken();
    expect(hasAuthToken()).toBe(false);

    expect(await getAuthToken()).toBe(TOKEN_B);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
