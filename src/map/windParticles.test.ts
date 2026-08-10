import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { windSpeedColor, paintWindFrame, startWindAnimation } from './windParticles';
import type { WindGrid } from '@/data/windField';

function fixtureGrid(): WindGrid {
  const cols = 4;
  const rows = 3;
  const n = cols * rows;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    u[i] = -10;
    v[i] = 0;
  }
  return { cols, rows, u, v, speedMax: 10, fetchedAt: Date.now() };
}

function mockCtx(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = {
    canvas,
    globalCompositeOperation: 'source-over',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: 'round',
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  } as unknown as CanvasRenderingContext2D;
  return ctx;
}

describe('windSpeedColor', () => {
  it('returns RGB triples in 0..255', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const [r, g, b] = windSpeedColor(t);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(255);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(255);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(255);
    }
  });

  it('clamps out-of-range t', () => {
    expect(windSpeedColor(-1)).toEqual(windSpeedColor(0));
    expect(windSpeedColor(2)).toEqual(windSpeedColor(1));
  });
});

describe('paintWindFrame', () => {
  it('draws without throwing on a mocked canvas context', () => {
    const canvas = { width: 80, height: 60 } as HTMLCanvasElement;
    const ctx = mockCtx(canvas);
    const particles = Array.from({ length: 20 }, () => ({
      x: Math.random() * 80,
      y: Math.random() * 60,
      age: 0,
    }));
    expect(() =>
      paintWindFrame(ctx, fixtureGrid(), particles, { fade: false, move: true })
    ).not.toThrow();
    expect(ctx.stroke).toHaveBeenCalled();
  });
});

describe('startWindAnimation', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('respects prefers-reduced-motion with a static paint + stoppable handle', () => {
    const canvas = document.createElement('canvas');
    const ctx = mockCtx(canvas);
    vi.spyOn(canvas, 'getContext').mockReturnValue(ctx);
    const onFrame = vi.fn();
    const handle = startWindAnimation(canvas, fixtureGrid(), {
      onFrame,
      particleCount: 40,
    });
    expect(onFrame).toHaveBeenCalled();
    expect(canvas.width).toBeGreaterThan(0);
    expect(() => handle.stop()).not.toThrow();
  });
});
