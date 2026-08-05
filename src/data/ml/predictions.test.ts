import { describe, it, expect, vi, afterEach } from 'vitest';
import type { NavStatus, Vessel } from '@/types/domain';
import {
  buildContext,
  failedModels,
  fetchFleetPredictions,
  indexByMmsi,
  selectFleet,
  toRequestRow,
} from './predictions';
import type { PredictionResponse } from './types';

function vessel(mmsi: string, status: NavStatus = 'underway', over: Partial<Vessel> = {}): Vessel {
  return {
    MMSI: mmsi,
    VESSEL_NAME: `MV ${mmsi}`,
    VESSEL_TYPE: 'Container Ship',
    NAV_STATUS: status,
    SOG: 11.2,
    COG: 78,
    HEADING: 80,
    LAT: 18.95,
    LON: 72.95,
    ETA: 1_785_030_000_000,
    BERTH_ID: null,
    TIMESTAMP: 1_785_000_000_000,
    SOURCE: 'mock',
    ...over,
  };
}

function response(mmsis: string[]): PredictionResponse {
  return {
    schema: 'uc1-webapp-predictions/1.0.0',
    adapter: {
      moduleId: 'UC1-ADAPTER',
      version: 'uc1-adapter-v1.0.0',
      scope: 'FLEET',
      models_requested: ['m1'],
      max_fleet: 80,
      note: '',
    },
    dashboard: {
      schema: 'uc1-dashboard/1.0.0',
      run: {
        generated_at_utc: '2026-08-04T00:00:00Z',
        input_file: 'live-ais-feed',
        vessels: mmsis.length,
        models_run: ['UC1-M1'],
        models_failed: [],
        wait_model: 'optimiser',
        tide_policy: 'harmonic',
      },
      model_questions: {},
      glossary: {},
      vessels: mmsis.map((mmsi, i) => ({
        call_id: `C-000${i + 1}`,
        vessel: `MV ${mmsi}`,
        imo: '',
        voyage: '',
        terminal: '',
        mmsi,
        source: 'mock',
        degraded: true,
        input: {},
        data_quality: {},
        flags: [],
        models: {},
        mapping: null,
      })),
      port_summary: {},
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toRequestRow', () => {
  it('projects only the fields the models can use', () => {
    const row = toRequestRow(vessel('419000501'));
    expect(Object.keys(row).sort()).toEqual(
      [
        'BERTH_ID', 'COG', 'ETA', 'HEADING', 'LAT', 'LON', 'MMSI', 'NAV_STATUS',
        'SOG', 'SOURCE', 'TIMESTAMP', 'VESSEL_NAME', 'VESSEL_TYPE',
      ].sort(),
    );
  });

  it('sends epoch-ms timestamps unchanged — the service reads ms', () => {
    const row = toRequestRow(vessel('419000501'));
    expect(row.TIMESTAMP).toBe(1_785_000_000_000);
    expect(row.ETA).toBe(1_785_030_000_000);
  });

  it('defaults an unset provenance to mock rather than claiming live', () => {
    expect(toRequestRow(vessel('1', 'underway', { SOURCE: undefined })).SOURCE).toBe('mock');
  });

  it('keeps a null berth null instead of inventing one', () => {
    expect(toRequestRow(vessel('1')).BERTH_ID).toBeNull();
  });
});

describe('selectFleet', () => {
  const fleet = [
    vessel('A', 'moored'),
    vessel('B', 'underway'),
    vessel('C', 'approaching'),
    vessel('D', 'anchored'),
  ];

  it('always sends the focal vessel first, however low her priority', () => {
    expect(selectFleet(fleet, 'A', 4).map((v) => v.MMSI)).toEqual(['A', 'C', 'D', 'B']);
  });

  it('orders the rest by operational priority', () => {
    expect(selectFleet(fleet, 'B', 4).map((v) => v.MMSI)).toEqual(['B', 'C', 'D', 'A']);
  });

  it('keeps the focal vessel when the cap would otherwise drop her', () => {
    // The panel would be useless if it answered "she was not in the sample".
    expect(selectFleet(fleet, 'A', 2).map((v) => v.MMSI)).toEqual(['A', 'C']);
  });

  it('is stable — equal priorities keep feed order', () => {
    const twoMoored = [vessel('X', 'moored'), vessel('Y', 'moored')];
    expect(selectFleet(twoMoored, 'Z', 2).map((v) => v.MMSI)).toEqual(['X', 'Y']);
  });

  it('returns nothing for a non-positive cap', () => {
    expect(selectFleet(fleet, 'A', 0)).toEqual([]);
  });
});

describe('buildContext', () => {
  it('includes only values that are genuinely held', () => {
    expect(buildContext({ berthOccupancyPct: 68.2, windKn: null })).toEqual({
      berth_occupancy_pct: 68.2,
    });
  });

  it('omits an absent value rather than sending a zero placeholder', () => {
    // A 0 would be read as a measured calm/empty port, which is a different
    // claim from "we do not know" — and the service's own fallback is better.
    expect(buildContext({})).toEqual({});
    expect(buildContext({ windKn: undefined, tideM: null })).toEqual({});
  });

  it('passes a real zero through', () => {
    expect(buildContext({ windKn: 0 })).toEqual({ wind_kn: 0 });
  });
});

describe('indexByMmsi', () => {
  it('keys each vessel block by MMSI', () => {
    const map = indexByMmsi(response(['419000501', '419000502']));
    expect(map.get('419000502')?.call_id).toBe('C-0002');
  });

  it('falls back to the vessel name when a row carried no MMSI', () => {
    const res = response(['419000501']);
    res.dashboard.vessels[0].mmsi = '';
    expect(indexByMmsi(res).get('MV 419000501')).toBeDefined();
  });
});

describe('failedModels', () => {
  it('reports a model that failed, with its error', () => {
    const res = response(['1']);
    res.dashboard.run.models_failed = [{ model: 'UC1-M5', error: 'solver timeout' }];
    expect(failedModels(res)).toEqual(['UC1-M5 — solver timeout']);
  });

  it('is empty on a clean run', () => {
    expect(failedModels(response(['1']))).toEqual([]);
  });
});

describe('fetchFleetPredictions', () => {
  it('refuses an empty feed instead of calling the service', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchFleetPredictions([])).rejects.toThrow(/no vessels/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the projected rows and the context together', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => response(['419000501']),
    }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    await fetchFleetPredictions([vessel('419000501')], { berth_occupancy_pct: 68 });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as {
      vessels: Array<{ MMSI: string }>;
      context: Record<string, number>;
    };
    expect(body.vessels).toHaveLength(1);
    expect(body.vessels[0].MMSI).toBe('419000501');
    expect(body.context.berth_occupancy_pct).toBe(68);
  });
});
