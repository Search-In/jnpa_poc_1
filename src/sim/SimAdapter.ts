/**
 * SimAdapter — a transparent wrapper around the real `DataAdapter` that overlays
 * the current simulator state (`useSimStore`) on every read. This is the single
 * seam that lets the existing map + dashboard react to the Simulator page's
 * controls with no per-panel changes (the PoC_2 pattern).
 *
 * It never mutates the base adapter's data — every overlay in `applySim` returns
 * fresh objects — so `resetAll()` returns the whole board to baseline and mock
 * determinism is preserved.
 *
 * Vessel stream: the wrapped listener overlays each base batch; additionally the
 * adapter subscribes to `useSimStore` and re-emits the last base batch (re-
 * overlaid) whenever sim state changes, so spawning/forcing vessels updates the
 * map immediately without waiting for the next 3 s AIS tick.
 */
import type {
  ArrivalsDeparturesBlock,
  Berth,
  BerthingPlanEntry,
  KpiSnapshot,
  PortCraftUnit,
  PredictionPoint,
  Vessel,
  WeatherReading,
} from '@/types/domain';
import type { KpiBundle } from '@/types/kpi';
import type {
  ConnectionListener,
  DataAdapter,
  TimeWindow,
  Unsubscribe,
  VesselListener,
  WhatIfResult,
  WhatIfScenario,
} from '@/data/types';
import { useSimStore } from './simStore';
import type { SimSnapshot } from './applySim';
import { applyBerths, applyKpis, applyPortCraft, applyVessels, applyWeather } from './applySim';

function snap(): SimSnapshot {
  const s = useSimStore.getState();
  return { clockH: s.clockH, levers: s.levers, overrides: s.overrides };
}

export class SimAdapter implements DataAdapter {
  readonly mode: 'mock' | 'live';

  constructor(private readonly base: DataAdapter) {
    this.mode = base.mode;
  }

  subscribeVessels(onBatch: VesselListener, onState?: ConnectionListener): Unsubscribe {
    let lastBase: Vessel[] = [];
    const emit = () => onBatch(applyVessels(lastBase, snap()));

    const unsubBase = this.base.subscribeVessels((vessels) => {
      lastBase = vessels;
      emit();
    }, onState);

    // Re-emit (re-overlaid) whenever sim overrides / clock change so the map
    // reflects spawned/forced vessels immediately, between AIS ticks.
    let lastVersion = useSimStore.getState().version;
    const unsubSim = useSimStore.subscribe((s) => {
      if (s.version !== lastVersion) {
        lastVersion = s.version;
        emit();
      }
    });

    return () => {
      unsubBase();
      unsubSim();
    };
  }

  async getBerths(): Promise<Berth[]> {
    return applyBerths(await this.base.getBerths(), snap());
  }

  async getBerthPlan(window?: TimeWindow): Promise<BerthingPlanEntry[]> {
    return this.base.getBerthPlan(window);
  }

  async getKPIs(): Promise<KpiBundle> {
    return applyKpis(await this.base.getKPIs(), snap().overrides.kpiDeltas);
  }

  async getArrivalsDepartures(window?: TimeWindow): Promise<ArrivalsDeparturesBlock[]> {
    return this.base.getArrivalsDepartures(window);
  }

  async getDelaySeries(
    kind: 'preBerthing' | 'preSailing',
    window?: TimeWindow,
  ): Promise<KpiSnapshot[]> {
    return this.base.getDelaySeries(kind, window);
  }

  async getPrediction(window?: TimeWindow): Promise<PredictionPoint[]> {
    return this.base.getPrediction(window);
  }

  async getPortCraft(): Promise<PortCraftUnit[]> {
    return applyPortCraft(await this.base.getPortCraft(), snap());
  }

  async getWeather(): Promise<WeatherReading> {
    return applyWeather(await this.base.getWeather(), snap());
  }

  async getKpiHistory(window?: TimeWindow): Promise<KpiSnapshot[]> {
    return this.base.getKpiHistory(window);
  }

  async runWhatIf(scenario: WhatIfScenario): Promise<WhatIfResult> {
    return this.base.runWhatIf(scenario);
  }
}
