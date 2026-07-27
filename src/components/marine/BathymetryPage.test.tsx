/**
 * <BathymetryPage> — tab wiring and the post-import refresh contract.
 *
 * The refresh path is the point of this file: a successful chart import must make the
 * OVERVIEW refetch, not just the keyed Surveys table. Overview is the default pane and
 * shows "charts with soundings" / "soundings stored", so a stale Overview reads as a
 * failed import even when the backend accepted every row.
 *
 * Only the network boundary is stubbed (`fetchBathymetrySurveys`) — the real Page, Tabs
 * and Overview all run, so the test exercises the actual prop chain rather than a mock
 * of it. Calcite tab primitives are stubbed to mirror their real behaviour: every pane
 * stays mounted, only `selected` moves.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

vi.mock('@esri/calcite-components-react', () => ({
  CalciteTabs: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CalciteTabNav: ({ children }: { children?: React.ReactNode }) => <div role="tablist">{children}</div>,
  CalciteTabTitle: ({ children, selected, onCalciteTabsActivate }: {
    children?: React.ReactNode; selected?: boolean; onCalciteTabsActivate?: () => void;
  }) => (
    <button role="tab" aria-selected={!!selected} onClick={() => onCalciteTabsActivate?.()}>
      {children}
    </button>
  ),
  // Calcite keeps hidden panes MOUNTED — mirror that, don't conditionally render.
  CalciteTab: ({ children, selected }: { children?: React.ReactNode; selected?: boolean }) => (
    <div role="tabpanel" hidden={!selected}>{children}</div>
  ),
  CalciteInput: () => <input />,
  // Used by Panel's loading/empty/error states and by SourceBadge, which the real
  // Overview renders.
  CalciteLoader: ({ label }: { label?: string }) => <div>{label}</div>,
  CalciteNotice: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CalciteIcon: () => <span />,
}));

// Leaf panes that are not under test: the survey table has its own coverage, and the
// upload panel is replaced by a button that fires the real onImported chain.
vi.mock('@/components/marine/BathymetrySurveyTable', () => ({
  BathymetrySurveyTable: () => <div>survey-table</div>,
}));
vi.mock('@/components/marine/BathymetryDataUpload', () => ({
  BathymetryDataUpload: ({ onImported }: { onImported?: (r: unknown) => void }) => (
    <button onClick={() => onImported?.({ status: 'SUCCESS' })}>fake-import</button>
  ),
}));

// The ONLY stub inside the unit under test: the network call.
const fetchSurveys = vi.fn();
vi.mock('@/data/uc3/bathymetry', () => ({
  fetchBathymetrySurveys: (...args: unknown[]) => fetchSurveys(...args),
}));

import { BathymetryPage } from './BathymetryPage';

const survey = (drawingNo: string, soundingCount: number) => ({
  surveyId: drawingNo.length, drawingNo, sectionLabel: 'E-F',
  designDepthM: 14.4, surveyStart: '', surveyEnd: '', surveyVessel: 'ME QUEEN',
  soundingCount,
});

const tab = (name: string) => screen.getByRole('tab', { name });

beforeEach(() => {
  fetchSurveys.mockReset();
});

describe('BathymetryPage — tab structure', () => {
  it('shows Overview, Surveys and Data Upload in that order', async () => {
    fetchSurveys.mockResolvedValue([survey('CHART-1', 0)]);
    render(<BathymetryPage />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview', 'Surveys', 'Data Upload',
    ]);
  });

  it('opens on Overview', async () => {
    fetchSurveys.mockResolvedValue([survey('CHART-1', 0)]);
    render(<BathymetryPage />);
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });

  it('switches panes on click', async () => {
    fetchSurveys.mockResolvedValue([survey('CHART-1', 0)]);
    render(<BathymetryPage />);
    fireEvent.click(tab('Surveys'));
    expect(tab('Surveys')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'false');
  });
});

describe('BathymetryPage — post-import refresh', () => {
  it('refetches surveys after a successful import', async () => {
    fetchSurveys.mockResolvedValue([survey('CHART-1', 0)]);
    render(<BathymetryPage />);
    await waitFor(() => expect(fetchSurveys).toHaveBeenCalledTimes(1));

    fireEvent.click(tab('Data Upload'));
    await act(async () => { fireEvent.click(screen.getByText('fake-import')); });

    await waitFor(() => expect(fetchSurveys).toHaveBeenCalledTimes(2));
  });

  it('Overview cards show the NEW counts after an import', async () => {
    // Before: one chart registered, no soundings. After: the same chart, 9,878 soundings.
    fetchSurveys
      .mockResolvedValueOnce([survey('CHART-1', 0)])
      .mockResolvedValueOnce([survey('CHART-1', 9878)]);

    render(<BathymetryPage />);
    // "Charts with soundings" is 0 and the awaiting-upload callout is showing.
    await waitFor(() => expect(screen.getByText(/awaiting upload/i)).toBeInTheDocument());

    fireEvent.click(tab('Data Upload'));
    await act(async () => { fireEvent.click(screen.getByText('fake-import')); });

    // The stale-Overview bug shows up exactly here: without a refetch these still read 0.
    await waitFor(() => {
      expect(screen.getByText('9,878')).toBeInTheDocument();
      expect(screen.getByText(/all charts loaded/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/awaiting upload/i)).not.toBeInTheDocument();
  });
});
