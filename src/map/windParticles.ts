/**
 * Zoom Earth–style wind particle animation on a canvas georeferenced to
 * FIELD_EXTENT. Pure canvas (no ArcGIS) — the MediaLayer wrapper owns the map.
 */

import type { WindGrid } from '@/data/windField';
import { canvasToGrid, sampleWindUv } from '@/data/windField';
import { fieldLandAlpha } from './tideField';

export const WIND_CANVAS_W = 900;
export const WIND_CANVAS_H = 650;

const PARTICLE_COUNT = 3200;
/** Pixels of travel per kn of wind per frame (tuned for ~24 fps look). */
const SPEED_SCALE = 0.55;
const MAX_AGE = 90;
const FADE = 'rgba(0,0,0,0.08)';

export interface WindParticleHandle {
  stop: () => void;
  setGrid: (grid: WindGrid) => void;
  canvas: HTMLCanvasElement;
}

interface Particle {
  x: number;
  y: number;
  age: number;
}

/** Cool→warm speed ramp (readable on imagery basemap), t∈[0,1]. */
export function windSpeedColor(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  // deep blue → cyan → lime → amber → coral
  if (x < 0.25) {
    const f = x / 0.25;
    return [Math.round(30 + 20 * f), Math.round(60 + 140 * f), Math.round(180 + 40 * f)];
  }
  if (x < 0.5) {
    const f = (x - 0.25) / 0.25;
    return [Math.round(50 + 70 * f), Math.round(200 - 20 * f), Math.round(220 - 100 * f)];
  }
  if (x < 0.75) {
    const f = (x - 0.5) / 0.25;
    return [Math.round(120 + 100 * f), Math.round(180 + 40 * f), Math.round(120 - 80 * f)];
  }
  const f = (x - 0.75) / 0.25;
  return [Math.round(220 + 35 * f), Math.round(220 - 100 * f), Math.round(40 + 40 * f)];
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function spawn(p: Particle, w: number, h: number): void {
  p.x = Math.random() * w;
  p.y = Math.random() * h;
  p.age = Math.floor(Math.random() * MAX_AGE);
}

/**
 * Draw one static frame of streaks (reduced-motion / first paint).
 * Returns the colour scale max used.
 */
export function paintWindFrame(
  ctx: CanvasRenderingContext2D,
  grid: WindGrid,
  particles: Particle[],
  opts: { fade: boolean; move: boolean } = { fade: true, move: true }
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  if (opts.fade) {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = FADE;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  } else {
    ctx.clearRect(0, 0, w, h);
  }

  const speedMax = Math.max(1, grid.speedMax);
  ctx.lineWidth = 1.2;
  ctx.lineCap = 'round';

  for (const p of particles) {
    const { gx, gy } = canvasToGrid(p.x, p.y, w, h, grid.cols, grid.rows);
    const sample = sampleWindUv(grid, gx, gy);
    const nx = p.x / Math.max(1, w - 1);
    const ny = 1 - p.y / Math.max(1, h - 1);
    const land = fieldLandAlpha(nx, ny);
    if (!sample || land < 0.15) {
      spawn(p, w, h);
      continue;
    }
    const [r, g, b] = windSpeedColor(sample.speed / speedMax);
    const alpha = 0.35 + 0.55 * land;
    const dx = sample.u * SPEED_SCALE;
    // canvas y increases southward; v is northward → subtract
    const dy = -sample.v * SPEED_SCALE;
    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    if (opts.move) {
      p.x += dx;
      p.y += dy;
      p.age += 1;
    }
    ctx.lineTo(p.x, p.y);
    ctx.stroke();

    if (
      opts.move &&
      (p.age > MAX_AGE || p.x < 0 || p.y < 0 || p.x > w || p.y > h || land < 0.2)
    ) {
      spawn(p, w, h);
    }
  }
}

/**
 * Start the particle loop on a canvas. Calls `onFrame` after each paint so the
 * MediaLayer can refresh. Reduced-motion: paints static streaks once and stops.
 */
export function startWindAnimation(
  canvas: HTMLCanvasElement,
  grid: WindGrid,
  opts?: { onFrame?: () => void; particleCount?: number }
): WindParticleHandle {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { stop: () => undefined, setGrid: () => undefined, canvas };
  }
  canvas.width = WIND_CANVAS_W;
  canvas.height = WIND_CANVAS_H;

  let current = grid;
  const count = opts?.particleCount ?? PARTICLE_COUNT;
  const particles: Particle[] = Array.from({ length: count }, () => {
    const p = { x: 0, y: 0, age: 0 };
    spawn(p, canvas.width, canvas.height);
    return p;
  });

  let raf = 0;
  let stopped = false;
  let last = 0;
  const minDt = 1000 / 24; // ~24 fps

  const tick = (ts: number) => {
    if (stopped) return;
    if (ts - last >= minDt) {
      last = ts;
      paintWindFrame(ctx, current, particles, { fade: true, move: true });
      opts?.onFrame?.();
    }
    raf = requestAnimationFrame(tick);
  };

  if (prefersReducedMotion()) {
    // Static streaks: advance once without fade so trails are visible.
    for (let i = 0; i < 12; i++) {
      paintWindFrame(ctx, current, particles, { fade: i > 0, move: true });
    }
    opts?.onFrame?.();
  } else {
    raf = requestAnimationFrame(tick);
  }

  return {
    canvas,
    stop: () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    setGrid: (g: WindGrid) => {
      current = g;
    },
  };
}
