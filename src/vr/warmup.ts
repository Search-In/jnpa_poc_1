/**
 * Model warm-up — fetch the walkthrough's glTF assets while the operator is
 * still on the setup screen, so the immersive view opens onto a finished port
 * instead of assembling itself around them.
 *
 * THE NUMBERS THIS EXISTS FOR. The scene needs roughly 1.2 MB of glTF before it
 * reads as JNPA: `sts-crane.glb` alone is 542 KB, and the yard needs all three
 * container colours. On a 3G link (~50 KB/s) that is about 24 seconds — and in
 * stereo, with two SceneViews resolving their resources independently, it was up
 * to twice that, with the two eyes finishing at different times because they
 * were racing each other for the same pipe. That race is the reported "one side
 * renders late".
 *
 * Warming the HTTP cache first collapses both problems: the first view's fetches
 * are already local, and the second view's are cache hits, so the eyes converge
 * together. In a production build the service worker holds them, so the second
 * RUN opens instantly too.
 *
 * Fetch order is deliberate — priority first. On a thin pipe the point is not to
 * finish sooner (the bytes are the bytes) but for the assets that carry the
 * story to land first.
 */
import type { SceneBudget } from './sceneBudget';

/** Where the glTF models are served from. Must match `portAssets3d`/`sceneAnim`. */
const MODELS = '/models';

/** One model the scene will ask for, with the size it costs to get it. */
export interface ModelAsset {
  /** URL exactly as the renderer will request it — same string, same cache key. */
  href: string;
  /** Bytes on disk (`public/models`), for the transfer estimates. */
  bytes: number;
  /** Why the scene needs it — used to order the fetches. */
  role: 'crane' | 'fleet' | 'yard' | 'gate' | 'berthed' | 'tug' | 'truck';
}

/**
 * Every model the walkthrough can place, in the order it should arrive.
 *
 * Cranes and hulls first: they are the assets that CHANGE under a what-if
 * scenario (a crane stops and turns red, a hull holds at anchor), so they are
 * the ones the viewer is there to see. The yard, gates and decorative hulls are
 * scenery — they make the port look like a port, but nothing about them answers
 * the question being asked.
 */
const CATALOGUE: ModelAsset[] = [
  { href: `${MODELS}/sts-crane.glb`, bytes: 542_664, role: 'crane' },
  { href: `${MODELS}/container-ship.glb`, bytes: 203_056, role: 'fleet' },
  { href: `${MODELS}/yard-container-blue.glb`, bytes: 57_020, role: 'yard' },
  { href: `${MODELS}/yard-container-green.glb`, bytes: 71_732, role: 'yard' },
  { href: `${MODELS}/yard-container-red.glb`, bytes: 58_932, role: 'yard' },
  { href: `${MODELS}/toll-naka.glb`, bytes: 25_780, role: 'gate' },
  { href: `${MODELS}/ship-cargo-a.glb`, bytes: 106_788, role: 'berthed' },
  { href: `${MODELS}/ship-cargo-b.glb`, bytes: 88_628, role: 'berthed' },
  { href: `${MODELS}/boat-tug-a.glb`, bytes: 49_876, role: 'tug' },
  { href: `${MODELS}/truck-realistic.glb`, bytes: 326_828, role: 'truck' },
  { href: `${MODELS}/container-truck.glb`, bytes: 12_916, role: 'truck' },
];

/** The models a scene built to this budget will actually request. */
export function modelsFor(budget: Pick<SceneBudget, 'includeTrucks' | 'includeTug' | 'includeBerthedVessels'>): ModelAsset[] {
  return CATALOGUE.filter((m) => {
    if (m.role === 'truck') return budget.includeTrucks;
    if (m.role === 'tug') return budget.includeTug;
    if (m.role === 'berthed') return budget.includeBerthedVessels;
    return true;
  });
}

/** Total transfer for a model set, bytes. */
export function totalBytes(models: ModelAsset[]): number {
  return models.reduce((sum, m) => sum + m.bytes, 0);
}

/** Throughput each network class is assumed to deliver, bytes/second. */
export const THROUGHPUT_BPS: Record<SceneBudget['network'], number> = {
  // Deliberately pessimistic: these are the numbers the budget is defended at,
  // not the numbers a good link achieves. 'moderate' is the ~400 kbit/s that
  // Chrome's "Slow 3G" preset emulates.
  slow: 20_000,
  moderate: 50_000,
  fast: 750_000,
};

/** How long a model set takes to arrive on a given link, seconds. */
export function transferSeconds(models: ModelAsset[], network: SceneBudget['network']): number {
  return totalBytes(models) / THROUGHPUT_BPS[network];
}

export interface WarmupProgress {
  /** Models fetched so far (whether from network or cache). */
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
}

export interface WarmupHandle {
  /** Resolves when every model has been fetched or has failed. */
  finished: Promise<void>;
  /** Stop fetching — the operator entered the scene, or left the page. */
  cancel: () => void;
}

/**
 * Fetch a model set into the HTTP (and, in production, service-worker) cache.
 *
 * Concurrency-limited on purpose. Six parallel fetches on a 3G link do not
 * finish sooner than two — they finish at the same time as each other, which
 * means the crane and the hulls arrive as late as the trucks. Two at a time
 * keeps the pipe full while preserving the priority order.
 *
 * Every failure is swallowed: a warm-up that could not run is a slower scene,
 * never a broken one, and the renderer will fetch the model itself regardless.
 */
export function warmModels(
  models: ModelAsset[],
  opts: {
    concurrency?: number;
    onProgress?: (p: WarmupProgress) => void;
    fetchImpl?: typeof fetch;
  } = {}
): WarmupHandle {
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const doFetch = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  const total = models.length;
  const totalB = totalBytes(models);

  if (!doFetch || total === 0) {
    opts.onProgress?.({ done: total, total, bytes: totalB, totalBytes: totalB });
    return { finished: Promise.resolve(), cancel: () => {} };
  }

  let cancelled = false;
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  let done = 0;
  let bytes = 0;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (cancelled) return;
      const i = next++;
      if (i >= models.length) return;
      const m = models[i];
      try {
        // `force-cache` because these are vendored, immutable meshes: there is
        // nothing to revalidate and a conditional request on a 200 ms link is a
        // round trip spent to be told nothing changed.
        const res = await doFetch(m.href, { cache: 'force-cache', signal: controller?.signal });
        // DRAIN THE BODY. A Response whose body is never read leaves the stream
        // open and the bytes buffered — and with a service worker in the middle
        // the SW has already `clone()`d it, so an unread branch pins the whole
        // response in memory indefinitely. Reading it to completion is also what
        // makes the entry actually land in the cache, which is the entire point
        // of warming.
        await res?.arrayBuffer?.().catch(() => undefined);
      } catch {
        /* offline, aborted, 404 — the renderer will try again itself */
      }
      done += 1;
      bytes += m.bytes;
      opts.onProgress?.({ done, total, bytes, totalBytes: totalB });
    }
  };

  const finished = Promise.all(
    Array.from({ length: Math.min(concurrency, models.length) }, () => worker())
  ).then(() => undefined);

  return {
    finished,
    cancel: () => {
      cancelled = true;
      try {
        controller?.abort();
      } catch {
        /* already gone */
      }
    },
  };
}
