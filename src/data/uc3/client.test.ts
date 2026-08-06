import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env } from '../config';
import { http, httpErrorMessage, uc3Url } from './client';
import { clearAuthToken } from './token';

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
    const [url, init] = spy.mock.calls[1];
    expect(url).toBe('/api/shipping-lines/lines');
    expect(authOf(init)).toBe('Bearer T1');
  });

  it('reuses the cached token across requests (one login, many calls)', async () => {
    const spy = vi.fn((url: string) =>
      isLogin(url) ? jsonResponse(loginBody('T1')) : jsonResponse({ ok: true }),
    );
    vi.stubGlobal('fetch', spy);

    await http('/a');
    await http('/b');
    await http('/c');

    expect(spy.mock.calls.filter(([u]) => isLogin(String(u)))).toHaveLength(1);
  });

  it('on 401 re-logs in and replays the request exactly once', async () => {
    let gets = 0;
    let logins = 0;
    const spy = vi.fn((url: string, _init?: RequestInit) => {
      if (isLogin(url)) {
        logins += 1;
        return jsonResponse(loginBody(`T${logins}`));
      }
      gets += 1;
      // First GET is rejected (expired token), the replay succeeds.
      return gets === 1
        ? jsonResponse({ detail: 'missing bearer token' }, 401, 'Unauthorized')
        : jsonResponse({ recovered: true });
    });
    vi.stubGlobal('fetch', spy);

    const body = await http<{ recovered: boolean }>('/shipping-lines/lines');

    expect(body.recovered).toBe(true);
    expect(logins).toBe(2); // original + one re-login
    expect(gets).toBe(2); // original + one replay
    // The replay carried the NEW token, not the stale one.
    const getCalls = spy.mock.calls.filter(([u]) => !isLogin(String(u)));
    expect(authOf(getCalls[0][1])).toBe('Bearer T1');
    expect(authOf(getCalls[1][1])).toBe('Bearer T2');
  });

  it('surfaces a second 401 instead of retrying forever', async () => {
    let logins = 0;
    const spy = vi.fn((url: string) => {
      if (isLogin(url)) {
        logins += 1;
        return jsonResponse(loginBody('T1'));
      }
      return jsonResponse({ detail: 'nope' }, 401, 'Unauthorized');
    });
    vi.stubGlobal('fetch', spy);

    await expect(http('/shipping-lines/lines')).rejects.toThrow(/HTTP 401/);
    expect(logins).toBe(2); // exactly one retry, never a loop
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
