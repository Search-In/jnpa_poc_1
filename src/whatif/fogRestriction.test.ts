/**
 * UC-1 Ticket 2 — Fog / Night Navigation Restriction engine tests.
 *
 * The ticket's matrix in order: the strict < 1 km rule (0.5 / 0.8 / 0.99
 * trigger; exactly 1.0 and 2.0 do not); unavailable visibility; the night
 * condition reported unavailable (no day/night data exists in this repo);
 * delay arithmetic per call state; the operational plan untouched; repeat runs
 * not accumulating; selection validation; and publish-nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BerthingPlanEntry, WeatherReading } from '@/types/domain';
import {
  evaluateVisibility,
  NM_TO_KM,
  simulateFogRestriction,
  VISIBILITY_THRESHOLD_KM,
  type FogRestrictionResult,
} from './fogRestriction';

const H = 3_600_000;
const NOW = Date.UTC(2026, 7, 6, 12, 0, 0);

function entry(over: Partial<BerthingPlanEntry> = {}): BerthingPlanEntry {
  return {
    PLAN_ID: 'PLAN-1',
    BERTH_ID: 'GTI-1',
    MMSI: '419000123',
    VESSEL_NAME: 'MV Test',
    PLANNED_START: NOW + 4 * H,
    PLANNED_END: NOW + 12 * H,
    ACTUAL_START: null,
    ACTUAL_END: null,
    STATUS: 'scheduled',
    ...over,
  };
}

function reading(visibilityNm: number): WeatherReading {
  return { TS: NOW, windKt: 12, windDir: 220, seaStateM: 1.2, visibilityNm, tideM: 2.5 };
}

type Req = Partial<Parameters<typeof simulateFogRestriction>[2]>;

function runOk(
  plan: BerthingPlanEntry[],
  weather: WeatherReading | null,
  req?: Req
): FogRestrictionResult {
  const out = simulateFogRestriction(plan, weather, { mmsi: '419000123', now: NOW, ...req });
  if (out.kind !== 'result') throw new Error(`expected result, got ${out.error.code}: ${out.error.message}`);
  return out.result;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the < 1 km rule (strict)', () => {
  it('T1: visibility 0.5 km → restriction ACTIVE', () => {
    const r = runOk([entry()], null, { visibilityOverrideKm: 0.5, holdDurationH: 4 });
    expect(r.restriction.active).toBe(true);
    expect(r.simulated.navigation).toBe('RESTRICTED');
    expect(r.figures.restriction_active).toBe(true);
  });

  it('T1b: 0.8 km and 0.99 km also trigger', () => {
    for (const km of [0.8, 0.99]) {
      expect(evaluateVisibility(null, km).active).toBe(true);
    }
  });

  it('T2: visibility exactly 1.0 km → NOT triggered by the strict < 1 km rule', () => {
    const status = evaluateVisibility(null, 1.0);
    expect(status.active).toBe(false);
    const r = runOk([entry()], null, { visibilityOverrideKm: 1.0, holdDurationH: 4 });
    expect(r.restriction.active).toBe(false);
    expect(r.simulated.navigation).toBe('NORMAL');
    // No restriction → zero impact, schedule unchanged — a result, not a blank.
    expect(r.simulated.delayH).toBe(0);
    expect(r.simulated.eta).toBe(r.original.eta);
    expect(r.simulated.etd).toBe(r.original.etd);
    expect(r.data_available).toBe(true);
  });

  it('T3: visibility 2.0 km → no restriction', () => {
    const r = runOk([entry()], null, { visibilityOverrideKm: 2.0 });
    expect(r.restriction.active).toBe(false);
    expect(r.simulated.delayH).toBe(0);
  });

  it('measured readings convert NM → km before the rule (0.4 NM = 0.74 km → active)', () => {
    const r = runOk([entry()], reading(0.4), { holdDurationH: 2 });
    expect(r.restriction.visibilitySource).toBe('MEASURED');
    expect(r.restriction.visibilityNm).toBe(0.4);
    expect(r.restriction.visibilityKm).toBe(Number((0.4 * NM_TO_KM).toFixed(2)));
    expect(r.restriction.active).toBe(true);
  });

  it('a clear measured reading (8 NM ≈ 14.8 km) does not trigger', () => {
    const r = runOk([entry()], reading(8));
    expect(r.restriction.active).toBe(false);
    expect(r.restriction.thresholdKm).toBe(VISIBILITY_THRESHOLD_KM);
  });
});

describe('unavailable inputs', () => {
  it('T4: no visibility anywhere → explicit unavailable state, nothing fabricated', () => {
    const r = runOk([entry()], null);
    expect(r.restriction.active).toBeNull();
    expect(r.restriction.visibilityKm).toBeNull();
    expect(r.simulated.delayH).toBeNull();
    expect(r.data_available).toBe(false);
    const fields = r.unavailable.map((u) => u.field);
    expect(fields).toContain('visibility');
    expect(fields).toContain('schedule_impact');
  });

  it('T5: the night condition is reported unavailable on every result — no day/night data exists', () => {
    const clear = runOk([entry()], reading(8));
    const foggy = runOk([entry()], null, { visibilityOverrideKm: 0.5, holdDurationH: 4 });
    for (const r of [clear, foggy]) {
      const night = r.unavailable.find((u) => u.field === 'night_condition');
      expect(night).toBeDefined();
      expect(night?.reason).toMatch(/no sunrise\/sunset|day\/night/i);
    }
  });

  it('restriction active but duration unknown → restriction reported, impact honestly not calculable', () => {
    const r = runOk([entry()], null, { visibilityOverrideKm: 0.5 });
    expect(r.restriction.active).toBe(true);
    expect(r.simulated.delayH).toBeNull();
    expect(r.data_available).toBe(false);
    expect(r.unavailable.map((u) => u.field)).toContain('restriction_duration');
  });

  it('T7 (no schedule data): missing planned end → ETD null, not fabricated', () => {
    const r = runOk([entry({ PLANNED_END: 0 })], null, { visibilityOverrideKm: 0.5, holdDurationH: 4 });
    expect(r.original.etd).toBeNull();
    expect(r.simulated.etd).toBeNull();
    expect(r.unavailable.map((u) => u.field)).toContain('original_etd');
  });
});

describe('schedule impact arithmetic', () => {
  it('T6a: scheduled call (not berthed) shifts whole — ETA and ETD both +hold, turn preserved', () => {
    const p = entry();
    const r = runOk([p], null, { visibilityOverrideKm: 0.5, holdDurationH: 4 });
    expect(r.simulated.delayH).toBe(4);
    expect(r.simulated.eta).toBe(p.PLANNED_START + 4 * H);
    expect(r.simulated.etd).toBe(p.PLANNED_END + 4 * H);
    // Turn preserved: simulated alongside interval equals the original.
    expect(r.simulated.etd! - r.simulated.eta!).toBe(p.PLANNED_END - p.PLANNED_START);
  });

  it('T6b: vessel alongside — only the departure is held', () => {
    const p = entry({
      PLANNED_START: NOW - 6 * H,
      PLANNED_END: NOW + 2 * H,
      ACTUAL_START: NOW - 5 * H,
      STATUS: 'active',
    });
    const r = runOk([p], null, { visibilityOverrideKm: 0.5, holdDurationH: 3 });
    expect(r.simulated.eta).toBe(p.ACTUAL_START); // already berthed — unchanged
    expect(r.simulated.etd).toBe(p.PLANNED_END + 3 * H);
    expect(r.simulated.delayH).toBe(3);
    // Deviation: was +1h at berthing; +3h hold → +4h.
    expect(r.original.scheduleDeviationH).toBe(1);
    expect(r.simulated.scheduleDeviationH).toBe(4);
  });

  it('T6c / T8-zero: departed call → zero impact, shown as a result', () => {
    const p = entry({
      PLANNED_START: NOW - 20 * H,
      PLANNED_END: NOW - 10 * H,
      ACTUAL_START: NOW - 19 * H,
      ACTUAL_END: NOW - 9 * H,
      STATUS: 'completed',
    });
    const r = runOk([p], null, { visibilityOverrideKm: 0.5, holdDurationH: 4 });
    expect(r.simulated.delayH).toBe(0);
    expect(r.simulated.etd).toBe(p.ACTUAL_END);
    expect(r.data_available).toBe(true);
    expect(r.notes.join(' ')).toMatch(/already departed/i);
  });

  it('downstream: the delayed departure’s overrun into the next call at the berth is bounded and reported', () => {
    const p = entry(); // ends NOW+12h; +4h hold → sim ETD NOW+16h
    const next = entry({
      PLAN_ID: 'PLAN-NEXT',
      MMSI: '555000111',
      VESSEL_NAME: 'MV Behind',
      PLANNED_START: NOW + 14 * H, // 2h inside the delayed occupation
      PLANNED_END: NOW + 22 * H,
    });
    const r = runOk([p, next], null, { visibilityOverrideKm: 0.5, holdDurationH: 4 });
    expect(r.downstream.laterCallsAtBerth.map((c) => c.planId)).toEqual(['PLAN-NEXT']);
    expect(r.downstream.nextCallKnockOnH).toBe(2);
    expect(r.figures.next_call_knock_on_hours).toBe(2);
  });
});

describe('non-destructive guarantees', () => {
  it('T7: the operational plan is unchanged — frozen input, byte-equal after the run', () => {
    const plan = [entry(), entry({ PLAN_ID: 'PLAN-2', MMSI: '999', PLANNED_START: NOW, PLANNED_END: NOW + 8 * H })];
    const weather = reading(0.3);
    const snapshot = structuredClone(plan);
    const weatherSnapshot = structuredClone(weather);
    plan.forEach((p) => Object.freeze(p));
    Object.freeze(plan);
    Object.freeze(weather);
    runOk(plan, weather, { holdDurationH: 4 });
    expect(plan).toEqual(snapshot);
    expect(weather).toEqual(weatherSnapshot);
  });

  it('T8: repeated simulation does not accumulate — identical inputs, identical results', () => {
    const plan = [entry()];
    const first = runOk(plan, null, { visibilityOverrideKm: 0.5, holdDurationH: 4 });
    const second = runOk(plan, null, { visibilityOverrideKm: 0.5, holdDurationH: 4 });
    expect(second).toEqual(first);
    // And the delay is the hold, not hold × runs.
    expect(second.simulated.delayH).toBe(4);
  });

  it('T10: the simulation publishes nothing — no network, no broadcast, no storage write', () => {
    const fetchSpy = vi.fn();
    const bcSpy = vi.fn();
    const storageSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('BroadcastChannel', bcSpy);
    vi.stubGlobal('sessionStorage', { setItem: storageSpy, getItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal('localStorage', { setItem: storageSpy, getItem: vi.fn(), removeItem: vi.fn() });

    runOk([entry()], reading(0.3), { holdDurationH: 4 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(bcSpy).not.toHaveBeenCalled();
    expect(storageSpy).not.toHaveBeenCalled();
  });
});

describe('validation', () => {
  it('T9a: vessel without a JNPA call → clear validation error', () => {
    const out = simulateFogRestriction([entry()], null, { mmsi: '000000000', now: NOW });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.error.code).toBe('NO_JNPA_CALL');
  });

  it('T9b: wrong call id → CALL_NOT_FOUND with the valid candidates', () => {
    const out = simulateFogRestriction([entry()], null, { mmsi: '419000123', planId: 'PLAN-X', now: NOW });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') {
      expect(out.error.code).toBe('CALL_NOT_FOUND');
      expect(out.error.candidates?.map((c) => c.planId)).toEqual(['PLAN-1']);
    }
  });

  it('T9c: multiple JNPA calls → the engine refuses to guess; explicit selection works', () => {
    const a = entry({ PLAN_ID: 'PLAN-A' });
    const b = entry({ PLAN_ID: 'PLAN-B', PLANNED_START: NOW + 20 * H, PLANNED_END: NOW + 28 * H });
    const ambiguous = simulateFogRestriction([a, b], null, { mmsi: '419000123', now: NOW });
    expect(ambiguous.kind).toBe('error');
    if (ambiguous.kind === 'error') expect(ambiguous.error.code).toBe('AMBIGUOUS_CALL');
    const r = runOk([a, b], null, { planId: 'PLAN-B', visibilityOverrideKm: 0.5, holdDurationH: 2 });
    expect(r.call.planId).toBe('PLAN-B');
  });

  it('T9d: a cancelled call cannot be impacted', () => {
    const out = simulateFogRestriction([entry({ STATUS: 'cancelled' })], null, { mmsi: '419000123', now: NOW });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.error.code).toBe('CALL_CANCELLED');
  });
});
