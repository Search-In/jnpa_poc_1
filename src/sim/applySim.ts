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
  BerthingPlanEntry,
  NavStatus,
  PortCraftUnit,
  TideStationsReading,
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
export function spawnedVessels(count: number, clockH: number, idOffset = 0): Vessel[] {
  if (count <= 0) return [];
  const [aLng, aLat] = anchorageCentre();
  const out: Vessel[] = [];
  for (let i = 0; i < count; i++) {
    const idx = i + idOffset; // distinct ids across multiple spawn sources
    // Even spread around a ring; drift the phase with the sim clock.
    const theta = (i / count) * Math.PI * 2 + clockH * 0.05;
    const r = 0.012 + (i % 3) * 0.004;
    const approaching = i % 2 === 0;
    const [cLng, cLat] = approaching ? [PILOT_STATION.lng, PILOT_STATION.lat] : [aLng, aLat];
    out.push({
      MMSI: `SIM${String(100000 + idx)}`,
      VESSEL_NAME: `SIM Contact ${idx + 1}`,
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
  const { overrides, levers, clockH } = snap;
  // Two spawn sources: the operator's explicit spawnVessels override AND the
  // `extraArrivals` scenario lever — bunching arrivals must actually APPEAR at
  // the anchorage/approach (M5 "fog lifts, six arrivals present at once"), not
  // only slip the plan actuals. Offset the lever contacts' index so their ids
  // don't collide with the override-spawned ones.
  const extra = Math.min(levers.extraArrivals, 8);
  let vessels: Vessel[] = [
    ...base,
    ...spawnedVessels(overrides.spawnVessels, clockH),
    ...spawnedVessels(extra, clockH, overrides.spawnVessels + 1),
  ];

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

/** A call's lever-driven perturbation, split so it can move TAT as well as JIT. */
interface PlanSlip {
  /** Hours the *arrival/berthing* (ACTUAL_START) is pushed later — hits JIT + pre-berth delay. */
  startH: number;
  /**
   * Extra hours added to the *service/alongside* interval, i.e. applied to
   * ACTUAL_END ON TOP of startH. Because ATD moves more than ATA, turnaround
   * (ATD − ATA) grows — this is what makes TAT respond, not just shift.
   */
  serviceH: number;
}

/**
 * A call's lever-driven slip, vs the do-nothing baseline. Pure function of the
 * levers so a rehearsed run reproduces. Two components:
 *  - startH   pushes the berthing/arrival later (JIT miss + pre-berthing delay):
 *      weatherSeverity → pilotage hold at anchorage (~4h at full storm)
 *      pilotsDown      → boarding queue (~0.7h per missing pilot)
 *      channelDepthDeltaM (loss) → deep-draft calls wait for a higher tide (~3h/m)
 *      extraArrivals   → bunching compresses slots (~0.25h per extra arrival)
 *      berthsOut       → a call on a closed berth waits for a compatible one (+3h)
 *  - serviceH lengthens the alongside interval, so TAT grows (not just shifts):
 *      tugsDown        → unberthing is slower, extending the turn (~0.5h per tug)
 *      channelDepthDeltaM (loss) → tighter windows stretch the departure too
 * Zero when the twin is neutral, so JIT / delays / TAT match the honest baseline.
 */
function leverPlanSlip(levers: SimLevers, entry: BerthingPlanEntry): PlanSlip {
  // NET siltation: negative channelDepthDeltaM (loss) offset by dredgeRestoreM
  // (an additive dredging campaign adds depth back). Both default 0.
  const depthLossM = Math.max(0, -(levers.channelDepthDeltaM + (levers.dredgeRestoreM ?? 0)));

  let startH = 0;
  startH += levers.weatherSeverity * 4; // storm hold
  startH += levers.pilotsDown * 0.7; // boarding queue
  startH += depthLossM * 3; // wait for a higher tide (deep-draft window loss)
  startH += Math.min(levers.extraArrivals, 8) * 0.25; // bunching
  if (levers.berthsOut.includes(entry.BERTH_ID)) startH += 3; // reassignment wait
  // UC-1 additive causes (all levers default 0 → no effect on the baseline):
  startH += Math.min((levers.rainMmHr ?? 0) * 0.05, 3); // rain squall cuts visibility → pilotage hold (≤3h)
  startH += (levers.oilSpill ?? 0) * 6; // oil spill closes the fairway → transit deferred (≤6h)
  startH += (levers.accident ?? 0) * 5; // marine accident suspends movements (≤5h)

  let serviceH = 0;
  serviceH += levers.tugsDown * 0.5; // slower unberthing extends the turn
  serviceH += depthLossM * 0.5; // narrower windows stretch the departure
  serviceH += levers.berthWindowExtendH ?? 0; // extended berth/service window → longer alongside → TAT grows

  return { startH, serviceH };
}

/**
 * Overlay the berthing plan with lever-driven slip. Non-destructive: for each
 * call that has actuals, ACTUAL_START moves later by `startH` and ACTUAL_END by
 * `startH + serviceH`, so the SAME formulas recompute JIT / pre-berthing delay
 * (from the later berthing) AND turnaround (from the widened alongside interval)
 * off one perturbed plan. This is the single causal source — the gantt and every
 * headline KPI read it, so they stay consistent. Neutral levers → identity
 * (honest baseline preserved).
 */
export function applyPlanLevers(base: BerthingPlanEntry[], levers: SimLevers): BerthingPlanEntry[] {
  return base.map((p) => {
    if (p.ACTUAL_START === null) return p;
    const { startH, serviceH } = leverPlanSlip(levers, p);
    if (startH === 0 && serviceH === 0) return p;
    const startMs = startH * 3_600_000;
    const endMs = (startH + serviceH) * 3_600_000;
    return {
      ...p,
      ACTUAL_START: p.ACTUAL_START + startMs,
      ACTUAL_END: p.ACTUAL_END === null ? null : p.ACTUAL_END + endMs,
    };
  });
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
  if (l.weatherSeverity === 0 && l.tideOffsetM === 0 && l.channelDepthDeltaM === 0 && (l.rainMmHr ?? 0) === 0) return base;
  return weatherAt(snap.clockH, l);
}

/**
 * Overlay the per-station tide + sea-state set with the scenario levers, so the
 * Tide & Sea State panel stays consistent with the weather panel and DUKC under
 * what-if: the tide offset shifts every station's height, and weather severity
 * lifts sea state / swell (a storm hits the whole port). Neutral levers pass the
 * base reading through unchanged. See [[uc1-whatif-consistency]].
 */
export function applyTideStations(base: TideStationsReading, snap: SimSnapshot): TideStationsReading {
  const l = snap.levers;
  if (l.weatherSeverity === 0 && l.tideOffsetM === 0) return base;
  const stations = base.stations.map((st) => ({
    ...st,
    tideM: Number((st.tideM + l.tideOffsetM).toFixed(2)),
    seaStateM: Number((st.seaStateM + l.weatherSeverity * 3.0).toFixed(1)),
    swellM: Number((st.swellM + l.weatherSeverity * 1.5).toFixed(1)),
    windKt: Number((st.windKt + l.weatherSeverity * 25).toFixed(1)),
  }));
  return { ...base, stations };
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
