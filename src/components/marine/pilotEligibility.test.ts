import { describe, expect, it } from 'vitest';
import { isCraftAssignable, isPilotAssignable } from '@/components/marine/pilotLifecycle';
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

describe('port craft assignment eligibility — projection only', () => {
  it('is eligible when a pilot is Assigned — a launch can be sent', () => {
    expect(isCraftAssignable(call(lc({ pilotState: 'Assigned' })))).toBe(true);
  });

  it('is eligible when the pilot is Onboard — tugs can be assigned', () => {
    expect(isCraftAssignable(call(lc({ pilotState: 'Onboard' })))).toBe(true);
  });

  it('is eligible when the pilot is Active — the IMPORTED equivalent of Onboard', () => {
    /* Imported and manual must behave identically; the engine simply words them
       differently, so all three engaged states are accepted. */
    expect(isCraftAssignable(call(lc({ pilotState: 'Active' })))).toBe(true);
  });

  it('is NOT eligible before a pilot exists', () => {
    expect(isCraftAssignable(call(lc({ pilotState: 'Pending' })))).toBe(false);
  });

  it('is NOT eligible once the pilot job is Completed', () => {
    expect(isCraftAssignable(call(lc({ pilotState: 'Completed' })))).toBe(false);
  });

  it('is NOT eligible once the pilot is Released', () => {
    expect(isCraftAssignable(call(lc({ pilotState: 'Released' })))).toBe(false);
  });

  it('is NOT eligible once the vessel has departed, whatever the pilot state', () => {
    expect(isCraftAssignable(call(lc({
      pilotState: 'Onboard', departureState: 'Completed',
    })))).toBe(false);
  });

  it('is NOT eligible with no lifecycle — the projection has no opinion', () => {
    expect(isCraftAssignable(call(null))).toBe(false);
  });

  it('ignores stored columns entirely — the defect this replaced', () => {
    /* A piloted vessel with NO ata/eta failed the old raw-column gate and vanished from
       the dropdown. 86 vessels were hidden this way. */
    const c = call(lc({ pilotState: 'Onboard' }), { ata: 0, eta: 0, atd: 0 });
    expect(isCraftAssignable(c)).toBe(true);
  });

  it('a completed job with an open-looking call row stays ineligible', () => {
    /* The other direction: 134 completed jobs were still being offered craft. */
    const c = call(lc({ pilotState: 'Completed' }), { ata: 1000, eta: 900, atd: 0 });
    expect(isCraftAssignable(c)).toBe(false);
  });
});

describe('pilot and craft eligibility are complementary, never overlapping', () => {
  it('a vessel is never offered for BOTH pilot and craft at once', () => {
    /* Pilot picker wants Pending; craft picker wants engaged. A call cannot be both, so
       an operator can never assign a pilot and craft from the same state. */
    for (const st of ['Pending', 'Required', 'Assigned', 'Onboard', 'Active', 'Completed', 'Released']) {
      const c = call(lc({ pilotState: st }));
      expect(isPilotAssignable(c) && isCraftAssignable(c)).toBe(false);
    }
  });

  it('craft eligibility begins exactly where pilot eligibility ends', () => {
    const assigned = call(lc({ pilotState: 'Assigned' }));
    expect(isPilotAssignable(assigned)).toBe(false);
    expect(isCraftAssignable(assigned)).toBe(true);
  });
});
