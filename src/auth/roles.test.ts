import { describe, it, expect } from 'vitest';
import { scopeData, canEdit, ROLES, type ScopeInput } from './roles';
import type { Berth, BerthingPlanEntry, PortCraftUnit, Vessel } from '@/types/domain';

function berth(id: string, terminal: string): Berth {
  return {
    BERTH_ID: id,
    BERTH_NAME: `${terminal}-${id}`,
    TERMINAL: terminal,
    LENGTH_M: 350,
    DRAFT_M: 15,
    STATUS: 'available',
    GEOM: [],
  };
}
function entry(planId: string, berthId: string, mmsi: string): BerthingPlanEntry {
  return {
    PLAN_ID: planId,
    BERTH_ID: berthId,
    MMSI: mmsi,
    VESSEL_NAME: `V-${mmsi}`,
    PLANNED_START: 1_700_000_000_000,
    PLANNED_END: 1_700_000_000_000 + 12 * 3_600_000,
    ACTUAL_START: null,
    ACTUAL_END: null,
    STATUS: 'scheduled',
  };
}
function vessel(mmsi: string): Vessel {
  return {
    MMSI: mmsi,
    VESSEL_NAME: `V-${mmsi}`,
    VESSEL_TYPE: 'Container Ship',
    NAV_STATUS: 'underway',
    SOG: 8,
    COG: 90,
    HEADING: 90,
    LAT: 18.95,
    LON: 72.95,
    ETA: null,
    BERTH_ID: null,
    TIMESTAMP: 1_700_000_000_000,
  };
}
function craft(id: string, mmsi: string | null): PortCraftUnit {
  return {
    CRAFT_ID: id,
    TYPE: 'pilot',
    STATUS: mmsi ? 'deployed' : 'idle',
    ASSIGNED_MMSI: mmsi,
    DEPLOYED_AT: null,
    RESPONSE_MIN: null,
  };
}

const data: ScopeInput = {
  berths: [berth('B1', 'NSICT'), berth('B2', 'NSICT'), berth('B3', 'BMCT')],
  plan: [entry('P1', 'B1', '111'), entry('P2', 'B3', '222')],
  vessels: [vessel('111'), vessel('222'), vessel('333')],
  craft: [craft('PIL-1', '111'), craft('PIL-2', '222')],
};

describe('scopeData — role matrix', () => {
  it('Marine Ops sees everything, unscoped', () => {
    const r = scopeData('marineOps', {}, data);
    expect(r.berths).toHaveLength(3);
    expect(r.vessels).toHaveLength(3);
    expect(r.scoped).toBe(false);
  });

  it('Viewer sees everything but cannot edit', () => {
    const r = scopeData('viewer', {}, data);
    expect(r.berths).toHaveLength(3);
    expect(canEdit('viewer')).toBe(false);
  });

  it('Terminal operator sees only own-terminal berths + their calls', () => {
    const r = scopeData('terminal', { terminal: 'NSICT' }, data);
    expect(r.berths.map((b) => b.BERTH_ID).sort()).toEqual(['B1', 'B2']);
    expect(r.plan.map((p) => p.PLAN_ID)).toEqual(['P1']); // P2 is on BMCT
    expect(r.vessels.map((v) => v.MMSI)).toEqual(['111']);
    expect(r.scoped).toBe(true);
  });

  it('Shipping line sees only owned vessels + their windows', () => {
    const r = scopeData('shippingLine', { ownedMmsi: new Set(['222']) }, data);
    expect(r.vessels.map((v) => v.MMSI)).toEqual(['222']);
    expect(r.plan.map((p) => p.PLAN_ID)).toEqual(['P2']);
    expect(r.berths.map((b) => b.BERTH_ID)).toEqual(['B3']);
    expect(r.scoped).toBe(true);
  });

  it('Pilot desk sees all vessels and craft', () => {
    const r = scopeData('pilotDesk', {}, data);
    expect(r.vessels).toHaveLength(3);
    expect(r.craft).toHaveLength(2);
  });
});

describe('canEdit', () => {
  it('matches the role matrix', () => {
    expect(canEdit('marineOps')).toBe(true);
    expect(canEdit('terminal')).toBe(true);
    expect(canEdit('pilotDesk')).toBe(true);
    expect(canEdit('shippingLine')).toBe(false);
    expect(canEdit('viewer')).toBe(false);
  });

  it('every role has a definition with a scope description', () => {
    for (const def of Object.values(ROLES)) {
      expect(def.label).toBeTruthy();
      expect(def.scope).toBeTruthy();
    }
  });
});
