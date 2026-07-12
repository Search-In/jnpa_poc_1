/**
 * useHighlight — the single seam that lets DASHBOARD panels spotlight the same
 * assets the reactive guide / guided tour ring on the map. Every panel reads the
 * shared `highlights` id set from the sim store and asks "is THIS anchor lit?".
 *
 * The highlight vocabulary is deliberately coarse (terminal ids like `GTI`,
 * anchorage ids, channel-segment ids, the pilot ground `PBG`) because it is
 * authored once per scenario/causal-node and consumed by both the map and the
 * dashboard. Panels key their rows/cards on finer ids (BERTH_ID, KpiKey, craft
 * type, plan id), so this module owns the id-granularity bridge:
 *
 *  - a highlighted TERMINAL id (`GTI`) lights every berth row of that terminal
 *    (`GTI-1`, …) — resolved against the caller's berth list.
 *  - a highlighted BERTH_ID lights that row directly.
 *  - channel-segment / KPI-key / craft-type / plan-id anchors match by equality.
 *
 * Non-destructive and cheap: it's a set membership test over a handful of ids,
 * recomputed only when the highlight set changes.
 */
import { useMemo } from 'react';
import { useSimStore } from '@/sim/simStore';
import { SCENARIO_BY_ID } from '@/sim/scenarios';
import type { Berth } from '@/types/domain';
import type { KpiKey } from '@/types/kpi';

/** Causal-graph KPI node id → headline KpiBundle key. */
const KPI_NODE_TO_KEY: Record<string, KpiKey> = {
  preBerthDelay: 'preBerthingDelay',
  jit: 'jitPct',
  tat: 'avgTat',
};

/**
 * The KPI keys the active scenario's causal chain names — used to spotlight the
 * matching KPI cards. Empty when no scenario is running, so the strip is neutral
 * on a free run. Driven by the chain (not the map highlights) because KPI cards
 * are effects of the chain, not map assets.
 */
export function useHighlightedKpis(): ReadonlySet<KpiKey> {
  const scenarioId = useSimStore((s) => s.scenarioId);
  return useMemo(() => {
    const chain = scenarioId ? SCENARIO_BY_ID[scenarioId]?.chain ?? [] : [];
    const out = new Set<KpiKey>();
    for (const node of chain) {
      const key = KPI_NODE_TO_KEY[node];
      if (key) out.add(key);
    }
    return out;
  }, [scenarioId]);
}

/** The live highlight id set (stable reference between changes via the store). */
export function useHighlightIds(): string[] {
  return useSimStore((s) => s.highlights);
}

/**
 * A matcher closed over the current highlight set. `has(id)` is a direct-equality
 * test; `berth(berthId, terminal)` also lights a berth when its TERMINAL is lit.
 * `any` is true when anything at all is highlighted (for panel-level chrome).
 */
export interface HighlightMatcher {
  any: boolean;
  ids: ReadonlySet<string>;
  has: (id: string | null | undefined) => boolean;
  /** Lit when the berth id itself OR its terminal id is highlighted. */
  berth: (berthId: string | null | undefined, terminal?: string | null) => boolean;
}

export function useHighlightMatch(): HighlightMatcher {
  const highlights = useHighlightIds();
  return useMemo(() => {
    const ids = new Set(highlights);
    const has = (id: string | null | undefined) => id != null && ids.has(id);
    return {
      any: ids.size > 0,
      ids,
      has,
      berth: (berthId, terminal) => has(berthId) || has(terminal),
    };
  }, [highlights]);
}

/** Expand the highlight set to concrete BERTH_IDs, resolving terminal ids too. */
export function highlightedBerthIds(highlights: string[], berths: Berth[]): Set<string> {
  const lit = new Set(highlights);
  const out = new Set<string>();
  for (const b of berths) {
    if (lit.has(b.BERTH_ID) || lit.has(b.TERMINAL)) out.add(b.BERTH_ID);
  }
  return out;
}
