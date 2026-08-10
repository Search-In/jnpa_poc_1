/**
 * UC1-011 — corpus vessel-states → geometry-derived positions with SOURCE:'derived'.
 */
import { describe, it, expect } from 'vitest';
import {
  synthesiseDerivedVessel,
  type BerthGeomMap,
} from './Uc3Adapter';
import type { MarineVesselState } from './uc3/marineDashboard';

const AS_OF = Date.parse('2026-06-09T08:30:00+05:30');

function state(partial: Partial<MarineVesselState> & Pick<MarineVesselState, 'state' | 'vesselName'>): MarineVesselState {
  return {
    callId: 1,
    vcn: 'INNSA1NF0S0776',
    viaNo: 'VIA1',
    imoNo: '9241918',
    voyageNo: 'V1',
    status: 'ACTIVE',
    berthCode: '',
    terminal: 'APMT',
    eta: 0,
    etb: 0,
    etd: 0,
    ata: 0,
    atd: 0,
    anchorDownAt: 0,
    pilotBoardedAt: 0,
    firstLineAt: 0,
    movementType: 'INBOUND',
    ...partial,
  };
}

const berthGeom: BerthGeomMap = new Map([
  ['CB02', { geom: [[72.95, 18.95], [72.951, 18.95], [72.951, 18.951], [72.95, 18.951], [72.95, 18.95]], centre: [72.9505, 18.9505] }],
]);

describe('synthesiseDerivedVessel (UC1-011)', () => {
  it('places an alongside vessel on its berth slot and badges DERIVED', () => {
    const v = synthesiseDerivedVessel(
      state({ state: 'alongside', berthCode: 'CB02', vesselName: 'TSS AMBER', terminal: 'NSFT' }),
      berthGeom,
      AS_OF,
    );
    expect(v).not.toBeNull();
    expect(v!.SOURCE).toBe('derived');
    expect(v!.NAV_STATUS).toBe('moored');
    expect(v!.BERTH_ID).toBe('CB02');
    expect(v!.LON).toBeCloseTo(72.9505, 4);
    expect(v!.LAT).toBeCloseTo(18.9505, 4);
  });

  it('places an anchored vessel on an anchorage ring', () => {
    const v = synthesiseDerivedVessel(
      state({ state: 'at_anchorage', vesselName: 'ANCHOR ONE', berthCode: '' }),
      berthGeom,
      AS_OF,
    );
    expect(v).not.toBeNull();
    expect(v!.SOURCE).toBe('derived');
    expect(v!.NAV_STATUS).toBe('anchored');
    // Anchorage centroids sit west of the quay belt (~72.9x).
    expect(v!.LON).toBeGreaterThan(72.85);
    expect(v!.LON).toBeLessThan(73.0);
  });

  it('places approaching traffic on the channel, nearer when ETA is soon', () => {
    const far = synthesiseDerivedVessel(
      state({
        state: 'inbound',
        vesselName: 'FAR INBOUND',
        eta: AS_OF + 20 * 3_600_000,
      }),
      berthGeom,
      AS_OF,
    );
    const near = synthesiseDerivedVessel(
      state({
        state: 'expected',
        vesselName: 'NEAR EXPECTED',
        imoNo: '9999999',
        etb: AS_OF + 1 * 3_600_000,
      }),
      berthGeom,
      AS_OF,
    );
    expect(far!.SOURCE).toBe('derived');
    expect(near!.SOURCE).toBe('derived');
    expect(far!.NAV_STATUS).toBe('approaching');
    expect(near!.NAV_STATUS).toBe('approaching');
    // Higher centreline fraction ≈ closer to the berths (seaward end is lower t).
    // Near ETA → larger t; far ETA → smaller t. Longitude increases toward the port.
    expect(near!.LON).not.toEqual(far!.LON);
  });

  it('never returns a vessel without SOURCE derived', () => {
    for (const s of ['alongside', 'at_anchorage', 'inbound', 'under_pilotage'] as const) {
      const v = synthesiseDerivedVessel(
        state({ state: s, vesselName: `SHIP-${s}`, berthCode: s === 'alongside' ? 'CB02' : '' }),
        berthGeom,
        AS_OF,
      );
      expect(v?.SOURCE).toBe('derived');
    }
  });

  it('drops long-departed vessels from the picture', () => {
    const v = synthesiseDerivedVessel(
      state({
        state: 'departed',
        vesselName: 'GONE',
        atd: AS_OF - 48 * 3_600_000,
      }),
      berthGeom,
      AS_OF,
    );
    expect(v).toBeNull();
  });
});
