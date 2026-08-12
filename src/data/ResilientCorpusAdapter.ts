/**
 * Resilient wrapper around Uc3Adapter — falls back to MockAdapter when the
 * corpus gateway is unreachable or persistently errors, so the demo does not
 * stall on a red connection banner with an empty map.
 *
 * Two rules make that fallback honest rather than a silent lie:
 *
 *  1. **It is per-read, not global.** A single failing endpoint used to flip one
 *     sticky flag that routed EVERY subsequent read — berths, KPIs, tide, port
 *     craft — to the mock for the rest of the session. One 500 on
 *     /marine/vessel-states was enough to turn the whole board synthetic. Each
 *     read now degrades only itself, and only until its cooldown expires, so a
 *     transient fault cannot take healthy panels down with it.
 *
 *  2. **It is announced.** Serving invented numbers under a live badge is worse
 *     than showing an error. Every fallback reports its source to the
 *     provenance store as IMPUTED (and back to LIVE on recovery), so the panel's
 *     SourceBadge, the global DataModeChip and the reconciliation audit log all
 *     say so. A console.warn nobody reads is not a disclosure.
 */

import type { DataAdapter, ConnectionListener, Unsubscribe, VesselListener } from './types';
import type { SourceId } from '@/provenance/sources';
import { useDataModeStore } from '@/provenance/useDataModeStore';
import { Uc3Adapter } from './Uc3Adapter';
import { MockAdapter } from './MockAdapter';

/**
 * How long a failed read keeps serving the mock before the corpus is retried.
 * Long enough that a hard-down gateway is not hammered once per panel refresh,
 * short enough that a restarted gateway heals within one poll cycle.
 */
const COOLDOWN_MS = 60_000;

/** Reads whose failure has a provenance source to report. */
type ReadKey =
  | 'berths'
  | 'berthPlan'
  | 'kpis'
  | 'arrivalsDepartures'
  | 'delaySeries'
  | 'prediction'
  | 'portCraft'
  | 'weather'
  | 'tideStations'
  | 'kpiHistory'
  | 'shippingLines'
  | 'whatIf'
  | 'vessels';

/**
 * Which production source each read speaks for. `null` = no single source owns
 * it (derived/aggregate reads), so it degrades quietly without mislabelling a
 * feed that is actually healthy.
 */
const READ_SOURCE: Record<ReadKey, SourceId | null> = {
  berths: 'BERTH_PLAN',
  berthPlan: 'BERTH_PLAN',
  kpis: null,
  arrivalsDepartures: 'BERTH_PLAN',
  delaySeries: null,
  prediction: null,
  portCraft: 'CRAFT',
  weather: 'WEATHER',
  tideStations: 'TIDE',
  kpiHistory: null,
  shippingLines: 'SHIPPING_LINE',
  whatIf: null,
  vessels: 'AIS',
};

export class ResilientCorpusAdapter implements DataAdapter {
  readonly mode = 'live' as const;

  private corpus = new Uc3Adapter();
  private mock = new MockAdapter();
  /** read → epoch ms until which this read keeps serving the mock. */
  private degradedUntil = new Map<ReadKey, number>();

  /** Wall clock, isolated so tests can reason about the cooldown. */
  protected now(): number {
    return Date.now();
  }

  private isDegraded(key: ReadKey): boolean {
    const until = this.degradedUntil.get(key);
    return until !== undefined && this.now() < until;
  }

  private markDegraded(key: ReadKey, reason: string): void {
    const first = !this.isDegraded(key);
    this.degradedUntil.set(key, this.now() + COOLDOWN_MS);
    if (!first) return;
    console.warn(`[adapter] ${key}: ${reason} — serving MockAdapter for ${COOLDOWN_MS / 1000}s`);
    const src = READ_SOURCE[key];
    if (src) {
      useDataModeStore
        .getState()
        .setSourceState(src, 'IMPUTED', `corpus read "${key}" failed (${reason}) — synthetic values`);
    }
  }

  private markRecovered(key: ReadKey): void {
    if (!this.degradedUntil.has(key)) return;
    this.degradedUntil.delete(key);
    const src = READ_SOURCE[key];
    if (src) {
      useDataModeStore.getState().setSourceState(src, 'LIVE', `corpus read "${key}" recovered`);
    }
  }

  subscribeVessels(onBatch: VesselListener, onState?: ConnectionListener): Unsubscribe {
    if (this.isDegraded('vessels')) return this.mock.subscribeVessels(onBatch, onState);

    let mockUnsub: Unsubscribe | null = null;
    let switched = false;

    const corpUnsub = this.corpus.subscribeVessels(
      (v) => {
        this.markRecovered('vessels');
        onBatch(v);
      },
      (s) => {
        if (s === 'error' && !switched) {
          switched = true;
          this.markDegraded('vessels', 'corpus vessel feed failed');
          corpUnsub();
          mockUnsub = this.mock.subscribeVessels(onBatch, onState);
          return;
        }
        if (!switched) onState?.(s);
      },
    );

    return () => {
      corpUnsub();
      mockUnsub?.();
    };
  }

  private async tryCorpus<T>(
    key: ReadKey,
    fn: () => Promise<T>,
    mockFn: () => Promise<T>,
  ): Promise<T> {
    if (this.isDegraded(key)) return mockFn();
    try {
      const out = await fn();
      this.markRecovered(key);
      return out;
    } catch (err) {
      this.markDegraded(key, err instanceof Error ? err.message : 'corpus request failed');
      return mockFn();
    }
  }

  getBerths() {
    return this.tryCorpus('berths', () => this.corpus.getBerths(), () => this.mock.getBerths());
  }

  getBerthPlan(window?: import('./types').TimeWindow) {
    return this.tryCorpus(
      'berthPlan',
      () => this.corpus.getBerthPlan(window),
      () => this.mock.getBerthPlan(window),
    );
  }

  getKPIs() {
    return this.tryCorpus('kpis', () => this.corpus.getKPIs(), () => this.mock.getKPIs());
  }

  getArrivalsDepartures(window?: import('./types').TimeWindow) {
    return this.tryCorpus(
      'arrivalsDepartures',
      () => this.corpus.getArrivalsDepartures(window),
      () => this.mock.getArrivalsDepartures(window),
    );
  }

  getDelaySeries(
    kind: 'preBerthing' | 'preSailing',
    window?: import('./types').TimeWindow,
  ) {
    return this.tryCorpus(
      'delaySeries',
      () => this.corpus.getDelaySeries(kind, window),
      () => this.mock.getDelaySeries(kind, window),
    );
  }

  getPrediction(window?: import('./types').TimeWindow) {
    return this.tryCorpus(
      'prediction',
      () => this.corpus.getPrediction(window),
      () => this.mock.getPrediction(window),
    );
  }

  getPortCraft() {
    return this.tryCorpus(
      'portCraft',
      () => this.corpus.getPortCraft(),
      () => this.mock.getPortCraft(),
    );
  }

  getWeather() {
    return this.tryCorpus('weather', () => this.corpus.getWeather(), () => this.mock.getWeather());
  }

  getTideStations() {
    return this.tryCorpus(
      'tideStations',
      () => this.corpus.getTideStations(),
      () => this.mock.getTideStations(),
    );
  }

  getKpiHistory(window?: import('./types').TimeWindow) {
    return this.tryCorpus(
      'kpiHistory',
      () => this.corpus.getKpiHistory(window),
      () => this.mock.getKpiHistory(window),
    );
  }

  getShippingLines() {
    return this.tryCorpus(
      'shippingLines',
      () => this.corpus.getShippingLines(),
      () => this.mock.getShippingLines(),
    );
  }

  runWhatIf(scenario: import('./types').WhatIfScenario) {
    return this.tryCorpus(
      'whatIf',
      () => this.corpus.runWhatIf(scenario),
      () => this.mock.runWhatIf(scenario),
    );
  }
}
