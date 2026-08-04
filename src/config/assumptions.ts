/**
 * Assumptions register (spec §A5 / B1.5) — every calibration figure the demo
 * leans on, each with a value, unit, and a sourced justification. Rendered by the
 * Methodology & Assumptions panel. These are the FY24-25-class public performance
 * figures that make the simulated traffic instantly credible to a domain
 * evaluator; the simulator is tuned so its statistics land near them.
 *
 * Integrity: these are *calibration targets / public reference figures*, NOT
 * claimed JNPA baselines and NOT improvement claims. Framing everywhere is
 * "simulated result under stated assumptions" (spec §A3).
 */

import {
  BUNKER_USD_PER_T,
  CO2_T_PER_FUEL_T,
  DEMO_JIT_INPUTS,
  FUEL_T_PER_H_AT_SERVICE,
  SERVICE_SPEED_KN,
} from '@/planning/jit';

export interface Assumption {
  id: string;
  label: string;
  value: string;
  /** Where the figure comes from / how it's justified. */
  source: string;
  /** How the twin uses it. */
  use: string;
}

export const ASSUMPTIONS: Assumption[] = [
  { id: 'calls', label: 'Vessel calls / day', value: '~10–12', source: 'JNPA FY24-25 public performance figures (order-of-magnitude).', use: 'Arrival generator rate for the simulated fleet.' },
  { id: 'berthStay', label: 'Average berth stay', value: '≈ 0.97 days', source: 'JNPA FY24-25 public performance figures.', use: 'Berthing-plan window durations.' },
  { id: 'preBerthWait', label: 'Average pre-berthing waiting', value: '≈ 0.23 days', source: 'JNPA FY24-25 public performance figures.', use: 'Pre-berthing delay target line on the KPI card.' },
  { id: 'pilotTat', label: 'Pilot-boarding→deboarding TAT', value: '≈ 1.10 days', source: 'JNPA FY24-25 public performance figures.', use: 'Component of overall TAT calibration.' },
  { id: 'vesselTat', label: 'Overall vessel TAT', value: '≈ 1.83 days', source: 'JNPA FY24-25 public performance figures.', use: 'Average TAT KPI target line.' },
  { id: 'parcel', label: 'Average container-vessel parcel', value: '≈ 2,355 TEU', source: 'JNPA FY24-25 public performance figures.', use: 'Vessel size-class distribution.' },
  { id: 'ukcMargin', label: 'UKC safety margin', value: '1.0 m', source: 'Conservative port-policy allowance (typical harbour UKC policy).', use: 'DUKC go/no-go threshold in the corridor + tidal-window engine.' },
  { id: 'squat', label: 'Squat model', value: 'Barrass-style, Cb·V²/100', source: 'Simplified open-water squat approximation; not a proprietary DUKC product.', use: 'Dynamic-draft term in the UKC computation.' },
  { id: 'tide', label: 'Tide model', value: 'Mixed semidiurnal, mean 2.6 m ± 1.7 m', source: 'Plausible spring/neap envelope for the JNPA approach; production would use INCOIS predictions.', use: 'Tide curve driving DUKC windows over the sim clock.' },
  { id: 'channelDepth', label: 'Controlling channel depth', value: '15.0 m (maintained inner)', source: 'Representative maintained depth; production reads the bathymetry survey layer.', use: 'DUKC floor for the pinch segments.' },

  // ── JIT / RTA advisory ────────────────────────────────────────────────────
  // Values are INTERPOLATED FROM THE CODE, not retyped. jit.ts previously
  // claimed these were "documented in the assumptions register" while they were
  // not; building the rows from the exported constants means the claim cannot
  // become false again — and assumptions.test.ts fails if a value drifts.
  {
    id: 'jitFuelRate',
    label: 'Main-engine fuel burn at service speed',
    value: `${FUEL_T_PER_H_AT_SERVICE} t/h (HFO-equivalent)`,
    source: 'Nominal figure for a ~2,400 TEU container vessel. Not a measured JNPA value.',
    use: 'Bunker-saving term in the simulated JIT advisory.',
  },
  {
    id: 'jitServiceSpeed',
    label: 'Service speed',
    value: `${SERVICE_SPEED_KN} kn`,
    source: 'Nominal container-vessel service speed.',
    use: 'Reference speed for the fuel-vs-speed law below.',
  },
  {
    id: 'jitSpeedLaw',
    label: 'Fuel-vs-speed relationship',
    value: 'Cube law — burn ∝ (v / v_service)³',
    source: 'Standard naval-architecture approximation for main-engine propulsion power.',
    use: 'Converts the slower recommended speed into a bunker saving.',
  },
  {
    id: 'jitCo2Factor',
    label: 'Bunker → CO₂ factor',
    value: `${CO2_T_PER_FUEL_T} t CO₂ per t fuel`,
    source: 'IMO standard carbon factor for HFO.',
    use: 'CO₂ figure on the JIT advisory.',
  },
  {
    id: 'jitBunkerPrice',
    label: 'Bunker price',
    value: `$${BUNKER_USD_PER_T} / t`,
    source: 'Indicative VLSFO price. Not a contracted rate.',
    use: 'Converts the simulated bunker saving into USD.',
  },
  {
    id: 'jitDemoInputs',
    label: 'JIT advisory inputs (demo-fixed)',
    value: `berth free ETA+${DEMO_JIT_INPUTS.berthReadyOffsetH} h · go-window ETA+${DEMO_JIT_INPUTS.goWindowOffsetH} h · ${DEMO_JIT_INPUTS.distanceNm} nm to run · ${DEMO_JIT_INPUTS.currentSpeedKn} kn`,
    source: 'Fixed constants chosen to demonstrate the mechanism; the plan data carries none of these quantities.',
    use: 'In production: the berth plan (berth-free), the DUKC engine (go-window), and the vessel’s AIS track (distance, speed).',
  },

  // ── What-if scenario engine ───────────────────────────────────────────────
  {
    id: 'whatIfModel',
    label: 'What-if impact model',
    value: 'Linear: 1 h delay → −5 pp JIT, +1 h average TAT, both × (1 + weather severity)',
    source: 'Transparent linear stub, deliberately not a queueing or berth-recompute simulation.',
    use: 'Scenario deltas on the KPI wall. Runs in live mode too, not only mock.',
  },
];

/** Open-source components used, with licences (spec §A3 open-source honesty). */
export interface OssComponent {
  name: string;
  license: string;
  role: string;
}

export const OSS: OssComponent[] = [
  { name: 'ArcGIS Maps SDK for JavaScript (@arcgis/core)', license: 'Esri proprietary SDK (dev free tier)', role: '2D map + 3D SceneView, feature layers.' },
  { name: 'Calcite Components (@esri/calcite-components)', license: 'Apache-2.0', role: 'Design system / dark shell.' },
  { name: 'React', license: 'MIT', role: 'UI framework.' },
  { name: 'Chart.js + react-chartjs-2', license: 'MIT', role: 'KPI + convergence + UKC-profile charts.' },
  { name: 'Zustand', license: 'MIT', role: 'Lightweight state (store / sim / provenance).' },
  { name: 'Vite + Vitest', license: 'MIT', role: 'Build + unit tests.' },
];
