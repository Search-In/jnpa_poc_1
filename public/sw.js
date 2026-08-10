/*
 * Service worker — installability and offline resilience for the JNPA twin PWA.
 *
 * Deliberately conservative. This app talks to a gateway, a model service and
 * Esri's tile CDN, and silently serving a stale berth plan or a stale vessel
 * position from cache would be an integrity failure, not a feature. So:
 *
 *  • Only same-origin GETs for the built app shell are cached, stale-while-
 *    revalidate. Those are content-hashed by Vite, so a new build never collides
 *    with an old entry.
 *  • Every API call (`/api`, `/ml-api`, `/aishub-proxy`, `/incois-proxy`) and
 *    every cross-origin request is passed straight to the network, untouched.
 *  • Navigations fall back to the cached shell ONLY when the network fails, so
 *    an offline launch still opens rather than showing the browser's error page.
 *
 * Bumping CACHE invalidates everything from the previous build.
 */

const CACHE = 'jnpa-uc1-shell-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

/** Paths that must always hit the network — live data and model inference. */
const NETWORK_ONLY = [/^\/api\//, /^\/ml-api\//, /^\/aishub-proxy\//, /^\/incois-proxy\//];

self.addEventListener('install', (event) => {
  // Take over promptly so the first launch after install is already controlled.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {
      /* a missing shell entry must never block installation */
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Esri tiles, CDNs — untouched
  if (NETWORK_ONLY.some((re) => re.test(url.pathname))) return;

  // Navigations: network first, cached shell only as a fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html').then((r) => r || Response.error()))
    );
    return;
  }

  // Static assets: serve from cache immediately, refresh in the background.
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit || Response.error());
      return hit || network;
    })
  );
});
