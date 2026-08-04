import { describe, it, expect } from 'vitest';
import { ASSUMPTIONS, OSS } from './assumptions';
import {
  BUNKER_USD_PER_T,
  CO2_T_PER_FUEL_T,
  DEMO_JIT_INPUTS,
  FUEL_T_PER_H_AT_SERVICE,
  SERVICE_SPEED_KN,
} from '@/planning/jit';

const byId = (id: string) => ASSUMPTIONS.find((a) => a.id === id);

describe('assumptions register — integrity', () => {
  it('has unique ids', () => {
    const ids = ASSUMPTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never renders a blank cell — every row is fully populated', () => {
    for (const a of ASSUMPTIONS) {
      for (const field of ['id', 'label', 'value', 'source', 'use'] as const) {
        expect(a[field].trim(), `${a.id}.${field}`).not.toBe('');
      }
    }
  });

  it('states a source for every figure, so none reads as an unattributed claim', () => {
    for (const a of ASSUMPTIONS) expect(a.source.length).toBeGreaterThan(15);
  });
});

/**
 * The drift guard. `jit.ts` used to claim its constants were "documented in the
 * assumptions register" while they were absent — a comment asserting
 * documentation that did not exist. The register now interpolates the constants,
 * and these tests fail if a value is changed in one place only.
 */
describe('assumptions register — JIT constants cannot drift from the code', () => {
  it('publishes every bunker/emission factor with its live value', () => {
    expect(byId('jitFuelRate')?.value).toContain(String(FUEL_T_PER_H_AT_SERVICE));
    expect(byId('jitServiceSpeed')?.value).toContain(String(SERVICE_SPEED_KN));
    expect(byId('jitCo2Factor')?.value).toContain(String(CO2_T_PER_FUEL_T));
    expect(byId('jitBunkerPrice')?.value).toContain(String(BUNKER_USD_PER_T));
  });

  it('publishes the fuel-vs-speed law, not just the factors', () => {
    // Without the law, a reader cannot reproduce the saving from the factors.
    expect(byId('jitSpeedLaw')?.value).toMatch(/cube|³/i);
  });

  it('publishes all four demo-fixed advisory inputs', () => {
    const row = byId('jitDemoInputs');
    expect(row).toBeDefined();
    for (const v of Object.values(DEMO_JIT_INPUTS)) {
      expect(row!.value).toContain(String(v));
    }
    // …and names where each would come from in production, so "demo-fixed" is
    // not left as an unexplained label.
    expect(row!.use).toMatch(/berth plan/i);
    expect(row!.use).toMatch(/DUKC/i);
    expect(row!.use).toMatch(/AIS/i);
  });

  it('discloses the what-if model, including that it runs in live mode too', () => {
    const row = byId('whatIfModel');
    expect(row?.value).toMatch(/linear/i);
    expect(row?.use).toMatch(/live mode/i);
  });
});

describe('open-source register', () => {
  it('names a licence and a role for every component', () => {
    for (const o of OSS) {
      expect(o.name.trim()).not.toBe('');
      expect(o.license.trim()).not.toBe('');
      expect(o.role.trim()).not.toBe('');
    }
  });
});
