/**
 * Just-In-Time arrival orchestration (spec C-1). For an inbound vessel we
 * compute a Recommended Time of Arrival (RTA) = the latest feasible moment that
 * still hits the first berth-available + tidal go window, so the ship can "steam
 * slower, arrive just in time" rather than wait at anchor. We then estimate the
 * (simulated) bunker + CO₂ saved by dropping to the slower required speed.
 *
 * Every figure is a SIMULATED result under stated assumptions (bunker/emission
 * factors are nominal, documented in the assumptions register) — never a JNPA
 * baseline. Pure/deterministic.
 */

import { MS_PER_HOUR } from '@/kpi/helpers';

/** Nominal main-engine fuel/emission assumptions (documented, simulated). */
export const FUEL_T_PER_H_AT_SERVICE = 3.2; // t/h HFO-equivalent at service speed
export const SERVICE_SPEED_KN = 16;
export const CO2_T_PER_FUEL_T = 3.114; // IMO bunker→CO₂ factor
export const BUNKER_USD_PER_T = 600;

export interface JitInput {
  /** Current ETA at pilot boarding ground (epoch ms). */
  etaMs: number;
  /** Earliest the berth is free (epoch ms). */
  berthReadyMs: number;
  /** Start of the next tidal/DUKC go window (epoch ms). */
  goWindowStartMs: number;
  /** Distance still to run to the boarding ground (nm). */
  distanceNm: number;
  /** Current planned speed (kn). */
  currentSpeedKn: number;
}

export interface JitRecommendation {
  /** Recommended time of arrival (epoch ms) = max(berthReady, goWindowStart). */
  rtaMs: number;
  /** Hours of anchor waiting avoided vs steaming at current speed to the ETA. */
  waitAvoidedH: number;
  /** Recommended (slower) speed to arrive at RTA (kn); null if RTA ≤ now-implied. */
  recommendedSpeedKn: number | null;
  /** Simulated bunker saved (tonnes) by slowing from current to recommended. */
  bunkerSavedT: number;
  /** Simulated CO₂ saved (tonnes). */
  co2SavedT: number;
  /** Simulated bunker cost saved (USD). */
  costSavedUsd: number;
  /** Plain-language advisory. */
  advisory: string;
}

/**
 * Compute the JIT recommendation. The RTA is the first moment the vessel can
 * actually berth (berth free AND in a go window). If arriving then needs a
 * slower speed than currently planned, we estimate the fuel/CO₂ saved.
 */
export function recommendRta(input: JitInput): JitRecommendation {
  const rtaMs = Math.max(input.berthReadyMs, input.goWindowStartMs);

  // Waiting avoided = how long the ship would otherwise sit between its ETA and
  // the moment it can berth.
  const waitAvoidedH = Math.max(0, (rtaMs - input.etaMs) / MS_PER_HOUR);

  // Time available from the ETA-implied departure to the RTA, at current speed
  // the run takes distance/current hours; to arrive at RTA instead we can slow.
  const currentRunH = input.distanceNm / Math.max(0.1, input.currentSpeedKn);
  const availableH = currentRunH + waitAvoidedH; // stretch the passage over the wait
  const recommendedSpeedKn = availableH > 0 ? input.distanceNm / availableH : null;

  // Fuel scales ~ with the cube of speed for the main engine; approximate the
  // per-hour burn at the slower speed and integrate over the (longer) passage.
  let bunkerSavedT = 0;
  if (recommendedSpeedKn && recommendedSpeedKn < input.currentSpeedKn) {
    const burnAt = (kn: number) =>
      FUEL_T_PER_H_AT_SERVICE * (kn / SERVICE_SPEED_KN) ** 3;
    const currentFuel = burnAt(input.currentSpeedKn) * currentRunH;
    const slowerFuel = burnAt(recommendedSpeedKn) * availableH;
    bunkerSavedT = Math.max(0, currentFuel - slowerFuel);
  }
  const co2SavedT = bunkerSavedT * CO2_T_PER_FUEL_T;
  const costSavedUsd = bunkerSavedT * BUNKER_USD_PER_T;

  const advisory =
    waitAvoidedH < 0.25
      ? 'Arrive as planned — no material JIT benefit.'
      : recommendedSpeedKn
        ? `Reduce to ~${recommendedSpeedKn.toFixed(1)} kn to arrive just in time; ` +
          `avoids ~${waitAvoidedH.toFixed(1)} h at anchor (simulated).`
        : `Hold departure — berth/window not ready for ~${waitAvoidedH.toFixed(1)} h.`;

  return {
    rtaMs,
    waitAvoidedH: round1(waitAvoidedH),
    recommendedSpeedKn: recommendedSpeedKn ? round1(recommendedSpeedKn) : null,
    bunkerSavedT: round1(bunkerSavedT),
    co2SavedT: round1(co2SavedT),
    costSavedUsd: Math.round(costSavedUsd),
    advisory,
  };
}

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
