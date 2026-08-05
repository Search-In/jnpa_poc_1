import { describe, expect, it } from 'vitest';
import { isPilotAssignable } from '@/components/marine/pilotLifecycle';
import type { VesselCall, CallLifecycle } from '@/types/domain';

function lc(over: Partial<CallLifecycle> = {}): CallLifecycle {
  return {
    status: 'Berth Allotted', arrivalState: 'Pending', berthState: 'Allotted',
    pilotState: 'Pending', departureState: 'Pending', shippingState: 'Expected',
    portcraftState: 'Idle', craftState: 'Idle', craftCommitted: 0,
    isInPort: false, isAtBerth: false, latestEvent: '', latestEventTime: 0,
    ...over,
  } as CallLifecycle;
}

function call(lifecycle: CallLifecycle | null, over: Partial<VesselCall> = {}): VesselCall {
  return {
    callId: 1, vcn: 'INNSA1NF0S0001', viaNo: 'S0001', voyageNo: '1', imoNo: '9000001',
    vesselName: 'TEST VESSEL', terminalCode: '', berthCode: '', status: 'Berth Allotted',
    eta: 0, etb: 0, ata: 0, atc: 0, atd: 0, rotationNo: '', updatedAt: 0,
    lifecycle, ...over,
  } as VesselCall;
}

describe('pilot assignment eligibility — projection only', () => {
  it('is eligible when the pilot state is Pending', () => {
    expect(isPilotAssignable(call(lc({ pilotState: 'Pending' })))).toBe(true);
  });

  it('is eligible when the pilot state is Required', () => {
    expect(isPilotAssignable(call(lc({ pilotState: 'Required' })))).toBe(true);
  });

  it('is NOT eligible once a pilot is Assigned', () => {
    expect(isPilotAssignable(call(lc({ pilotState: 'Assigned' })))).toBe(false);
  });

  it('is NOT eligible while the pilot is Onboard', () => {
    expect(isPilotAssignable(call(lc({ pilotState: 'Onboard' })))).toBe(false);
  });

  it('is NEVER eligible once the pilot job is Completed', () => {
    expect(isPilotAssignable(call(lc({ pilotState: 'Completed' })))).toBe(false);
  });

  it('is NOT eligible when Released', () => {
    expect(isPilotAssignable(call(lc({ pilotState: 'Released' })))).toBe(false);
  });

  it('is NOT eligible while a pilot is Active on an imported movement', () => {
    expect(isPilotAssignable(call(lc({ pilotState: 'Active' })))).toBe(false);
  });

  it('is NOT eligible once the vessel has departed, whatever the pilot state', () => {
    expect(isPilotAssignable(call(lc({
      pilotState: 'Pending', departureState: 'Completed',
    })))).toBe(false);
  });

  it('is NOT eligible with no lifecycle — the projection has no opinion', () => {
    expect(isPilotAssignable(call(null))).toBe(false);
  });

  it('ignores stored columns entirely', () => {
    /* atd set and no ata/eta would have FAILED the old raw-column predicate, yet the
       projection says a pilot is still needed — the lifecycle is what decides. */
    const c = call(lc({ pilotState: 'Pending' }), { atd: 0, ata: 0, eta: 0 });
    expect(isPilotAssignable(c)).toBe(true);
  });

  it('a Completed pilot job stays ineligible even with an open-looking call row', () => {
    const c = call(lc({ pilotState: 'Completed' }), { atd: 0, ata: 1000, eta: 900 });
    expect(isPilotAssignable(c)).toBe(false);
  });
});
