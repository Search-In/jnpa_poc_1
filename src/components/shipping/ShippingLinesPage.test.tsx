/**
 * <ShippingLinesPage> — five-tab structure and the post-import refresh fan-out.
 *
 * The load-bearing assertions are in the last describe: ONE successful import must
 * refresh EVERY read surface, because one import can change all of them (the ledger
 * gains a file, the registry may gain carrier codes, the document tables gain rows).
 * Overview / Carrier Registry / Advance Lists / Delivery Orders are remounted via
 * `key`; Data Upload's ledger takes the counter as a prop. Keying only some of them
 * would leave the rest silently stale — the regression this file exists to catch.
 *
 * Leaf panes are stubbed (each has its own coverage, and mounting them for real would
 * drag in the UC-3 transport). Calcite tab primitives are stubbed to mirror their real
 * behaviour: every pane stays mounted, only `selected` moves.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

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

vi.mock('@/components/shipping/ShippingLinesOverview', () => ({
  ShippingLinesOverview: () => <div data-testid="overview">overview</div>,
}));
vi.mock('@/components/shipping/ShippingLinesRegistry', () => ({
  ShippingLinesRegistry: () => <div data-testid="registry">registry</div>,
}));
vi.mock('@/components/shipping/ShippingLinesAdvanceListsTab', () => ({
  ShippingLinesAdvanceListsTab: () => <div data-testid="advance">advance</div>,
}));
vi.mock('@/components/shipping/ShippingLinesDeliveryOrdersTab', () => ({
  ShippingLinesDeliveryOrdersTab: () => <div data-testid="delivery">delivery</div>,
}));
vi.mock('@/components/shipping/ShippingLinesDataUpload', () => ({
  ShippingLinesDataUpload: ({ onImported, refreshKey }: {
    onImported?: (r: unknown) => void; refreshKey?: number;
  }) => (
    <div>
      <span data-testid="ledger-key">{refreshKey}</span>
      <button onClick={() => onImported?.({ status: 'SUCCESS' })}>fake-import</button>
    </div>
  ),
}));

import { ShippingLinesPage } from './ShippingLinesPage';

const tab = (name: string) => screen.getByRole('tab', { name });
const panes = () => ({
  overview: screen.getByTestId('overview'),
  registry: screen.getByTestId('registry'),
  advance: screen.getByTestId('advance'),
  delivery: screen.getByTestId('delivery'),
});

describe('ShippingLinesPage — tab structure', () => {
  it('shows all five tabs in order', () => {
    render(<ShippingLinesPage />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
      'Overview', 'Carrier Registry', 'Advance Lists', 'Delivery Orders', 'Data Upload',
    ]);
  });

  it('opens on Overview by default', () => {
    render(<ShippingLinesPage />);
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
    for (const name of ['Carrier Registry', 'Advance Lists', 'Delivery Orders', 'Data Upload']) {
      expect(tab(name)).toHaveAttribute('aria-selected', 'false');
    }
  });

  it('switches to each tab', () => {
    render(<ShippingLinesPage />);
    for (const name of ['Carrier Registry', 'Advance Lists', 'Delivery Orders', 'Data Upload', 'Overview']) {
      fireEvent.click(tab(name));
      expect(tab(name)).toHaveAttribute('aria-selected', 'true');
    }
  });

  it('keeps every pane mounted across a tab switch', () => {
    render(<ShippingLinesPage />);
    fireEvent.click(tab('Data Upload'));
    const p = panes();
    expect(p.overview).toBeInTheDocument();
    expect(p.registry).toBeInTheDocument();
    expect(p.advance).toBeInTheDocument();
    expect(p.delivery).toBeInTheDocument();
  });
});

describe('ShippingLinesPage — post-import refresh fan-out', () => {
  it('remounts ALL FOUR read tabs on a successful import', () => {
    render(<ShippingLinesPage />);
    const before = panes();

    fireEvent.click(screen.getByText('fake-import'));

    // A changed `key` forces React to build new DOM nodes. Identity comparison is the
    // observable proof of a remount, and therefore of a refetch.
    const after = panes();
    expect(after.overview).not.toBe(before.overview);
    expect(after.registry).not.toBe(before.registry);
    expect(after.advance).not.toBe(before.advance);
    expect(after.delivery).not.toBe(before.delivery);
  });

  it('advances the ledger refresh key so the import history refetches in place', () => {
    render(<ShippingLinesPage />);
    expect(screen.getByTestId('ledger-key').textContent).toBe('0');

    fireEvent.click(screen.getByText('fake-import'));
    expect(screen.getByTestId('ledger-key').textContent).toBe('1');

    fireEvent.click(screen.getByText('fake-import'));
    expect(screen.getByTestId('ledger-key').textContent).toBe('2');
  });

  it('refreshes again on a second import', () => {
    render(<ShippingLinesPage />);
    fireEvent.click(screen.getByText('fake-import'));
    const afterFirst = panes();

    fireEvent.click(screen.getByText('fake-import'));
    const afterSecond = panes();
    expect(afterSecond.overview).not.toBe(afterFirst.overview);
    expect(afterSecond.delivery).not.toBe(afterFirst.delivery);
  });
});
