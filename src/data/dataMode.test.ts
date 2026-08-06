import { describe, it, expect } from 'vitest';
import { DATA_MODES, DEFAULT_DATA_MODE, resolveDataMode } from './dataMode';

describe('resolveDataMode', () => {
  it('accepts every documented mode without a warning', () => {
    for (const mode of DATA_MODES) {
      expect(resolveDataMode(mode)).toEqual({ mode, warning: null });
    }
  });

  it('defaults silently when unset — most runs never set it', () => {
    expect(resolveDataMode(undefined)).toEqual({ mode: DEFAULT_DATA_MODE, warning: null });
    expect(resolveDataMode(null)).toEqual({ mode: DEFAULT_DATA_MODE, warning: null });
    expect(resolveDataMode('')).toEqual({ mode: DEFAULT_DATA_MODE, warning: null });
  });

  /**
   * The reason this module exists: a programme document told operators to run
   * `VITE_DATA_MODE=uc3`, which silently produced MockAdapter — a dashboard of
   * invented vessels that looked like a working one.
   */
  it('falls back to mock for an unknown value AND warns', () => {
    const r = resolveDataMode('uc3');
    expect(r.mode).toBe('mock');
    expect(r.warning).toBeTruthy();
  });

  it('names the offending value, the legal set, and the consequence', () => {
    const w = resolveDataMode('uc3').warning!;
    expect(w).toContain('"uc3"');
    for (const mode of DATA_MODES) expect(w).toContain(mode);
    expect(w).toMatch(/SIMULATED/);
  });

  it('points at the RIGHT switch for gateway data, so nobody "fixes" it wrongly', () => {
    // Without this sentence the natural next move for someone who wanted UC-3
    // data is to start disabling things that were never the problem.
    expect(resolveDataMode('uc3').warning).toContain('VITE_UC3_ENABLED');
  });

  it('does not silently coerce near-misses into shape', () => {
    // Accepting 'Mock' or ' live' would be the same class of bug: the operator
    // believes a value works that a stricter consumer may reject.
    expect(resolveDataMode('Mock').warning).toBeTruthy();
    expect(resolveDataMode('LIVE').warning).toBeTruthy();
    expect(resolveDataMode(' live').warning).toBeTruthy();
  });

  it('always resolves to a legal mode, whatever it was given', () => {
    for (const raw of ['uc3', 'Mock', 'nonsense', '   ', '0', 'true']) {
      expect(DATA_MODES).toContain(resolveDataMode(raw).mode);
    }
  });
});
