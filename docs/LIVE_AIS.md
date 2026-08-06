# Live AIS overlay (real vessels)

**What it is.** A map overlay showing *genuine* AIS traffic in the JNPA / Mumbai
area, fetched from the shared JNPA gateway's MarineTraffic proxy. It is the only
real-vessel source in UC-1 that works over Indian waters — AISStream and the
AISHub station overlay (docs/AISHUB.md) do not.

**Where it appears.** A `Live AIS` button in the map control bar (top-right of
the map panel), in both 2D and 3D. Off by default.

---

## Data path

```
MarineTraffic tile API  →  JNPA gateway  →  browser (same-origin /api)
  (6 tiles, z=12)          normalise + 60 s cache      render + poll
                           GET /api/marine/vessels/live
```

Nothing is persisted anywhere: the endpoint is pure pass-through with a 60-second
in-process cache on the gateway, and this app keeps only the last response in
component state.

The gateway fetches a 3×2 grid of z=12 tiles around JNPA (X=1438, Y=913), dedupes
rows on `SHIP_ID`, and maps them to the DTO below. There is **no pagination and no
filtering** — the response is everything inside that tile window. Covering a
different port means changing the tile centre in the gateway, not a query param.

## Endpoint

```
GET {VITE_UC3_API_BASE}/marine/vessels/live      →  /api/marine/vessels/live
Authorization: Bearer <jwt>
```

Returns a **bare JSON array** (not the `{items:[…]}` envelope every other UC-3
list route uses). `parseLiveVessels` accepts both.

```json
[{ "mmsi": "571902", "vessel_name": "FENG HAI 66", "imo_no": null,
   "lat": 18.9271, "lon": 72.8954, "speed_knots": 8.4, "course": 222,
   "heading": 224, "ship_type_code": 70, "ship_type_label": "Cargo",
   "destination": "INNSA", "flag": "CN", "length": 190, "elapsed_seconds": 45 }]
```

Status codes seen in practice: **401** without a bearer, **502**
(`marinetraffic_fetch_failed`) when the upstream scrape fails.

## Auth, CORS and base URL

No new plumbing: the overlay rides on the **same** `/api` base and the same
bearer as every other UC-3 call (`src/data/uc3/client.ts` + `token.ts`), which
already do the one-shot re-login-and-retry on a 401. Using a second base URL for
the map is exactly the mistake that broke the reference implementation in
production.

`/api` is a *relative* prefix, proxied to the gateway by Vite in dev
(`vite.config.ts`) and by nginx in production (`deploy/nginx.conf` →
`https://traffic-three.searchintech.in`), so the browser stays same-origin and
CORS never applies.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `VITE_LIVE_AIS_ENABLED` | `true` | Master switch; `false` hides the button |
| `VITE_LIVE_AIS_POLL_MS` | `60000` | Poll period, clamped to a 60 s floor |
| `VITE_UC3_ENABLED` | `true` | Gate on the whole gateway — off disables this too |
| `VITE_GATEWAY_URL` | `http://localhost:8000` | Dev-proxy target only; production resolves in nginx |

The poll floor is the gateway's own cache TTL — a faster interval just re-fetches
identical rows.

## Code map

| File | Role |
|---|---|
| `src/data/uc3/liveVessels.ts` | Endpoint, wire type, pure mappers, in-flight de-dup |
| `src/types/domain.ts` → `LiveVessel` | Domain type |
| `src/map/liveVesselStore.ts` | Shared toggle + poll status (survives a 2D↔3D flip) |
| `src/map/useLiveVessels.ts` | The single polling loop, with the cancelled guard |
| `src/map/liveVesselLayer.ts` | 2D + 3D GraphicsLayers, graphics, symbols, popup |
| `src/components/AISMap.tsx` | 2D wiring |
| `src/map/PortScene.tsx` | 3D wiring + the live-click guard |
| `src/App.tsx` | The `Live AIS` toolbar button |

## Behaviour worth knowing

- **It replaces invented data, it does not overlay it.** What comes off the map
  while the overlay is on:

  | | 2D map | 3D scene |
  |---|---|---|
  | Simulated AIS fleet + nav-status markers | emptied | emptied |
  | Berthed hero ships, harbour tug | hidden | hidden |
  | Cranes, yard stacks, gates, gate trucks | kept | kept |
  | Berth polygons, quays, channel, anchorages | kept | kept |

  Only *traffic* is replaced. Port infrastructure is the port, not something the
  AIS feed has an opinion about, so it stays in both views.

  Two mechanisms, and the distinction matters:
  - The simulated fleet and its nav-status markers are **emptied**, not merely
    hidden — those layers are repopulated on every sim tick, so a visibility flag
    alone is not enough to keep them off.
  - The decorative hulls are hidden by **visibility**, which no checkbox can
    override while the overlay is on: 3D by layer (`isDummyVesselLayer` in
    `portAssets3d.ts`), 2D per-graphic (`setPortAssets2dVisible` in
    `portAssets2d.ts`), because the 2D map draws every port asset in one
    GraphicsLayer.
- **The 2D layer checkboxes split by meaning, not by layer.** All port assets
  share one GraphicsLayer, but *Port Assets* controls only the infrastructure
  (cranes, yard stacks, gates, trucks) — the berthed hulls and tug inside that
  same layer follow *Vessel Tracks*, so unchecking Port Assets never takes the
  vessels with it.
- **A failed poll keeps the last good picture** and turns the button red with the
  error in its tooltip, rather than blanking the map.
- **Clicking a live hull opens the info popup only.** Live graphics are keyed
  `LIVE-<feed id>` and the 3D click handler skips them, so they never reach the
  placement-store lookup (which would open the "Move & rotate" editor).
- **In-flight GET de-duplication** — two identical requests before the first
  settles share one call, which is what stops React 18 StrictMode's deliberate
  mount→unmount→remount from double-fetching in dev.
- **Live vessels are flat markers, not ship models** — an amber triangle in 2D
  (bow along the AIS heading) and an amber dot in 3D. A glTF hull would assert a
  class, size and orientation the feed does not supply: `heading` is frequently
  null and `length` is often 0 or missing.
- **Both renderers are GraphicsLayers with the symbol on each graphic**, matching
  how the 2D map draws everything else. A client-side FeatureLayer silently drops
  attributes missing from `fields`, and its first `applyEdits` is discarded if the
  layer has not finished loading when a poll lands — which is what stopped live
  vessels appearing on the 2D map in the first cut.
- **Rotation is `angle` on the marker symbol**, which is clockwise from
  screen-up and so maps 1:1 onto an AIS heading. The FeatureLayer-renderer
  equivalent would be `rotationType: 'geographic'`; its default, `arithmetic`,
  measures counter-clockwise from east and points every vessel the wrong way.

## Field notes / caveats

- **`mmsi` is not an MMSI.** The gateway fills it from MarineTraffic's `SHIP_ID`,
  falling back to `MMSI`. It is a stable graphic key, nothing more — the popup
  labels it "Feed id (MarineTraffic)" and it must never be joined against a real
  MMSI. Some rows (satellite AIS) carry a long base64 id and the name `[SAT-AIS]`.
- **Speed is already in knots.** The gateway divides the upstream tenths-of-a-knot
  value; do not divide again. A handful of rows still report implausible speeds —
  that is upstream data, passed through as-is.
- **`heading` is often null** (Class B / SAT-AIS). The mapper falls back to
  `course` so hulls still point somewhere sensible.
- **The gateway cache is process-local**, so with multiple workers two
  consecutive requests can return data up to 60 s apart from each other.

## Verifying

```bash
curl -o /dev/null -w '%{http_code}\n' https://traffic-three.searchintech.in/api/marine/vessels/live   # 401
T=$(curl -s -X POST https://traffic-three.searchintech.in/api/auth/login \
      -H 'content-type: application/json' -d '{"username":"…","password":"…"}' | jq -r .access_token)
curl -s -H "authorization: Bearer $T" \
     https://traffic-three.searchintech.in/api/marine/vessels/live | jq 'length'                      # 200 + a count
```
