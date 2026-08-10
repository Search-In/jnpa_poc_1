import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from '../config';
import {
  friendlyMlError,
  httpErrorMessage,
  looksLikeProxyFailure,
  mlHttp,
  mlUrl,
} from './client';

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response;
}

/**
 * What a dev proxy / nginx returns when nothing is listening upstream: a 5xx
 * with an EMPTY, non-JSON body. Verified against `vite` with the model service
 * stopped — `500 Internal Server Error`, `content-type: text/plain`, no body.
 */
function proxyFailure(status = 500, statusText = 'Internal Server Error'): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => {
      throw new SyntaxError('Unexpected end of JSON input');
    },
    headers: new Headers({ 'content-type': 'text/plain' }),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mlUrl', () => {
  it('joins the api base with a path suffix', () => {
    expect(mlUrl('/uc1/webapp/predictions', '/ml-api')).toBe('/ml-api/uc1/webapp/predictions');
    expect(mlUrl('uc1/webapp/predictions', '/ml-api')).toBe('/ml-api/uc1/webapp/predictions');
  });

  it('defaults to the configured base', () => {
    expect(mlUrl('/health')).toBe(`${env.ml.apiBase}/health`);
  });

  it('tolerates a trailing slash on the base', () => {
    expect(mlUrl('/health', '/ml-api/')).toBe('/ml-api/health');
  });

  it('does not double the prefix when a caller passes the full path', () => {
    // The mistake this guards is a 404 that looks like a routing bug in the
    // service rather than a caller passing an already-prefixed path.
    expect(mlUrl('/ml-api/health', '/ml-api')).toBe('/ml-api/health');
  });
});

describe('httpErrorMessage', () => {
  it('names the path, the status and the detail', () => {
    expect(httpErrorMessage('/uc1/webapp/predictions', 422, 'Unprocessable', 'no vessels')).toBe(
      '[ML] /uc1/webapp/predictions → HTTP 422 Unprocessable — no vessels',
    );
  });

  it('omits the detail when there is none', () => {
    expect(httpErrorMessage('/health', 503, 'Service Unavailable')).toBe(
      '[ML] /health → HTTP 503 Service Unavailable',
    );
  });
});

describe('looksLikeProxyFailure', () => {
  it('flags a 5xx that carried no JSON body — the proxy, not the service', () => {
    // The shipped bug: with the model service stopped, the Vite dev proxy
    // answers `500 Internal Server Error` with an EMPTY text/plain body.
    expect(looksLikeProxyFailure(500, undefined)).toBe(true);
    expect(looksLikeProxyFailure(502, null)).toBe(true);
  });

  it('does not flag a 5xx the service itself explained', () => {
    expect(looksLikeProxyFailure(500, 'ValueError: no vessels supplied')).toBe(false);
  });

  it('does not flag a 4xx — those are always the service answering', () => {
    expect(looksLikeProxyFailure(422, undefined)).toBe(false);
  });
});

describe('friendlyMlError', () => {
  it('turns "Failed to fetch" into the command that starts the service', () => {
    const msg = friendlyMlError(new TypeError('Failed to fetch'), '/health');
    expect(msg).toContain('model service is not reachable');
    expect(msg).toContain('python run.py serve');
  });

  it('explains a timeout in terms of what is slow', () => {
    const msg = friendlyMlError(new DOMException('aborted', 'AbortError'), '/uc1/webapp/predictions');
    expect(msg).toContain('did not answer within');
    expect(msg).toContain('VITE_ML_TIMEOUT_MS');
  });

  it('keeps an already-meaningful message, but marks it as ML', () => {
    // The text survives; the [ML] marker is what stops friendlyError from
    // classifying it as a JNPA gateway fault.
    expect(friendlyMlError(new Error('boom'), '/health')).toBe('[ML] boom');
  });

  it('does not double the marker on a message that already carries it', () => {
    expect(friendlyMlError(new Error('[ML] boom'), '/health')).toBe('[ML] boom');
  });
});

describe('mlHttp', () => {
  it('POSTs JSON to the resolved url', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(mlHttp('/uc1/webapp/predictions', { method: 'POST', body: '{}' })).resolves.toEqual({
      ok: true,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${env.ml.apiBase}/uc1/webapp/predictions`);
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('throws a descriptive error on a non-2xx, carrying the FastAPI detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ detail: 'unknown model(s): m9' }, 422, 'Unprocessable Entity')),
    );
    await expect(mlHttp('/uc1/webapp/predictions')).rejects.toThrow(/HTTP 422.*unknown model/);
  });

  it('translates a transport failure rather than surfacing "Failed to fetch"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(mlHttp('/health')).rejects.toThrow(/model service is not reachable/);
  });

  // --- the regression that shipped -----------------------------------------
  // With the service stopped, the dev proxy answers 500 with an empty body, so
  // fetch RESOLVES. The message used to fall through to a generic 5xx and the
  // panel told the operator "The JNPA gateway hit an internal error" — the wrong
  // system, and no way to act on it.
  it('reports a dead service as unreachable when the proxy answers an empty 500', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith('/health') ? proxyFailure() : proxyFailure(),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(mlHttp('/uc1/webapp/predictions', { method: 'POST' })).rejects.toThrow(
      /model service is not reachable/,
    );
    // It confirmed against /health rather than guessing from the status alone.
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/health'))).toBe(true);
  });

  it('does NOT claim unreachable when /health answers — the service crashed on this request', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('/health')
        ? jsonResponse({ status: 'ok' })
        : proxyFailure(),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = await mlHttp('/uc1/webapp/predictions', { method: 'POST' }).catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 500/);
    expect(String(err)).not.toMatch(/not reachable/);
  });

  it('trusts a 5xx the service explained, without probing /health', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ detail: 'ValueError: no vessels supplied' }, 500, 'Internal Server Error'),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(mlHttp('/uc1/webapp/predictions')).rejects.toThrow(/no vessels supplied/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('prefixes every failure with [ML] so the classifier cannot mistake it for the gateway', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ detail: 'boom' }, 503, 'Unavailable')));
    const err = await mlHttp('/uc1/webapp/predictions').catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/^\[ML\]/);
  });
});
