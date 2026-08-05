/**
 * Lifecycle → tone mapping. A pure lookup over the engine's own vocabulary.
 *
 * The guard: this must never DECIDE anything. If a test here ever needs to assert a
 * transition or a ranking, presentation has started doing business logic.
 */

import { describe, it, expect } from 'vitest';
import { lifecycleTone } from './lifecycleTone';

describe('call-status tones', () => {
  it.each([
    ['At Berth', 'good'],
    ['Departed', 'muted'],
    ['Sailing', 'warn'],
    ['Pilot Boarded', 'warn'],
    ['Anchored', 'warn'],
    ['Berth Allotted', 'info'],
    ['Planned', 'muted'],
  ])('%s → %s', (v, want) => expect(lifecycleTone(v)).toBe(want));
});

describe('per-module state tones', () => {
  it.each([
    ['Occupied', 'good'], ['Allotted', 'info'], ['Released', 'muted'],
    ['Completed', 'good'], ['Active', 'warn'], ['In Port', 'info'],
    ['Busy', 'warn'], ['Idle', 'muted'],
    ['Pilot Completed', 'good'], ['Departure Pilot Completed', 'good'],
    ['BERTHING_STARTED', 'good'], ['EXPECTED', 'muted'], ['DEPARTED', 'muted'],
  ])('%s → %s', (v, want) => expect(lifecycleTone(v)).toBe(want));
});

describe('nothing is invented and nothing is hidden', () => {
  // Pending awaits the NEXT ACTION, so it earns operator attention (amber) — but never
  // 'bad', which would read as an error. It also carries no anomaly mark: a pending
  // departure is normal, and only a verified correlation failure is flagged.
  it('treats Pending as attention, not as an error', () => {
    expect(lifecycleTone('Pending')).toBe('warn');
    expect(lifecycleTone('Pending')).not.toBe('bad');
  });

  // A new engine state must degrade to a readable grey chip, never vanish or mis-colour.
  it('falls through to muted for an unmapped value', () => {
    expect(lifecycleTone('Quarantined')).toBe('muted');
    expect(lifecycleTone('SOMETHING_NEW')).toBe('muted');
  });

  it('handles absent values without throwing', () => {
    expect(lifecycleTone('')).toBe('muted');
    expect(lifecycleTone(null)).toBe('muted');
    expect(lifecycleTone(undefined)).toBe('muted');
  });

  it('is a pure lookup — same input, same tone, no context', () => {
    expect(lifecycleTone('At Berth')).toBe(lifecycleTone('At Berth'));
    expect(lifecycleTone(' At Berth ')).toBe('good');   // trimmed, not re-interpreted
  });

  it('uses only tones the shared chip supports', () => {
    const allowed = new Set(['good', 'warn', 'bad', 'info', 'muted']);
    for (const v of ['At Berth', 'Departed', 'Busy', 'Idle', 'EXPECTED', 'nonsense', '']) {
      expect(allowed.has(lifecycleTone(v))).toBe(true);
    }
  });
});
