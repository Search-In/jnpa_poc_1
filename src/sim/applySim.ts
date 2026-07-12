/**
 * applySim — pure, non-mutating overlays that fold the current sim state
 * (`levers` + `overrides`) onto base adapter reads. `SimAdapter` calls these on
 * every read so the existing map + dashboard reflect the simulator with zero
 * per-panel wiring (the PoC_2 "control room" pattern).
 *
 * Two layers, applied in order:
 *  1. `levers`    — environment/resource causes, via the existing `derive.ts`
 *                   (berths out → maintenance, craft down → maintenance, weather).
 *  2. `overrides` — direct data effects the operator staged from the Simulator
 *                   page: inject vessels, force per-berth status, take specific
 *                   craft offline, nudge headline KPI values.
 *
 * Nothing here mutates its inputs or touches Date.now/Math.random in a way that
 * breaks determinism — spawned vessels are a deterministic function of the base
 * clock + index, so a rehearsed run reproduces.
 */
import type {
  Berth,
  NavStatus,
  PortCraftUnit,
  Vessel,
  WeatherReading,
} from '@/types/domain';
import type { KpiBundle, KpiValue } from '@/types/kpi';
import { PILOT_STATION, ANCHORAGES } from '@/map/portGeometry';
import { berthsUnderScenario, craftUnderScenario, weatherAt } from './derive';
import type { KpiDeltas, SimLevers, SimOverrides } from './simStore';

/** The full sim state slice the overlays need. */
export interface SimSnapshot {
  clockH: number;
  levers: SimLevers;
  overrides: SimOverrides;
}

/** Centre of the waiting anchorage, used to place spawned/forced-anchored ships. */
function anchorageCentre(): [number, number] {
  const ring = ANCHORAGES[0]?.ring ?? [[72.878, 18.898]];
  const n = ring.length || 1;
  const lng = ring.reduce((a, p) => a + p[0], 0) / n;
  const lat = ring.reduce((a, p) => a + p[1], 0) / n;
  return [lng, lat];
}

/**
 * Injected vessels — deterministic pseudo-AIS contacts the operator spawns to
 * stage congestion on the map. Placed on a ring around the anchorage / pilot
 * boarding ground and drifted by the sim clock so they visibly move.
 */
export function spawnedVessels(count: number, clockH: number): Vessel[] {
  if (count <= 0) return [];
  const [aLng, aLat] = anchorageCentre();
  const out: Vessel[] = [];
  for (let i = 0; i < count; i++) {
    // Even spread around a ring; drift the phase with the sim clock.
    const theta = (i / count) * Math.PI * 2 + clockH * 0.05;
    const r = 0.012 + (i % 3) * 0.004;
    const approaching = i % 2 === 0;
    const [cLng, cLat] = approaching ? [PILOT_STATION.lng, PILOT_STATION.lat] : [aLng, aLat];
    out.push({
      MMSI: `SIM${String(100000 + i)}`,
      VESSEL_NAME: `SIM Contact ${i + 1}`,
      VESSEL_TYPE: i % 3 === 0 ? 'Container Ship' : i % 3 === 1 ? 'Tanker' : 'Bulk Carrier',
      NAV_STATUS: approaching ? 'approaching' : 'anchored',
      SOG: approaching ? Number((6 + (i % 4)).toFixed(1)) : 0,
      COG: Math.round((theta * 180) / Math.PI) % 360,
      HEADING: Math.round((theta * 180) / Math.PI) % 360,
      LAT: Number((cLat + r * Math.sin(theta)).toFixed(5)),
      LON: Number((cLng + r * Math.cos(theta)).toFixed(5)),
      ETA: null,
      BERTH_ID: null,
      TIMESTAMP: Date.now(),
    });
  }
  return out;
}

/**
 * Overlay vessels: append spawned contacts, then force the first N of the whole
 * set to `anchored` / `approaching` so the operator can flood the anchorage or
 * the approach lanes directly.
 */
export function applyVessels(base: Vessel[], snap: SimSnapshot): Vessel[] {
  const { overrides, clockH } = snap;
  let vessels: Vessel[] = [...base, ...spawnedVessels(overrides.spawnVessels, clockH)];

  const force = (status: NavStatus, n: number) => {
    if (n <= 0) return;
    let done = 0;
    vessels = vessels.map((v) => {
      if (done < n && v.NAV_STATUS !== status) {
        done++;
        // Anchored contacts drift toward the anchorage; approaching to the PBG.
        const target = status === 'anchored' ? anchorageCentre() : [PILOT_STATION.lng, PILOT_STATION.lat];
        return { ...v, NAV_STATUS: status, SOG: status === 'anchored' ? 0 : v.SOG, LON: target[0], LAT: target[1] };
      }
      return v;
    });
  };
  force('anchored', overrides.forceAnchored);
  force('approaching', overrides.forceApproaching);
  return vessels;
}

/** Overlay berths: lever outages (maintenance) then per-berth forced status. */
export function applyBerths(base: Berth[], snap: SimSnapshot): Berth[] {
  const leverApplied = berthsUnderScenario(base, snap.levers);
  const forced = snap.overrides.berthStatus;
  if (Object.keys(forced).length === 0) return leverApplied;
  return leverApplied.map((b) => (forced[b.BERTH_ID] ? { ...b, STATUS: forced[b.BERTH_ID] } : b));
}

/** Overlay port craft: lever pilots/tugs-down then explicit per-craft outages. */
export function applyPortCraft(base: PortCraftUnit[], snap: SimSnapshot): PortCraftUnit[] {
  const leverApplied = craftUnderScenario(base, snap.levers);
  const out = new Set(snap.overrides.craftOut);
  if (out.size === 0) return leverApplied;
  return leverApplied.map((c) => (out.has(c.CRAFT_ID) ? { ...c, STATUS: 'maintenance' as const } : c));
}

/** Overlay weather from the weather-severity / tide / channel-depth levers. */
export function applyWeather(base: WeatherReading, snap: SimSnapshot): WeatherReading {
  // The derived reading is a strict function of the levers; when neutral it
  // returns essentially the calm baseline, so prefer it whenever any lever is set.
  const l = snap.levers;
  if (l.weatherSeverity === 0 && l.tideOffsetM === 0 && l.channelDepthDeltaM === 0) return base;
  return weatherAt(snap.clockH, l);
}

/** Re-derive a KPI card's signed delta-vs-target after a value nudge. */
function withValue(card: KpiValue, value: number): KpiValue {
  const v = Number(value.toFixed(2));
  const deltaPct = card.target === 0 ? 0 : Number((((v - card.target) / card.target) * 100).toFixed(1));
  return { ...card, value: v, deltaPct };
}

/**
 * Overlay the headline KPI bundle with the operator's signed metric deltas.
 * Percentage metrics are clamped to [0, 100]; delays/TAT floored at 0.
 */
export function applyKpis(base: KpiBundle, deltas: KpiDeltas): KpiBundle {
  const clampPct = (n: number) => Math.max(0, Math.min(100, n));
  const floor0 = (n: number) => Math.max(0, n);
  return {
    ...base,
    preBerthingDelay: withValue(base.preBerthingDelay, floor0(base.preBerthingDelay.value + deltas.preBerthingDelay)),
    preSailingDelay: withValue(base.preSailingDelay, floor0(base.preSailingDelay.value + deltas.preSailingDelay)),
    avgTat: withValue(base.avgTat, floor0(base.avgTat.value + deltas.avgTat)),
    jitPct: withValue(base.jitPct, clampPct(base.jitPct.value + deltas.jitPct)),
    forecastAccuracy: withValue(base.forecastAccuracy, clampPct(base.forecastAccuracy.value + deltas.forecastAccuracy)),
    berthOccupancy: withValue(base.berthOccupancy, clampPct(base.berthOccupancy.value + deltas.berthOccupancy)),
  };
}
