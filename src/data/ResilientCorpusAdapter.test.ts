/**
 * The fallback must be per-read and announced. A single failing endpoint used to
 * flip one sticky flag that routed EVERY later read to the mock for the rest of
 * the session — one 500 on /marine/vessel-states silently turned the tide table,
 * the KPI wall and the craft roster synthetic while their badges still read LIVE.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const corpus = {
  getBerths: vi.fn(),
  getTideStations: vi.fn(),
  getPortCraft: vi.fn(),
  getKPIs: vi.fn(),
};
const mock = {
  getBerths: vi.fn(),
  getTideStations: vi.fn(),
  getPortCraft: vi.fn(),
  getKPIs: vi.fn(),
};

vi.mock('./Uc3Adapter', () => ({ Uc3Adapter: vi.fn(() => corpus) }));
vi.mock('./MockAdapter', () => ({ MockAdapter: vi.fn(() => mock) }));

const { ResilientCorpusAdapter } = await import('./ResilientCorpusAdapter');
const { useDataModeStore } = await import('@/provenance/useDataModeStore');

describe('ResilientCorpusAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDataModeStore.getState().resetAll();
    corpus.getBerths.mockResolvedValue('corpus-berths');
    corpus.getTideStations.mockResolvedValue('corpus-tide');
    corpus.getPortCraft.mockResolvedValue('corpus-craft');
    corpus.getKPIs.mockResolvedValue('corpus-kpis');
    mock.getBerths.mockResolvedValue('mock-berths');
    mock.getTideStations.mockResolvedValue('mock-tide');
    mock.getPortCraft.mockResolvedValue('mock-craft');
    mock.getKPIs.mockResolvedValue('mock-kpis');
  });

  it('serves the corpus when it answers', async () => {
    const a = new ResilientCorpusAdapter();
    expect(await a.getTideStations()).toBe('corpus-tide');
    expect(mock.getTideStations).not.toHaveBeenCalled();
  });

  it('does NOT take healthy reads down with a failing one', async () => {
    const a = new ResilientCorpusAdapter();
    corpus.getKPIs.mockRejectedValue(new Error('[UC3] /marine/vessel-states → HTTP 500'));

    expect(await a.getKPIs()).toBe('mock-kpis');
    // The exact regression: tide + craft must still come from the corpus.
    expect(await a.getTideStations()).toBe('corpus-tide');
    expect(await a.getPortCraft()).toBe('corpus-craft');
    expect(await a.getBerths()).toBe('corpus-berths');
  });

  it("announces a fallback on that read's own source, not globally", async () => {
    const a = new ResilientCorpusAdapter();
    corpus.getTideStations.mockRejectedValue(new Error('gateway down'));

    expect(await a.getTideStations()).toBe('mock-tide');
    const { sources } = useDataModeStore.getState();
    expect(sources.TIDE.state).toBe('IMPUTED');
    // Feeds that never failed stay LIVE.
    expect(sources.CRAFT.state).toBe('LIVE');
    expect(sources.BERTH_PLAN.state).toBe('LIVE');
  });

  it('writes one audit entry naming the failed read', async () => {
    const a = new ResilientCorpusAdapter();
    corpus.getPortCraft.mockRejectedValue(new Error('boom'));
    await a.getPortCraft();

    const entry = useDataModeStore.getState().audit.find((e) => e.source === 'CRAFT');
    expect(entry?.to).toBe('IMPUTED');
    expect(entry?.note).toContain('portCraft');
  });

  it('keeps serving the mock during the cooldown, then retries and recovers', async () => {
    const a = new ResilientCorpusAdapter();
    let clock = 1_000_000;
    // The adapter reads wall time through a seam so the cooldown is testable.
    vi.spyOn(a as unknown as { now: () => number }, 'now').mockImplementation(() => clock);

    corpus.getTideStations.mockRejectedValue(new Error('gateway down'));
    expect(await a.getTideStations()).toBe('mock-tide');

    // Inside the cooldown: no second call against a gateway known to be down.
    corpus.getTideStations.mockClear();
    clock += 30_000;
    expect(await a.getTideStations()).toBe('mock-tide');
    expect(corpus.getTideStations).not.toHaveBeenCalled();

    // Past it: retried, and a healthy gateway is reported as recovered.
    clock += 40_000;
    corpus.getTideStations.mockResolvedValue('corpus-tide');
    expect(await a.getTideStations()).toBe('corpus-tide');
    expect(useDataModeStore.getState().sources.TIDE.state).toBe('LIVE');
    expect(useDataModeStore.getState().audit[0].recovery).toBe(true);
  });
});
