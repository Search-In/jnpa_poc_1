import { describe, expect, it } from 'vitest';
import type { VesselCall } from '@/types/domain';
import {
  callInTrafficPicture,
  trafficStateFromCall,
} from '@/data/uc3/marineDashboardShim';

const H = 3_600_000;
const at = Date.parse('2026-06-09T08:30:00+05:30');

function call(over: Partial<VesselCall> = {}): VesselCall {
  return {
    callId: 1,
    vcn: 'VCN1',
    viaNo: 'V001',
    imoNo: '1234567',
    vesselName: 'TEST SHIP',
    voyageNo: '001',
    rotationNo: '',
    terminalId: null,
    terminalCode: 'BMCT',
    berthId: null,
    berthCode: '',
    purpose: '',
    status: 'Planned',
    lifecycle: null,
    igmNo: null,
    sourceNote: '',
    eta: 0,
    etb: 0,
    etd: 0,
    ata: 0,
    atc: 0,
    atd: 0,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('trafficStateFromCall', () => {
  it('returns alongside when at berth', () => {
    expect(
      trafficStateFromCall(
        call({ lifecycle: { ...lc(), isAtBerth: true, isInPort: true } }),
        at,
      ),
    ).toBe('alongside');
  });

  it('returns departed within twelve hours', () => {
    expect(
      trafficStateFromCall(call({ atd: at - 2 * H }), at),
    ).toBe('departed');
  });

  it('returns at_anchorage when in port but not at berth', () => {
    expect(
      trafficStateFromCall(
        call({ lifecycle: { ...lc(), isInPort: true, isAtBerth: false } }),
        at,
      ),
    ).toBe('at_anchorage');
  });

  it('returns expected for future ETA without ATA', () => {
    expect(
      trafficStateFromCall(call({ eta: at + 24 * H }), at),
    ).toBe('expected');
  });
});

describe('callInTrafficPicture', () => {
  it('includes in-port calls', () => {
    expect(
      callInTrafficPicture(call({ ata: at - H, atd: 0 }), at),
    ).toBe(true);
  });

  it('includes recently departed', () => {
    expect(
      callInTrafficPicture(call({ atd: at - 2 * H }), at),
    ).toBe(true);
  });

  it('excludes long-gone departures', () => {
    expect(
      callInTrafficPicture(call({ atd: at - 20 * H }), at),
    ).toBe(false);
  });
});

function lc() {
  return {
    status: '',
    arrivalState: 'Pending',
    berthState: 'Pending',
    pilotState: 'Pending',
    departureState: 'Pending',
    shippingState: 'Pending',
    portcraftState: 'Pending',
    craftState: 'Idle',
    craftCommitted: 0,
    isInPort: false,
    isAtBerth: false,
    latestEvent: '',
  };
}
