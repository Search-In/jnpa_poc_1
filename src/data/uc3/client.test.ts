import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from '../config';
import { http, httpErrorMessage, uc3Url } from './client';
import { clearAuthToken } from './token';
import { getToken as getSessionToken } from '../../auth/sessionStore';

/** The bearer the global test setup signs in with (src/test/setup.ts). */
const SESSION_TOKEN = 'test.jwt.token';

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response;
}

const loginBody = (token: string) => ({
  access_token: token,
  token_type: 'bearer',
  role: 'DTCCC_ADMIN',
  auth_enabled: true,
});

const isLogin = (url: string) => url.endsWith('/auth/login');
const authOf = (init?: RequestInit) =>
  (init?.headers as Record<string, string> | undefined)?.authorization;

beforeEach(() => {
  clearAuthToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthToken();
});

describe('uc3Url', () => {
  it('joins the api base with a path suffix', () => {
    expect(uc3Url('/shipping-lines/lines', '/api')).toBe('/api/shipping-lines/lines');
    expect(uc3Url('shipping-lines/lines', '/api')).toBe('/api/shipping-lines/lines');
  });

  it('defaults to the configured api base', () => {
    expect(uc3Url('/auth/login')).toBe(`${env.uc3.apiBase}/auth/login`);
  });

  it('tolerates a trailing slash on the base', () => {
    expect(uc3Url('/auth/login', '/api/')).toBe('/api/auth/login');
  });

  it('never doubles the prefix when a caller passes the full path', () => {
    // The classic /api/api/... 404. Normalised rather than silently broken.
    expect(uc3Url('/api/shipping-lines/lines', '/api')).toBe('/api/shipping-lines/lines');
  });

  it('does not strip a path that merely starts with the same letters', () => {
    expect(uc3Url('/apiary/lines', '/api')).toBe('/api/apiary/lines');
  });

  it('supports an absolute base for a direct (non-proxied) gateway', () => {
    expect(uc3Url('/auth/login', 'https://gw.example/api')).toBe(
      'https://gw.example/api/auth/login',
    );
  });
});

describe('httpErrorMessage', () => {
  it('includes the path, status and a JSON detail body', () => {
    expect(httpErrorMessage('/x', 403, 'Forbidden', { error: 'nope' })).toBe(
      '[UC3] /x → HTTP 403 Forbidden — {"error":"nope"}',
    );
  });

  it('omits the detail when there is no body', () => {
    expect(httpErrorMessage('/x', 500, 'Internal Server Error')).toBe(
      '[UC3] /x → HTTP 500 Internal Server Error',
    );
  });
});

describe('http (authenticated transport)', () => {
  it('attaches the bearer and returns the parsed body', async () => {
    const spy = vi.fn((url: string, _init?: RequestInit) =>
      isLogin(url) ? jsonResponse(loginBody('T1')) : jsonResponse({ items: [], total: 0 }),
    );
    vi.stubGlobal('fetch', spy);

    const body = await http<{ total: number }>('/shipping-lines/lines');

    expect(body.total).toBe(0);
    // Call 0, not 1: there is no login round trip in front of the request any
    // more, and the bearer is the one the signed-in session already holds.
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/shipping-lines/lines');
    expect(authOf(init)).toBe(`Bearer ${SESSION_TOKEN}`);
  });

  it('NEVER logs in — the bearer comes from the signed-in session', async () => {
    const spy = vi.fn((url: string, _init?: RequestInit) =>
      isLogin(url) ? jsonResponse(loginBody('T1')) : jsonResponse({ ok: true }),
    );
    vi.stubGlobal('fetch', spy);

    await http('/a');
    await http('/b');
    await http('/c');

    // The transport used to authenticate itself with build-time credentials.
    // A data request must never put a credential on the wire now.
    expect(spy.mock.calls.filter(([u]) => isLogin(String(u)))).toHaveLength(0);
    const gets = spy.mock.calls.filter(([u]) => !isLogin(String(u)));
    expect(gets).toHaveLength(3);
    for (const [, init] of gets) expect(authOf(init)).toBe(`Bearer ${SESSION_TOKEN}`);
  });

  it('on 401 re-reads the session and replays the request exactly once', async () => {
    let gets = 0;
    const spy = vi.fn((url: string, _init?: RequestInit) => {
      if (isLogin(url)) return jsonResponse(loginBody('T1'));
      gets += 1;
      // First GET is rejected (expired token), the replay succeeds.
      return gets === 1
        ? jsonResponse({ detail: 'missing bearer token' }, 401, 'Unauthorized')
        : jsonResponse({ recovered: true });
    });
    vi.stubGlobal('fetch', spy);

    const body = await http<{ recovered: boolean }>('/shipping-lines/lines');

    expect(body.recovered).toBe(true);
    expect(gets).toBe(2); // original + one replay
    expect(spy.mock.calls.filter(([u]) => isLogin(String(u)))).toHaveLength(0);
  });

  it('surfaces a second 401 and ends the session instead of retrying forever', async () => {
    let gets = 0;
    const spy = vi.fn((url: string) => {
      if (isLogin(url)) return jsonResponse(loginBody('T1'));
      gets += 1;
      return jsonResponse({ detail: 'nope' }, 401, 'Unauthorized');
    });
    vi.stubGlobal('fetch', spy);

    await expect(http('/shipping-lines/lines')).rejects.toThrow(/HTTP 401/);
    expect(gets).toBe(2); // exactly one retry, never a loop
    // A bearer the gateway rejects twice is dead: the session is dropped so
    // AuthGate returns the user to the sign-in screen.
    expect(getSessionToken()).toBeNull();
  });

  it('throws a descriptive error on a non-401 failure without retrying', async () => {
    let gets = 0;
    const spy = vi.fn((url: string) => {
      if (isLogin(url)) return jsonResponse(loginBody('T1'));
      gets += 1;
      return jsonResponse({ error: 'forbidden' }, 403, 'Forbidden');
    });
    vi.stubGlobal('fetch', spy);

    await expect(http('/shipping-lines/lines')).rejects.toThrow(
      /\[UC3\] \/shipping-lines\/lines → HTTP 403 Forbidden/,
    );
    expect(gets).toBe(1); // a 403 is a policy answer, not a stale token
  });

  it('makes NO network call at all when UC-3 is disabled', async () => {
    const spy = vi.fn(() => jsonResponse({}));
    vi.stubGlobal('fetch', spy);

    const prev = env.uc3.enabled;
    env.uc3.enabled = false;
    try {
      await expect(http('/shipping-lines/lines')).rejects.toThrow(/disabled/);
      expect(spy).not.toHaveBeenCalled(); // mock mode stays provably offline
    } finally {
      env.uc3.enabled = prev;
    }
  });
});
