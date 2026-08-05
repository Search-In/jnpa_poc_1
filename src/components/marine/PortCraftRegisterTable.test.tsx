/**
 * <PortCraftRegisterTable> — Fleet Register filters + pager.
 *
 * Covers the operational filters on the Fleet Register tab: the search box (craft
 * name OR owner name — the combination the gateway cannot express, see the component
 * header), the craft-type and ownership dropdowns, the dropdown options being derived
 * from the COMPLETE register, and client-side paging.
 *
 * The connector is stubbed, so no transport, no token and no gateway are involved —
 * the API contract is exercised only in src/data/uc3/portCraft.test.ts, which is
 * unchanged. Calcite web components are stubbed because jsdom does not upgrade them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { PortCraft } from '@/types/domain';

vi.mock('@esri/calcite-components-react', () => ({
  CalciteInput: ({ placeholder, value, onCalciteInputChange }: {
    placeholder?: string; value?: string;
    onCalciteInputChange?: (e: { target: { value: string } }) => void;
  }) => (
    <input
      aria-label={placeholder}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onCalciteInputChange?.({ target: { value: e.target.value } })}
    />
  ),
  CalciteLoader: ({ label }: { label?: string }) => <div>{label}</div>,
  CalciteNotice: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@/data/uc3/portCraft', () => ({ fetchPortCraftPage: vi.fn() }));

import { fetchPortCraftPage } from '@/data/uc3/portCraft';
import { PortCraftRegisterTable } from './PortCraftRegisterTable';

const craft = (craftId: number, name: string, craftType: string, ownedOrHired: string, ownerName: string): PortCraft => ({
  craftId, name, craftType, ownedOrHired, ownerName,
  yearBuilt: 'Apr-18', loaM: 30.31, breadthM: 12, draftM: 4.3,
  mainEngines: '2 x NIGATA', bollardPullT: 50, designSpeedKn: 12, extras: {},
});

/** 12 craft so PAGE_SIZE (10) actually pages. */
const REGISTER: PortCraft[] = [
  craft(1, 'Ocean Divine', 'Tug', 'Hired', 'M/s Ocean Sparkle Ltd.'),
  craft(2, 'Ocean Freedom', 'Tug', 'Hired', 'M/s Ocean Sparkle Ltd.'),
  craft(3, 'Jal Sarathi', 'Pilot Launch', 'Owned', 'JNPA'),
  craft(4, 'Jal Doot', 'Pilot Launch', 'Owned', 'JNPA'),
  craft(5, 'Sagar Pradeep', 'Launch', 'Owned', 'JNPA'),
  craft(6, 'Sagar Deep', 'Launch', 'Owned', 'JNPA'),
  craft(7, 'Vishwakarma', 'Tug', 'Owned', 'JNPA'),
  craft(8, 'Bhagirathi', 'Tug', 'Owned', 'JNPA'),
  craft(9, 'Ganga', 'Launch', 'Hired', 'M/s Coastal Marine'),
  craft(10, 'Yamuna', 'Launch', 'Hired', 'M/s Coastal Marine'),
  craft(11, 'Narmada', 'VIP Launch', 'Owned', 'JNPA'),
  craft(12, 'Kaveri', 'VIP Launch', 'Owned', 'JNPA'),
];

const mocked = vi.mocked(fetchPortCraftPage);

/** Body rows currently rendered (excludes the sticky header row). */
async function bodyRows(): Promise<HTMLElement[]> {
  const table = await screen.findByRole('table');
  return within(table).getAllByRole('row').slice(1);
}

function names(rows: HTMLElement[]): string[] {
  return rows.map((r) => within(r).getAllByRole('cell')[0].textContent ?? '');
}

beforeEach(() => {
  mocked.mockReset();
  mocked.mockResolvedValue({ items: REGISTER, total: REGISTER.length, limit: 500, offset: 0 });
});

describe('PortCraftRegisterTable — data path', () => {
  it('reads the register once, unfiltered, through the existing connector', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked).toHaveBeenCalledWith({ sort: 'name', direction: 'asc' }, 500, 0);
  });

  it('keeps every existing column', async () => {
    /* The guarantee is that no particular was DROPPED — the register is the fleet's
       reference data and losing a column silently would be the regression worth catching.
       Additions are allowed and asserted separately below. */
    render(<PortCraftRegisterTable />);
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    for (const col of ['Name', 'Type', 'Owned/Hired', 'Owner', 'Year Built', 'LOA',
                       'Breadth', 'Draft', 'Engines', 'Bollard Pull', 'Speed']) {
      expect(headers).toContain(col);
    }
  });

  it('adds a live Status column sourced from craft assignments', async () => {
    /* Availability is a fact about NOW, so it comes from core.manual_craft_assignment —
       never derived from the register's static particulars. */
    render(<PortCraftRegisterTable />);
    const table = await screen.findByRole('table');
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toContain('Status');
    expect(headers.indexOf('Status')).toBe(1); // beside the name, where an operator looks
  });

  it('shows the register-empty hint when nothing has been uploaded', async () => {
    mocked.mockResolvedValue({ items: [], total: 0, limit: 500, offset: 0 });
    render(<PortCraftRegisterTable />);
    expect(await screen.findByText(/No port-craft register yet/)).toBeInTheDocument();
  });
});

describe('PortCraftRegisterTable — search', () => {
  it('matches craft name', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Search craft name / owner…'), { target: { value: 'sagar' } });
    expect(names(await bodyRows())).toEqual(['Sagar Pradeep', 'Sagar Deep']);
  });

  it('matches OWNER name — the case the gateway cannot AND together', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Search craft name / owner…'), { target: { value: 'coastal' } });
    expect(names(await bodyRows())).toEqual(['Ganga', 'Yamuna']);
  });

  it('does NOT match craft type — that has its own dropdown', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Search craft name / owner…'), { target: { value: 'vip' } });
    expect(await screen.findByText(/No craft match the current search or filters/)).toBeInTheDocument();
  });

  it('is case-insensitive and reports no match without erroring', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Search craft name / owner…'), { target: { value: 'ZZZ' } });
    expect(await screen.findByText(/No craft match the current search or filters/)).toBeInTheDocument();
  });

  it('never refetches — filtering is in memory', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Search craft name / owner…'), { target: { value: 'ocean' } });
    fireEvent.change(screen.getByLabelText('Filter by craft type'), { target: { value: 'Tug' } });
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});

describe('PortCraftRegisterTable — dropdown filters', () => {
  it('derives craft-type options from the complete register', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    const select = screen.getByLabelText('Filter by craft type');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All types', 'Tug', 'Pilot Launch', 'Launch', 'VIP Launch',
    ]);
  });

  it('derives ownership options from the complete register', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    const select = screen.getByLabelText('Filter by ownership');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All ownership', 'Hired', 'Owned',
    ]);
  });

  it('filters by craft type', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Filter by craft type'), { target: { value: 'Tug' } });
    expect(names(await bodyRows())).toEqual(['Ocean Divine', 'Ocean Freedom', 'Vishwakarma', 'Bhagirathi']);
  });

  it('filters by ownership', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Filter by ownership'), { target: { value: 'Hired' } });
    expect(names(await bodyRows())).toEqual(['Ocean Divine', 'Ocean Freedom', 'Ganga', 'Yamuna']);
  });

  it('ANDs the two dropdowns with the search box', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText('Filter by craft type'), { target: { value: 'Tug' } });
    fireEvent.change(screen.getByLabelText('Filter by ownership'), { target: { value: 'Owned' } });
    expect(names(await bodyRows())).toEqual(['Vishwakarma', 'Bhagirathi']);
  });

  it('does not collapse the type options once a type is selected', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    const select = screen.getByLabelText('Filter by craft type');
    fireEvent.change(select, { target: { value: 'Tug' } });
    expect(within(select).getAllByRole('option')).toHaveLength(5);
  });
});

describe('PortCraftRegisterTable — pager', () => {
  it('pages at 10 rows and reaches the tail', async () => {
    render(<PortCraftRegisterTable />);
    expect(await bodyRows()).toHaveLength(10);
    expect(screen.getByText('‹ Prev')).toBeDisabled();

    fireEvent.click(screen.getByText('Next ›'));
    expect(names(await bodyRows())).toEqual(['Narmada', 'Kaveri']);
    expect(screen.getByText('Next ›')).toBeDisabled();

    fireEvent.click(screen.getByText('‹ Prev'));
    expect(await bodyRows()).toHaveLength(10);
  });

  it('resets to the first page when a filter changes', async () => {
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    fireEvent.click(screen.getByText('Next ›'));
    fireEvent.change(screen.getByLabelText('Filter by craft type'), { target: { value: 'Tug' } });
    expect(names(await bodyRows())).toEqual(['Ocean Divine', 'Ocean Freedom', 'Vishwakarma', 'Bhagirathi']);
  });

  it('states the shortfall when the gateway holds more than one page', async () => {
    mocked.mockResolvedValue({ items: REGISTER, total: 600, limit: 500, offset: 0 });
    render(<PortCraftRegisterTable />);
    await screen.findByRole('table');
    expect(await screen.findByText(/588 more on the server/)).toBeInTheDocument();
  });
});
