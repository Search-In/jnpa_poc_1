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
