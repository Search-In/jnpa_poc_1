/**
 * Sim-derived domain data (spec §B2). Pure functions that take the base fixtures
 * + the current sim levers and produce the "twin under scenario" view the panels
 * render — and, crucially, the "shadow" (do-nothing) view so every scenario can
 * show a simulated delta vs do-nothing instead of a claimed baseline improvement.
 *
 * Nothing here is random; everything is a deterministic function of the levers +
 * the sim clock, so a rehearsed run reproduces exactly.
 */
import type { Berth, BerthingPlanEntry, PortCraftUnit, WeatherReading } from '@/types/domain';
import { CHANNEL, TERMINALS } from '@/map/portGeometry';
import { computeUkc, tideAt, tidalWindows, type TidalWindow } from '@/dukc/ukc';
import type { SimLevers } from './simStore';

/**
 * Controlling (shallowest maintained) channel depth after a siltation delta AND
 * any dredging restoration. `channelDepthDeltaM` is negative for siltation loss;
 * `dredgeRestoreM` (≥0, additive UC-1 lever) adds depth back — a completed
 * dredging campaign offsets the loss. Both default to 0 → identical baseline.
 */
export function controllingDepthM(levers: SimLevers): number {
  const base = Math.min(...CHANNEL.filter((c) => c.id.includes('INNER') || c.id.includes('TURN')).map((c) => c.chartedDepthM));
  return Number((base + levers.channelDepthDeltaM + (levers.dredgeRestoreM ?? 0)).toFixed(2));
}

/**
 * Net channel-depth change (metres) after siltation loss and dredging restore.
 * Negative = net loss still present, positive = net gain. Additive helper the
 * plan-slip and DUKC overlays share so dredging consistently offsets siltation.
 */
export function netChannelDepthDeltaM(levers: SimLevers): number {
  return Number((levers.channelDepthDeltaM + (levers.dredgeRestoreM ?? 0)).toFixed(2));
}

/** Tide at the current sim time including any scenario offset. */
export function tideNow(clockH: number, levers: SimLevers): number {
  return Number((tideAt(clockH) + levers.tideOffsetM).toFixed(2));
}

/**
 * Weather reading synthesised from the sim clock + weather-severity lever, plus
 * the additive `rainMmHr` rain lever. Rain is reported as `rainMmHr` and, when
 * present, further reduces visibility (heavy rain lowers it toward the pilotage
 * limit) — a strict function of the lever, so `rainMmHr === 0` leaves the wind/
 * wave/visibility reading byte-identical to before (no regression).
 */
export function weatherAt(clockH: number, levers: SimLevers): WeatherReading {
  const sev = levers.weatherSeverity;
  const rain = levers.rainMmHr ?? 0;
  // Heavy rain cuts visibility (~0.35 nm lost per mm/h), floored with the storm
  // term. Zero rain → the original `Math.max(0.5, 8 - sev*6)` value unchanged.
  const rainVisPenalty = rain > 0 ? Math.min(6, rain * 0.35) : 0;
  return {
    TS: clockH,
    windKt: Number((10 + sev * 25 + 4 * Math.sin(clockH / 5)).toFixed(1)),
    windDir: Math.round(225 + 20 * Math.sin(clockH / 8)),
    seaStateM: Number((1.0 + sev * 3.0 + 0.4 * Math.sin(clockH / 4)).toFixed(1)),
    visibilityNm: Number(Math.max(0.3, 8 - sev * 6 - rainVisPenalty).toFixed(1)),
    tideM: tideNow(clockH, levers),
    rainMmHr: Number(rain.toFixed(1)),
  };
}

/**
 * Pilotage limit: suspended when wind/wave exceed the (severity-driven) limit,
 * OR visibility falls below the small-craft transfer minimum (~1 nm, e.g. a rain
 * squall / fog). Visibility is optional-safe. Behaviour is unchanged for calm,
 * good-visibility readings (visibility ≥ 1 nm).
 */
export function pilotageSuspended(w: WeatherReading): boolean {
  // Typical small-craft pilot-transfer limits: ~2.5 m sea / ~30 kn wind / ~1 nm vis.
  return w.seaStateM >= 2.5 || w.windKt >= 30 || (typeof w.visibilityNm === 'number' && w.visibilityNm < 1);
}

/**
 * Marine incident (oil spill / accident) severity that suspends vessel
 * movements. Additive: both levers default 0, so returns false in the baseline.
 * A spill or accident ≥ 0.3 severity halts pilot boarding while the fairway is
 * secured / the incident is contained.
 */
export function incidentSuspendsMovements(levers: SimLevers): boolean {
  return (levers.oilSpill ?? 0) >= 0.3 || (levers.accident ?? 0) >= 0.3;
}

/**
 * Channel segments closed by an oil spill (the fairway is shut while the slick is
 * boomed/contained). Additive: empty unless `oilSpill` ≥ 0.3. A worsening spill
 * closes the maintained inner reach first (the pinch point), then the turn.
 */
export function channelSegmentsClosed(levers: SimLevers): string[] {
  const s = levers.oilSpill ?? 0;
  if (s < 0.3) return [];
  const closed = ['CH-INNER'];
  if (s >= 0.6) closed.push('CH-TURN');
  if (s >= 0.85) closed.push('CH-QUAY');
  return closed;
}

/** Berths with scenario outages marked out of service. */
export function berthsUnderScenario(berths: Berth[], levers: SimLevers): Berth[] {
  if (!levers.berthsOut.length) return berths;
  const out = new Set(levers.berthsOut);
  return berths.map((b) => (out.has(b.BERTH_ID) ? { ...b, STATUS: 'maintenance' as const } : b));
}

/** Effective craft counts after a scenario knocks some offline. */
export function craftUnderScenario(craft: PortCraftUnit[], levers: SimLevers): PortCraftUnit[] {
  let pilotsDown = levers.pilotsDown;
  let tugsDown = levers.tugsDown;
  return craft.map((c) => {
    if (c.TYPE === 'pilot' && pilotsDown > 0 && c.STATUS === 'idle') {
      pilotsDown--;
      return { ...c, STATUS: 'maintenance' as const };
    }
    if (c.TYPE === 'tug' && tugsDown > 0 && c.STATUS === 'idle') {
      tugsDown--;
      return { ...c, STATUS: 'maintenance' as const };
    }
    return c;
  });
}

export interface PlannedTransit {
  planId: string;
  mmsi: string;
  vesselName: string;
  berthId: string;
  terminal: string;
  /** Static draft (m) — deep for BMCT/GTI calls, shallower elsewhere. */
  staticDraftM: number;
  blockCoef: number;
  /** Controlling depth on this transit's route (m). */
  controllingDepthM: number;
  /** Planned alongside start (epoch ms). */
  plannedStart: number;
  /** Go/no-go tidal windows over the 5-day horizon (hours-from-epoch). */
  windows: TidalWindow[];
}

/** Assign a plausible draft per terminal size-class (BMCT/GTI take the deepest). */
function draftForTerminal(terminal: string): { draft: number; cb: number } {
  const t = TERMINALS.find((x) => terminal.startsWith(x.id));
  const max = t?.maxDraftM ?? 14;
  // A call typically sits ~0.5–1.5 m under the terminal max design draft.
  return { draft: Number((max - 0.8).toFixed(1)), cb: /BMCT|GTI/.test(terminal) ? 0.68 : 0.65 };
}

/**
 * Derive planned DUKC transits from the berthing plan (one per planned call),
 * each with its tidal go/no-go windows under the current channel-depth/tide
 * levers — the data behind both the DUKC corridor and the gantt's feasibility bands.
 */
export function plannedTransits(plan: BerthingPlanEntry[], levers: SimLevers, startH = 0): PlannedTransit[] {
  const depth = controllingDepthM(levers);
  return plan.map((p) => {
    const terminal = p.BERTH_ID.split('-')[0];
    const { draft, cb } = draftForTerminal(terminal);
    return {
      planId: p.PLAN_ID,
      mmsi: p.MMSI,
      vesselName: p.VESSEL_NAME,
      berthId: p.BERTH_ID,
      terminal,
      staticDraftM: draft,
      blockCoef: cb,
      controllingDepthM: depth,
      plannedStart: p.PLANNED_START,
      windows: tidalWindows({
        staticDraftM: draft,
        controllingDepthM: depth,
        speedKt: 8,
        blockCoef: cb,
        horizonH: 120,
        startH,
      }),
    };
  });
}

/** Per-segment live UKC for the corridor colouring at the current tide. */
export function corridorUkc(clockH: number, levers: SimLevers, staticDraftM = 15.5, speedKt = 8) {
  const tide = tideNow(clockH, levers);
  return CHANNEL.map((seg) => ({
    seg,
    ...computeUkc({
      staticDraftM,
      // Include dredging restoration so the live corridor recovers consistently
      // with the tidal windows (both go through the depth delta). Default 0.
      chartedDepthM: seg.chartedDepthM + levers.channelDepthDeltaM + (levers.dredgeRestoreM ?? 0),
      tideM: tide,
      speedKt,
      blockCoef: 0.68,
    }),
  }));
}
