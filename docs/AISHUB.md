# AISHub live vessel overlay (hybrid mode)

The `hybrid` data mode (`VITE_DATA_MODE=hybrid`) shows the simulated JNPA fleet
**with real live vessels layered on top**, badged **LIVE** on the map and in the
vessel feed. Two live sources run concurrently and merge into one overlay:

1. **AISStream.io** — global free AIS over a WebSocket. Coverage over Indian
   waters is thin, so this often contributes few/zero JNPA vessels.
2. **AISHub public station feed** — real JNPA / Nhava Sheva hulls scraped from
   the public station map that the browser plots. This is the source that
   actually populates the JNPA area.

Code: [`src/data/aishub.ts`](../src/data/aishub.ts) (parser + poller),
[`src/data/LiveOverlayAdapter.ts`](../src/data/LiveOverlayAdapter.ts) (compositing),
[`vite.config.ts`](../vite.config.ts) (dev proxy).

## Why not the AISHub API?

The official AISHub Web API (`data.aishub.net/ws.php`) requires an account
**username granted only to contributing members** — you must run an AIS receiver
and feed data back. We don't have a receiver, and approval is slow, so the API is
not an option for this PoC.

## Why the station-map endpoint + a bundled sample

The public station page plots vessels by fetching:

```
https://www.aishub.net/station/<id>/map.json      # <id> = 2387 for JNPA/Mumbai
```

This returns real positions **when requested by a logged-in aishub.net browser
session**. Two hard constraints make it unusable as a plain browser fetch from
this SPA, both verified against the live endpoint:

- **Anonymous requests return empty.** `{"extent":[],"positions":[]}` — for
  every station, even with a session cookie and the right `Referer`. A
  server-side proxy hitting it anonymously gets the same empty result.
- **No CORS header.** The response carries no `Access-Control-Allow-Origin`, so
  a direct `fetch()` from the SPA origin is blocked by the browser regardless.

So the connector is built to degrade honestly:

1. It fetches `map.json` **through the Vite dev proxy** (`/aishub-proxy/...`,
   which adds the `aishub.net` origin/referer and strips CORS in `npm run dev`).
2. If that returns **empty or is blocked**, it serves a **bundled sample**
   ([`src/data/mock/aishub.sample.json`](../src/data/mock/aishub.sample.json)) —
   a real 38-vessel JNPA snapshot captured from a logged-in session — so the map
   shows genuine hulls rather than blank. The sample is clearly labelled and
   every vessel it yields is flagged `SOURCE='live'`.

### Data caveats (the public feed is coarser than the API)

- **MMSI is anonymised** — a 32-char hash, not a real MMSI. It's a stable
  per-vessel key, so tracking/merge work; we prefix it `AISHUB-` so it can never
  collide with AISStream's numeric MMSIs. Do **not** treat it as a real MMSI.
- **SOG is coarsened** (values floor to 0/1) and there is **no true heading**
  (COG is used) and **no usable ETA/nav-status** — status is inferred from speed.
- **Names, types, and positions are genuine.**

## Going to real live AISHub data in production

The bundled sample is a demo stand-in. To serve genuinely live AISHub positions
in a deployed build, you need **both**:

1. **A server-side proxy** (the Vite dev proxy only exists in `npm run dev`).
   Add an endpoint on your backend that fetches `https://www.aishub.net/station/
   <id>/map.json` server-side and returns it with permissive CORS, then set
   `VITE_AISHUB_PROXY_BASE` to that endpoint's base path.
2. **An authenticated aishub.net session on that proxy** (or a contributing-member
   API username for `ws.php`). Without it, the endpoint returns empty — the proxy
   alone does not unlock the data.

Until both are in place, keep `VITE_AISHUB_SAMPLE_FALLBACK=true` so the JNPA
overlay stays populated.

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `VITE_DATA_MODE` | `mock` | Set to `hybrid` to enable the live overlay. |
| `VITE_AISHUB_ENABLED` | `true` | Toggle the AISHub source within hybrid mode. |
| `VITE_AISHUB_STATION` | `2387` | AISHub station id (2387 = JNPA/Mumbai). |
| `VITE_AISHUB_PROXY_BASE` | `/aishub-proxy` | Fetch base (dev proxy; set to a prod proxy for deploy). |
| `VITE_AISHUB_SAMPLE_FALLBACK` | `true` | Serve the bundled JNPA sample when the live fetch is empty/blocked. |
| `VITE_AISHUB_AOI_BBOX` | station coverage | DQ area-of-interest for AISHub vessels, `swLat,swLon,neLat,neLon`. |
| `VITE_AISSTREAM_TOKEN` | — | AISStream.io API key (the other live source). |
