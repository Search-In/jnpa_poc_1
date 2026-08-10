/**
 * Lifecycle vocabulary → status-chip tone. PRESENTATION ONLY.
 *
 * A pure lookup. It maps a value the backend already decided onto a colour tone; it never
 * ranks, combines or derives anything, so it cannot disagree with the projection.
 *
 * The vocabularies are lifted from services/marine/state_engine.py (derive_state), the
 * four parser stages in parsers/pcs_common.py, the pilot workflow in pilot_status.py and
 * the berthing ladder in services/berthing/lifecycle.py.
 *
 * UNKNOWN VALUES FALL THROUGH TO 'muted' and keep their text verbatim — a state the UI has
 * no colour for must still be readable, never blank and never mis-coloured.
 *
 * Colour is never the only signal: <StatusChip> always renders the label and mirrors it
 * into `title`, and the dot is aria-hidden.
 */

import type { ChipTone } from '@/components/shipping/dataTable';

/** call status + berthing ladder + pilot workflow + craft state, in one table. */
const TONE: Record<string, ChipTone> = {
  // ---- call status (state_engine) ----
  Departed: 'muted',            // finished — dark/neutral, not a warning
  Sailing: 'warn',              // under way, still in the port's care
  'At Berth': 'good',
  'Pilot Boarded': 'warn',
  Anchored: 'warn',
  // ---- parser stages (pcs_common) — planned, nothing has happened yet ----
  'Berth Allotted': 'info',
  'Berth Planned': 'info',
  'VCN Allotted': 'muted',
  Planned: 'muted',
  // ---- per-module states ----
  Completed: 'good',
  Occupied: 'good',
  Allotted: 'info',
  Released: 'muted',
  Active: 'warn',
  // Amber, not grey: pending is an operational state AWAITING THE NEXT ACTION, not an
  // idle one. Amber signals 'needs attention' without implying an error — which is
  // reserved for 'bad'. Departure Pending / cargo not started stay normal, uncoloured
  // by any anomaly mark; the tone is attention, not fault.
  Pending: 'warn',
  'In Port': 'info',
  Expected: 'muted',
  Sailed: 'muted',
  Busy: 'warn',
  Idle: 'muted',
  // ---- pilot workflow (pilot_status) ----
  'Pilot Requested': 'info',
  'Pilot Completed': 'good',
  'Departure Pilot Completed': 'good',
  // ---- berthing ladder (services/berthing/lifecycle) ----
  EXPECTED: 'muted',
  ARRIVED: 'info',
  BERTH_ASSIGNED: 'info',
  BERTHING_STARTED: 'good',
  CARGO_OPERATION: 'good',
  COMPLETED: 'good',
  DEPARTED: 'muted',
};

/**
 * Tone for a lifecycle value. 'muted' for anything unrecognised — the label still shows,
 * so a new engine state degrades to a readable grey chip rather than vanishing.
 */
export function lifecycleTone(value: string | null | undefined): ChipTone {
  if (!value) return 'muted';
  return TONE[value.trim()] ?? 'muted';
}
