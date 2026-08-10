import { describe, it, expect, beforeEach } from 'vitest';
import {
  windUv,
  windSamplePoints,
  sampleWindUv,
  canvasToGrid,
  clearWindGridCache,
  WIND_GRID_COLS,
  WIND_GRID_ROWS,
  type WindGrid,
} from './windField';
import { FIELD_EXTENT } from '@/map/tideField';

describe('windUv', () => {
  it('maps north wind (from 0°) to negative v (blows south)', () => {
    const { u, v } = windUv(10, 0);
    expect(u).toBeCloseTo(0, 5);
    expect(v).toBeCloseTo(-10, 5);
  });

  it('maps east wind (from 90°) to negative u (blows west)', () => {
    const { u, v } = windUv(10, 90);
    expect(u).toBeCloseTo(-10, 5);
    expect(v).toBeCloseTo(0, 5);
  });

  it('maps south wind (from 180°) to positive v', () => {
    const { u, v } = windUv(5, 180);
    expect(u).toBeCloseTo(0, 5);
    expect(v).toBeCloseTo(5, 5);
  });
});

describe('windSamplePoints', () => {
  it('covers FIELD_EXTENT corners', () => {
    const pts = windSamplePoints(2, 2);
    expect(pts).toHaveLength(4);
    expect(pts[0]).toEqual({ lon: FIELD_EXTENT.xmin, lat: FIELD_EXTENT.ymin });
    expect(pts[3].lon).toBeCloseTo(FIELD_EXTENT.xmax, 5);
    expect(pts[3].lat).toBeCloseTo(FIELD_EXTENT.ymax, 5);
  });

  it('defaults to configured grid size', () => {
    expect(windSamplePoints()).toHaveLength(WIND_GRID_COLS * WIND_GRID_ROWS);
  });
});

describe('sampleWindUv', () => {
  const grid: WindGrid = {
    cols: 2,
    rows: 2,
    u: new Float32Array([1, 2, 3, 4]),
    v: new Float32Array([10, 20, 30, 40]),
    speedMax: 50,
    fetchedAt: 0,
  };

  it('returns corner values exactly', () => {
    expect(sampleWindUv(grid, 0, 0)).toMatchObject({ u: 1, v: 10, speed: Math.hypot(1, 10) });
    expect(sampleWindUv(grid, 1, 1)).toMatchObject({ u: 4, v: 40 });
  });

  it('bilinear-interpolates the centre', () => {
    const s = sampleWindUv(grid, 0.5, 0.5)!;
    expect(s.u).toBeCloseTo(2.5, 5);
    expect(s.v).toBeCloseTo(25, 5);
  });

  it('returns null outside the grid', () => {
    expect(sampleWindUv(grid, -0.1, 0)).toBeNull();
    expect(sampleWindUv(grid, 0, 2)).toBeNull();
  });
});

describe('canvasToGrid', () => {
  it('maps top-left (north-west) to high gy / low gx', () => {
    const { gx, gy } = canvasToGrid(0, 0, 100, 100, 11, 11);
    expect(gx).toBeCloseTo(0, 5);
    expect(gy).toBeCloseTo(10, 5); // north edge → max gy (row-major south→north)
  });

  it('maps bottom-right to high gx / low gy', () => {
    const { gx, gy } = canvasToGrid(99, 99, 100, 100, 11, 11);
    expect(gx).toBeCloseTo(10, 5);
    expect(gy).toBeCloseTo(0, 5);
  });
});

describe('clearWindGridCache', () => {
  beforeEach(() => {
    clearWindGridCache();
  });

  it('is safe to call with an empty cache', () => {
    expect(() => clearWindGridCache()).not.toThrow();
  });
});
