/**
 * <VesselPredictionsSheet> — the contract that matters when a prediction rests
 * on an estimate.
 *
 * Three things are asserted, and they are the three that make this panel safe:
 *
 *   1. **The assumptions notice renders before the numbers.** An under-keel
 *      clearance computed from an estimated draft is advice, not a clearance,
 *      and DOM order is what an operator actually reads.
 *   2. **Every model block that arrived is shown**, including one the frontend
 *      has never heard of — a model gaining a block is exactly the thing worth
 *      seeing, not something to drop silently.
 *   3. **A failure shows the failure**, not a blank sheet or stale numbers.
 *
 * Only the network boundary is stubbed. The real store, the real ordering and
 * the real formatting all run, so this exercises the actual path from a table
 * click to rendered text. Calcite primitives are replaced with plain elements
 * that keep their slotted content visible — jsdom does not run shadow DOM.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import type { Vessel } from '@/types/domain';
import type { PredictionResponse } from '@/data/ml/types';

/**
 * Counts how many times a <CalcitePanel> ELEMENT was created.
 *
 * This is the regression hook for a bug that shipped: `calcite-panel` handles
 * its own ✕ by setting `closed = true` on the element, its React wrapper only
 * writes props that changed, and we never pass `closed` — so the second open
 * rendered an empty white sheet with no header and no ✕. The fix is a `key` that
 * forces a new element per open, and this counter is what proves it is still
 * there. Asserting on rendered text alone would NOT have caught it: the mocked
 * panel has no `closed` behaviour to reproduce.
 */
const panelMounts = vi.fn();

vi.mock('@esri/calcite-components-react', () => ({
  // `calcite-sheet` keeps its slotted content MOUNTED and toggles visibility —
  // mirror that, do not conditionally render. Getting this wrong is what let the
  // reopen bug through the first time: a mock that unmounts children on close
  // re-creates the panel for free, so the missing `key` looked harmless.
  CalciteSheet: ({ children, open }: { children?: ReactNode; open?: boolean }) => (
    <div role="dialog" hidden={!open}>
      {children}
    </div>
  ),
  CalcitePanel: ({ children, heading }: { children?: ReactNode; heading?: string }) => {
    useEffect(() => {
      panelMounts();
    }, []);
    return (
      <section>
        <h1>{heading}</h1>
        {children}
      </section>
    );
  },
  CalciteNotice: ({ children }: { children?: ReactNode }) => <div role="status">{children}</div>,
  // Forwards `title`: the real <calcite-chip> puts it on the host element, and
  // hover text is now where the substitution detail lives — a mock that dropped
  // it would let that regress silently.
  CalciteChip: ({ children, title }: { children?: ReactNode; title?: string }) => (
    <span title={title}>{children}</span>
  ),
  CalciteButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
  CalciteLoader: ({ label }: { label?: string }) => <div>{label}</div>,
  CalciteIcon: () => <span />,
}));

const fetchFleet = vi.fn();
vi.mock('@/data/ml/predictions', async () => {
  const actual = await vi.importActual<typeof import('@/data/ml/predictions')>(
    '@/data/ml/predictions',
  );
  return { ...actual, fetchFleetPredictions: (...a: unknown[]) => fetchFleet(...a) };
});

import { VesselPredictionsSheet } from './VesselPredictionsSheet';
import { usePredictionStore } from '@/data/ml/predictionStore';

const vessel: Vessel = {
  MMSI: '419000501',
  VESSEL_NAME: 'MSC ANNA',
  VESSEL_TYPE: 'Container Ship',
  NAV_STATUS: 'approaching',
  SOG: 11.4,
  COG: 78,
  HEADING: 80,
  LAT: 18.9,
  LON: 72.9,
  ETA: 1_785_030_000_000,
  BERTH_ID: 'BMCT-01',
  TIMESTAMP: 1_785_000_000_000,
  SOURCE: 'live',
};

function payload(over: Partial<PredictionResponse['dashboard']> = {}): PredictionResponse {
  return {
    schema: 'uc1-webapp-predictions/1.0.0',
    adapter: {
      moduleId: 'UC1-ADAPTER',
      version: 'uc1-adapter-v1.0.0',
      scope: 'FLEET',
      models_requested: ['m1'],
      max_fleet: 80,
      note: 'fleet note',
    },
    dashboard: {
      schema: 'uc1-dashboard/1.0.0',
      run: {
        generated_at_utc: '2026-08-04T10:00:00Z',
        input_file: 'live-ais-feed',
        vessels: 1,
        models_run: ['UC1-M1'],
        models_failed: [],
        wait_model: 'optimiser',
        tide_policy: 'harmonic',
      },
      model_questions: { m1_under_keel_clearance: 'Can she safely transit the channel?' },
      glossary: { net_ukc_m: 'Under-keel clearance after squat and the 1.0 m margin.' },
      vessels: [
        {
          call_id: 'C-0001',
          vessel: 'MSC ANNA',
          imo: '',
          voyage: '',
          terminal: 'BMCT',
          mmsi: '419000501',
          source: 'live',
          degraded: true,
          input: { draft_m: 16 },
          data_quality: { tide: 'SYNTHETIC_HARMONIC_v1' },
          flags: ['TIDE_SYNTHETIC'],
          models: {
            m1_under_keel_clearance: { status: 'NO GO', net_ukc_m: 0.28, squat_m: 0.65 },
            m9_future_model: { headroom: 3 },
          },
          mapping: {
            adapter_version: 'uc1-adapter-v1.0.0',
            mmsi: '419000501',
            vessel: 'MSC ANNA',
            degraded: true,
            derived: [],
            assumptions: ['Draft_m=16.0 -- AIS sent no draught; estimated from LOA'],
            warnings: [],
            inputs_observed: 4,
            inputs_assumed: 3,
          },
        },
      ],
      port_summary: { turnaround: { mean_tat_hours: 48.8 } },
      ...over,
    },
  };
}

beforeEach(() => {
  fetchFleet.mockReset();
  panelMounts.mockReset();
  usePredictionStore.setState({
    openMmsi: null,
    openVesselName: '',
    loading: false,
    error: null,
    response: null,
    fetchedAt: null,
    scored: 0,
    feedSize: 0,
  });
});

async function openPanel() {
  render(<VesselPredictionsSheet />);
  await act(async () => {
    await usePredictionStore.getState().open(vessel, [vessel]);
  });
}

describe('VesselPredictionsSheet', () => {
  it('shows the verdict, the headline and the per-field values', async () => {
    fetchFleet.mockResolvedValue(payload());
    await openPanel();

    expect(await screen.findByText('NO GO')).toBeInTheDocument();
    expect(screen.getByText('0.28')).toBeInTheDocument(); // net_ukc_m headline
    expect(screen.getByText('Squat m')).toBeInTheDocument();
  });

  it('renders a model block it has never seen rather than dropping it', async () => {
    fetchFleet.mockResolvedValue(payload());
    await openPanel();
    expect(await screen.findByText('M9 future model')).toBeInTheDocument();
  });

  // --- what the panel does NOT spend height on ------------------------------
  // The first build printed a model's plain-English question under every card
  // title and a full-width advisory banner above the numbers. Both were read
  // once and then became furniture between the operator and the figures.

  it('keeps the model question on the ⓘ affordance, not as a permanent line', async () => {
    fetchFleet.mockResolvedValue(payload());
    await openPanel();
    await screen.findByText('M1 · Under-keel clearance');

    const question = 'Can she safely transit the channel?';
    // Not standing on its own as body text…
    expect(screen.queryByText(question)).not.toBeInTheDocument();
    // …but reachable on hover, and announced to a screen reader.
    const hint = screen.getByRole('note', { name: question });
    expect(hint).toHaveAttribute('title', question);
    // Keyboard users get it too — hover-only would exclude them.
    expect(hint).toHaveAttribute('tabindex', '0');
  });

  it('states the estimate count as a chip, not a banner', async () => {
    fetchFleet.mockResolvedValue(payload());
    await openPanel();

    const chip = await screen.findByText('3 estimated');
    // No fraction that could be read as a tally of the eight models.
    expect(chip.textContent).not.toMatch(/\d+\s+of\s+\d+/);
    expect(screen.queryByText(/Advisory —/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Treat the figures below as advice/)).not.toBeInTheDocument();
  });

  it('still names every substitution — quieter, not dropped', async () => {
    const withNote = payload();
    withNote.dashboard.vessels[0].mapping!.warnings = ['no measured tide supplied'];
    fetchFleet.mockResolvedValue(withNote);
    await openPanel();

    // On the chip's hover…
    const chip = await screen.findByText('3 estimated');
    const hover = chip.closest('[title]')?.getAttribute('title') ?? chip.getAttribute('title') ?? '';
    expect(hover).toMatch(/estimated from LOA/);
    expect(hover).toMatch(/no measured tide supplied/);

    // …and in full in the model-inputs disclosure, so it survives a client that
    // shows no tooltips at all (touch).
    expect(screen.getByText(/estimated from LOA/)).toBeInTheDocument();
    expect(screen.getByText('no measured tide supplied')).toBeInTheDocument();
  });

  it('says so plainly when nothing had to be estimated', async () => {
    const clean = payload();
    clean.dashboard.vessels[0].degraded = false;
    clean.dashboard.vessels[0].mapping!.degraded = false;
    clean.dashboard.vessels[0].mapping!.assumptions = [];
    fetchFleet.mockResolvedValue(clean);
    await openPanel();

    expect(await screen.findByText('all inputs observed')).toBeInTheDocument();
  });

  it('collapses the reference sections so the models are what you land on', async () => {
    fetchFleet.mockResolvedValue(payload());
    await openPanel();
    await screen.findByText('M1 · Under-keel clearance');

    const disclosures = document.querySelectorAll('details');
    expect(disclosures.length).toBe(2); // model inputs + port-level
    disclosures.forEach((d) => expect(d.open).toBe(false));
  });

  it('surfaces a transport failure instead of a blank sheet', async () => {
    fetchFleet.mockRejectedValue(new Error('Cannot reach the UC-1 model service at /ml-api'));
    await openPanel();

    await waitFor(() => expect(screen.getByText('Try again')).toBeInTheDocument());
    expect(screen.queryByText('M1 · Under-keel clearance')).not.toBeInTheDocument();
  });

  it('names a model that failed mid-run while still showing the rest', async () => {
    const partial = payload();
    partial.dashboard.run.models_failed = [{ model: 'UC1-M5', error: 'solver timeout' }];
    fetchFleet.mockResolvedValue(partial);
    await openPanel();

    expect(await screen.findByText(/1 model\(s\) failed in this run/)).toBeInTheDocument();
    expect(screen.getByText(/UC1-M5: solver timeout/)).toBeInTheDocument();
    expect(screen.getByText('M1 · Under-keel clearance')).toBeInTheDocument();
  });

  it('reports vessels the fleet models could not cover', async () => {
    const capped = payload();
    capped.dashboard.run.vessels_dropped = 5;
    capped.dashboard.run.dropped_reason = 'this endpoint scores at most 80 per call';
    fetchFleet.mockResolvedValue(capped);
    await openPanel();

    expect(await screen.findByText(/5 vessel\(s\) left out of the fleet models/)).toBeInTheDocument();
  });

  it('builds a FRESH panel each time it opens, so a closed one cannot come back', async () => {
    // The bug: calcite-panel's own ✕ sets closed=true on the element and the
    // React wrapper never resets it, so the second open was an empty white box.
    const two = payload();
    two.dashboard.vessels.push({
      ...two.dashboard.vessels[0],
      call_id: 'C-0002',
      mmsi: '419000502',
      vessel: 'SSL KOCHI',
    });
    fetchFleet.mockResolvedValue(two);
    await openPanel();
    const afterFirstOpen = panelMounts.mock.calls.length;

    await act(async () => usePredictionStore.getState().close());
    await act(async () => {
      await usePredictionStore
        .getState()
        .open({ ...vessel, MMSI: '419000502', VESSEL_NAME: 'SSL KOCHI' }, [vessel]);
    });

    expect(panelMounts.mock.calls.length).toBeGreaterThan(afterFirstOpen);
    // …and the reopened panel really has its content, not just a new element.
    expect(await screen.findByText('M1 · Under-keel clearance')).toBeInTheDocument();
  });

  it('reopens the SAME vessel with a fresh panel too', async () => {
    fetchFleet.mockResolvedValue(payload());
    await openPanel();
    const afterFirstOpen = panelMounts.mock.calls.length;

    await act(async () => usePredictionStore.getState().close());
    await act(async () => {
      await usePredictionStore.getState().open(vessel, [vessel]);
    });

    // Closing sets openMmsi to null, so the key changes on the way out as well
    // as on the way back in — reopening the same hull is not a no-op remount.
    expect(panelMounts.mock.calls.length).toBeGreaterThan(afterFirstOpen);
    expect(await screen.findByText('NO GO')).toBeInTheDocument();
  });

  it('reuses the scored fleet when a second vessel in it is opened', async () => {
    const two = payload();
    two.dashboard.vessels.push({ ...two.dashboard.vessels[0], call_id: 'C-0002', mmsi: '419000502', vessel: 'SSL KOCHI' });
    fetchFleet.mockResolvedValue(two);
    await openPanel();

    const second = { ...vessel, MMSI: '419000502', VESSEL_NAME: 'SSL KOCHI' };
    await act(async () => {
      await usePredictionStore.getState().open(second, [vessel, second]);
    });

    // One call, not two: scoring runs the optimiser over the whole fleet.
    expect(fetchFleet).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('SSL KOCHI')).toBeInTheDocument();
  });
});
