import { describe, it, expect } from 'vitest';
import { classifyLdbFailure, ldbFallbackMessage, type LdbFallbackReason } from './failure';
import { LdbAuthRequiredError } from './token';

/**
 * Inputs are the LITERAL strings thrown by src/data/ldb/track.ts. If one of those
 * messages is reworded, the matching test fails here rather than the reason
 * silently degrading to the generic 'error' bucket on screen.
 *
 * These were rewritten when LDB auth moved to the OTP/searate-token flow: that
 * change replaced every `[LDB] … HTTP 4xx` string with operator language, which
 * would have quietly broken every pattern in this module.
 */
describe('classifyLdbFailure', () => {
  it('recognises a switched-off integration (no request was made)', () => {
    expect(classifyLdbFailure(new Error('Container tracking is currently unavailable.')).reason).toBe(
      'disabled',
    );
  });

  it('recognises an auth-required error STRUCTURALLY, not by wording', () => {
    // The auth path has several different sentences; none of them may be
    // mistaken for a lookup failure.
    for (const msg of [
      'Please verify your mobile number to track a container.',
      'Your session expired. Please verify your mobile number again.',
    ]) {
      expect(classifyLdbFailure(new LdbAuthRequiredError(msg)).reason).toBe('unauthorized');
    }
  });

  it('recognises an empty record — LDB answered, it just has nothing', () => {
    expect(
      classifyLdbFailure(new Error('No tracking details found for this container.')).reason,
    ).toBe('empty');
  });

  it('recognises the shared non-JSON / non-2xx message', () => {
    // Both branches in fetchTrackOnce throw this one sentence. Note the
    // typographic apostrophe — the pattern must not depend on it.
    expect(
      classifyLdbFailure(new Error('Couldn’t look up this container. Please try again.')).reason,
    ).toBe('lookup-failed');
    expect(classifyLdbFailure(new TypeError('Failed to fetch')).reason).toBe('lookup-failed');
  });

  it('falls back to a generic reason without losing the message', () => {
    const f = classifyLdbFailure(new Error('something nobody predicted'));
    expect(f.reason).toBe('error');
    expect(f.detail).toContain('nobody predicted');
  });

  it('survives a non-Error throw', () => {
    expect(classifyLdbFailure('just a string')).toEqual({ reason: 'error', detail: 'just a string' });
    expect(classifyLdbFailure(null).reason).toBe('error');
  });

  it('always preserves the raw message verbatim for the details disclosure', () => {
    const raw = 'No tracking details found for this container.';
    expect(classifyLdbFailure(new Error(raw)).detail).toBe(raw);
  });
});

describe('ldbFallbackMessage', () => {
  const reasons: LdbFallbackReason[] = [
    'disabled',
    'unauthorized',
    'lookup-failed',
    'empty',
    'error',
  ];

  it('gives every reason a distinct operator-language sentence', () => {
    const messages = reasons.map(ldbFallbackMessage);
    expect(new Set(messages).size).toBe(reasons.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(20);
  });

  it('names the env var for the one reason an operator can fix directly', () => {
    expect(ldbFallbackMessage('disabled')).toContain('VITE_LDB_ENABLED');
  });
});
