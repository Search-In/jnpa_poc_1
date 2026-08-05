/**
 * Presentation rules for the eight UC-1 model blocks. Pure — no React, no I/O —
 * so the ordering, the tone mapping and the value formatting are unit-tested
 * without rendering anything.
 *
 * The service's document is deliberately open (a model may publish a new field
 * tomorrow) and ships its own glossary, so the panel renders WHATEVER it is
 * handed. This module adds only the three things a generic renderer cannot
 * derive from the data:
 *
 *   1. **Order and title.** M1 before M8, and a human name per block.
 *   2. **The headline.** Which one of five to nine fields is the number an
 *      operator looks at first.
 *   3. **Tone.** Which verdicts are good, marginal or bad. This is domain
 *      knowledge — 'MARGINAL' is amber and 'NO GO' is red because of what they
 *      mean in a channel, not because of anything in the string.
 *
 * A block the service sends that is NOT listed here still renders, after the
 * known ones, under its raw id. Dropping an unknown model would hide exactly
 * the thing worth looking at.
 */

import type { ModelBlock, ModelFieldValue } from '@/data/ml/types';

export interface ModelView {
  /** Block id in the response, e.g. 'm1_under_keel_clearance'. */
  id: string;
  /** Short human title for the card header. */
  title: string;
  /** The field an operator reads first. */
  headline?: string;
  /** Unit suffix for the headline. */
  unit?: string;
  /** Field whose value is rendered as the card's status chip. */
  statusKey?: string;
  /** Fields rendered specially by the component, so the grid skips them. */
  richKeys?: string[];
}

/** Display order and headline per model. Ids match `dashboard_json.MODEL_VIEWS`. */
export const MODEL_VIEWS: ModelView[] = [
  {
    id: 'm1_under_keel_clearance',
    title: 'M1 · Under-keel clearance',
    headline: 'net_ukc_m',
    unit: 'm',
    statusKey: 'status',
    richKeys: ['recommendation'],
  },
  {
    id: 'm2_tidal_window',
    title: 'M2 · Tidal window',
    headline: 'usable_hours',
    unit: 'h',
  },
  {
    id: 'm3_turnaround_time',
    title: 'M3 · Turnaround time',
    headline: 'tat_hours',
    unit: 'h',
    statusKey: 'confidence',
    richKeys: ['top_drivers'],
  },
  {
    id: 'm4_eta_confidence',
    title: 'M4 · ETA confidence',
    headline: 'eta_band_hours',
    unit: 'h',
    statusKey: 'confidence',
  },
  {
    id: 'm5_berth_plan',
    title: 'M5 · Berth plan',
    headline: 'assigned_berth',
    richKeys: ['reason'],
  },
  {
    id: 'm6_jit_arrival',
    title: 'M6 · Just-in-time arrival',
    headline: 'recommended_speed_kn',
    unit: 'kn',
    richKeys: ['recommendation'],
  },
  {
    id: 'm7_port_craft',
    title: 'M7 · Port craft',
    headline: 'movement',
    richKeys: ['pilots_tugs_mooring', 'shortfall'],
  },
  {
    id: 'm8_risk_chain',
    title: 'M8 · Risk chain',
    headline: 'system_confidence',
    statusKey: 'alert_level',
    richKeys: ['root_causes'],
  },
];

/**
 * Order the blocks the service actually returned: the known eight first, in
 * spec order, then anything unrecognised under a generated title. Pure.
 */
export function orderedBlocks(
  models: Record<string, ModelBlock>,
): Array<{ view: ModelView; block: ModelBlock }> {
  const known = MODEL_VIEWS.filter((v) => models[v.id]).map((view) => ({
    view,
    block: models[view.id],
  }));
  const extra = Object.keys(models)
    .filter((id) => !MODEL_VIEWS.some((v) => v.id === id))
    .map((id) => ({ view: { id, title: humaniseKey(id) }, block: models[id] }));
  return [...known, ...extra];
}

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';

/**
 * Tone for a status/verdict value. Domain knowledge, deliberately explicit:
 * 'MARGINAL' means the clearance is inside the safety band but not comfortable,
 * so it is amber, and 'NO GO' is red. Unknown text is neutral rather than
 * optimistically green. Pure.
 */
export function statusTone(value: ModelFieldValue): Tone {
  if (typeof value === 'boolean') return value ? 'good' : 'bad';
  if (value === null || value === undefined) return 'neutral';
  const text = String(value).trim().toUpperCase();
  if (['SAFE', 'GO', 'HIGH', 'NORMAL', 'FEASIBLE', 'OK'].includes(text)) return 'good';
  if (['MARGINAL', 'MEDIUM', 'ADVISORY', 'TIGHT', 'DEGRADED'].includes(text)) return 'warn';
  if (['NO GO', 'NO-GO', 'NOGO', 'LOW', 'CRITICAL', 'INFEASIBLE', 'BLOCKED'].includes(text)) {
    return 'bad';
  }
  return 'neutral';
}

/** 'net_ukc_m' → 'Net ukc m' … readable without inventing a second glossary. Pure. */
export function humaniseKey(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Render one leaf value for display. Pure.
 *
 * Numbers keep at most two decimals — the models return figures already rounded
 * for display, and re-rounding here would be the second place that decision
 * lives. `null` renders as an em dash, never as 0: "no value" and "zero" are
 * different answers, and a 0.00 m clearance is not the same as an unknown one.
 */
export function formatValue(value: ModelFieldValue): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  // An empty string is "not stated" — M5 sends `requested_berth: ''` for a
  // vessel with no berth request. Rendered raw it left a blank cell that reads
  // as a missing UI, not as a missing value.
  if (typeof value === 'string' && value.trim() === '') return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
  }
  if (Array.isArray(value)) {
    return value.length ? value.map((v) => formatValue(v)).join(', ') : '—';
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([k, v]) => `${humaniseKey(k)}: ${formatValue(v)}`)
      .join(' · ');
  }
  return String(value);
}

/**
 * The scalar fields of a block, in the order the service sent them, minus the
 * ones the component renders itself. Pure.
 */
export function gridFields(
  block: ModelBlock,
  view: ModelView,
): Array<[string, ModelFieldValue]> {
  const skip = new Set([...(view.richKeys ?? []), view.headline, view.statusKey].filter(Boolean) as string[]);
  return Object.entries(block).filter(([key]) => !skip.has(key));
}
