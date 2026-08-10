/**
 * Resilient wrapper around Uc3Adapter — falls back to MockAdapter when the
 * corpus gateway is unreachable or persistently errors, so the demo does not
 * stall on a red connection banner with an empty map.
 */

import type { DataAdapter, ConnectionListener, Unsubscribe, VesselListener } from './types';
import { Uc3Adapter } from './Uc3Adapter';
import { MockAdapter } from './MockAdapter';

export class ResilientCorpusAdapter implements DataAdapter {
  readonly mode = 'live' as const;

  private corpus = new Uc3Adapter();
  private mock = new MockAdapter();
  private fallback = false;

  private switchToMock(reason: string): void {
    if (!this.fallback) {
      this.fallback = true;
      console.warn(`[adapter] ${reason} — falling back to MockAdapter`);
    }
  }

  subscribeVessels(onBatch: VesselListener, onState?: ConnectionListener): Unsubscribe {
    if (this.fallback) return this.mock.subscribeVessels(onBatch, onState);

    let mockUnsub: Unsubscribe | null = null;
    let switched = false;

    const corpUnsub = this.corpus.subscribeVessels(
      (v) => onBatch(v),
      (s) => {
        if (s === 'error' && !switched) {
          switched = true;
          this.switchToMock('corpus vessel feed failed');
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

  private async tryCorpus<T>(fn: () => Promise<T>, mockFn: () => Promise<T>): Promise<T> {
    if (this.fallback) return mockFn();
    try {
      return await fn();
    } catch (err) {
      this.switchToMock(err instanceof Error ? err.message : 'corpus request failed');
      return mockFn();
    }
  }

  getBerths() {
    return this.tryCorpus(() => this.corpus.getBerths(), () => this.mock.getBerths());
  }

  getBerthPlan(window?: import('./types').TimeWindow) {
    return this.tryCorpus(
      () => this.corpus.getBerthPlan(window),
      () => this.mock.getBerthPlan(window),
    );
  }

  getKPIs() {
    return this.tryCorpus(() => this.corpus.getKPIs(), () => this.mock.getKPIs());
  }

  getArrivalsDepartures(window?: import('./types').TimeWindow) {
    return this.tryCorpus(
      () => this.corpus.getArrivalsDepartures(window),
      () => this.mock.getArrivalsDepartures(window),
    );
  }

  getDelaySeries(
    kind: 'preBerthing' | 'preSailing',
    window?: import('./types').TimeWindow,
  ) {
    return this.tryCorpus(
      () => this.corpus.getDelaySeries(kind, window),
      () => this.mock.getDelaySeries(kind, window),
    );
  }

  getPrediction(window?: import('./types').TimeWindow) {
    return this.tryCorpus(
      () => this.corpus.getPrediction(window),
      () => this.mock.getPrediction(window),
    );
  }

  getPortCraft() {
    return this.tryCorpus(() => this.corpus.getPortCraft(), () => this.mock.getPortCraft());
  }

  getWeather() {
    return this.tryCorpus(() => this.corpus.getWeather(), () => this.mock.getWeather());
  }

  getTideStations() {
    return this.tryCorpus(
      () => this.corpus.getTideStations(),
      () => this.mock.getTideStations(),
    );
  }

  getKpiHistory(window?: import('./types').TimeWindow) {
    return this.tryCorpus(
      () => this.corpus.getKpiHistory(window),
      () => this.mock.getKpiHistory(window),
    );
  }

  getShippingLines() {
    return this.tryCorpus(
      () => this.corpus.getShippingLines(),
      () => this.mock.getShippingLines(),
    );
  }

  runWhatIf(scenario: import('./types').WhatIfScenario) {
    return this.tryCorpus(
      () => this.corpus.runWhatIf(scenario),
      () => this.mock.runWhatIf(scenario),
    );
  }
}
