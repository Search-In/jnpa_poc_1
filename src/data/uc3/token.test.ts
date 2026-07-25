import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LOGIN_PATH, clearAuthToken, getAuthToken, hasAuthToken, login } from './token';

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
    // the module for the life of the page.
    let attempt = 0;
    const spy = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse({ detail: 'boom' }, 500, 'Internal Server Error')
        : jsonResponse(loginBody(TOKEN_A));
    });

    await expect(getAuthToken()).rejects.toThrow(/HTTP 500/);
    expect(hasAuthToken()).toBe(false);

    expect(await getAuthToken()).toBe(TOKEN_A); // recovers on the next attempt
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
