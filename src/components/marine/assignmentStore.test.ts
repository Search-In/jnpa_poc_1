import { beforeEach, describe, expect, it } from 'vitest';
import { isLive, useAssignmentStore } from '@/components/marine/assignmentStore';

const base = { callId: 51, vcn: 'INNSA1NS0S0814', via: 'S0814', vesselName: 'HONG YONG CHANG SHENG' };

beforeEach(() => {
  sessionStorage.clear();
  useAssignmentStore.getState().clearAll();
});

describe('pilot assignment lifecycle', () => {
  it('assigns a pilot to a call and starts at Assigned', () => {
    const id = useAssignmentStore.getState().assignPilot({ ...base, pilotId: 'JP 91', pilotName: '' });
    const a = useAssignmentStore.getState().pilots.find((p) => p.id === id)!;
    expect(a.status).toBe('Assigned');
    expect(a.callId).toBe(51);
    expect(a.boardedAt).toBe(0);
    expect(isLive(a)).toBe(true);
  });

  it('walks Assigned → Onboard → Released, stamping each time', () => {
    const s = useAssignmentStore.getState();
    const id = s.assignPilot({ ...base, pilotId: 'JP 91', pilotName: '' });
    useAssignmentStore.getState().boardPilot(id, 1000);
    expect(useAssignmentStore.getState().pilots[0].status).toBe('Onboard');
    expect(useAssignmentStore.getState().pilots[0].boardedAt).toBe(1000);
    useAssignmentStore.getState().release(id, 2000);
    expect(useAssignmentStore.getState().pilots[0].status).toBe('Released');
    expect(useAssignmentStore.getState().pilots[0].releasedAt).toBe(2000);
  });

  it('will not board a pilot who is not currently Assigned', () => {
    const id = useAssignmentStore.getState().assignPilot({ ...base, pilotId: 'JP 91', pilotName: '' });
    useAssignmentStore.getState().release(id, 500);
    useAssignmentStore.getState().boardPilot(id, 900);
    expect(useAssignmentStore.getState().pilots[0].status).toBe('Released');
  });
});

describe('imported data always wins', () => {
  it('supersedes a manual assignment when the call gains imported pilotage', () => {
    useAssignmentStore.getState().assignPilot({ ...base, pilotId: 'JP 91', pilotName: '' });
    useAssignmentStore.getState().supersede([51], 5000);
    const a = useAssignmentStore.getState().pilots[0];
    expect(a.supersededAt).toBe(5000);
    expect(isLive(a)).toBe(false);
  });

  it('NEVER deletes the superseded record — it stays for audit', () => {
    useAssignmentStore.getState().assignPilot({ ...base, pilotId: 'JP 91', pilotName: '' });
    useAssignmentStore.getState().supersede([51], 5000);
    expect(useAssignmentStore.getState().pilots).toHaveLength(1);
  });

  it('leaves assignments for other calls untouched', () => {
    useAssignmentStore.getState().assignPilot({ ...base, pilotId: 'JP 91', pilotName: '' });
    useAssignmentStore.getState().assignPilot({ ...base, callId: 99, via: 'S0999', pilotId: 'JP 92', pilotName: '' });
    useAssignmentStore.getState().supersede([51], 5000);
    const live = useAssignmentStore.getState().pilots.filter(isLive);
    expect(live).toHaveLength(1);
    expect(live[0].callId).toBe(99);
  });

  it('is idempotent — a second supersede does not restamp', () => {
    useAssignmentStore.getState().assignPilot({ ...base, pilotId: 'JP 91', pilotName: '' });
    useAssignmentStore.getState().supersede([51], 5000);
    useAssignmentStore.getState().supersede([51], 8000);
    expect(useAssignmentStore.getState().pilots[0].supersededAt).toBe(5000);
  });

  it('supersedes craft assignments by the same rule', () => {
    useAssignmentStore.getState().assignCraft({ ...base, craftId: 3, craftName: 'OCEAN DIVINE', craftType: 'Tug' });
    useAssignmentStore.getState().supersede([51], 5000);
    expect(isLive(useAssignmentStore.getState().craft[0])).toBe(false);
  });
});

describe('craft assignment', () => {
  it('records the craft from the fleet register verbatim', () => {
    useAssignmentStore.getState().assignCraft({ ...base, craftId: 3, craftName: 'OCEAN DIVINE', craftType: 'Tug' });
    const c = useAssignmentStore.getState().craft[0];
    expect(c.craftName).toBe('OCEAN DIVINE');
    expect(c.craftType).toBe('Tug');
    expect(c.status).toBe('Assigned');
  });

  it('releases a craft', () => {
    const id = useAssignmentStore.getState().assignCraft({ ...base, craftId: 3, craftName: 'OCEAN DIVINE', craftType: 'Tug' });
    useAssignmentStore.getState().release(id, 4000);
    expect(useAssignmentStore.getState().craft[0].status).toBe('Released');
  });
});

describe('persistence', () => {
  it('survives a store reload via sessionStorage', () => {
    useAssignmentStore.getState().assignPilot({ ...base, pilotId: 'JP 91', pilotName: '' });
    expect(sessionStorage.getItem('jnpa.marineAssignments.v1')).toContain('S0814');
  });

  it('clearAll drops manual transactions only', () => {
    useAssignmentStore.getState().assignPilot({ ...base, pilotId: 'JP 91', pilotName: '' });
    useAssignmentStore.getState().clearAll();
    expect(useAssignmentStore.getState().pilots).toHaveLength(0);
  });
});
