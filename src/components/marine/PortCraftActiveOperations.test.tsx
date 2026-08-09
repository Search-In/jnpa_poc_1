/**
 * <PortCraftActiveOperations> — the single vessel-detail surface on the Port Craft tab.
 *
 * Under test: the nine columns render backend values (never raw ids or field names), the
 * three filters compose, and the section degrades to nothing when the gateway is down —
 * so it can never break the tab it was added to.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { CraftMovement, PortCraftDemand } from '@/data/uc3/portCraftState';

// Same stub set as PortCraftRegisterTable.test.tsx: real Calcite web components are not
// registered in jsdom, so the three this table renders through are replaced with plain DOM.
vi.mock('@esri/calcite-components-react', () => ({
  CalciteInput: ({ placeholder, value, onCalciteInputChange }: {
    placeholder?: string; value?: string;
    onCalciteInputChange?: (e: { target: { value: string } }) => void;
  }) => (
    <input
      aria-label="Search vessel"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onCalciteInputChange?.({ target: { value: e.target.value } })}
    />
  ),
  CalciteLoader: ({ label }: { label?: string }) => <div>{label}</div>,
  CalciteNotice: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const fetchDemand = vi.fn();
const fetchBerths = vi.fn();
vi.mock('@/data/uc3/portCraftState', () => ({
  fetchPortCraftDemand: () => fetchDemand(),
  fetchBerthCodes: () => fetchBerths(),
}));

import { PortCraftActiveOperations } from './PortCraftActiveOperations';

const mv = (o: Partial<CraftMovement>): CraftMovement => ({
  callId: 1, vcn: '', viaNo: '', vesselName: '', berthId: null, latestEvent: '',
  imoNo: '', status: '', arrivalState: '', pilotState: '', berthState: '',
  departureState: '', shippingState: '', portcraftState: 'Busy',
  latestEventTime: 0, movementPhase: '', ...o,
});

const AMBER = mv({
  callId: 48, vcn: 'INNSA1NF0S0776', viaNo: 'S0776', vesselName: 'TSS AMBER',
  berthId: 2, latestEvent: 'ARRIVED', imoNo: '9241918', status: 'At Berth',
  arrivalState: 'Completed', pilotState: 'Completed', berthState: 'Occupied',
  departureState: 'Pending', shippingState: 'In Port', portcraftState: 'Busy',
  latestEventTime: Date.parse('2026-07-29T15:54:00Z'), movementPhase: 'Alongside',
});
const INBOUND = mv({
  callId: 310, viaNo: 'S0874', vesselName: 'BLOSSOM', status: 'Pilot Boarded',
  pilotState: 'Active', berthState: 'Allotted', latestEvent: 'PILOT_BOARDED',
  movementPhase: 'Inbound', berthId: 9,
});

const DEMAND: PortCraftDemand = {
  fleetTotal: 18, fleetByType: [], totalDemand: 2,
  inboundCount: 1, alongsideCount: 1, outboundCount: 0,
  inbound: [INBOUND], alongside: [AMBER], outbound: [], activeCalls: 1230,
};

const row = (vessel: string) =>
  screen.getByText(vessel).closest('tr') as HTMLTableRowElement;

describe('<PortCraftActiveOperations>', () => {
  beforeEach(() => {
    fetchDemand.mockReset();
    fetchBerths.mockReset();
    fetchBerths.mockResolvedValue(new Map([[2, 'CB02'], [9, 'NSD03']]));
  });

  // As a section inside Overview this rendered null and let the board stand. As its own
  // tab a blank pane would just look broken, so it states the outage — the same idiom
  // <PortCraftRegisterTable> uses. The filters stay usable either way.
  it('states the outage when the gateway does not answer', async () => {
    fetchDemand.mockResolvedValue(null);
    render(<PortCraftActiveOperations />);
    expect(await screen.findByText(/state service did not respond/i)).toBeTruthy();
    expect(screen.getByLabelText('Search vessel')).toBeTruthy();
  });

  it('answers the four operator questions on one row', async () => {
    fetchDemand.mockResolvedValue(DEMAND);
    render(<PortCraftActiveOperations />);
    await screen.findByText('TSS AMBER');
    const r = within(row('TSS AMBER'));
    expect(r.getByText('INNSA1NF0S0776')).toBeTruthy();          // which vessel
    expect(r.getByText('Currently Berthed')).toBeTruthy();       // which stage
    expect(r.getByText('Requires marine support')).toBeTruthy(); // why it is here
    expect(r.getByText('Departure')).toBeTruthy();               // what happens next
    expect(r.getByText('Pilot Operation Completed')).toBeTruthy();
    expect(r.getByText('ARRIVED')).toBeTruthy();
  });

  it('shows the berth CODE, never the raw numeric id', async () => {
    fetchDemand.mockResolvedValue(DEMAND);
    render(<PortCraftActiveOperations />);
    await screen.findByText('TSS AMBER');
    expect(within(row('TSS AMBER')).getByText('CB02')).toBeTruthy();
    expect(row('TSS AMBER').textContent).not.toMatch(/\b2\b(?!\d)/);
  });

  // The berth lookup is a convenience over a second endpoint; losing it must not blank
  // the column, so it falls back to the berth STATE the row already carries.
  it('falls back to the berth state when the code cannot be resolved', async () => {
    fetchBerths.mockResolvedValue(new Map());
    fetchDemand.mockResolvedValue(DEMAND);
    render(<PortCraftActiveOperations />);
    await screen.findByText('TSS AMBER');
    expect(within(row('TSS AMBER')).getByText('Currently Berthed', { selector: 'td' }))
      .toBeTruthy();
  });

  it('derives the next stage from the engine ladder only', async () => {
    fetchDemand.mockResolvedValue(DEMAND);
    render(<PortCraftActiveOperations />);
    await screen.findByText('BLOSSOM');
    expect(within(row('BLOSSOM')).getByText('Berthing')).toBeTruthy();   // Pilot Boarded →
    expect(within(row('TSS AMBER')).getByText('Departure')).toBeTruthy(); // At Berth →
  });

  it('leaves the next stage blank when the ladder has no successor', async () => {
    fetchDemand.mockResolvedValue({
      ...DEMAND, alongside: [mv({ callId: 7, vesselName: 'UNKNOWN', status: 'Quarantined' })],
    });
    render(<PortCraftActiveOperations />);
    await screen.findByText('UNKNOWN');
    // Falls through as the raw stage, but the NEXT column stays empty rather than echoing it.
    const cells = within(row('UNKNOWN')).getAllByRole('cell');
    expect(cells[cells.length - 1].textContent).toBe('—');
  });

  describe('filters', () => {
    beforeEach(() => fetchDemand.mockResolvedValue(DEMAND));

    it('searches by vessel, VCN or VIA', async () => {
      render(<PortCraftActiveOperations />);
      await screen.findByText('TSS AMBER');
      fireEvent.change(screen.getByLabelText('Search vessel'), { target: { value: 'amber' } });
      await waitFor(() => expect(screen.queryByText('BLOSSOM')).toBeNull());
      expect(screen.getByText('TSS AMBER')).toBeTruthy();

      fireEvent.change(screen.getByLabelText('Search vessel'), { target: { value: 'S0874' } });
      await waitFor(() => expect(screen.getByText('BLOSSOM')).toBeTruthy());
      expect(screen.queryByText('TSS AMBER')).toBeNull();
    });

    it('filters by movement', async () => {
      render(<PortCraftActiveOperations />);
      await screen.findByText('TSS AMBER');
      fireEvent.change(screen.getByLabelText('Filter by movement'), { target: { value: 'Inbound' } });
      await waitFor(() => expect(screen.queryByText('TSS AMBER')).toBeNull());
      expect(screen.getByText('BLOSSOM')).toBeTruthy();
    });

    it('filters by status', async () => {
      render(<PortCraftActiveOperations />);
      await screen.findByText('TSS AMBER');
      fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'Busy' } });
      await waitFor(() => expect(screen.getByText('TSS AMBER')).toBeTruthy());
    });

    // Every vessel on this list requires support by construction, so Idle and Completed
    // are legitimately empty. The message must explain that, not read as a broken table.
    it('explains why Idle and Completed are empty rather than showing a blank table', async () => {
      render(<PortCraftActiveOperations />);
      await screen.findByText('TSS AMBER');
      fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'Idle' } });
      await waitFor(() => expect(screen.queryByText('TSS AMBER')).toBeNull());
      expect(screen.getByText(/only while it requires marine support/i)).toBeTruthy();
    });
  });

  it('uses no raw backend field names or craft assignments', async () => {
    fetchDemand.mockResolvedValue(DEMAND);
    const { container } = render(<PortCraftActiveOperations />);
    await screen.findByText('TSS AMBER');
    const text = container.textContent ?? '';
    for (const banned of ['arrival_state', 'pilot_state', 'berth_state', 'portcraft_state',
                          'movement_phase', 'latest_event', 'Tug-', 'Assigned to',
                          'Utilisation', '%']) {
      expect(text).not.toContain(banned);
    }
  });
});
