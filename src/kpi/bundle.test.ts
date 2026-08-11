import { describe, it, expect } from 'vitest';
import { buildKpiBundle, type KpiInputs } from './bundle';
import { KPI_TARGETS } from '@/config/targets';
import { KPI_ANATOMY } from '@/config/kpiAnatomy';
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
    craftJobs: [
      { type: 'pilot', deployed: true, responseMin: 12 },
      { type: 'tug', deployed: false, responseMin: 14 },
      { type: 'mooring', deployed: true, responseMin: 8 },
    ],
    provenance: 'SIM',
    ...over,
  };
}

describe('buildKpiBundle', () => {
  it('produces all eight tender KPI cards with anatomy (UC1-042)', () => {
    const b = buildKpiBundle(baseInputs());
    const keys = Object.keys(b) as (keyof typeof b)[];
    expect(keys).toHaveLength(8);
    for (const k of keys) {
      expect(b[k].key).toBe(k);
      expect(b[k].label).toBe(KPI_TARGETS[k].label);
      expect(b[k].label).toBe(KPI_ANATOMY[k].name);
      expect(b[k].unit).toBe(KPI_TARGETS[k].unit);
      expect(b[k].target).toBe(KPI_TARGETS[k].target);
      expect(b[k].definition).toBeTruthy();
      expect(b[k].basis).toBeTruthy();
      expect(b[k].baselineSource).toBeTruthy();
      expect(b[k].provenance).toBe('SIM');
      expect(b[k].sampleN).toBeGreaterThan(0);
      // Never a bare number: unit present (or vessels) + baseline statement.
      expect(b[k].unit.length).toBeGreaterThan(0);
    }
  });

  it('combines anchored and approaching into one card with breakdown', () => {
    const b = buildKpiBundle(baseInputs());
    expect(b.anchored.value).toBe(3);
    expect(b.anchored.breakdown).toBe('1 anchored · 2 approaching');
    expect(b.anchored.label).toBe('Anchored / Approaching');
  });

  it('computes Port Craft Optimization utilisation', () => {
    const b = buildKpiBundle(baseInputs());
    // 2 of 3 deployed across types averaged: pilot 100%, tug 0%, mooring 100% → 66.7
    expect(b.portCraftOptimization.value).toBeCloseTo(66.7, 0);
    expect(b.portCraftOptimization.unit).toBe('%');
  });

  it('attaches trend series sourced from snapshots', () => {
    const b = buildKpiBundle(baseInputs());
    expect(b.jitPct.trend).toHaveLength(2);
    expect(b.jitPct.trend[1].value).toBe(80);
    expect(b.avgTat.trend.map((t) => t.value)).toEqual([25, 27]);
  });

  it('computes deltaPct against target and attaches p50/p90 for TAT', () => {
    const b = buildKpiBundle(baseInputs());
    // avgTat: ACTUAL_END-ACTUAL_START = 7h vs target 24 → (7-24)/24*100
    expect(b.avgTat.p50).toBe(7);
    expect(b.avgTat.p90).toBe(7);
    expect(b.avgTat.deltaPct).toBeCloseTo(((7 - 24) / 24) * 100, 0);
  });

  it('renders unmeasurable dash anatomy when samples are empty (n=0 + note)', () => {
    const b = buildKpiBundle(
      baseInputs({ plan: [], predictions: [], craftJobs: [], vessels: [] }),
    );
    expect(b.preBerthingDelay.sampleN).toBe(0);
    expect(b.preBerthingDelay.note).toMatch(/not measurable/i);
    expect(b.jitPct.sampleN).toBe(0);
    expect(b.portCraftOptimization.sampleN).toBe(0);
    expect(b.anchored.sampleN).toBe(0);
  });
});
