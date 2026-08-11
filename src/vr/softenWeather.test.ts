import { describe, expect, it } from 'vitest';
import { softenWeather } from './sceneAnim';
import type { WeatherVisual } from './liveWorld';

describe('softenWeather', () => {
  const monsoon: WeatherVisual = { type: 'rainy', cloudCover: 0.95, precipitation: 0.8 };
  const fog: WeatherVisual = { type: 'foggy', fogStrength: 0.9 };

  it('is a no-op on a capable device', () => {
    expect(softenWeather(monsoon, false)).toBe(monsoon);
    expect(softenWeather(fog, false)).toBe(fog);
  });

  it('never changes what the weather DEPICTS', () => {
    // The type is the evidence — fog is why pilotage stopped. Only the
    // expensive intensity dials may be turned down.
    for (const w of [monsoon, fog, { type: 'sunny', cloudCover: 0.2 } as WeatherVisual]) {
      expect(softenWeather(w, true).type).toBe(w.type);
    }
  });

  it('caps rain intensity on a weak device', () => {
    const w = softenWeather(monsoon, true);
    expect(w.type).toBe('rainy');
    if (w.type === 'rainy') {
      expect(w.precipitation).toBeLessThanOrEqual(0.35);
      expect(w.cloudCover).toBeLessThanOrEqual(0.7);
    }
  });

  it('caps fog thickness on a weak device', () => {
    const w = softenWeather(fog, true);
    expect(w.type).toBe('foggy');
    if (w.type === 'foggy') expect(w.fogStrength).toBeLessThanOrEqual(0.5);
  });

  it('leaves already-mild weather alone', () => {
    const light: WeatherVisual = { type: 'rainy', cloudCover: 0.4, precipitation: 0.1 };
    const w = softenWeather(light, true);
    if (w.type === 'rainy') {
      expect(w.precipitation).toBe(0.1);
      expect(w.cloudCover).toBe(0.4);
    }
  });

  it('passes calm weather through untouched', () => {
    const sunny: WeatherVisual = { type: 'sunny', cloudCover: 0.1 };
    expect(softenWeather(sunny, true)).toEqual(sunny);
  });
});
