/**
 * Saved workflow-rule store (spec W-3): create / edit / enable-disable / delete
 * author-defined rules, with per-rule versioning. Persisted to sessionStorage so
 * a refresh keeps the composed rules (crash recovery). Mock-first; production
 * persists these server-side.
 */
import { create } from 'zustand';
import { type WorkflowRule, starterRule } from './rules';

const KEY = 'jnpa.workflowRules.v1';

function load(): WorkflowRule[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as WorkflowRule[];
  } catch {
    /* ignore */
  }
  // Seed with one starter rule so the ledger has something to fire on first run.
  return [starterRule('RULE-1', 1)];
}
function persist(rules: WorkflowRule[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(rules));
  } catch {
    /* ignore */
  }
}

interface RuleStore {
  rules: WorkflowRule[];
  seq: number;
  /** Create a new rule (returns its id). */
  create: (rule: Omit<WorkflowRule, 'id' | 'version' | 'updatedSeq'>) => string;
  /** Replace a rule by id, bumping its version. */
  update: (id: string, patch: Partial<Omit<WorkflowRule, 'id' | 'version'>>) => void;
  toggle: (id: string) => void;
  remove: (id: string) => void;
}

export const useRuleStore = create<RuleStore>((set, get) => ({
  rules: load(),
  seq: 1,
  create: (rule) => {
    const seq = get().seq + 1;
    const id = `RULE-${seq}`;
    const full: WorkflowRule = { ...rule, id, version: 1, updatedSeq: seq };
    const next = [...get().rules, full];
    persist(next);
    set({ rules: next, seq });
    return id;
  },
  update: (id, patch) => {
    const seq = get().seq + 1;
    const next = get().rules.map((r) =>
      r.id === id ? { ...r, ...patch, version: r.version + 1, updatedSeq: seq } : r
    );
    persist(next);
    set({ rules: next, seq });
  },
  toggle: (id) => {
    const next = get().rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
    persist(next);
    set({ rules: next });
  },
  remove: (id) => {
    const next = get().rules.filter((r) => r.id !== id);
    persist(next);
    set({ rules: next });
  },
}));
