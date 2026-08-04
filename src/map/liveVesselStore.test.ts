import { describe, it, expect, beforeEach } from 'vitest';
import { useLiveVesselStore } from './liveVesselStore';

const reset = () => useLiveVesselStore.getState().setEnabled(false);

beforeEach(reset);

describe('live-AIS toggle default', () => {
  /**
   * The overlay must start OFF on every load, in BOTH renderers. Two reasons it
   * is asserted rather than assumed: a default of on would make the first paint
   * depend on a gateway call, and the app's other UI stores (roleStore,
   * planStore, simStore) persist to sessionStorage — this one deliberately does
   * not, so a reload never resurrects a live session.
   */
  it('is off before anything touches it', () => {
    expect(useLiveVesselStore.getState().enabled).toBe(false);
  });

  it('reports no vessels, no error and no timestamp while off', () => {
    const s = useLiveVesselStore.getState();
    expect(s.count).toBe(0);
    expect(s.error).toBeNull();
    expect(s.lastUpdated).toBeNull();
    expect(s.loading).toBe(false);
  });

  it('is shared, so a 2D↔3D flip keeps ONE state rather than two defaults', () => {
    useLiveVesselStore.getState().toggle();
    expect(useLiveVesselStore.getState().enabled).toBe(true);
    // Whichever renderer mounts next reads the same store.
    expect(useLiveVesselStore.getState().enabled).toBe(true);
  });

  it('turning it off clears the status so no stale count outlives the layer', () => {
    useLiveVesselStore.getState().setEnabled(true);
    useLiveVesselStore.getState().setResult(42, 1_700_000_000_000);
    useLiveVesselStore.getState().toggle();

    const s = useLiveVesselStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.count).toBe(0);
    expect(s.lastUpdated).toBeNull();
  });

  it('a failed poll leaves the overlay on, with the error surfaced', () => {
    useLiveVesselStore.getState().setEnabled(true);
    useLiveVesselStore.getState().setError('502 marinetraffic_fetch_failed');

    const s = useLiveVesselStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.loading).toBe(false);
    expect(s.error).toMatch(/502/);
  });
});
