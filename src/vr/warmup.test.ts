/**
 * Model warm-up — and the byte budget the walkthrough has to arrive within.
 *
 * The transfer numbers here are the reason the feature exists at all: on a 3G
 * link the port's glTF is tens of seconds, and in stereo it used to be fetched
 * twice. These tests pin the size of the set, the order it arrives in, and the
 * fact that the concurrency limit is a BANDWIDTH decision, not a CPU one.
 */
import { describe, expect, it, vi } from 'vitest';
import { sceneBudget, type DeviceProfile } from './sceneBudget';
import { modelsFor, THROUGHPUT_BPS, totalBytes, transferSeconds, warmModels } from './warmup';

const HANDSET: DeviceProfile = {
  coarsePointer: true,
  cores: 8,
  memory: 8,
  network: 'fast',
  devicePixelRatio: 3,
};

const budgetOn = (network: DeviceProfile['network']) =>
  sceneBudget({ ...HANDSET, network }, true);

describe('the model set', () => {
  it('asks for the same URLs the renderer will, so they share a cache entry', () => {
    // A prefetch to a different string is a prefetch of nothing: the renderer
    // would miss the cache and fetch it all again.
    for (const m of modelsFor(budgetOn('fast'))) {
      expect(m.href.startsWith('/models/')).toBe(true);
      expect(m.href.endsWith('.glb')).toBe(true);
    }
  });

  it('puts the assets a what-if scenario CHANGES at the front of the queue', () => {
    const roles = modelsFor(budgetOn('moderate')).map((m) => m.role);
    // Cranes stop and turn red; hulls hold at anchor. Those are what the viewer
    // is there to see. The yard and gates are scenery — they make the port look
    // like a port but answer nothing.
    expect(roles[0]).toBe('crane');
    expect(roles[1]).toBe('fleet');
    expect(roles.indexOf('crane')).toBeLessThan(roles.indexOf('yard'));
    expect(roles.indexOf('fleet')).toBeLessThan(roles.indexOf('gate'));
  });

  it('never grows as the link gets worse', () => {
    const bytes = (['fast', 'moderate', 'slow'] as const).map((n) =>
      totalBytes(modelsFor(budgetOn(n)))
    );
    expect(bytes[1]).toBeLessThanOrEqual(bytes[0]);
    expect(bytes[2]).toBeLessThan(bytes[1]);
  });

  it('drops the truck queues on a handset regardless of the link', () => {
    // A phone is already GPU-bound before the network is considered: 25 trucks
    // in stereo is 50 extra glTF instances for scenery that carries no state.
    for (const net of ['fast', 'moderate', 'slow'] as const) {
      expect(modelsFor(budgetOn(net)).some((m) => m.role === 'truck')).toBe(false);
    }
  });

  it('drops them on a desktop too once the link is the constraint', () => {
    const desktop = (network: DeviceProfile['network']) =>
      sceneBudget(
        { coarsePointer: false, cores: 12, memory: 16, network, devicePixelRatio: 2 },
        false
      );
    expect(modelsFor(desktop('fast')).some((m) => m.role === 'truck')).toBe(true);
    expect(totalBytes(modelsFor(desktop('moderate')))).toBeLessThan(
      totalBytes(modelsFor(desktop('fast')))
    );
  });

  it('keeps the cranes, hulls and yard at every link speed', () => {
    // The set may shrink, but never past the assets that carry the answer.
    for (const net of ['fast', 'moderate', 'slow'] as const) {
      const roles = new Set(modelsFor(budgetOn(net)).map((m) => m.role));
      expect(roles.has('crane')).toBe(true);
      expect(roles.has('fleet')).toBe(true);
      expect(roles.has('yard')).toBe(true);
    }
  });
});

describe('the 3G budget', () => {
  it('is under half a minute for the whole port', () => {
    const seconds = transferSeconds(modelsFor(budgetOn('moderate')), 'moderate');
    // ~1 MB at the ~50 KB/s that Chrome's "Slow 3G" preset emulates. This is the
    // number the warm-up is spending the setup screen's dead time against — and
    // in stereo it used to be paid twice, once per view.
    expect(seconds).toBeLessThan(30);
    expect(seconds).toBeGreaterThan(5); // if this ever drops, the estimate is wrong
  });

  it('is dominated by the crane, which is why the crane goes first', () => {
    const models = modelsFor(budgetOn('moderate'));
    const crane = models.find((m) => m.role === 'crane')!;
    expect(crane.bytes / totalBytes(models)).toBeGreaterThan(0.3);
  });

  it('is a small fraction of a second on a venue connection', () => {
    expect(transferSeconds(modelsFor(budgetOn('fast')), 'fast')).toBeLessThan(3);
  });

  it('assumes pessimistic throughput, so the budget is defended not flattered', () => {
    expect(THROUGHPUT_BPS.moderate).toBeLessThanOrEqual(50_000);
    expect(THROUGHPUT_BPS.slow).toBeLessThan(THROUGHPUT_BPS.moderate);
  });
});

describe('warmModels', () => {
  it('fetches every model exactly once, in priority order', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(null, { status: 200 });
    });
    const models = modelsFor(budgetOn('slow'));
    await warmModels(models, { concurrency: 1, fetchImpl: fetchImpl as never }).finished;

    expect(seen).toEqual(models.map((m) => m.href));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('never has more than `concurrency` requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return new Response(null, { status: 200 });
    });
    await warmModels(modelsFor(budgetOn('fast')), {
      concurrency: 2,
      fetchImpl: fetchImpl as never,
    }).finished;
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it('reports progress that ends at the full set', async () => {
    const progress: number[] = [];
    const models = modelsFor(budgetOn('moderate'));
    await warmModels(models, {
      concurrency: 1,
      fetchImpl: (async () => new Response(null, { status: 200 })) as never,
      onProgress: (p) => progress.push(p.done),
    }).finished;
    expect(progress[progress.length - 1]).toBe(models.length);
  });

  it('treats a failed fetch as a slower scene, never a broken one', async () => {
    const models = modelsFor(budgetOn('slow'));
    let completed = 0;
    await warmModels(models, {
      concurrency: 2,
      fetchImpl: (async () => {
        throw new Error('offline');
      }) as never,
      onProgress: (p) => {
        completed = p.done;
      },
    }).finished;
    // The renderer will fetch these itself; the warm-up's only job was to try.
    expect(completed).toBe(models.length);
  });

  it('stops when the operator enters the scene', async () => {
    let started = 0;
    const handle = warmModels(modelsFor(budgetOn('fast')), {
      concurrency: 1,
      fetchImpl: (async () => {
        started += 1;
        await new Promise((r) => setTimeout(r, 5));
        return new Response(null, { status: 200 });
      }) as never,
    });
    await new Promise((r) => setTimeout(r, 8));
    handle.cancel();
    await handle.finished;
    const all = modelsFor(budgetOn('fast')).length;
    expect(started).toBeLessThan(all);
  });

  it('asks the cache first — these meshes are vendored and immutable', async () => {
    const init: RequestInit[] = [];
    const fetchImpl = async (_url: RequestInfo | URL, opts?: RequestInit) => {
      init.push(opts ?? {});
      return new Response(null, { status: 200 });
    };
    await warmModels(modelsFor(budgetOn('slow')).slice(0, 1), {
      fetchImpl: fetchImpl as never,
    }).finished;
    // A conditional request on a 200 ms link is a round trip spent being told
    // nothing changed.
    expect(init[0]).toMatchObject({ cache: 'force-cache' });
  });

  it('resolves immediately when there is nothing to fetch', async () => {
    await expect(warmModels([], {}).finished).resolves.toBeUndefined();
  });
});
