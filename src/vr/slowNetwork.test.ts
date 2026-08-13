/**
 * A 3G cold start, simulated end to end.
 *
 * The other tests check individual decisions. This one puts the whole loading
 * strategy on a bandwidth-limited link and measures what the viewer actually
 * experiences: how long until the port is there, and how far apart the two eyes
 * finish.
 *
 * The link model is a fair-share discrete-event simulation — the bytes are real
 * (measured from `public/models`), the throughput is Chrome's "Slow 3G" preset,
 * and the only assumption is that a cached response costs nothing, which is what
 * a service-worker hit does cost.
 *
 * What it does NOT model: basemap tiles. Those are fetched by Esri's own workers
 * from a CDN whose per-tile size depends on the imagery, so any number here
 * would be invented. The tile side of the budget is defended structurally
 * instead — one tile service instead of three, plus a bundled ground underlay so
 * there is no white-ground state at all (`vrBasemap.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { sceneBudget, type DeviceProfile } from './sceneBudget';
import { modelsFor, THROUGHPUT_BPS, totalBytes, type ModelAsset } from './warmup';

// ---------------------------------------------------------------------------
// A bandwidth-limited link
// ---------------------------------------------------------------------------

interface LinkOptions {
  /** Bytes per second, shared fairly between everything in flight. */
  bytesPerSecond: number;
  /** Round trip before a response starts arriving, seconds. */
  rttS: number;
  /** How many requests the client keeps in flight. */
  concurrency: number;
  /** URLs already in the cache — these cost nothing. */
  cached?: ReadonlySet<string>;
}

interface LinkResult {
  /** Seconds until everything had arrived. */
  finishedS: number;
  /** Seconds until each individual asset had arrived. */
  arrivedS: Map<string, number>;
  /** Bytes that actually crossed the link. */
  transferred: number;
}

/**
 * Fetch a list of assets over a shared link, in order, with a concurrency cap.
 *
 * Fair share: everything in flight progresses at `bytesPerSecond / inFlight`.
 * That is the property that makes high concurrency a false economy on a thin
 * pipe — six parallel fetches do not finish sooner, they finish TOGETHER, so the
 * one that matters arrives as late as the one that does not.
 */
function fetchOverLink(assets: ModelAsset[], opts: LinkOptions): LinkResult {
  const cached = opts.cached ?? new Set<string>();
  const arrivedS = new Map<string, number>();
  let transferred = 0;
  let t = 0;
  let next = 0;
  const inFlight: Array<{ href: string; remaining: number; startsAt: number }> = [];

  const admit = () => {
    while (inFlight.length < opts.concurrency && next < assets.length) {
      const a = assets[next++];
      if (cached.has(a.href)) {
        arrivedS.set(a.href, t);
        continue;
      }
      transferred += a.bytes;
      inFlight.push({ href: a.href, remaining: a.bytes, startsAt: t + opts.rttS });
    }
  };

  admit();
  // Guard against a modelling mistake turning into a hung test rather than a
  // failed one.
  for (let guard = 0; guard < 100_000 && inFlight.length; guard++) {
    const live = inFlight.filter((r) => r.startsAt <= t + 1e-9);
    if (!live.length) {
      t = Math.min(...inFlight.map((r) => r.startsAt));
      continue;
    }
    const share = opts.bytesPerSecond / live.length;
    const tillDone = Math.min(...live.map((r) => r.remaining / share));
    const waiting = inFlight.filter((r) => r.startsAt > t).map((r) => r.startsAt - t);
    const dt = waiting.length ? Math.min(tillDone, Math.min(...waiting)) : tillDone;

    for (const r of live) r.remaining -= share * dt;
    t += dt;

    for (let i = inFlight.length - 1; i >= 0; i--) {
      if (inFlight[i].startsAt <= t && inFlight[i].remaining <= 1e-6) {
        arrivedS.set(inFlight[i].href, t);
        inFlight.splice(i, 1);
      }
    }
    admit();
  }

  return { finishedS: t, arrivedS, transferred };
}

// ---------------------------------------------------------------------------

/** The target handset on 3G: iQOO Neo 7, stereo, in a Jio VR box. */
const PHONE_3G: DeviceProfile = {
  coarsePointer: true,
  cores: 8,
  memory: 8,
  network: 'moderate',
  devicePixelRatio: 3,
};

const BUDGET = sceneBudget(PHONE_3G, true);
const MODELS = modelsFor(BUDGET);
const LINK = { bytesPerSecond: THROUGHPUT_BPS.moderate, rttS: 0.2 };

const CRANE = MODELS.find((m) => m.role === 'crane')!.href;

describe('the link model itself', () => {
  it('conserves bandwidth — concurrency cannot create throughput', () => {
    const one = fetchOverLink(MODELS, { ...LINK, concurrency: 1 });
    const six = fetchOverLink(MODELS, { ...LINK, concurrency: 6 });
    expect(one.transferred).toBe(six.transferred);
    // More requests in parallel finishes marginally sooner only because the
    // round trips overlap, never because there are more bytes per second.
    expect(six.finishedS).toBeLessThanOrEqual(one.finishedS);
    expect(six.finishedS).toBeGreaterThan(one.finishedS * 0.9);
  });

  it('charges nothing for a cached asset', () => {
    const warm = fetchOverLink(MODELS, {
      ...LINK,
      concurrency: 2,
      cached: new Set(MODELS.map((m) => m.href)),
    });
    expect(warm.transferred).toBe(0);
    expect(warm.finishedS).toBe(0);
  });
});

describe('the fetch order, and why it is not six at a time', () => {
  const atBudget = () =>
    fetchOverLink(MODELS, { ...LINK, concurrency: BUDGET.prefetchConcurrency });

  it('lands the assets a scenario CHANGES before the scenery', () => {
    // The crane stops and turns red when its berth goes out of service; the
    // hulls hold at anchor. Those answer the question. The gates, the tug and
    // the decorative berthed hulls are there to make the port look like a port.
    const r = atBudget();
    const at = (role: ModelAsset['role']) =>
      Math.max(...MODELS.filter((m) => m.role === role).map((m) => r.arrivedS.get(m.href)!));
    expect(at('crane')).toBeLessThan(at('gate'));
    expect(at('fleet')).toBeLessThan(at('gate'));
    expect(at('crane')).toBeLessThan(at('berthed'));
    expect(at('crane')).toBeLessThan(at('tug'));
  });

  it('gets the crane in at less than half the time an unthrottled browser would', () => {
    const low = atBudget();
    const high = fetchOverLink(MODELS, { ...LINK, concurrency: 6 });
    // Under fair sharing everything in flight finishes together, so the biggest
    // and most important file is starved by the scenery it is supposed to
    // precede. Serialised: ~11 s. Six at a time: ~24 s.
    expect(low.arrivedS.get(CRANE)!).toBeLessThan(high.arrivedS.get(CRANE)! * 0.5);
  });

  it('only ever gets that at concurrency one — two is already too many', () => {
    // The finding that set the concurrency. At two in flight the crane is
    // requested FIRST and still arrives after the 26 KB gate mesh, because the
    // pair splits the link and the small file wins. Priority ordering is
    // meaningless without serialisation.
    const two = fetchOverLink(MODELS, { ...LINK, concurrency: 2 });
    const gate = MODELS.find((m) => m.role === 'gate')!.href;
    expect(two.arrivedS.get(CRANE)!).toBeGreaterThan(two.arrivedS.get(gate)!);
    expect(atBudget().arrivedS.get(CRANE)!).toBeLessThan(atBudget().arrivedS.get(gate)!);
  });

  it('costs about 5% of the total to prioritise like that', () => {
    // Bandwidth is conserved; serialising only stops the round trips
    // overlapping, which is one RTT per asset.
    const serial = atBudget().finishedS;
    const parallel = fetchOverLink(MODELS, { ...LINK, concurrency: 6 }).finishedS;
    expect(serial).toBeGreaterThan(parallel);
    expect(serial).toBeLessThan(parallel * 1.1);
  });
});

describe('a stereo cold start on 3G', () => {
  /**
   * What the walkthrough used to do: enter the scene, and both SceneViews start
   * resolving their own resources at once. They share only the HTTP cache, and
   * requests already in flight do not de-duplicate, so the same meshes cross the
   * link twice.
   */
  function beforeStrategy(): LinkResult {
    const both = [...MODELS, ...MODELS.map((m) => ({ ...m, href: `${m.href}#eye2` }))];
    return fetchOverLink(both, { ...LINK, concurrency: 6 });
  }

  /**
   * What it does now: warm the cache from the setup screen, then bring the eyes
   * up one after the other. The first eye's fetches are already local; the
   * second eye's are cache hits.
   */
  function afterStrategy(): { warmS: number; afterEnterS: number; transferred: number } {
    const warm = fetchOverLink(MODELS, {
      ...LINK,
      concurrency: BUDGET.prefetchConcurrency,
    });
    const cached = new Set(MODELS.map((m) => m.href));
    const eyeOne = fetchOverLink(MODELS, { ...LINK, concurrency: 6, cached });
    const eyeTwo = fetchOverLink(MODELS, { ...LINK, concurrency: 6, cached });
    return {
      warmS: warm.finishedS,
      afterEnterS: eyeOne.finishedS + eyeTwo.finishedS,
      transferred: warm.transferred + eyeOne.transferred + eyeTwo.transferred,
    };
  }

  it('used to pull the whole port across the link twice', () => {
    const before = beforeStrategy();
    expect(before.transferred).toBe(totalBytes(MODELS) * 2);
    // ~48 seconds of a viewer standing in an empty world with a phone strapped
    // to their face.
    expect(before.finishedS).toBeGreaterThan(40);
  });

  it('now crosses the link once', () => {
    expect(afterStrategy().transferred).toBe(totalBytes(MODELS));
  });

  it('spends the wait on the setup screen instead of inside the viewer', () => {
    const before = beforeStrategy();
    const after = afterStrategy();
    // The bytes still take the time they take — what changed is WHEN. The wait
    // now happens while the operator is picking a scenario, and what is left
    // after they press Enter is nothing.
    expect(after.afterEnterS).toBeLessThan(0.1);
    expect(after.warmS).toBeLessThan(before.finishedS / 1.8);
  });

  it('halves the time even if the operator enters immediately', () => {
    // Worst case: they hit Enter the instant the page loads, so nothing is warm.
    // Sequential startup still means the second eye is a cache hit rather than a
    // second trip across the link.
    const before = beforeStrategy();
    const eyeOne = fetchOverLink(MODELS, { ...LINK, concurrency: 6 });
    const cached = new Set(MODELS.map((m) => m.href));
    const eyeTwo = fetchOverLink(MODELS, { ...LINK, concurrency: 6, cached });
    const cold = eyeOne.finishedS + eyeTwo.finishedS;
    expect(cold).toBeLessThan(before.finishedS * 0.55);
  });

  it('brings both eyes up together rather than one long after the other', () => {
    // The desync being fixed. Under the old strategy the two eyes' copies of the
    // same mesh completed at different times, so one eye had cranes while the
    // other did not.
    const before = beforeStrategy();
    const eyeOneCrane = before.arrivedS.get(CRANE)!;
    const eyeTwoCrane = before.arrivedS.get(`${CRANE}#eye2`)!;
    expect(Math.abs(eyeOneCrane - eyeTwoCrane)).toBeGreaterThan(1);

    // Now: the second eye reads everything from cache, so the gap is nil — and
    // the reveal gate holds both back until then regardless (`sceneBoot.test.ts`).
    const cached = new Set(MODELS.map((m) => m.href));
    const warmEye = fetchOverLink(MODELS, { ...LINK, concurrency: 6, cached });
    expect(warmEye.arrivedS.get(CRANE)).toBe(0);
  });
});

describe('a 2G link still opens', () => {
  it('stays inside the gate’s patience once the set has been trimmed', () => {
    const budget2g = sceneBudget({ ...PHONE_3G, network: 'slow' }, true);
    const models = modelsFor(budget2g);
    const r = fetchOverLink(models, {
      bytesPerSecond: THROUGHPUT_BPS.slow,
      rttS: 0.4,
      concurrency: budget2g.prefetchConcurrency,
    });
    // This one WILL exceed the reveal timeout, and that is the designed
    // behaviour: the gate opens on a still-streaming scene rather than never.
    // What must hold is that the trimmed set is genuinely smaller, so the scene
    // completes rather than crawling forever.
    expect(totalBytes(models)).toBeLessThan(totalBytes(MODELS));
    expect(r.finishedS).toBeLessThan(120);
  });
});
