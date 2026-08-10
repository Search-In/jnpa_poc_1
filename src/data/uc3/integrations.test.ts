import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  JNPA_INTEGRATION_HEALTH_PATH,
  fetchJnpaIntegrationHealth,
  parseJnpaIntegrationHealth,
  parseJnpaMode,
  syncedGroupCount,
} from './integrations';
import { clearAuthToken } from './token';

const HEALTH_BODY = {
  configured: true,
  mode: 'LIVE',
  api_url: 'https://portdata.jnport.gov.in',
  groups: [
    { group: 'vessel_calls', kind: 'incremental', watermark_ts: '2026-08-04T10:00:00+00:00',
      last_status: 'ok', updated_at: '2026-08-04T10:05:00+00:00' },
    { group: 'berthing', kind: 'incremental', watermark_ts: null,
      last_status: 'error', updated_at: '2026-08-04T10:05:00+00:00' },
    { group: 'tides', kind: 'snapshot', watermark_ts: '2026-08-03T00:00:00+00:00',
      last_status: 'ok', updated_at: '2026-08-04T10:05:00+00:00' },
  ],
  last_run: {
    status: 'SUCCESS', trigger: 'scheduled',
    started_at: '2026-08-04T10:00:00+00:00', finished_at: '2026-08-04T10:04:30+00:00',
  },
};

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return { ok: status >= 200 && status < 300, status, statusText, json: async () => body } as unknown as Response;
}
const loginBody = { access_token: 'T1', token_type: 'bearer', role: 'DTCCC_ADMIN', auth_enabled: true };

beforeEach(() => {
  clearAuthToken();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthToken();
});

describe('parseJnpaMode', () => {
  it('accepts the three wire modes case-insensitively', () => {
    expect(parseJnpaMode('LIVE')).toBe('LIVE');
    expect(parseJnpaMode('sim')).toBe('SIM');
    expect(parseJnpaMode('DISABLED')).toBe('DISABLED');
  });

  it('floors anything unrecognised to DISABLED — never a fabricated LIVE', () => {
    expect(parseJnpaMode('TURBO')).toBe('DISABLED');
    expect(parseJnpaMode(null)).toBe('DISABLED');
    expect(parseJnpaMode(undefined)).toBe('DISABLED');
    expect(parseJnpaMode(7)).toBe('DISABLED');
  });
});

describe('parseJnpaIntegrationHealth (wire → domain)', () => {
  it('maps the full payload', () => {
    const h = parseJnpaIntegrationHealth(HEALTH_BODY);
    expect(h.configured).toBe(true);
    expect(h.mode).toBe('LIVE');
    expect(h.apiUrl).toBe('https://portdata.jnport.gov.in');
    expect(h.groups).toHaveLength(3);
    expect(h.groups[0]).toEqual({
      group: 'vessel_calls',
      kind: 'incremental',
      watermarkTs: Date.parse('2026-08-04T10:00:00+00:00'),
      lastStatus: 'ok',
      updatedAt: Date.parse('2026-08-04T10:05:00+00:00'),
    });
    // Never-synced group keeps a 0 watermark instead of NaN/throwing.
    expect(h.groups[1].watermarkTs).toBe(0);
    expect(h.lastRun).toEqual({
      status: 'SUCCESS',
      trigger: 'scheduled',
      startedAt: Date.parse('2026-08-04T10:00:00+00:00'),
      finishedAt: Date.parse('2026-08-04T10:04:30+00:00'),
      detail: '',
    });
  });

  it('degrades a malformed/empty payload to the disabled shape', () => {
    for (const raw of [null, undefined, {}, 'nope', 42]) {
      const h = parseJnpaIntegrationHealth(raw);
      expect(h.configured).toBe(false);
      expect(h.mode).toBe('DISABLED');
      expect(h.apiUrl).toBe('');
      expect(h.groups).toEqual([]);
      expect(h.lastRun).toBeNull();
    }
  });

  it('keeps lastRun null when the integration has never run', () => {
    expect(parseJnpaIntegrationHealth({ ...HEALTH_BODY, last_run: null }).lastRun).toBeNull();
  });

  it("surfaces a failed run's error text as detail", () => {
    const h = parseJnpaIntegrationHealth({
      ...HEALTH_BODY,
      last_run: { status: 'FAILED', error: 'upstream 504' },
    });
    expect(h.lastRun?.status).toBe('FAILED');
    expect(h.lastRun?.detail).toBe('upstream 504');
  });

  it('drops group rows without a group name', () => {
    const h = parseJnpaIntegrationHealth({
      ...HEALTH_BODY,
      groups: [...HEALTH_BODY.groups, { group: '', kind: 'x' }],
    });
    expect(h.groups).toHaveLength(3);
  });
});

describe('syncedGroupCount', () => {
  it('counts only groups carrying a watermark', () => {
    const h = parseJnpaIntegrationHealth(HEALTH_BODY);
    expect(syncedGroupCount(h.groups)).toBe(2); // berthing never synced
    expect(syncedGroupCount([])).toBe(0);
  });
});

describe('fetchJnpaIntegrationHealth', () => {
  it('logs in, then GETs the health path with the bearer (happy path)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      return String(url).includes('/auth/login') ? jsonResponse(loginBody) : jsonResponse(HEALTH_BODY);
    });
    vi.stubGlobal('fetch', fetchMock);

    const h = await fetchJnpaIntegrationHealth();
    expect(h.mode).toBe('LIVE');
    expect(syncedGroupCount(h.groups)).toBe(2);
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes(JNPA_INTEGRATION_HEALTH_PATH))!;
    expect(String(call[0])).toBe(`/api${JNPA_INTEGRATION_HEALTH_PATH}`);
    expect(call[1]?.headers).toMatchObject({ authorization: 'Bearer test.jwt.token' });
  });

  it('surfaces a gateway failure so the card can render "unavailable"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/auth/login')
          ? jsonResponse(loginBody)
          : jsonResponse({ detail: 'db unavailable' }, 503, 'Service Unavailable'),
      ),
    );
    await expect(fetchJnpaIntegrationHealth()).rejects.toThrow(/503/);
  });
});
