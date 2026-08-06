/**
 * <BathymetrySurveyTable> — the Marine Ops survey register.
 *
 * Covers the operational contract: the status vocabulary, the shoal-first ordering, the
 * three filters, and the N+1 degradation rule (a failed per-survey stats call must blank
 * ONE cell, never the table).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@esri/calcite-components-react', () => ({
  CalciteInput: ({ placeholder, value, onCalciteInputChange }: {
    placeholder?: string; value?: string; onCalciteInputChange?: (e: unknown) => void;
  }) => (
    <input
      placeholder={placeholder}
      value={value}
      onChange={(e) => onCalciteInputChange?.({ target: { value: e.target.value } })}
    />
  ),
  CalciteLoader: ({ label }: { label?: string }) => <div>{label}</div>,
  CalciteNotice: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CalciteIcon: () => <span />,
}));

const fetchSurveys = vi.fn();
const fetchStats = vi.fn();
vi.mock('@/data/uc3/bathymetry', () => ({
  fetchBathymetrySurveys: (...a: unknown[]) => fetchSurveys(...a),
  fetchBathymetrySurveyStats: (...a: unknown[]) => fetchStats(...a),
}));

import { BathymetrySurveyTable } from './BathymetrySurveyTable';
import { surveyStatus } from './bathymetrySurveyStatus';

const survey = (drawingNo: string, sectionLabel: string, soundingCount: number, surveyId = drawingNo.length) => ({
  surveyId, drawingNo, sectionLabel, designDepthM: 14.4,
  surveyStart: '', surveyEnd: '', surveyVessel: 'ME QUEEN', soundingCount,
});
const stats = (surveyId: number, aboveDesignCount: number, georeferencedCount = 100) => ({
  surveyId, drawingNo: '', designDepthM: 14.4, soundingCount: 100,
  aboveDesignCount, georeferencedCount,
  minDepthM: 1, maxDepthM: 20, avgDepthM: 12, bbox: null,
});

beforeEach(() => {
  fetchSurveys.mockReset();
  fetchStats.mockReset();
});

describe('surveyStatus', () => {
  it('is awaiting when no soundings have been imported', () => {
    expect(surveyStatus(0, 0)).toBe('awaiting');
    expect(surveyStatus(0, null)).toBe('awaiting');
  });
  it('is shoal when any sounding sits above design depth', () => {
    expect(surveyStatus(100, 1)).toBe('shoal');
  });
  it('is clear when soundings exist and none are above design', () => {
    expect(surveyStatus(100, 0)).toBe('clear');
  });
  it('treats unknown above-design as clear rather than inventing a hazard', () => {
    expect(surveyStatus(100, null)).toBe('clear');
  });
});

describe('BathymetrySurveyTable', () => {
  it('shows the Marine Ops columns, not raw database fields', async () => {
    fetchSurveys.mockResolvedValue([survey('CHART-1', 'E-F', 0)]);
    render(<BathymetrySurveyTable />);
    await waitFor(() => expect(screen.getByText('Drawing No')).toBeInTheDocument());
    for (const h of ['Section / Area', 'Design Depth', 'Soundings', 'Above Design', 'Status']) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
    // Provenance columns are deliberately absent.
    expect(screen.queryByText('Survey Vessel')).not.toBeInTheDocument();
    expect(screen.queryByText('Survey Start')).not.toBeInTheDocument();
  });

  it('only requests stats for surveys that actually have soundings', async () => {
    fetchSurveys.mockResolvedValue([survey('EMPTY', 'AB', 0, 1), survey('LOADED', 'CD', 500, 2)]);
    fetchStats.mockResolvedValue(stats(2, 0));
    render(<BathymetrySurveyTable />);
    await waitFor(() => expect(screen.getByText('LOADED')).toBeInTheDocument());
    expect(fetchStats).toHaveBeenCalledTimes(1);
    expect(fetchStats).toHaveBeenCalledWith(2);
  });

  it('orders shoal surveys first', async () => {
    fetchSurveys.mockResolvedValue([
      survey('AAA-clear', 'AB', 100, 1),
      survey('ZZZ-shoal', 'CD', 100, 2),
    ]);
    fetchStats.mockImplementation((id: number) => Promise.resolve(stats(id, id === 2 ? 7 : 0)));
    render(<BathymetrySurveyTable />);
    await waitFor(() => expect(screen.getByText('ZZZ-shoal')).toBeInTheDocument());
    const order = screen.getAllByRole('row').slice(1).map((r) => r.textContent ?? '');
    expect(order[0]).toContain('ZZZ-shoal');
  });

  it('a failed stats call blanks one cell, not the table', async () => {
    fetchSurveys.mockResolvedValue([survey('OK', 'AB', 100, 1), survey('BROKEN', 'CD', 100, 2)]);
    fetchStats.mockImplementation((id: number) =>
      id === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(stats(id, 0)));
    render(<BathymetrySurveyTable />);
    await waitFor(() => expect(screen.getByText('BROKEN')).toBeInTheDocument());
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('one search box matches drawing no OR section', async () => {
    fetchSurveys.mockResolvedValue([survey('ALPHA', 'E-F', 0, 1), survey('BETA', 'C-D', 0, 2)]);
    render(<BathymetrySurveyTable />);
    await waitFor(() => expect(screen.getByText('ALPHA')).toBeInTheDocument());

    const box = screen.getByPlaceholderText(/search drawing no or section/i);
    fireEvent.change(box, { target: { value: 'BETA' } });
    await waitFor(() => expect(screen.queryByText('ALPHA')).not.toBeInTheDocument());

    fireEvent.change(box, { target: { value: 'E-F' } });   // now match on SECTION
    await waitFor(() => expect(screen.getByText('ALPHA')).toBeInTheDocument());
    expect(screen.queryByText('BETA')).not.toBeInTheDocument();
  });

  it('filters by status', async () => {
    fetchSurveys.mockResolvedValue([survey('LOADED', 'AB', 100, 1), survey('EMPTY', 'CD', 0, 2)]);
    fetchStats.mockResolvedValue(stats(1, 0));
    render(<BathymetrySurveyTable />);
    await waitFor(() => expect(screen.getByText('EMPTY')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'awaiting' } });
    await waitFor(() => expect(screen.queryByText('LOADED')).not.toBeInTheDocument());
    expect(screen.getByText('EMPTY')).toBeInTheDocument();
  });

  it('filters by section', async () => {
    fetchSurveys.mockResolvedValue([survey('ALPHA', 'E-F', 0, 1), survey('BETA', 'C-D', 0, 2)]);
    render(<BathymetrySurveyTable />);
    await waitFor(() => expect(screen.getByText('ALPHA')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Filter by section'), { target: { value: 'C-D' } });
    await waitFor(() => expect(screen.queryByText('ALPHA')).not.toBeInTheDocument());
    expect(screen.getByText('BETA')).toBeInTheDocument();
  });
});
