import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PERF_KPI_PATH,
  PERF_TRAFFIC_PATH,
  PERF_TRAFFIC_MAX_LIMIT,
  fetchPerformanceKpi,
  fetchPerformanceTerminals,
  fetchPerformanceTrafficPage,
  mapPerformanceKpi,
  mapPerformanceMetrics,
  mapPerformanceTerminal,
  mapPerformanceTraffic,
  parsePerformanceTerminals,
  parsePerformanceTrafficPage,
  performanceKpiQuery,
  performanceTrafficQuery,
  type PerformanceTrafficWire,
} from './performance';
import { clearAuthToken } from './token';

/** Shaped exactly as services/performance/repository.py `_day_headline` + `kpi` return. */
const KPI_BODY = {
  report_date: '2026-07-25',
  prev_report_date: '2026-07-24',
  metrics: {
    total_teus: 18432.5,
    total_tonnes: 241900,
    vessel_calls: 17,
    yard_occupancy_pct: 71.4,
    gate_total_teus: 9100,
    gate_in_teus: 4400,
    gate_out_teus: 4700,
    total_pendency_teus: 1320,
    reefer_available_slots: 210,
    reefer_total_slots: 900,
  },
  deltas: { total_teus: 512.5, total_pendency_teus: -80, vessel_calls: 0 },
};

const TRAFFIC: PerformanceTrafficWire = {
  report_date: '2026-07-25',
  terminal_code: 'NSICT',
  period: 'DAY',
  vessels: 3,
  imp_teus: 2100,
  exp_teus: 1980,
  total_teus: 4080,
  rakes: 4,
  rail_dis_teus: 640,
  rail_ldg_teus: 610,
  rail_total_teus: 1250,
};

const env = <T>(items: T[], total = items.length) => ({
  items,
  total,
  limit: 50,
  offset: 0,
  count: items.length,
});

function jsonResponse(body: unknown, status = 200, statusText = 'OK'): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
  } as unknown as Response;
}
const loginBody = {
  access_token: 'T1',
  token_type: 'bearer',
  role: 'DTCCC_ADMIN',
  auth_enabled: true,
};
const stub = (body: unknown, status = 200, statusText = 'OK') =>
  vi.fn((url: string, _init?: RequestInit) =>
    String(url).endsWith('/auth/login')
      ? jsonResponse(loginBody)
      : jsonResponse(body, status, statusText)
  );

beforeEach(() => clearAuthToken());
afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthToken();
});

describe('mapPerformanceMetrics', () => {
  it('maps every headline metric', () => {
    const m = mapPerformanceMetrics(KPI_BODY.metrics);
    expect(m).toEqual({
      totalTeus: 18432.5,
      totalTonnes: 241900,
      vesselCalls: 17,
      yardOccupancyPct: 71.4,
      gateTotalTeus: 9100,
      gateInTeus: 4400,
      gateOutTeus: 4700,
      totalPendencyTeus: 1320,
      reeferAvailableSlots: 210,
      reeferTotalSlots: 900,
    });
  });

  it('yields null — never 0 — for a section the report omits', () => {
    const m = mapPerformanceMetrics({
      ...KPI_BODY.metrics,
      yard_occupancy_pct: null,
      total_tonnes: null,
    });
    expect(m.yardOccupancyPct).toBeNull();
    expect(m.totalTonnes).toBeNull();
  });

  it('yields all-null for a missing metrics block', () => {
    const m = mapPerformanceMetrics(null);
    expect(Object.values(m).every((v) => v === null)).toBe(true);
  });
});

describe('mapPerformanceKpi', () => {
  it('maps dates, metrics and deltas', () => {
    const k = mapPerformanceKpi(KPI_BODY);
    expect(k.reportDate).toBe('2026-07-25');
    expect(k.prevReportDate).toBe('2026-07-24');
    expect(k.metrics.totalTeus).toBe(18432.5);
    expect(k.deltas.totalTeus).toBe(512.5);
    expect(k.deltas.totalPendencyTeus).toBe(-80);
  });

  it('keeps a zero delta distinct from an absent one', () => {
    const k = mapPerformanceKpi(KPI_BODY);
    expect(k.deltas.vesselCalls).toBe(0); // computed, and flat
    expect('yardOccupancyPct' in k.deltas).toBe(false); // not computable — stays ABSENT
  });

  it('tolerates a malformed payload without throwing', () => {
    const k = mapPerformanceKpi(null);
    expect(k.reportDate).toBe('');
    expect(k.deltas).toEqual({});
    expect(k.metrics.totalTeus).toBeNull();
  });

  it('reports the earliest-report case as an empty prev date, not a fake one', () => {
    expect(mapPerformanceKpi({ ...KPI_BODY, prev_report_date: null }).prevReportDate).toBe('');
  });
});

describe('mapPerformanceTraffic', () => {
  it('maps every column and builds a composite key', () => {
    const r = mapPerformanceTraffic(TRAFFIC);
    expect(r.id).toBe('2026-07-25|NSICT|DAY');
    expect(r).toMatchObject({
      reportDate: '2026-07-25',
      terminalCode: 'NSICT',
      period: 'DAY',
      vessels: 3,
      impTeus: 2100,
      expTeus: 1980,
      totalTeus: 4080,
      rakes: 4,
      railDisTeus: 640,
      railLdgTeus: 610,
      railTotalTeus: 1250,
    });
  });

  it('still yields a unique key when the row carries no identifying fields', () => {
    const a = mapPerformanceTraffic(
      { ...TRAFFIC, report_date: null, terminal_code: null, period: null },
      0
    );
    const b = mapPerformanceTraffic(
      { ...TRAFFIC, report_date: null, terminal_code: null, period: null },
      1
    );
    expect(a.id).toBe('row#0');
    expect(b.id).toBe('row#1');
  });

  it('keeps absent measures as null so a gap is not shown as zero throughput', () => {
    const r = mapPerformanceTraffic({ ...TRAFFIC, total_teus: null, rakes: null });
    expect(r.totalTeus).toBeNull();
    expect(r.rakes).toBeNull();
  });
});

describe('parsePerformanceTrafficPage', () => {
  it('preserves server order and passes total through', () => {
    const p = parsePerformanceTrafficPage(
      env([TRAFFIC, { ...TRAFFIC, terminal_code: 'GTI' }], 812),
      25
    );
    expect(p.items.map((r) => r.terminalCode)).toEqual(['NSICT', 'GTI']);
    expect(p.total).toBe(812);
  });

  it('tolerates a malformed payload', () => {
    expect(parsePerformanceTrafficPage(null, 25).items).toEqual([]);
    expect(parsePerformanceTrafficPage({ items: 'nope' }, 25).items).toEqual([]);
  });

  it('falls back to the requested limit when the envelope omits it', () => {
    expect(parsePerformanceTrafficPage({ items: [TRAFFIC] }, 25).limit).toBe(25);
  });
});

describe('mapPerformanceTerminal', () => {
  it('falls back to the code when full_name is absent', () => {
    const t = mapPerformanceTerminal({
      code: 'BMCT',
      full_name: null,
      operator: 'JSW',
      terminal_type: 'CONTAINER',
      is_container: true,
      sort_order: 2,
    })!;
    expect(t.fullName).toBe('BMCT');
    expect(t.isContainer).toBe(true);
  });

  it('drops a row with no code — it cannot be a filter value', () => {
    expect(
      mapPerformanceTerminal({
        code: null,
        full_name: 'x',
        operator: null,
        terminal_type: null,
        is_container: null,
        sort_order: null,
      })
    ).toBeNull();
  });

  it('parses the list envelope tolerantly', () => {
    expect(parsePerformanceTerminals(null)).toEqual([]);
    expect(parsePerformanceTerminals({ items: 'nope' })).toEqual([]);
  });
});

describe('query builders — only parameters the gateway accepts', () => {
  it('kpi: omits `date` entirely so the gateway resolves its own latest report', () => {
    expect(performanceKpiQuery()).toBe(PERF_KPI_PATH);
    expect(performanceKpiQuery('2026-07-25')).toBe(`${PERF_KPI_PATH}?date=2026-07-25`);
  });

  it('traffic: maps dateFrom/dateTo onto the gateway aliases from/to', () => {
    const q = performanceTrafficQuery({ dateFrom: '2026-07-01', dateTo: '2026-07-25' });
    expect(q).toContain('from=2026-07-01');
    expect(q).toContain('to=2026-07-25');
    expect(q).not.toContain('dateFrom');
  });

  it('traffic: emits terminal / period / sort / direction and omits blanks', () => {
    const q = performanceTrafficQuery({
      terminal: 'NSICT',
      period: 'DAY',
      sort: 'total_teus',
      direction: 'asc',
    });
    expect(q).toContain('terminal=NSICT');
    expect(q).toContain('period=DAY');
    expect(q).toContain('sort=total_teus');
    expect(q).toContain('direction=asc');
    expect(performanceTrafficQuery({ terminal: '   ' })).not.toContain('terminal=');
  });

  it('traffic: caps limit at the gateway ceiling rather than sending a rejected value', () => {
    expect(performanceTrafficQuery({}, 5000)).toContain(`limit=${PERF_TRAFFIC_MAX_LIMIT}`);
  });
});

describe('fetch* (end to end over a stubbed transport)', () => {
  it('kpi: sends the bearer and maps the body', async () => {
    const spy = stub(KPI_BODY);
    vi.stubGlobal('fetch', spy);
    const k = await fetchPerformanceKpi();
    expect(k).not.toBeNull();
    expect(k!.metrics.totalTeus).toBe(18432.5);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe('/api/performance/kpi');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer test.jwt.token');
  });

  it('traffic: builds the URL and maps the envelope', async () => {
    const spy = stub(env([TRAFFIC], 812));
    vi.stubGlobal('fetch', spy);
    const p = await fetchPerformanceTrafficPage({ terminal: 'NSICT', period: 'DAY' }, 25, 50);
    expect(p.total).toBe(812);
    expect(p.items[0].terminalCode).toBe('NSICT');
    expect(spy.mock.calls[0][0]).toBe(
      `${'/api'}${PERF_TRAFFIC_PATH}?terminal=NSICT&period=DAY&limit=25&offset=50`
    );
  });

  it('terminals: maps the dimension list', async () => {
    vi.stubGlobal(
      'fetch',
      stub(
        env([
          {
            code: 'NSICT',
            full_name: 'Nhava Sheva International Container Terminal',
            operator: 'DP World',
            terminal_type: 'CONTAINER',
            is_container: true,
            sort_order: 1,
          },
        ])
      )
    );
    const t = await fetchPerformanceTerminals();
    expect(t[0].code).toBe('NSICT');
  });

  it('treats gateway 404 (no_daily_reports) as empty, not a red error', async () => {
    vi.stubGlobal('fetch', stub({ detail: { error: 'no_daily_reports' } }, 404, 'Not Found'));
    await expect(fetchPerformanceKpi()).resolves.toBeNull();
  });

  it('surfaces a 400 from an invalid period rather than swallowing it', async () => {
    vi.stubGlobal('fetch', stub({ detail: { error: 'invalid_period' } }, 400, 'Bad Request'));
    await expect(fetchPerformanceTrafficPage({ period: 'WEEK' })).rejects.toThrow(/HTTP 400/);
  });
});
