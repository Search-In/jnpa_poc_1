/**
 * Survey status vocabulary for the Bathymetry ▸ Surveys register.
 *
 * Split out of BathymetrySurveyTable.tsx so the component file exports only its
 * component (fast-refresh rule) and this stays independently unit-testable.
 *
 * Deliberately THREE outcomes, not a spectrum — an operator scanning the column needs a
 * decision, not a gradient:
 *
 *   awaiting — registered chart, no soundings imported: we have NO depth evidence here.
 *   shoal    — soundings present AND at least one sits above design depth (shallower than
 *              the design profile). The hazard state.
 *   clear    — soundings present, none above design depth.
 */

import { tokens } from '@/theme/tokens';

export type SurveyStatus = 'awaiting' | 'shoal' | 'clear';

/**
 * Classify one survey. Pure.
 *
 * `aboveDesign` is null when the survey HAS soundings but its per-survey stats call
 * failed. That resolves to `clear`, not `shoal`: an unknown must never be rendered as a
 * hazard an operator might act on. The table shows "—" in the Above Design cell so the
 * gap stays visible.
 */
export function surveyStatus(soundingCount: number, aboveDesign: number | null): SurveyStatus {
  if (soundingCount <= 0) return 'awaiting';
  return (aboveDesign ?? 0) > 0 ? 'shoal' : 'clear';
}

export const STATUS_LABEL: Record<SurveyStatus, string> = {
  awaiting: 'Awaiting chart',
  shoal: 'Shoal',
  clear: 'Clear',
};

export const STATUS_COLOR: Record<SurveyStatus, string> = {
  awaiting: tokens.textMuted,
  shoal: tokens.bad,
  clear: tokens.good,
};

export const STATUS_HINT: Record<SurveyStatus, string> = {
  awaiting: 'Registered, but no chart imported yet — no depth evidence for this area',
  shoal: 'At least one sounding is shallower than the design depth',
  clear: 'No soundings above design depth',
};

/** Display order — hazards first, because that is why this screen gets opened. */
export const STATUS_ORDER: SurveyStatus[] = ['shoal', 'clear', 'awaiting'];
