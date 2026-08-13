import { describe, expect, it } from 'vitest';
import { TERMINALS, TERMINAL_QUAYS } from '@/map/portGeometry';
import { defaultVantages, useVrStore } from './vrStore';
import { bearingTo, groundDistanceM, normalizeHeading } from './stereo';
import { FOV_MAX_DEG, FOV_MIN_DEG } from './sceneBudget';

/** Smallest signed angle between two bearings, degrees. */
function angleDelta(a: number, b: number): number {
  const d = normalizeHeading(a - b);
  return Math.abs(d > 180 ? d - 360 : d);
}

describe('defaultVantages', () => {
  const vantages = defaultVantages();

  it('offers an apron and a crane cab per terminal, plus the VTS tower', () => {
    for (const t of TERMINALS) {
      expect(vantages.some((v) => v.id === `apron:${t.id}`), t.id).toBe(true);
      expect(vantages.some((v) => v.id === `crane:${t.id}`), t.id).toBe(true);
    }
    expect(vantages.some((v) => v.id === 'vts')).toBe(true);
  });

  it('gives every vantage a unique id and a legal pose', () => {
    const ids = vantages.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const v of vantages) {
      expect(v.eyeHeightM).toBeGreaterThan(0);
      expect(v.heading).toBeGreaterThanOrEqual(0);
      expect(v.heading).toBeLessThan(360);
      expect(Number.isFinite(v.longitude)).toBe(true);
      expect(Number.isFinite(v.latitude)).toBe(true);
      expect(v.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('faces each apron vantage at its terminal, not out to sea', () => {
    // Regression guard: the landward bearing was originally derived with atan2
    // over raw degree components, which ignores the ~5% longitude compression
    // at this latitude and skewed the opening heading.
    for (const t of TERMINALS) {
      const v = vantages.find((x) => x.id === `apron:${t.id}`)!;
      const toTerminal = bearingTo(v.longitude, v.latitude, t.lng, t.lat);
      expect(angleDelta(v.heading, toTerminal), `${t.id} faces its terminal`).toBeLessThan(45);
    }
  });

  it('stands the apron vantage off the quay, on the seaward side', () => {
    for (const t of TERMINALS) {
      const v = vantages.find((x) => x.id === `apron:${t.id}`)!;
      const q = TERMINAL_QUAYS[t.id];
      const offset = groundDistanceM(v.longitude, v.latitude, q.mid[0], q.mid[1]);
      // Far enough back to clear the 6 m deck wall, close enough to stay in the
      // berth pocket rather than out in the channel.
      expect(offset).toBeGreaterThan(100);
      expect(offset).toBeLessThan(200);
      // Seaward means further from the terminal centroid than the quay mid is.
      expect(groundDistanceM(v.longitude, v.latitude, t.lng, t.lat)).toBeGreaterThan(
        groundDistanceM(q.mid[0], q.mid[1], t.lng, t.lat)
      );
    }
  });
});

describe('useVrStore', () => {
  it('opens on a quay apron rather than the empty port centroid', () => {
    const s = useVrStore.getState();
    const apron = defaultVantages().find((v) => v.id === 'apron:GTI')!;
    expect(s.longitude).toBeCloseTo(apron.longitude, 9);
    expect(s.latitude).toBeCloseTo(apron.latitude, 9);
    expect(s.eyeHeightM).toBe(apron.eyeHeightM);
  });

  it('clamps eye height and IPD to sane ranges', () => {
    const { setEyeHeight, setIpd } = useVrStore.getState();
    setEyeHeight(-5);
    expect(useVrStore.getState().eyeHeightM).toBe(1);
    setEyeHeight(9999);
    expect(useVrStore.getState().eyeHeightM).toBe(400);
    setIpd(0.5);
    expect(useVrStore.getState().ipdM).toBe(0.09);
    setIpd(0);
    expect(useVrStore.getState().ipdM).toBe(0.045);
  });

  it('normalises heading and never leaves the immersive state stuck', () => {
    const { setHeading, enter, exit } = useVrStore.getState();
    setHeading(-45);
    expect(useVrStore.getState().heading).toBe(315);
    enter('vr');
    expect(useVrStore.getState().entered).toBe(true);
    expect(useVrStore.getState().mode).toBe('vr');
    exit();
    expect(useVrStore.getState().entered).toBe(false);
    // Exiting must drop the gyro so re-entering re-prompts for motion access.
    expect(useVrStore.getState().gyroActive).toBe(false);
  });
});

describe('field of view', () => {
  it('starts on the derived default rather than a hard-coded number', () => {
    // null means "work it out from the mode and the eye box" — a stored number
    // would be wrong the moment the phone is a different shape.
    useVrStore.getState().setFov(null);
    expect(useVrStore.getState().fovDeg).toBeNull();
  });

  it('clamps an operator’s trim to a usable range', () => {
    const { setFov } = useVrStore.getState();
    setFov(500);
    expect(useVrStore.getState().fovDeg).toBe(FOV_MAX_DEG);
    setFov(1);
    expect(useVrStore.getState().fovDeg).toBe(FOV_MIN_DEG);
    setFov(97);
    expect(useVrStore.getState().fovDeg).toBe(97);
    setFov(null);
    expect(useVrStore.getState().fovDeg).toBeNull();
  });
});
