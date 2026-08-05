/**
 * <PortCraftPage> — Overview / Fleet Register / Data Upload tab wiring.
 *
 * Verifies the UX contract of the screen: Overview is the default tab, all three
 * four tabs are present in order, selection switches, and a guided-tour beat snaps back
 * to Overview (the six `tab: 'craft'` steps in sim/scenarios.ts narrate the resource
 * board, which lives there).
 *
 * The three leaf panes are stubbed — each has its own coverage, and mounting the real
 * board would drag in the adapter, sim clock and ArcGIS highlight wiring. Calcite tab
 * primitives are stubbed to mirror their real behaviour: every pane stays mounted,
 * only `selected` moves.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

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
}));

vi.mock('@/components/marine/PortCraftOverview', () => ({
  PortCraftOverview: () => <div>overview-pane</div>,
}));
vi.mock('@/components/marine/PortCraftOperationsTab', () => ({
  PortCraftOperationsTab: () => <div>operations-pane</div>,
}));
vi.mock('@/components/marine/PortCraftFleetRegister', () => ({
  PortCraftFleetRegister: ({ registerKey }: { registerKey: number }) => <div>register-pane-{registerKey}</div>,
}));
vi.mock('@/components/marine/CraftAssignmentsTab', () => ({
  CraftAssignmentsTab: () => <div>craft-assignments-pane</div>,
}));
vi.mock('@/components/marine/PortCraftDataUpload', () => ({
  PortCraftDataUpload: ({ onImported }: { onImported?: (r: unknown) => void }) => (
    <button onClick={() => onImported?.({})}>fake-import</button>
  ),
}));

import { PortCraftPage } from './PortCraftPage';
import { useSimStore } from '@/sim/simStore';

const tab = (name: string) => screen.getByRole('tab', { name });

beforeEach(() => {
  act(() => { useSimStore.setState({ tour: { scenarioId: null, step: 0, auto: true } }); });
});

describe('PortCraftPage — tab structure', () => {
  it('shows Overview, Active Marine Operations, Fleet Register, Craft Assignments and Data Upload in that order', () => {
    render(<PortCraftPage />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview', 'Active Marine Operations', 'Fleet Register', 'Craft Assignments', 'Data Upload',
    ]);
  });

  it('opens on Overview by default', () => {
    render(<PortCraftPage />);
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Active Marine Operations')).toHaveAttribute('aria-selected', 'false');
    expect(tab('Fleet Register')).toHaveAttribute('aria-selected', 'false');
    expect(tab('Data Upload')).toHaveAttribute('aria-selected', 'false');
  });

  it('switches to Active Marine Operations', () => {
    render(<PortCraftPage />);
    fireEvent.click(tab('Active Marine Operations'));
    expect(tab('Active Marine Operations')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'false');
  });

  it('switches to Fleet Register and back', () => {
    render(<PortCraftPage />);
    fireEvent.click(tab('Fleet Register'));
    expect(tab('Fleet Register')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(tab('Overview'));
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });

  it('switches to Data Upload', () => {
    render(<PortCraftPage />);
    fireEvent.click(tab('Data Upload'));
    expect(tab('Data Upload')).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps every pane mounted so the register survives a tab switch', () => {
    render(<PortCraftPage />);
    fireEvent.click(tab('Data Upload'));
    expect(screen.getByText('overview-pane')).toBeInTheDocument();
    expect(screen.getByText('operations-pane')).toBeInTheDocument();
    expect(screen.getByText('register-pane-0')).toBeInTheDocument();
  });
});

describe('PortCraftPage — post-import refresh', () => {
  it('bumps the register key on a successful import', () => {
    render(<PortCraftPage />);
    expect(screen.getByText('register-pane-0')).toBeInTheDocument();
    fireEvent.click(screen.getByText('fake-import'));
    expect(screen.getByText('register-pane-1')).toBeInTheDocument();
  });
});

describe('PortCraftPage — guided tour', () => {
  it('snaps back to Overview on a tour beat', () => {
    render(<PortCraftPage />);
    fireEvent.click(tab('Data Upload'));
    expect(tab('Data Upload')).toHaveAttribute('aria-selected', 'true');

    act(() => { useSimStore.setState({ tour: { scenarioId: 'M4', step: 0, auto: true } }); });
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
  });

  it('leaves the operator alone when no tour is running', () => {
    render(<PortCraftPage />);
    fireEvent.click(tab('Fleet Register'));
    act(() => { useSimStore.setState({ version: useSimStore.getState().version + 1 }); });
    expect(tab('Fleet Register')).toHaveAttribute('aria-selected', 'true');
  });
});
