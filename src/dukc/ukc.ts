/**
 * DUKC / RTUKC under-keel-clearance engine (spec §A5, §A7 kill-shot).
 *
 * DUKC (Dynamic/Predictive Under-Keel Clearance) is the *predictive* passage-plan
 * computation: for a planned transit we project, per channel segment and over the
 * tide curve, whether the available water column exceeds the vessel's dynamic
 * draft plus a safety margin — producing go / no-go tidal windows.
 *
 * RTUKC (Real-Time UKC) is the *live* readout during an in-progress transit:
 * observed tide + measured squat at the vessel's current position, updated each
 * tick. This module computes both from the same physical relation; the UI renders
 * them as visibly distinct features (predictive windows vs live gauge).
 *
 * Water column model (defensible, explainable under probing):
 *   available = chartedDepth + tideHeight
 *   required  = staticDraft + squat + safetyMargin
 *   UKC       = available − required
 * Squat uses a simplified Barrass-style term scaling with speed² and block
 * coefficient; the safety margin is a fixed policy allowance. Every figure is
 * sourced in the assumptions register.
 */

/** Policy UKC safety margin (m) — gross UKC below this is no-go. */
export const UKC_SAFETY_MARGIN_M = 1.0;
/** Marginal band above the hard margin (m) — amber, pilot discretion. */
export const UKC_MARGINAL_BAND_M = 0.6;

export interface UkcInputs {
  /** Static (still-water) draft of the vessel, m. */
  staticDraftM: number;
  /** Charted depth below datum for the segment, m. */
  chartedDepthM: number;
  /** Tide height above chart datum at the transit time, m. */
  tideM: number;
  /** Speed over ground through the segment, knots. */
  speedKt: number;
  /** Block coefficient (fullness of hull); container ≈ 0.65, bulk ≈ 0.80. */
  blockCoef?: number;
}

export interface UkcResult {
  availableM: number;
  requiredM: number;
  squatM: number;
  ukcM: number;
  /** Traffic-light classification against the safety policy. */
  status: 'go' | 'marginal' | 'noGo';
}

/**
 * Barrass-style squat (simplified, open-water form):
 *   squat ≈ Cb · V² / 100   (metres, V in knots)
 * Good enough to make speed and hull-fullness visibly matter without over-claiming
 * a proprietary model. Clamped to a sane range.
 */
export function squat(speedKt: number, blockCoef = 0.65): number {
  const s = (blockCoef * speedKt * speedKt) / 100;
  return Math.max(0, Math.min(2.5, Number(s.toFixed(2))));
}

export function computeUkc(inp: UkcInputs): UkcResult {
  const sq = squat(inp.speedKt, inp.blockCoef);
  const available = inp.chartedDepthM + inp.tideM;
  const required = inp.staticDraftM + sq + UKC_SAFETY_MARGIN_M;
  // Gross UKC excludes the policy margin so the number reads as physical clearance.
  const grossUkc = inp.chartedDepthM + inp.tideM - (inp.staticDraftM + sq);
  const status: UkcResult['status'] =
    grossUkc < UKC_SAFETY_MARGIN_M
      ? 'noGo'
      : grossUkc < UKC_SAFETY_MARGIN_M + UKC_MARGINAL_BAND_M
        ? 'marginal'
        : 'go';
  return {
    availableM: Number(available.toFixed(2)),
    requiredM: Number(required.toFixed(2)),
    squatM: sq,
    ukcM: Number(grossUkc.toFixed(2)),
    status,
  };
}

/**
 * Simple semidiurnal tide model for JNPA (mixed, ~2 highs/day). Amplitude and
 * datum are calibrated to a plausible spring/neap envelope; phase is driven by
 * the sim clock so the DUKC windows move as time advances. Deterministic — no
 * Date.now / Math.random.
 *
 * @param hoursFromEpoch hours since the sim epoch (fractional ok)
 */
export function tideAt(hoursFromEpoch: number, meanM = 2.6, amplitudeM = 1.7): number {
  // Two constituents → a mixed semidiurnal shape (M2-ish + a diurnal skew).
  const semidiurnal = Math.sin((2 * Math.PI * hoursFromEpoch) / 12.42);
  const diurnal = 0.35 * Math.sin((2 * Math.PI * hoursFromEpoch) / 24.0 + 0.6);
  return Number((meanM + amplitudeM * (semidiurnal + diurnal) * 0.8).toFixed(2));
}

export interface TidalWindow {
  /** Window start / end in hours-from-epoch. */
  fromH: number;
  toH: number;
  status: 'go' | 'marginal';
}

/**
 * Compute the go/no-go tidal windows for a vessel over a horizon by walking the
 * tide curve at a fixed step and classifying UKC at the shallowest segment it
 * must transit. Returns contiguous go/marginal windows (no-go gaps omitted).
 */
export function tidalWindows(
  params: {
    staticDraftM: number;
    controllingDepthM: number;
    speedKt: number;
    blockCoef?: number;
    horizonH?: number;
    stepH?: number;
    startH?: number;
  },
): TidalWindow[] {
  const { staticDraftM, controllingDepthM, speedKt, blockCoef = 0.65 } = params;
  const horizonH = params.horizonH ?? 120; // 5 days
  const stepH = params.stepH ?? 0.25;
  const startH = params.startH ?? 0;

  const windows: TidalWindow[] = [];
  let cur: TidalWindow | null = null;
  for (let h = startH; h <= startH + horizonH; h += stepH) {
    const tide = tideAt(h);
    const { status } = computeUkc({
      staticDraftM,
      chartedDepthM: controllingDepthM,
      tideM: tide,
      speedKt,
      blockCoef,
    });
    const open = status === 'go' || status === 'marginal';
    if (open) {
      if (!cur) cur = { fromH: h, toH: h, status: status as 'go' | 'marginal' };
      else {
        cur.toH = h;
        // A window that dips to marginal is labelled marginal overall.
        if (status === 'marginal') cur.status = 'marginal';
      }
    } else if (cur) {
      windows.push(cur);
      cur = null;
    }
  }
  if (cur) windows.push(cur);
  return windows;
}
