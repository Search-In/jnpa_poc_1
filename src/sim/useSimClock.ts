/**
 * useSimClock — drives the shared sim clock. Advances useSimStore.clockH while
 * `running`, at a fixed cadence (~4×/second) so the whole board updates smoothly.
 * Deterministic: the advance is a pure function of rate (no wall-clock delta), so
 * a rehearsed run reproduces exactly regardless of frame timing. Respects the OS
 * reduce-motion setting by advancing on a timer, not rAF.
 */
import { useEffect } from 'react';
import { useSimStore } from './simStore';

export function useSimClock(): void {
  const running = useSimStore((s) => s.running);
  useEffect(() => {
    if (!running) return;
    const tick = useSimStore.getState().tick;
    const id = setInterval(() => tick(), 250);
    return () => clearInterval(id);
  }, [running]);
}
