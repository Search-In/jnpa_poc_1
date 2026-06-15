/**
 * Design tokens — the ONLY place colour literals live (quality-bar rule).
 * Everything else references these. Values lean on Calcite LIGHT UI tokens so
 * the app uses the Esri light theme.
 */

export const tokens = {
  /** Calcite light surface ramp. */
  bg: '#f4f5f6',
  panel: '#ffffff',
  panelAlt: '#f8f8f8',
  border: '#d4d4d4',
  text: '#151515',
  textMuted: '#6a6a6a',

  /** Brand / accent. */
  accent: '#0079c1', // JNPA marine blue
  accentDim: '#00619b',

  /** Status semantics. */
  good: '#35ac46',
  warn: '#e8a33d',
  bad: '#d83020',
  live: '#35ac46',
  offline: '#9f9f9f',
} as const;

/** Vessel symbology by NAV_STATUS — used by the map renderer and the feed. */
export const navStatusColor: Record<string, string> = {
  underway: '#0079c1',
  approaching: '#e8a33d',
  anchored: '#7c5ce0',
  berthing: '#35ac46',
  moored: '#6a6a6a',
};
