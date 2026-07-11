import { describe, it, expect } from 'vitest';
import {
  conditionHolds,
  ruleFires,
  evaluateRules,
  actionText,
  triggerText,
  starterRule,
  type WorkflowRule,
} from './rules';

function rule(over: Partial<WorkflowRule> = {}): WorkflowRule {
  return {
    id: 'R1',
    name: 'Test',
    enabled: true,
    trigger: { metric: 'windKt', cmp: 'gte', value: 30 },
    conditions: [],
    actions: [{ kind: 'holdPilotage' }],
    version: 1,
    updatedSeq: 1,
    ...over,
  };
}

describe('conditionHolds', () => {
  it('evaluates comparators', () => {
    expect(conditionHolds({ metric: 'windKt', cmp: 'gte', value: 30 }, { windKt: 35 })).toBe(true);
    expect(conditionHolds({ metric: 'windKt', cmp: 'gte', value: 30 }, { windKt: 25 })).toBe(false);
    expect(conditionHolds({ metric: 'ukcM', cmp: 'lt', value: 1 }, { ukcM: 0.5 })).toBe(true);
    expect(conditionHolds({ metric: 'ukcM', cmp: 'lt', value: 1 }, { ukcM: 1.5 })).toBe(false);
  });
  it('is false when the signal is missing or non-finite', () => {
    expect(conditionHolds({ metric: 'windKt', cmp: 'gte', value: 30 }, {})).toBe(false);
    expect(conditionHolds({ metric: 'windKt', cmp: 'gte', value: 30 }, { windKt: NaN })).toBe(false);
  });
});

describe('ruleFires', () => {
  it('fires when trigger and all conditions hold', () => {
    const r = rule({
      trigger: { metric: 'windKt', cmp: 'gte', value: 30 },
      conditions: [{ metric: 'seaStateM', cmp: 'gte', value: 2.5 }],
    });
    expect(ruleFires(r, { windKt: 35, seaStateM: 3 })).toBe(true);
    expect(ruleFires(r, { windKt: 35, seaStateM: 1 })).toBe(false); // condition fails
  });
  it('never fires when disabled', () => {
    expect(ruleFires(rule({ enabled: false }), { windKt: 100 })).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('returns firings with synthesised proposals', () => {
    const rules = [
      rule({ id: 'A', trigger: { metric: 'windKt', cmp: 'gte', value: 30 }, actions: [{ kind: 'holdPilotage' }] }),
      rule({ id: 'B', trigger: { metric: 'ukcM', cmp: 'lt', value: 1 }, actions: [{ kind: 'proposeReplan' }] }),
    ];
    const firings = evaluateRules(rules, { windKt: 40, ukcM: 2 });
    expect(firings).toHaveLength(1);
    expect(firings[0].rule.id).toBe('A');
    expect(firings[0].proposal).toMatch(/Hold pilotage/);
  });
});

describe('text helpers', () => {
  it('renders action text including a notified role', () => {
    expect(actionText({ kind: 'notifyRole', role: 'pilotDesk' })).toMatch(/Notify pilotDesk/);
    expect(actionText({ kind: 'raiseAlert', note: 'x' })).toMatch(/Raise alert — x/);
  });
  it('renders trigger text with conditions', () => {
    const r = rule({
      trigger: { metric: 'windKt', cmp: 'gte', value: 30 },
      conditions: [{ metric: 'seaStateM', cmp: 'gte', value: 2.5 }],
    });
    expect(triggerText(r)).toMatch(/Wind speed ≥ 30 AND Significant wave height ≥ 2.5/);
  });
});

describe('starterRule', () => {
  it('is a valid, enabled monsoon-hold rule', () => {
    const r = starterRule('R1', 1);
    expect(r.enabled).toBe(true);
    expect(ruleFires(r, { windKt: 32 })).toBe(true);
    expect(ruleFires(r, { windKt: 10 })).toBe(false);
  });
});
