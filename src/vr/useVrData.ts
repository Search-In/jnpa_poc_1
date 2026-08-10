/**
 * Read-only data feed for the walkthrough view.
 *
 * Everything comes through `getAdapter()`, which is a `SimAdapter` wrapping the
 * base adapter — so berths, vessels and weather already carry the active
 * what-if levers with no per-view wiring. The view is a pure consumer: it never
 * calls a mutating sim action and never bumps `simStore.version` (that would
 * cascade a refetch through every dashboard panel).
 */
import { useEffect, useMemo, useState } from 'react';
import type { Berth, Vessel } from '@/types/domain';
import { useSimStore } from '@/sim/simStore';
import { useSimVersion } from '@/sim/useSimReactivity';
import { computeImpacts, type VrImpactModel } from './impactModel';

export interface VrData {
  berths: Berth[];
  vessels: Vessel[];
  model: VrImpactModel;
  loading: boolean;
}

export function useVrData(): VrData {
  const [berths, setBerths] = useState<Berth[]>([]);
  const [vessels, setVessels] = useState<Vessel[]>([]);
  const [loading, setLoading] = useState(true);

  const version = useSimVersion();
  const levers = useSimStore((s) => s.levers);
  const clockH = useSimStore((s) => s.clockH);
  const scenarioId = useSimStore((s) => s.scenarioId);

  // Berths are a one-shot read; re-run whenever a lever changes.
  useEffect(() => {
    let cancelled = false;
    void import('@/data').then(({ getAdapter }) =>
      getAdapter()
        .getBerths()
        .then((b) => {
          if (!cancelled) {
            setBerths(b);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        })
    );
    return () => {
      cancelled = true;
    };
  }, [version]);

  // Vessels are a push stream.
  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import('@/data').then(({ getAdapter }) => {
      if (cancelled) return;
      stop = getAdapter().subscribeVessels((batch) => setVessels(batch));
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [version]);

  // The impact model is pure — memoising on the levers/clock keeps the label
  // set stable between frames so the scene doesn't rebuild graphics per tick.
  const model = useMemo(
    () => computeImpacts({ levers, clockH, berths, scenarioId }),
    [levers, clockH, berths, scenarioId]
  );

  return { berths, vessels, model, loading };
}
