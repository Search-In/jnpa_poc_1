/**
 * Design tokens — the ONLY place colour literals live (quality-bar rule).
 * Everything else references these. Values lean on Calcite LIGHT UI tokens so
 * the app uses the Esri light theme.
 */

export const tokens = {
  /** Calcite light surface ramp. */
  bg: '#f4f5f6',
  panel: '#ffffff',
  panelAlt: '#f3f4f6',
  bgElevated: '#eef1f5',
  border: '#d4d4d4',
  text: '#151515',
  textMuted: '#5a5a5a',

  /** Brand / accent. */
  accent: '#0079c1', // JNPA marine blue
  accentDim: '#00619b',

  /** Status semantics. */
  good: '#2f9e41',
  warn: '#e8a33d',
  bad: '#d83020',
  live: '#2f9e41',
  offline: '#9f9f9f',

  /** DATA_MODE provenance chip colours (spec §A3 / B1). */
  mode: {
    LIVE: '#2f9e41',
    REPLAY: '#0079c1',
    SIM: '#6b5ce0',
    DEGRADED: '#e8a33d',
    OFFLINE: '#d83020',
  },

  /** Integration-source degradation traffic lights. */
  degradation: {
    GREEN: '#2f9e41',
    AMBER: '#e8a33d',
    RED: '#d83020',
  },

  /** Notification / workflow severity. */
  severity: {
    INFO: '#0079c1',
    WARN: '#e8a33d',
    CRIT: '#d83020',
  },

  /** KPI direction (vs target / vs simulated do-nothing — never vs baseline). */
  kpi: {
    better: '#2f9e41',
    worse: '#d83020',
    neutral: '#8a8a8a',
  },

  /** Overlay scrim + elevation shadow (slide-overs, modals). */
  scrim: 'rgba(0, 0, 0, 0.4)',
  shadow: 'rgba(0, 0, 0, 0.25)',

  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  radius: { sm: 4, md: 8 },
} as const;

/** Vessel symbology by NAV_STATUS — used by the map renderer, 3D scene and feed. */
export const navStatusColor: Record<string, string> = {
  underway: '#0079c1',
  approaching: '#e8a33d',
  anchored: '#6b5ce0',
  berthing: '#2f9e41',
  moored: '#6a6a6a',
};

/** DUKC go/no-go window colours for the channel corridor + UKC profile chart. */
export const ukcColor = {
  go: '#2f9e41',
  marginal: '#e8a33d',
  noGo: '#d83020',
} as const;
