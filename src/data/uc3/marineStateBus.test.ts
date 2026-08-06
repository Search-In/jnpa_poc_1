import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  __resetMarineStateBus, propagateMarineStateUpdate, useMarineStateVersion,
} from '@/data/uc3/marineStateBus';

beforeEach(() => __resetMarineStateBus());

describe('marine state bus', () => {
  it('starts at zero so a first render is not treated as a change', () => {
    const { result } = renderHook(() => useMarineStateVersion());
    expect(result.current).toBe(0);
  });

  it('bumps the version subscribers see', () => {
    const { result } = renderHook(() => useMarineStateVersion());
    act(() => propagateMarineStateUpdate());
    expect(result.current).toBe(1);
  });

  it('is monotonic — every action is a distinct dependency value', () => {
    const { result } = renderHook(() => useMarineStateVersion());
    act(() => { propagateMarineStateUpdate(); propagateMarineStateUpdate(); });
    expect(result.current).toBe(2);
  });

  it('notifies every subscriber, not just the caller', () => {
    const a = renderHook(() => useMarineStateVersion());
    const b = renderHook(() => useMarineStateVersion());
    act(() => propagateMarineStateUpdate());
    expect(a.result.current).toBe(1);
    expect(b.result.current).toBe(1);
  });

  it('can be called with no subscribers mounted', () => {
    expect(() => propagateMarineStateUpdate()).not.toThrow();
  });
});
