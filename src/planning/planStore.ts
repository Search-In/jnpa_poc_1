/**
 * Imported / manually-edited berthing-plan overlay (spec IU-2). Holds plan
 * entries a JNPA planner adds via CSV upload or the manual form, kept in-memory
 * (mock-first) and merged over the adapter's plan for display. Persisted to
 * sessionStorage so a refresh keeps an in-progress import (crash recovery).
 *
 * Production writes these through the BerthingPlan connector; here they live
 * client-side and are clearly provenance-labelled as manual entry.
 */
import { create } from 'zustand';
import type { BerthingPlanEntry } from '@/types/domain';

const KEY = 'jnpa.importedPlan.v1';

function load(): BerthingPlanEntry[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as BerthingPlanEntry[];
  } catch {
    /* ignore */
  }
  return [];
}
function persist(entries: BerthingPlanEntry[]): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(entries));
  } catch {
    /* ignore */
  }
}

interface PlanStore {
  imported: BerthingPlanEntry[];
  /** Add or replace by PLAN_ID. */
  upsert: (entry: BerthingPlanEntry) => void;
  /** Bulk-add (from a CSV import), replacing any with matching PLAN_IDs. */
  addMany: (entries: BerthingPlanEntry[]) => void;
  remove: (planId: string) => void;
  clear: () => void;
}

export const usePlanStore = create<PlanStore>((set, get) => ({
  imported: load(),
  upsert: (entry) => {
    const next = [...get().imported.filter((e) => e.PLAN_ID !== entry.PLAN_ID), entry];
    persist(next);
    set({ imported: next });
  },
  addMany: (entries) => {
    const ids = new Set(entries.map((e) => e.PLAN_ID));
    const next = [...get().imported.filter((e) => !ids.has(e.PLAN_ID)), ...entries];
    persist(next);
    set({ imported: next });
  },
  remove: (planId) => {
    const next = get().imported.filter((e) => e.PLAN_ID !== planId);
    persist(next);
    set({ imported: next });
  },
  clear: () => {
    persist([]);
    set({ imported: [] });
  },
}));
