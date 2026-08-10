import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  LOGIN_PATH,
  UNAUTHENTICATED,
  clearAuthToken,
  endSession,
  getAuthToken,
  hasAuthToken,
  login,
} from './token';
import { clearSession, getToken as getSessionToken, setSession } from '../../auth/sessionStore';

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
describe('getAuthToken (session-backed, never logs in)', () => {
  it('serves the token the sign-in form stored', async () => {
    const fetchSpy = stubFetch(() => jsonResponse({}));
    setSession(TOKEN_A, 'DTCCC_ADMIN', 'admin');
    await expect(getAuthToken()).resolves.toBe(TOKEN_A);
    // The whole point: no auto-login. A data panel asking for a bearer must
    // never put credentials on the wire.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects when nobody is signed in, without touching the network', async () => {
    const fetchSpy = stubFetch(() => jsonResponse({}));
    clearSession(); // src/test/setup.ts signs in by default; this test needs signed-OUT
    clearAuthToken();
    await expect(getAuthToken()).rejects.toThrow(UNAUTHENTICATED);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('caches, so a burst of callers reads storage once', async () => {
    setSession(TOKEN_A, 'DTCCC_ADMIN', 'admin');
    const [a, b, c] = await Promise.all([getAuthToken(), getAuthToken(), getAuthToken()]);
    expect([a, b, c]).toEqual([TOKEN_A, TOKEN_A, TOKEN_A]);
    expect(hasAuthToken()).toBe(true);
  });

  it('picks up a NEW session after the previous one was cleared', async () => {
    setSession(TOKEN_A, 'DTCCC_ADMIN', 'admin');
    await expect(getAuthToken()).resolves.toBe(TOKEN_A);
    clearAuthToken();
    setSession(TOKEN_B, 'DTCCC_ADMIN', 'admin');
    await expect(getAuthToken()).resolves.toBe(TOKEN_B);
  });
});

describe('clearAuthToken (the 401 path)', () => {
  it('drops the STORED SESSION too, so a dead token cannot be re-presented', async () => {
    setSession(TOKEN_A, 'DTCCC_ADMIN', 'admin');
    await expect(getAuthToken()).resolves.toBe(TOKEN_A);

    endSession(); // what client.ts calls once a RETRIED 401 also fails

    expect(hasAuthToken()).toBe(false);
    expect(getSessionToken()).toBeNull();
    // Nothing left to serve — AuthGate returns the user to the sign-in screen.
    await expect(getAuthToken()).rejects.toThrow(UNAUTHENTICATED);
  });
});
