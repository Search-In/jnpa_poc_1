/**
 * useAdapterQuery — run an async DataAdapter query with loading/error state and
 * a refresh interval. Keeps the UI's only data path through the adapter.
 */

import { useEffect, useRef, useState } from 'react';

export interface QueryState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * @param fn        async query (must be stable or listed in deps)
 * @param deps      re-run when these change
 * @param intervalMs optional auto-refresh (0 = once)
 */
export function useAdapterQuery<T>(
  fn: () => Promise<T>,
  deps: unknown[],
  intervalMs = 0
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ data: null, loading: true, error: null });
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const data = await fnRef.current();
        if (alive) setState({ data, loading: false, error: null });
      } catch (err) {
        if (alive) {
          setState((s) => ({
            ...s,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      }
    };
    setState((s) => ({ ...s, loading: true }));
    void run();
    if (intervalMs > 0) {
      const t = setInterval(run, intervalMs);
      return () => {
        alive = false;
        clearInterval(t);
      };
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, intervalMs]);

  return state;
}
