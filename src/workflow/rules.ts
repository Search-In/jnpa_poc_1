/**
 * Workflow composer model + evaluation (spec W-3).
 *
 * A JNPA stakeholder authors a rule in the UI: a TRIGGER metric crossing a
 * threshold, optional extra CONDITIONS, and one or more ACTIONS (notify a role,
 * raise an alert, propose a replan, hold pilotage). Rules are saved, versioned,
 * and individually enabled/disabled. This module is the pure core: the rule
 * shape, and `evaluateRules(rules, signals)` → the rules that fire and the
 * actions they emit. The UI and the run-ledger store wrap it.
 *
 * Deterministic and dependency-free (no clock/random) — evaluation is a pure
 * function of the rule set and the current twin signals.
 */

import type { Role } from '@/auth/roles';

/** Metrics a rule can trigger on — the twin signals we expose to authors. */
export type TriggerMetric =
  | 'ukcM' // minimum under-keel clearance, m
  | 'windKt' // wind speed, knots
  | 'seaStateM' // significant wave height, m
  | 'etaSlipH' // ETA slip vs plan, hours
  | 'pilotsAvailable' // count
  | 'tugsAvailable' // count
  | 'berthOccupancyPct'; // %

export const TRIGGER_METRICS: { id: TriggerMetric; label: string; unit: string }[] = [
  { id: 'ukcM', label: 'Min under-keel clearance', unit: 'm' },
  { id: 'windKt', label: 'Wind speed', unit: 'kn' },
  { id: 'seaStateM', label: 'Significant wave height', unit: 'm' },
  { id: 'etaSlipH', label: 'ETA slip vs plan', unit: 'h' },
  { id: 'pilotsAvailable', label: 'Pilots available', unit: '' },
  { id: 'tugsAvailable', label: 'Tugs available', unit: '' },
  { id: 'berthOccupancyPct', label: 'Berth occupancy', unit: '%' },
];

export type Comparator = 'lt' | 'lte' | 'gt' | 'gte' | 'eq';

export const COMPARATORS: { id: Comparator; label: string }[] = [
  { id: 'lt', label: '<' },
  { id: 'lte', label: '≤' },
  { id: 'gt', label: '>' },
  { id: 'gte', label: '≥' },
  { id: 'eq', label: '=' },
];

export interface Condition {
  metric: TriggerMetric;
  cmp: Comparator;
  value: number;
}

export type ActionKind = 'notifyRole' | 'raiseAlert' | 'proposeReplan' | 'holdPilotage';

export const ACTION_KINDS: { id: ActionKind; label: string }[] = [
  { id: 'notifyRole', label: 'Notify role' },
  { id: 'raiseAlert', label: 'Raise alert' },
  { id: 'proposeReplan', label: 'Propose replan' },
  { id: 'holdPilotage', label: 'Hold pilotage' },
];

export interface WorkflowAction {
  kind: ActionKind;
  /** For notifyRole. */
  role?: Role;
  /** Free-text note appended to the proposal. */
  note?: string;
}

/** A saved, versioned rule. */
export interface WorkflowRule {
  id: string;
  name: string;
  enabled: boolean;
  /** The primary trigger (a condition). */
  trigger: Condition;
  /** Extra AND conditions (all must hold). */
  conditions: Condition[];
  actions: WorkflowAction[];
  /** Bumped on every edit. */
  version: number;
  /** Monotonic edit stamp (sim/seq based, set by the store). */
  updatedSeq: number;
}

/** The twin signals evaluated against rules. */
export type Signals = Partial<Record<TriggerMetric, number>>;

function compare(a: number, cmp: Comparator, b: number): boolean {
  switch (cmp) {
    case 'lt':
      return a < b;
    case 'lte':
      return a <= b;
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'eq':
      return a === b;
  }
}

/** Does a single condition hold given the signals? Missing signal → false. */
export function conditionHolds(c: Condition, s: Signals): boolean {
  const v = s[c.metric];
  if (v === undefined || !Number.isFinite(v)) return false;
  return compare(v, c.cmp, c.value);
}

/** Does a rule fire? Trigger AND every extra condition must hold. */
export function ruleFires(rule: WorkflowRule, s: Signals): boolean {
  if (!rule.enabled) return false;
  if (!conditionHolds(rule.trigger, s)) return false;
  return rule.conditions.every((c) => conditionHolds(c, s));
}

export interface RuleFiring {
  rule: WorkflowRule;
  /** A human-readable proposal string synthesised from the actions. */
  proposal: string;
}

function metricLabel(m: TriggerMetric): string {
  return TRIGGER_METRICS.find((x) => x.id === m)?.label ?? m;
}
function cmpLabel(c: Comparator): string {
  return COMPARATORS.find((x) => x.id === c)?.label ?? c;
}

/** Render an action to a proposal fragment. */
export function actionText(a: WorkflowAction): string {
  switch (a.kind) {
    case 'notifyRole':
      return `Notify ${a.role ?? 'role'}${a.note ? ` — ${a.note}` : ''}`;
    case 'raiseAlert':
      return `Raise alert${a.note ? ` — ${a.note}` : ''}`;
    case 'proposeReplan':
      return `Propose berth replan${a.note ? ` — ${a.note}` : ''}`;
    case 'holdPilotage':
      return `Hold pilotage${a.note ? ` — ${a.note}` : ''}`;
  }
}

/** Describe a rule's trigger in words (for the ledger detail). */
export function triggerText(rule: WorkflowRule): string {
  const parts = [rule.trigger, ...rule.conditions].map(
    (c) => `${metricLabel(c.metric)} ${cmpLabel(c.cmp)} ${c.value}`
  );
  return parts.join(' AND ');
}

/**
 * Evaluate all rules against the signals; return each firing with a synthesised
 * proposal. Pure — the caller decides what to do (append to ledger, etc.).
 */
export function evaluateRules(rules: WorkflowRule[], s: Signals): RuleFiring[] {
  const out: RuleFiring[] = [];
  for (const rule of rules) {
    if (!ruleFires(rule, s)) continue;
    const proposal = rule.actions.map(actionText).join('; ') || 'No action defined';
    out.push({ rule, proposal });
  }
  return out;
}

/** A sensible starter rule for the composer (monsoon pilotage hold). */
export function starterRule(id: string, updatedSeq: number): WorkflowRule {
  return {
    id,
    name: 'Monsoon pilotage hold',
    enabled: true,
    trigger: { metric: 'windKt', cmp: 'gte', value: 30 },
    conditions: [],
    actions: [
      { kind: 'holdPilotage', note: 'wind over operating limit' },
      { kind: 'notifyRole', role: 'pilotDesk' },
    ],
    version: 1,
    updatedSeq,
  };
}
