/**
 * tatPredict — an ADDITIVE, explainable feature model for vessel turnaround-time
 * (TAT) prediction (UC-1 "predicting turnaround time"). This does NOT replace or
 * modify the existing descriptive `avgVesselTAT()` (a backward-looking mean in
 * `kpi/formulas.ts`); it is a separate forward-looking estimator a panel or the
 * planner can adopt when a *forecast* is wanted rather than a historical average.
 *
 * Integrity (spec §A3): this is a transparent, documented linear feature model
 * with quantified uncertainty — an explainable upgrade over a flat mean — NOT a
 * trained/proprietary ML model and NOT a claimed JNPA baseline. Every coefficient
 * is stated, and the prediction returns its per-factor contributions so the
 * number is fully auditable. Deterministic (no Date.now/Math.random).
 *
 * The stressor coefficients deliberately mirror the plan-slip causes used by the
 * reactive twin (`sim/applySim.ts`), so a forecast is consistent with how the
 * same what-if levers move the simulated actuals.
 */
import type { SimLevers } from '@/sim/simStore';
import { netChannelDepthDeltaM } from '@/sim/derive';

/** Feature vector for one call's turnaround forecast. */
export interface TatFeatures {
  /** Parcel size proxy — TEU exchanged this call (drives cargo work time). */
  parcelTeu: number;
  /** Terminal max design draft (m) — a size-class proxy (deeper ≈ larger ship). */
  terminalMaxDraftM: number;
  /** Weather severity 0..1 over the call window. */
  weatherSeverity: number;
  /** Rain intensity, mm/h. */
  rainMmHr: number;
  /** Net channel-depth change (m); negative = siltation loss net of dredging. */
  netDepthDeltaM: number;
  /** Pilots unavailable (count). */
  pilotsDown: number;
  /** Tugs unavailable (count). */
  tugsDown: number;
  /** Extra arrivals in the window (bunching/congestion). */
  extraArrivals: number;
  /** Marine-incident severity 0..1 (max of oil-spill / accident). */
  incidentSeverity: number;
  /** Extended berth/service window (hours). */
  berthWindowExtendH: number;
}

/** A prediction: point estimate + ~P10/P90 band + auditable contributions. */
export interface TatPrediction {
  /** Point (median) estimate, hours. */
  hoursP50: number;
  /** Lower ~10th-percentile bound, hours. */
  hoursP10: number;
  /** Upper ~90th-percentile bound, hours. */
  hoursP90: number;
  /** Model 1-sigma uncertainty, hours (grows with the active stressors). */
  sigmaH: number;
  /** Per-factor hour contributions, in application order (explainability). */
  contributions: { factor: string; hours: number }[];
}

/**
 * Model coefficients (documented calibration, not learned). Base ≈ a mid-size
 * container call's pilot-boarding→deboarding turn; the cargo/size terms scale it,
 * and the stressor terms mirror the reactive-twin plan-slip causes.
 */
export const TAT_MODEL = {
  baseH: 34, // mid-size call minimum turn
  perTeuH: 1 / 250, // ~9.4 h at 2,355 TEU (crane work)
  perDraftMOverH: 1.5, // hours per metre of terminal max draft over 13 m
  draftRefM: 13,
  weatherH: 5, // per unit severity
  rainPerMmH: 0.03, // capped
  rainCapH: 2,
  depthLossPerMH: 4, // window loss stretches the call
  pilotDownH: 0.7,
  tugDownH: 0.9,
  perExtraArrivalH: 0.3,
  extraArrivalCap: 8,
  incidentH: 6, // per unit severity
  extendWindowH: 1, // 1:1 with the extended alongside window
} as const;

/** Round to 1 dp. */
function r1(n: number): number {
  return Number(n.toFixed(1));
}

/**
 * Predict a call's turnaround (hours) from its features, with an explainable
 * breakdown and an uncertainty band. Pure and deterministic.
 */
export function predictTat(f: TatFeatures): TatPrediction {
  const m = TAT_MODEL;
  const depthLossM = Math.max(0, -f.netDepthDeltaM);
  const contributions: { factor: string; hours: number }[] = [
    { factor: 'Base turn', hours: r1(m.baseH) },
    { factor: 'Cargo (parcel)', hours: r1(Math.max(0, f.parcelTeu) * m.perTeuH) },
    { factor: 'Size class', hours: r1(Math.max(0, f.terminalMaxDraftM - m.draftRefM) * m.perDraftMOverH) },
    { factor: 'Weather', hours: r1(Math.max(0, f.weatherSeverity) * m.weatherH) },
    { factor: 'Rain', hours: r1(Math.min(Math.max(0, f.rainMmHr) * m.rainPerMmH, m.rainCapH)) },
    { factor: 'Channel depth loss', hours: r1(depthLossM * m.depthLossPerMH) },
    { factor: 'Pilots down', hours: r1(Math.max(0, f.pilotsDown) * m.pilotDownH) },
    { factor: 'Tugs down', hours: r1(Math.max(0, f.tugsDown) * m.tugDownH) },
    { factor: 'Congestion', hours: r1(Math.min(Math.max(0, f.extraArrivals), m.extraArrivalCap) * m.perExtraArrivalH) },
    { factor: 'Marine incident', hours: r1(Math.max(0, f.incidentSeverity) * m.incidentH) },
    { factor: 'Extended berth window', hours: r1(Math.max(0, f.berthWindowExtendH) * m.extendWindowH) },
  ];
  const p50 = contributions.reduce((s, c) => s + c.hours, 0);
  // Uncertainty grows with the active stressors: a calm, well-resourced call is
  // predictable (~±2 h); a stressed one is not. Sum of the non-structural terms.
  const stressorH = contributions
    .filter((c) => c.factor !== 'Base turn' && c.factor !== 'Cargo (parcel)' && c.factor !== 'Size class')
    .reduce((s, c) => s + c.hours, 0);
  const sigmaH = r1(2 + 0.3 * stressorH);
  return {
    hoursP50: r1(p50),
    hoursP10: r1(Math.max(0, p50 - 1.28 * sigmaH)),
    hoursP90: r1(p50 + 1.28 * sigmaH),
    sigmaH,
    contributions,
  };
}

/**
 * Build a feature vector from the current what-if levers plus a call's context
 * (parcel size + terminal max draft). Reuses `netChannelDepthDeltaM` so dredging
 * offsets siltation exactly as it does in the reactive twin. With neutral levers
 * the prediction reduces to the structural (base + cargo + size) terms only.
 */
export function tatFeaturesFromLevers(
  levers: SimLevers,
  ctx: { parcelTeu: number; terminalMaxDraftM: number },
): TatFeatures {
  return {
    parcelTeu: ctx.parcelTeu,
    terminalMaxDraftM: ctx.terminalMaxDraftM,
    weatherSeverity: levers.weatherSeverity,
    rainMmHr: levers.rainMmHr ?? 0,
    netDepthDeltaM: netChannelDepthDeltaM(levers),
    pilotsDown: levers.pilotsDown,
    tugsDown: levers.tugsDown,
    extraArrivals: levers.extraArrivals,
    incidentSeverity: Math.max(levers.oilSpill ?? 0, levers.accident ?? 0),
    berthWindowExtendH: levers.berthWindowExtendH ?? 0,
  };
}
