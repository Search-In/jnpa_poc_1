/**
 * <PortCraftOverview> — the demand strip is ADDITIVE over the existing board.
 *
 * The contract under test is degradation: the strip must never be able to break the tab.
 * When /api/marine/state/port-craft does not answer, the page must render exactly what it
 * rendered before the strip existed — the board, alone.
 *
 * <PortCraftBoard> is stubbed: it has its own coverage, and mounting it would drag in the
 * adapter, the sim clock and the ArcGIS highlight wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PortCraftDemand } from '@/data/uc3/portCraftState';

vi.mock('@/components/reports/PortCraftBoard', () => ({
  PortCraftBoard: () => <div>craft-board</div>,
}));


const fetchDemand = vi.fn();
vi.mock('@/data/uc3/portCraftState', () => ({
  fetchPortCraftDemand: () => fetchDemand(),
}));

import { PortCraftOverview } from './PortCraftOverview';

const DEMAND: PortCraftDemand = {
  fleetTotal: 18,
  fleetByType: [{ craftType: 'Tug', count: 10 }, { craftType: 'Pilot Launch', count: 4 }],
  totalDemand: 561,
  inboundCount: 25,
  alongsideCount: 536,
  outboundCount: 0,
  inbound: [],
  alongside: [{ callId: 48, vcn: 'INNSA1NF0S0776', viaNo: 'S0776',
                vesselName: 'TSS AMBER', berthId: 2, latestEvent: 'ARRIVED',
                imoNo: '9241918', status: 'At Berth', arrivalState: 'Completed',
                pilotState: 'Completed', berthState: 'Occupied',
                departureState: 'Pending', shippingState: 'In Port',
                portcraftState: 'Busy', latestEventTime: 1785081240000,
                movementPhase: 'Alongside' }],
  outbound: [],
  activeCalls: 1230,
};

describe('<PortCraftOverview>', () => {
  beforeEach(() => fetchDemand.mockReset());

  it('renders the existing board when the demand endpoint does not answer', async () => {
    fetchDemand.mockResolvedValue(null);
    render(<PortCraftOverview />);
    expect(await screen.findByText('craft-board')).toBeTruthy();
    // Nothing from the strip — the tab is byte-for-byte what it was before.
    expect(screen.queryByText('Fleet')).toBeNull();
    expect(screen.queryByText('Alongside')).toBeNull();
  });

  // NOTE: there is deliberately no "fetch rejects" case here. fetchPortCraftDemand catches
  // internally and resolves to null — asserted twice in portCraftState.test.ts (transport
  // failure and HTTP 500). A test that forces the mock to reject would be asserting a state
  // the real connector cannot reach, and the null case above already covers what the
  // component does about it.

  // Overview is KPI-only now: the per-vessel table moved to its own tab.
  it('holds the KPI surfaces and NOT the operational table', async () => {
    fetchDemand.mockResolvedValue(DEMAND);
    const { container } = render(<PortCraftOverview />);
    await screen.findByText('Fleet');
    const text = container.textContent ?? '';
    expect(text.indexOf('Fleet')).toBeLessThan(text.indexOf('craft-board'));
    expect(text).toContain('Awaiting Berthing');
    // The operational TABLE lives on its own tab. The caption may NAME that tab — what
    // must be absent is the table itself, so assert on structure, not on the words.
    expect(container.querySelector('table')).toBeNull();
    expect(text).not.toContain('Next Expected Stage');
    expect(text).not.toContain('Latest Event');
  });

  // No vessel is rendered twice in the module: the summary reports counts only.
  it('the summary shows counts without listing vessels', async () => {
    fetchDemand.mockResolvedValue(DEMAND);
    const { container } = render(<PortCraftOverview />);
    await screen.findByLabelText('At Berth');
    expect(screen.getByText('536')).toBeTruthy();
    expect(container.textContent).not.toContain('TSS AMBER');
  });

  // Operator-facing names for the SAME three backend phases. The counts are the phase
  // counts verbatim — renaming a label must never change a number.
  it('labels the three phases in operator language, values unchanged', async () => {
    fetchDemand.mockResolvedValue(DEMAND);
    render(<PortCraftOverview />);
    await screen.findByLabelText('At Berth');
    expect(screen.getByLabelText('Awaiting Berthing').textContent).toContain('25');
    expect(screen.getByLabelText('At Berth').textContent).toContain('536');
    expect(screen.getByLabelText('Preparing Departure').textContent).toContain('0');
    expect(screen.getByLabelText('Requiring marine support').textContent).toContain('561');
  });

  // The KPI card idiom shared with MarineStatCards / ShippingLinesSummaryCards /
  // BerthingStats — one `app-region` card per metric.
  it('uses the shared KPI card markup', async () => {
    fetchDemand.mockResolvedValue(DEMAND);
    const { container } = render(<PortCraftOverview />);
    await screen.findByLabelText('At Berth');
    expect(container.querySelectorAll('.app-region').length).toBe(4);
  });

  it('renders fleet capacity and demand counts above the board', async () => {
    fetchDemand.mockResolvedValue(DEMAND);
    render(<PortCraftOverview />);
    await screen.findByText('Fleet');
    expect(screen.getByText('18')).toBeTruthy();
    expect(screen.getByText('Tug')).toBeTruthy();
    expect(screen.getByText('536')).toBeTruthy();
    // The board is still there — the strip is additive, not a replacement.
    expect(screen.getByText('craft-board')).toBeTruthy();
  });






  it('states that this is demand, not craft engaged', async () => {
    fetchDemand.mockResolvedValue(DEMAND);
    render(<PortCraftOverview />);
    const note = await screen.findByText(/not the number of craft engaged/i);
    expect(note.textContent).toMatch(/assignment is not recorded/i);
  });

});
