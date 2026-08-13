/**
 * UC-1 — Vessel Omission engine tests.
 *
 * The matrix from the use-case brief, in order: a valid run succeeds; the call
 * is omitted only in the RESULT; the operational plan is untouched; recovered
 * time and the downstream recalculation are arithmetic-checked; a vessel with
 * no JNPA call, an invalid vessel/call, missing schedule inputs, multiple JNPA
 * calls and the no-recovery case all behave; and running the simulation
 * publishes nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BerthingPlanEntry } from '@/types/domain';
import {
  DEFAULT_DOWNSTREAM_HORIZON_H,
  jnpaCallsFor,
  simulateVesselOmission,
  type VesselOmissionResult,
} from './vesselOmission';

const H = 3_600_000;
/** Fixed evaluation instant — the engine takes `now` as an input, so tests are deterministic. */
const NOW = Date.UTC(2026, 7, 6, 12, 0, 0); // 06 Aug 2026 12:00Z

/** A plan entry with sane defaults, overridable per test. */
function entry(over: Partial<BerthingPlanEntry> = {}): BerthingPlanEntry {
  return {
    PLAN_ID: 'PLAN-1',
    BERTH_ID: 'GTI-1',
    MMSI: '419000123',
    VESSEL_NAME: 'MV Test',
    PLANNED_START: NOW - 10 * H,
    PLANNED_END: NOW - 2 * H,
    ACTUAL_START: null,
    ACTUAL_END: null,
    STATUS: 'scheduled',
    ...over,
  };
}

function runOk(plan: BerthingPlanEntry[], req?: Partial<Parameters<typeof simulateVesselOmission>[1]>): VesselOmissionResult {
  const out = simulateVesselOmission(plan, { mmsi: '419000123', now: NOW, ...req });
  if (out.kind !== 'result') throw new Error(`expected a result, got error ${out.error.code}: ${out.error.message}`);
  return out.result;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('simulateVesselOmission — valid runs', () => {
  it('T1: valid vessel + valid JNPA call → simulation succeeds with the answer populated', () => {
    const r = runOk([entry()]);
    expect(r.scenario).toBe('vessel-omission');
    expect(r.data_available).toBe(true);
    expect(r.vessel).toEqual({ mmsi: '419000123', name: 'MV Test' });
    expect(r.omittedCall.planId).toBe('PLAN-1');
    expect(r.executedAt).toBe(NOW);
    // Scheduled call, no actuals: recovered = planned window = 8 h.
    expect(r.recoveredH).toBe(8);
    expect(r.figures.recovered_hours).toBe(8);
  });

  it('T2: the call is OMITTED in the simulation result only — the input entry keeps its status', () => {
    const plan = [entry()];
    const r = runOk(plan);
    expect(r.simulated.callStatus).toBe('OMITTED');
    expect(r.figures.jnpa_call_status).toBe('OMITTED');
    // The operational record still says 'scheduled' — omission never leaks out of the result.
    expect(plan[0]!.STATUS).toBe('scheduled');
  });

  it('T3: the operational plan is unchanged — engine cannot and does not mutate its input', () => {
    const plan = [
      entry(),
      entry({ PLAN_ID: 'PLAN-2', MMSI: '999', VESSEL_NAME: 'Other', PLANNED_START: NOW, PLANNED_END: NOW + 8 * H }),
    ];
    const snapshot = structuredClone(plan);
    // Frozen input: any attempted write would throw, not just be detectable.
    plan.forEach((p) => Object.freeze(p));
    Object.freeze(plan);
    runOk(plan);
    expect(plan).toEqual(snapshot);
  });

  it('T4: recovered time = original departure − pass-by (ATD present, late berthing)', () => {
    // Planned 10:00→18:00-style window; berthed 2 h late, departed 3 h late.
    const p = entry({
      ACTUAL_START: NOW - 8 * H, // 2 h after planned start
      ACTUAL_END: NOW + 1 * H,   // 3 h after planned end
      STATUS: 'completed',
    });
    const r = runOk([p]);
    // pass-by = min(plannedStart, actualStart) = plannedStart (NOW−10h);
    // departure = ATD (NOW+1h) → recovered = 11 h.
    expect(r.simulated.passBy).toBe(p.PLANNED_START);
    expect(r.original.departure).toBe(p.ACTUAL_END);
    expect(r.recoveredH).toBe(11);
    // Deviation: was +3 h late; omission puts it 11 h ahead of that → −8 h vs plan.
    expect(r.original.scheduleDeviationH).toBe(3);
    expect(r.simulated.scheduleDeviationH).toBe(-8);
    expect(r.figures.next_port_eta_shift_hours).toBe(-11);
  });

  it('T5: downstream — the next call at the freed berth is recalculated, bounded by berth availability', () => {
    const omitted = entry(); // GTI-1, NOW−10h → NOW−2h, recovered 8 h
    const next = entry({
      PLAN_ID: 'PLAN-NEXT',
      MMSI: '555000111',
      VESSEL_NAME: 'MV Behind',
      PLANNED_START: NOW + 2 * H, // 12 h after the freed start
      PLANNED_END: NOW + 10 * H,
    });
    const otherBerth = entry({
      PLAN_ID: 'PLAN-ELSEWHERE',
      BERTH_ID: 'BMCT-1',
      MMSI: '555000222',
      PLANNED_START: NOW,
      PLANNED_END: NOW + 8 * H,
    });
    const r = runOk([omitted, next, otherBerth]);
    expect(r.downstream.berthId).toBe('GTI-1');
    expect(r.downstream.laterCallsAtBerth.map((c) => c.planId)).toEqual(['PLAN-NEXT']);
    // Advance is capped by the recovered time (8 h), not the 12 h head start.
    expect(r.downstream.nextCallPotentialAdvanceH).toBe(8);
    expect(r.figures.downstream_calls_at_berth).toBe(1);
    // Freed window is exactly the original occupation.
    expect(r.downstream.berthFreedFrom).toBe(omitted.PLANNED_START);
    expect(r.downstream.berthFreedTo).toBe(omitted.PLANNED_END);
  });

  it('T5b: downstream horizon parameter bounds the berth queue scan', () => {
    const omitted = entry();
    const farAway = entry({
      PLAN_ID: 'PLAN-FAR',
      MMSI: '555000333',
      PLANNED_START: omitted.PLANNED_START + (DEFAULT_DOWNSTREAM_HORIZON_H + 10) * H,
      PLANNED_END: omitted.PLANNED_START + (DEFAULT_DOWNSTREAM_HORIZON_H + 18) * H,
    });
    const r = runOk([omitted, farAway]);
    expect(r.downstream.laterCallsAtBerth).toEqual([]);
    expect(r.downstream.nextCallPotentialAdvanceH).toBeNull();
  });
});

describe('simulateVesselOmission — validation', () => {
  it('T6: vessel without a JNPA call → clear validation error, no result', () => {
    const out = simulateVesselOmission([entry()], { mmsi: '000000000', now: NOW });
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.code).toBe('NO_JNPA_CALL');
    expect(out.error.message).toMatch(/does not have a JNPA port call/i);
  });

  it('T7: a call id that does not belong to the vessel → proper error with the valid candidates', () => {
    const out = simulateVesselOmission([entry()], { mmsi: '419000123', planId: 'PLAN-WRONG', now: NOW });
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.code).toBe('CALL_NOT_FOUND');
    expect(out.error.candidates?.map((c) => c.planId)).toEqual(['PLAN-1']);
  });

  it('T7b: an already-cancelled call cannot be omitted again', () => {
    const out = simulateVesselOmission([entry({ STATUS: 'cancelled' })], { mmsi: '419000123', now: NOW });
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.error.code).toBe('ALREADY_CANCELLED');
  });

  it('T8: missing schedule input → the figure is null with a stated reason, never fabricated', () => {
    // Live-feed convention: 0 = unknown. No end time anywhere on the entry.
    const p = entry({ PLANNED_END: 0, ACTUAL_START: null, ACTUAL_END: null });
    const r = runOk([p]);
    expect(r.data_available).toBe(false);
    expect(r.recoveredH).toBeNull();
    expect(r.figures.recovered_hours).toBeNull();
    expect(r.original.departure).toBeNull();
    const fields = r.unavailable.map((u) => u.field);
    expect(fields).toContain('original_departure');
    expect(fields).toContain('recovered_time');
    // No numeric figure pretends to be a recovery.
    expect(Object.values(r.figures).every((v) => typeof v !== 'number' || Number.isFinite(v))).toBe(true);
  });

  it('T9: multiple JNPA calls → engine refuses to guess; the explicitly selected call is simulated', () => {
    const first = entry({ PLAN_ID: 'PLAN-A' });
    const second = entry({
      PLAN_ID: 'PLAN-B',
      BERTH_ID: 'GTI-2',
      PLANNED_START: NOW + 20 * H,
      PLANNED_END: NOW + 26 * H,
    });
    const ambiguous = simulateVesselOmission([first, second], { mmsi: '419000123', now: NOW });
    expect(ambiguous.kind).toBe('error');
    if (ambiguous.kind === 'error') {
      expect(ambiguous.error.code).toBe('AMBIGUOUS_CALL');
      expect(ambiguous.error.candidates?.map((c) => c.planId)).toEqual(['PLAN-A', 'PLAN-B']);
    }
    const r = runOk([first, second], { planId: 'PLAN-B' });
    expect(r.omittedCall.planId).toBe('PLAN-B');
    expect(r.omittedCall.berthId).toBe('GTI-2');
    expect(r.recoveredH).toBe(6); // PLAN-B's own 6 h window, not PLAN-A's 8 h
  });
});

describe('simulateVesselOmission — non-destructive guarantees', () => {
  it('T10: the simulation publishes nothing — no network, no broadcast, no storage write', () => {
    const fetchSpy = vi.fn();
    const bcSpy = vi.fn();
    const storageSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('BroadcastChannel', bcSpy);
    vi.stubGlobal('sessionStorage', { setItem: storageSpy, getItem: vi.fn(), removeItem: vi.fn() });
    vi.stubGlobal('localStorage', { setItem: storageSpy, getItem: vi.fn(), removeItem: vi.fn() });

    runOk([entry()]);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(bcSpy).not.toHaveBeenCalled();
    expect(storageSpy).not.toHaveBeenCalled();
  });

  it('T-zero: zero recovery is a result, not an error (degenerate window)', () => {
    // Departure equal to the pass-by instant: nothing to recover, still answered.
    const p = entry({ PLANNED_END: entry().PLANNED_START });
    const r = runOk([p]);
    expect(r.data_available).toBe(true);
    expect(r.recoveredH).toBe(0);
    expect(r.figures.next_port_eta_shift_hours).toBe(-0);
  });
});

describe('jnpaCallsFor', () => {
  it('returns the vessel’s calls earliest-first and leaves the plan order alone', () => {
    const late = entry({ PLAN_ID: 'PLAN-LATE', PLANNED_START: NOW + 30 * H, PLANNED_END: NOW + 36 * H });
    const early = entry({ PLAN_ID: 'PLAN-EARLY' });
    const plan = [late, early];
    const calls = jnpaCallsFor(plan, '419000123');
    expect(calls.map((c) => c.PLAN_ID)).toEqual(['PLAN-EARLY', 'PLAN-LATE']);
    expect(plan.map((c) => c.PLAN_ID)).toEqual(['PLAN-LATE', 'PLAN-EARLY']);
  });
});
