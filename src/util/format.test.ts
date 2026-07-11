import { describe, it, expect } from 'vitest';
import { istTime, istDate, istStamp, durationFromHours, signedPct } from './format';

// 2026-07-11T01:00:00Z == 06:30 IST on 11-07-2026.
const TS = Date.parse('2026-07-11T01:00:00Z');

describe('IST formatting (O-5)', () => {
  it('istTime is HH:MM in IST', () => {
    expect(istTime(TS)).toBe('06:30');
  });
  it('istDate is DD-MM-YYYY', () => {
    expect(istDate(TS)).toBe('11-07-2026');
  });
  it('istStamp is fully labelled DD-MM-YYYY HH:MM IST', () => {
    expect(istStamp(TS)).toBe('11-07-2026 06:30 IST');
  });
  it('handles a date that rolls to the next day in IST', () => {
    // 2026-07-11T20:00Z == 01:30 IST on 12-07-2026.
    const t2 = Date.parse('2026-07-11T20:00:00Z');
    expect(istDate(t2)).toBe('12-07-2026');
    expect(istTime(t2)).toBe('01:30');
  });
});

describe('durationFromHours / signedPct', () => {
  it('formats durations', () => {
    expect(durationFromHours(26)).toBe('26h');
    expect(durationFromHours(26.5)).toBe('26h 30m');
  });
  it('formats signed percentages', () => {
    expect(signedPct(12.34)).toBe('+12.3%');
    expect(signedPct(-4)).toBe('−4.0%');
    expect(signedPct(0)).toBe('0.0%');
  });
});
