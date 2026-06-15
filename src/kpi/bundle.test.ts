import { describe, it, expect } from 'vitest';
import { buildKpiBundle, type KpiInputs } from './bundle';
import { KPI_TARGETS } from '@/config/targets';
import type { BerthingPlanEntry, KpiSnapshot, PredictionPoint, Vessel } from '@/types/domain';

const H = 3_600_000;
const T0 = 1_700_000_000_000;

function vessel(mmsi: string, status: Vessel['NAV_STATUS']): Vessel {
  return {
    MMSI: mmsi,
    VESSEL_NAME: `V-${mmsi}`,
    VESSEL_TYPE: 'Container Ship',
    NAV_STATUS: status,
    SOG: 0,
    COG: 0,
    HEADING: 0,
    LAT: 18.95,
    LON: 72.95,
    ETA: null,
    BERTH_ID: null,
    TIMESTAMP: T0,
  };
}

function planEntry(over: Partial<BerthingPlanEntry>): BerthingPlanEntry {
  return {
    PLAN_ID: 'P1',
    BERTH_ID: 'B1',
    MMSI: '1',
    VESSEL_NAME: 'V',
    PLANNED_START: T0 - 10 * H,
    PLANNED_END: T0 - 2 * H,
    ACTUAL_START: T0 - 8 * H,
    ACTUAL_END: T0 - 1 * H,
    STATUS: 'completed',
    ...over,
  };
}

const snapshots: KpiSnapshot[] = [
  {
    TS: T0 - H,
    PRE_BERTH_DELAY: 2,
    PRE_SAIL_DELAY: 2,
    AVG_TAT: 25,
    JIT_PCT: 70,
    FORECAST_ACC: 88,
    BERTH_OCC: 70,
    ANCHORED: 3,
    APPROACHING: 6,
  },
  {
    TS: T0,
    PRE_BERTH_DELAY: 3,
    PRE_SAIL_DELAY: 1,
    AVG_TAT: 27,
    JIT_PCT: 80,
    FORECAST_ACC: 90,
    BERTH_OCC: 72,
    ANCHORED: 4,
    APPROACHING: 7,
  },
];

const predictions: PredictionPoint[] = [
  { MMSI: '1', VESSEL_NAME: 'V', predictedEta: T0 - 2 * H, actualAta: T0 - 2 * H },
];

function baseInputs(over: Partial<KpiInputs> = {}): KpiInputs {
  return {
    now: T0,
    vessels: [vessel('1', 'anchored'), vessel('2', 'approaching'), vessel('3', 'approaching')],
    plan: [planEntry({})],
    predictions,
    berthCount: 6,
    snapshots,
    windowHours: 24,
    ...over,
  };
}

describe('buildKpiBundle', () => {
  it('produces all eight KPI cards with correct keys, labels, units and targets', () => {
    const b = buildKpiBundle(baseInputs());
    const keys = Object.keys(b) as (keyof typeof b)[];
    expect(keys).toHaveLength(8);
    for (const k of keys) {
      expect(b[k].key).toBe(k);
      expect(b[k].label).toBe(KPI_TARGETS[k].label);
      expect(b[k].unit).toBe(KPI_TARGETS[k].unit);
      expect(b[k].target).toBe(KPI_TARGETS[k].target);
    }
  });

  it('counts anchored and approaching vessels from the live set', () => {
    const b = buildKpiBundle(baseInputs());
    expect(b.anchored.value).toBe(1);
    expect(b.approaching.value).toBe(2);
  });

  it('attaches trend series sourced from snapshots', () => {
    const b = buildKpiBundle(baseInputs());
    expect(b.jitPct.trend).toHaveLength(2);
    expect(b.jitPct.trend[1].value).toBe(80);
    expect(b.avgTat.trend.map((t) => t.value)).toEqual([25, 27]);
  });

  it('computes deltaPct against target', () => {
    const b = buildKpiBundle(baseInputs());
    // approaching value 2 vs target 8 → (2-8)/8*100 = -75
    expect(b.approaching.deltaPct).toBeCloseTo(-75, 5);
  });

  it('handles empty plan/predictions without throwing or NaN', () => {
    const b = buildKpiBundle(baseInputs({ plan: [], predictions: [] }));
    expect(b.preBerthingDelay.value).toBe(0);
    expect(b.jitPct.value).toBe(0);
    expect(b.forecastAccuracy.value).toBe(0);
    expect(Number.isNaN(b.avgTat.value)).toBe(false);
  });
});
