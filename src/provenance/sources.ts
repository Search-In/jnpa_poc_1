/**
 * The marine integration sources UC-1 ingests, and the DATA_MODE / fallback-rung
 * vocabulary shared by the provenance chips, the Integration Simulator Console and
 * the workflow ledger.
 *
 * Integrity rule (spec §A3): every screen and every data source carries an
 * explicit provenance label — a viewer must never be able to mistake simulated
 * data for live JNPA data. The default demo mode is SIMULATED.
 */

/** Global data-provenance mode shown on the persistent banner (spec §A3). */
export type DataMode = 'SIM' | 'REPLAY' | 'LIVE';

/**
 * Per-source health / fallback rung. This is the "what visibly happens when AIS
 * dies mid-demo" ladder (spec §A2 crit 3): a source degrades from its normal
 * feed down through cached last-known-good, model-based imputation, and finally
 * offline / manual-entry — each rung labelled on the map and in the console.
 */
export type SourceState =
  | 'LIVE' // feed nominal (simulated-live in demo mode)
  | 'DEGRADED' // elevated latency / partial data — still flowing
  | 'CACHED' // last-known-good, stale-watermarked (feed dropped)
  | 'IMPUTED' // model-based estimate with widening confidence band
  | 'OFFLINE'; // no data — manual-entry fallback form is the only input

/** The seven production sources the twin integrates (spec B1.2). */
export type SourceId =
  | 'AIS'
  | 'VTS' // VTS / pilotage movement orders
  | 'WEATHER' // IMD / MOSDAC-class met feed
  | 'TIDE' // INCOIS tide / DUKC predictive inputs
  | 'BATHY' // channel depth / bathymetry survey
  | 'BERTH_PLAN' // berthing-plan feed (stakeholder schedule)
  | 'CRAFT'; // port-craft (pilot/tug/mooring) roster

export interface SourceMeta {
  id: SourceId;
  label: string;
  /** Intended production source system (shown on the SourceBadge). */
  prodSource: string;
  /** Nominal update cadence — used in the console + kill-shot answers. */
  cadence: string;
  /** One-line role in the twin. */
  role: string;
}

export const SOURCES: SourceMeta[] = [
  {
    id: 'AIS',
    label: 'AIS',
    prodSource: 'ArcGIS Velocity (Kpler AIS) / AISStream.io fallback',
    cadence: '2–10 s per vessel',
    role: 'Live vessel positions, course, speed, nav-status.',
  },
  {
    id: 'VTS',
    label: 'VTS / Pilotage',
    prodSource: 'VTS movement-order feed + pilotage roster',
    cadence: 'event-driven',
    role: 'Movement orders, pilot boarding, transit clearances.',
  },
  {
    id: 'WEATHER',
    label: 'Weather',
    prodSource: 'IMD / MOSDAC (met + wave)',
    cadence: '10 min',
    role: 'Wind, wave height, visibility — drives pilotage limits.',
  },
  {
    id: 'TIDE',
    label: 'Tide',
    prodSource: 'INCOIS tide predictions',
    cadence: '6 min (predicted), hourly (observed)',
    role: 'Tide height above chart datum — the DUKC water column.',
  },
  {
    id: 'BATHY',
    label: 'Channel depth',
    prodSource: 'Hydrographic survey / bathymetry layer',
    cadence: 'survey-cycle (weeks)',
    role: 'Charted channel depths per segment — the DUKC floor.',
  },
  {
    id: 'BERTH_PLAN',
    label: 'Berthing plan',
    prodSource: 'Port berthing-plan feed (PMS)',
    cadence: 'on change',
    role: 'Planned alongside windows per berth, ≥5 days ahead.',
  },
  {
    id: 'CRAFT',
    label: 'Port craft',
    prodSource: 'Marine craft roster (pilot/tug/mooring)',
    cadence: 'on change',
    role: 'Finite pilot/tug/mooring resources and their assignments.',
  },
];

export const SOURCE_BY_ID: Record<SourceId, SourceMeta> = Object.fromEntries(
  SOURCES.map((s) => [s.id, s]),
) as Record<SourceId, SourceMeta>;

/** Order of the fallback ladder (best → worst) for progress bars / rungs. */
export const RUNGS: SourceState[] = ['LIVE', 'DEGRADED', 'CACHED', 'IMPUTED', 'OFFLINE'];

/** Is this rung a genuine feed (vs a fallback surrogate)? */
export function isFlowing(s: SourceState): boolean {
  return s === 'LIVE' || s === 'DEGRADED';
}

/** Human one-liner for what a rung means on screen. */
export function rungLabel(s: SourceState): string {
  switch (s) {
    case 'LIVE':
      return 'Feed nominal';
    case 'DEGRADED':
      return 'Degraded — elevated latency / partial data';
    case 'CACHED':
      return 'Last-known-good (stale) — feed dropped';
    case 'IMPUTED':
      return 'Model-imputed — widening confidence band';
    case 'OFFLINE':
      return 'Offline — manual-entry fallback only';
  }
}
