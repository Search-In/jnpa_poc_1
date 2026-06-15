import { describe, it, expect } from 'vitest';
import { hoursBetween, mean, round, clamp, deltaPct, mape, MS_PER_HOUR } from './helpers';

describe('helpers', () => {
  it('hoursBetween computes signed hour difference', () => {
    expect(hoursBetween(0, MS_PER_HOUR)).toBe(1);
    expect(hoursBetween(MS_PER_HOUR, 0)).toBe(-1);
    expect(hoursBetween(0, 0)).toBe(0);
  });

  it('mean returns 0 for empty array and the average otherwise', () => {
    expect(mean([])).toBe(0);
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([5])).toBe(5);
  });

  it('round respects decimal places', () => {
    expect(round(2.345, 1)).toBe(2.3);
    expect(round(2.355, 2)).toBe(2.36);
    expect(round(7.9, 0)).toBe(8);
  });

  it('clamp bounds the value', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it('deltaPct is signed and safe when target is 0', () => {
    expect(deltaPct(120, 100)).toBe(20);
    expect(deltaPct(80, 100)).toBe(-20);
    expect(deltaPct(5, 0)).toBe(0);
  });

  it('mape skips null + zero actuals and returns a fraction', () => {
    expect(mape([])).toBe(0);
    expect(mape([{ predicted: 10, actual: null }])).toBe(0);
    expect(mape([{ predicted: 10, actual: 0 }])).toBe(0);
    // |(10-9)/10| = 0.1
    expect(mape([{ predicted: 9, actual: 10 }])).toBeCloseTo(0.1, 5);
    // mean of 0.1 and 0.2
    expect(
      mape([
        { predicted: 9, actual: 10 },
        { predicted: 8, actual: 10 },
      ])
    ).toBeCloseTo(0.15, 5);
  });
});
