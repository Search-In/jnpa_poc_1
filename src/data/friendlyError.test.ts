import { describe, it, expect } from 'vitest';
import { friendlyError, isPlainMessage } from './friendlyError';
import { httpErrorMessage } from './uc3/client';

/**
 * Inputs are built with the REAL producer (`httpErrorMessage`) rather than
 * hand-written lookalikes. That pins the two modules together: if the message
 * format in client.ts changes, these tests fail loudly instead of the UI
 * silently degrading every error to the generic UNKNOWN branch.
 */
const uc3 = (status: number, statusText: string, detail?: unknown) =>
  httpErrorMessage('/marine/calls', status, statusText, detail);

describe('friendlyError — status classification', () => {
  const cases: [number, string, string][] = [
    [401, 'Unauthorized', 'UNAUTHORIZED'],
    [403, 'Forbidden', 'FORBIDDEN'],
    [404, 'Not Found', 'NOT_FOUND'],
    [408, 'Request Timeout', 'TIMEOUT'],
    [504, 'Gateway Timeout', 'TIMEOUT'],
    [429, 'Too Many Requests', 'RATE_LIMITED'],
    [502, 'Bad Gateway', 'UPSTREAM'],
    [503, 'Service Unavailable', 'UPSTREAM'],
    [500, 'Internal Server Error', 'SERVER'],
  ];

  it.each(cases)('HTTP %i → %s', (status, statusText, code) => {
    expect(friendlyError(uc3(status, statusText)).code).toBe(code);
  });

  it('gives every classified error a title and an action, with no raw detail in either', () => {
    for (const [status, statusText] of cases) {
      const e = friendlyError(uc3(status, statusText, { detail: 'upstream_timeout' }));
      expect(e.title.length).toBeGreaterThan(0);
      expect(e.action.length).toBeGreaterThan(0);
      expect(e.title).not.toContain('HTTP');
      expect(e.title).not.toContain('[UC3]');
      expect(e.action).not.toContain('HTTP');
    }
  });

  it('never discards the technical detail — it is only demoted', () => {
    const raw = uc3(502, 'Bad Gateway', { detail: 'marinetraffic_fetch_failed' });
    const e = friendlyError(raw);
    expect(e.detail).toBe(raw);
    expect(e.technical).toBe(true);
  });
});

describe('friendlyError — non-status conditions', () => {
  it('recognises a disabled integration before any status check', () => {
    // This message is generated locally by client.ts; no request was ever made.
    const e = friendlyError('[UC3] /shipping-lines/lines — UC-3 integration is disabled (VITE_UC3_ENABLED=false)');
    expect(e.code).toBe('DISABLED');
    expect(e.title).toMatch(/switched off/i);
  });

  it('recognises a fetch reject (no response at all)', () => {
    expect(friendlyError('TypeError: Failed to fetch').code).toBe('OFFLINE');
    expect(friendlyError('NetworkError when attempting to fetch resource.').code).toBe('OFFLINE');
  });

  it('recognises a non-JSON reply — usually a proxy or login page', () => {
    expect(friendlyError('[LDB] track → non-JSON body').code).toBe('BAD_PAYLOAD');
    expect(friendlyError('SyntaxError: Unexpected token < in JSON at position 0').code).toBe('BAD_PAYLOAD');
  });

  it('falls back to UNKNOWN for anything unrecognised, keeping the detail', () => {
    const e = friendlyError('[UC3] /marine/calls → something nobody predicted {"x":1}');
    expect(e.code).toBe('UNKNOWN');
    expect(e.detail).toContain('nobody predicted');
    expect(e.technical).toBe(true);
  });

  it('handles an empty message without rendering a blank notice', () => {
    expect(friendlyError('').title.length).toBeGreaterThan(0);
    expect(friendlyError('   ').code).toBe('UNKNOWN');
  });
});

describe('isPlainMessage / the PLAIN branch', () => {
  it('passes an already-human validation message through untouched', () => {
    // Thrown by src/data/ldb/track.ts and shown in ContainerTrackPanel.
    const e = friendlyError('Enter a container number');
    expect(e.code).toBe('PLAIN');
    expect(e.title).toBe('Enter a container number');
    expect(e.action).toBe('');
    // No "Technical details" toggle — there is nothing technical to reveal.
    expect(e.technical).toBe(false);
  });

  it('does not mistake machine output for human text', () => {
    expect(isPlainMessage('[UC3] /marine/calls → HTTP 500 Internal Server Error')).toBe(false);
    expect(isPlainMessage('Error: boom')).toBe(false);
    expect(isPlainMessage('TypeError: x is not a function')).toBe(false);
    expect(isPlainMessage('{"detail":"nope"}')).toBe(false);
    expect(isPlainMessage('https://traffic-three.searchintech.in/api failed')).toBe(false);
    expect(isPlainMessage('x'.repeat(200))).toBe(false);
    expect(isPlainMessage('')).toBe(false);
  });

  it('accepts short operator-written sentences', () => {
    expect(isPlainMessage('Container number is required')).toBe(true);
    expect(isPlainMessage('No survey selected.')).toBe(true);
  });
});
