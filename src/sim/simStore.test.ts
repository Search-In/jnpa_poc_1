/**
 * Regression tests for the what-if white-screen loop.
 *
 * Running a scenario starts a guided tour whose step effect calls setHighlights
 * on every beat. setHighlights used to bump `version`; because App subscribes to
 * `version`, that re-rendered App, which handed GuidedTour a fresh (unstable)
 * onStep, re-firing its effect → setHighlights → version bump → … an infinite
 * update loop that white-screened the app. These tests lock in that highlights
 * are a spotlight-only mutation: they must NOT bump `version`, and a repeat with
 * the same ids must be a no-op so subscribers never churn.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useSimStore } from './simStore';

describe('setHighlights — spotlight only, no version churn', () => {
  beforeEach(() => {
    useSimStore.getState().resetAll();
  });

  it('does not bump version when highlights change', () => {
    const v0 = useSimStore.getState().version;
    useSimStore.getState().setHighlights(['V-1', 'V-2']);
    expect(useSimStore.getState().highlights).toEqual(['V-1', 'V-2']);
    expect(useSimStore.getState().version).toBe(v0);
  });

  it('is a no-op (same object reference kept) when ids are unchanged', () => {
    useSimStore.getState().setHighlights(['V-1', 'V-2']);
    const ref = useSimStore.getState().highlights;
    const v0 = useSimStore.getState().version;

    // Same ids, different array instance — must not replace state or bump version.
    useSimStore.getState().setHighlights(['V-1', 'V-2']);
    expect(useSimStore.getState().highlights).toBe(ref);
    expect(useSimStore.getState().version).toBe(v0);
  });

  it('replaces highlights when the ids actually differ', () => {
    useSimStore.getState().setHighlights(['V-1']);
    const ref = useSimStore.getState().highlights;
    useSimStore.getState().setHighlights(['V-1', 'V-2']);
    expect(useSimStore.getState().highlights).not.toBe(ref);
    expect(useSimStore.getState().highlights).toEqual(['V-1', 'V-2']);
  });
});
