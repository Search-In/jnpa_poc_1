/**
 * State for the vessel-predictions panel: which vessel is open, the last
 * scored fleet, and the status of the call that produced it.
 *
 * Store-driven rather than component state for two reasons:
 *
 *  • **One fleet call serves every row.** Scoring runs the berth optimiser and
 *    the TAT engine over the whole feed; doing that again each time the operator
 *    opens a different row would be seconds of needless compute for numbers that
 *    are already in hand. So a successful response is cached and reused for any
 *    vessel it already covers, until it goes stale.
 *
 *  • **The panel outlives the table row.** The sheet is mounted at the app
 *    level, so its state cannot live inside <VesselTable>.
 *
 * Staleness is deliberate and short: the AIS feed moves, and a berth plan built
 * on positions from ten minutes ago is a different plan. After `CACHE_TTL_MS`
 * the next open refetches.
 */

import { create } from 'zustand';
import type { Vessel } from '@/types/domain';
import { env } from '../config';
import {
  fetchFleetPredictions,
  indexByMmsi,
  selectFleet,
} from './predictions';
import type { PredictionContext, PredictionResponse, VesselPrediction } from './types';

/** How long a scored fleet may be reused before the next open refetches. */
export const CACHE_TTL_MS = 5 * 60_000;

interface PredictionState {
  /** MMSI of the vessel whose panel is open; null when the panel is closed. */
  openMmsi: string | null;
  /** Name of that vessel, held so the panel has a title before data arrives. */
  openVesselName: string;
  loading: boolean;
  error: string | null;
  /** The last successful response, or null before the first / after a failure. */
  response: PredictionResponse | null;
  /** `Date.now()` of that response. */
  fetchedAt: number | null;
  /** How many vessels were sent, and how many the feed held at the time. */
  scored: number;
  feedSize: number;

  /** Open the panel for one vessel, scoring the feed if the cache cannot serve it. */
  open: (vessel: Vessel, fleet: Vessel[], context?: PredictionContext) => Promise<void>;
  close: () => void;
  /** Force a re-score of the currently open vessel's feed. */
  refresh: (fleet: Vessel[], context?: PredictionContext) => Promise<void>;
}

/** The prediction for the vessel currently open, or null. Selector, not state. */
export function selectOpenPrediction(s: PredictionState): VesselPrediction | null {
  if (!s.response || !s.openMmsi) return null;
  return indexByMmsi(s.response).get(s.openMmsi) ?? null;
}

async function score(
  set: (partial: Partial<PredictionState>) => void,
  vessel: Vessel,
  fleet: Vessel[],
  context: PredictionContext,
): Promise<void> {
  const sent = selectFleet(fleet, vessel.MMSI, env.ml.maxFleet);
  set({ loading: true, error: null, scored: sent.length, feedSize: fleet.length });
  try {
    const response = await fetchFleetPredictions(sent, context);
    set({ response, fetchedAt: Date.now(), loading: false, error: null });
  } catch (err) {
    // The previous response is dropped on failure: showing stale predictions
    // beside a fresh error is how an operator ends up acting on numbers that
    // no longer describe the feed in front of them.
    set({
      loading: false,
      error: err instanceof Error ? err.message : String(err),
      response: null,
      fetchedAt: null,
    });
  }
}

export const usePredictionStore = create<PredictionState>((set, get) => ({
  openMmsi: null,
  openVesselName: '',
  loading: false,
  error: null,
  response: null,
  fetchedAt: null,
  scored: 0,
  feedSize: 0,

  open: async (vessel, fleet, context = {}) => {
    set({ openMmsi: vessel.MMSI, openVesselName: vessel.VESSEL_NAME });

    const { response, fetchedAt } = get();
    const fresh = fetchedAt !== null && Date.now() - fetchedAt < CACHE_TTL_MS;
    if (response && fresh && indexByMmsi(response).has(vessel.MMSI)) {
      set({ loading: false, error: null });
      return;
    }
    await score(set, vessel, fleet, context);
  },

  close: () => set({ openMmsi: null, openVesselName: '' }),

  refresh: async (fleet, context = {}) => {
    const { openMmsi } = get();
    const vessel = fleet.find((v) => v.MMSI === openMmsi);
    if (!vessel) return;
    await score(set, vessel, fleet, context);
  },
}));
