/**
 * marineDashboard connector — pure mapper tests (no network, no fetch stub),
 * matching the convention of the sibling uc3 connector tests.
 */
import { describe, expect, it } from 'vitest';
import {
  mapEnvelope,
  parseKpiBaselines,
  parseArrDep,
  parseArrivalTimes,
  parseBerths,
  parseKpis,
  parsePilotPerformance,
  parsePlan,
  parseTides,
  parseVesselStates,
} from './marineDashboard';
import { nearestTide } from '../Uc3Adapter';

describe('mapEnvelope', () => {
  it('maps the provenance envelope and defaults to NO_DATA', () => {
    expect(mapEnvelope(null).dataMode).toBe('NO_DATA');
    const e = mapEnvelope({
      data_mode: 'CACHED', source: 'corpus',
      observed_at: '2026-06-09T08:30:00+00:00', as_of: '2026-06-09T08:30:00+00:00',
    });
    expect(e.dataMode).toBe('CACHED');
    expect(e.observedAt).toBeGreaterThan(0);
    expect(e.asOf).toBe(e.observedAt);
  });
});

describe('parseBerths', () => {
  it('maps berth states and drops rows without id/code', () => {
    const res = parseBerths({
      data_mode: 'CACHED', source: 's', occupied: 1,
      items: [
        { berth_id: 7, code: 'APM01', terminal: 'APMT', terminal_name: 'APM Terminals',
          operator: 'APM', length_m: 356, design_depth_m: 15, dimensions_assumed: true,
          state: 'occupied-working', vessel_name: 'TAYMA EXPRESS',
          alongside_since: '2026-06-07T13:18:00+00:00' },
        { berth_id: null, code: '' },
      ],
    });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].state).toBe('occupied-working');
    expect(res.items[0].dimensionsAssumed).toBe(true);
    expect(res.items[0].alongsideSince).toBeGreaterThan(0);
    expect(res.occupied).toBe(1);
  });
});

describe('parsePlan', () => {
  it('keeps confirmed vs indicative and the estimated-end flag', () => {
    const res = parsePlan({
      data_mode: 'CACHED', source: 's',
      window: { start: '2026-06-08T00:00:00Z', end: '2026-06-13T00:00:00Z',
                anchor: '2026-06-09T00:00:00Z' },
      entries: [
        { kind: 'confirmed', source: 'reports', berth_code: 'APM01',
          vessel_name: 'A', start_ts: '2026-06-08T10:00:00Z',
          end_ts: '2026-06-09T10:00:00Z', end_estimated: false, ref: 'berthing_record:1' },
        { kind: 'indicative', source: 'PCS', berth_code: '',
          vessel_name: 'B', start_ts: '2026-06-10T10:00:00Z',
          end_ts: null, end_estimated: true, ref: 'vessel_call:9' },
        { kind: 'confirmed', start_ts: null }, // undated — dropped
      ],
    });
    expect(res.entries).toHaveLength(2);
    expect(res.entries[0].kind).toBe('confirmed');
    expect(res.entries[1].kind).toBe('indicative');
    expect(res.entries[1].endEstimated).toBe(true);
    expect(res.anchor).toBeGreaterThan(res.windowStart);
  });
});

describe('parseKpis', () => {
  it('maps card anatomy including the measurability note', () => {
    const res = parseKpis({
      data_mode: 'CACHED', source: 's', window: { days: 30, anchor: '2026-06-09T00:00:00Z' },
      kpis: [{
        key: 'PRE_BERTH_DELAY', name: 'Pre-Berthing Delay', value: null, median: null,
        unit: 'h', n: 0, definition: 'def', basis: 'basis', baseline_source: 'no baseline',
        note: 'not measurable', series: [{ t: '2026-06-01T00:00:00Z', v: 1.5 }],
      }],
    });
    expect(res.kpis[0].value).toBeNull();
    expect(res.kpis[0].note).toBe('not measurable');
    expect(res.kpis[0].baseline).toBeNull();
    expect(res.kpis[0].vsBaselinePct).toBeNull();
    expect(res.kpis[0].series).toEqual([{ ts: Date.parse('2026-06-01T00:00:00Z'), value: 1.5 }]);
  });

  it('maps the JNPA-published baseline block and the vs-baseline delta', () => {
    const res = parseKpis({
      data_mode: 'CACHED', source: 's', window: { days: 30, anchor: '2026-06-09T00:00:00Z' },
      kpis: [{
        key: 'AVG_TAT', name: 'Average Vessel Turnaround', value: 27.01, median: null,
        unit: 'h', n: 44, definition: 'def', basis: 'basis',
        baseline_source: 'JNPA published baseline 27.36 h (FY 2025-26) — Operating Performance Profile',
        vs_baseline_pct: -1.3,
        baseline: {
          value: 27.36, unit: 'h', period: 'FY 2025-26',
          previous_value: 26.4, previous_period: 'FY 2024-25',
          source: 'JNPA Operating Performance Profile', url: 'https://www.jnport.gov.in/…',
          notes: 'pilot boarding to de-boarding',
        },
        note: null, series: [],
      }],
    });
    const k = res.kpis[0];
    expect(k.vsBaselinePct).toBe(-1.3);
    expect(k.baseline?.value).toBe(27.36);
    expect(k.baseline?.period).toBe('FY 2025-26');
    expect(k.baseline?.previousValue).toBe(26.4);
    expect(k.baselineSource).toContain('JNPA published baseline');
  });
});

describe('parseKpiBaselines', () => {
  it('keys the register by KPI and keeps null published values', () => {
    const map = parseKpiBaselines({
      items: [
        { kpi_key: 'BERTH_OCC', baseline_value: 64.16, unit: '%', period: 'FY 2025-26',
          previous_value: 65.05, previous_period: 'FY 2024-25',
          source_document: 'JNPA Operating Performance Profile', source_url: 'u', notes: '' },
        { kpi_key: 'PORT_CRAFT', baseline_value: null, unit: 'movements/pilot/day',
          period: null, source_document: 'JNPA Operating Performance Profile',
          notes: 'no published figure' },
      ],
    });
    expect(map.get('BERTH_OCC')?.value).toBe(64.16);
    expect(map.get('PORT_CRAFT')?.value).toBeNull();
    expect(map.get('PORT_CRAFT')?.notes).toContain('no published');
  });
});

describe('parseVesselStates', () => {
  it('maps ledger states and drops unnamed rows', () => {
    const res = parseVesselStates({
      data_mode: 'CACHED', source: 's',
      items: [
        { vessel_name: 'MSC REEF', imo_no: '9', state: 'alongside',
          berth_code: 'BMCT04', eta: '2026-06-08T00:00:00Z' },
        { vessel_name: '', imo_no: '' },
      ],
    });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].state).toBe('alongside');
  });
});

describe('parseArrivalTimes', () => {
  it('keeps all six rows with 0 for corpus-absent definitions', () => {
    const res = parseArrivalTimes({
      data_mode: 'CACHED', source: 's', call_id: 21, vcn: 'INNSA1NS0R2893',
      arrival_times: [
        { key: 'proforma_eta', label: 'Proforma ETA', value: null, source: null,
          derived: false, note: 'not present in the shared corpus' },
        { key: 'declared_eta', label: 'Declared ETA (PCS)',
          value: '2026-02-11T11:30:00+00:00', source: 'PCS CALINF/BERMAN (EDTA)',
          derived: false, note: null },
      ],
      actuals: { ata: null, atc: null, atd: null },
    });
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0].value).toBe(0);
    expect(res.rows[0].note).toContain('not present');
    expect(res.rows[1].value).toBeGreaterThan(0);
    expect(res.rows[1].source).toContain('CALINF');
  });
});

describe('parseArrDep / parsePilotPerformance / parseTides', () => {
  it('maps blocks, distribution rows and tide readings', () => {
    const ad = parseArrDep({
      data_mode: 'CACHED', source: 's', bucket_hours: 4,
      blocks: [{ bucket_start: '2026-06-08T00:00:00Z', arrivals: 3, departures: 1 }],
    });
    expect(ad.blocks[0].arrivals).toBe(3);

    const perf = parsePilotPerformance({
      data_mode: 'CACHED', source: 's', metric: 'm', movement: 'INWARD',
      overall: { pilot_code: null, n: 115, median_min: 111, p90_min: 149.2,
                 min_min: 32, max_min: 310 },
      per_pilot: [{ pilot_code: 'JP 91', n: 12, median_min: 100, p90_min: 140,
                    min_min: 60, max_min: 200 }],
    });
    expect(perf.overall?.n).toBe(115);
    expect(perf.perPilot[0].pilotCode).toBe('JP 91');

    const tides = parseTides({
      data_mode: 'CACHED', source: 's', datum: 'chart datum',
      items: [{ tide_ts: '2026-06-08T04:50:00+05:30', height_m: 3.1, source_terminal: 'APMT' }],
    });
    expect(tides.items[0].heightM).toBe(3.1);
  });
});

describe('nearestTide', () => {
  const rows = [
    { tideTs: 1_000_000, heightM: 1.0, sourceTerminal: 'APMT' },
    { tideTs: 2_000_000, heightM: 2.0, sourceTerminal: 'APMT' },
  ];
  it('picks the closest reading', () => {
    expect(nearestTide(rows, 1_800_000)?.heightM).toBe(2.0);
  });
  it('returns null beyond the ±8 h window', () => {
    expect(nearestTide(rows, 2_000_000 + 9 * 3_600_000)).toBeNull();
  });
});
