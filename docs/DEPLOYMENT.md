# Deployment Guide — UC-1 (spec D-1)

The app is a static single-page application. It can be served by any static host or by the bundled Docker image. Default mode is **mock** — it runs fully with **no credentials**.

## Option A — Docker (recommended)
Requirements: Docker + Docker Compose on a clean Ubuntu server.

```bash
docker compose up -d          # builds the image, serves on :8080 (non-root)
curl -s localhost:8080/health # {"status":"ok","service":"uc1-vtms"}
```

- The container runs as the unprivileged `nginx` user, read-only root FS, `no-new-privileges`.
- **Air-gap**: `docker compose build` bundles all app assets and the base images into the image; no network is needed at run time. Build once on a connected machine, `docker save`/`load` the image into the air-gapped environment.

## Option B — Static host
```bash
npm ci
npm run build         # → dist/
# serve dist/ with any static server / CDN / nginx
```

## TLS
Terminate TLS at a reverse proxy (nginx/Caddy/Traefik) or your load balancer in front of port 8080. Provide your own certificate; renew before expiry (a 14-day-prior warning appears on the System Health page — see D-2). Example nginx front-end: proxy_pass to `http://uc1-vtms:8080`, add HSTS.

## Hardware sizing (guidance)
Static SPA — modest. For a single-site JNPA command centre:
- **CPU** 2 vCPU · **RAM** 2 GB · **Disk** 5 GB (image + logs).
- Scales horizontally behind the proxy; the bundle is cache-friendly (hashed immutable assets).

## Configuration
Build-time env (`.env`, all optional; blank = mock). Vite **inlines** every one of
these into the client bundle, so never put a named-user secret here — see the
scope-honesty note on `env.uc3` in `src/data/config.ts`.

**Simulation vs. real feeds**
| Var | Purpose |
|---|---|
| `VITE_DATA_MODE` | `mock` (default) / `live` / `hybrid`. **Any other value fails the build** — see the note below. |
| `VITE_AISSTREAM_TOKEN` | AISStream live AIS (`live` + `hybrid`) |
| `VITE_STREAM_LAYER_URL` / `VITE_FS_*_URL` | ArcGIS Velocity stream layer + Hosted Feature Layers (`live` only) |
| `VITE_WEATHER_FEED_URL` | live weather feed |
| `VITE_ARCGIS_API_KEY` / `VITE_OAUTH_APPID` | ArcGIS private items (only if used) |

**UC-3 shared gateway** — orthogonal to `VITE_DATA_MODE`; these drive shipping
lines, vessel calls, pilotage, bathymetry, port craft and performance.
| Var | Purpose |
|---|---|
| `VITE_UC3_ENABLED` | Master switch (default on). `false` → the app makes no gateway call at all. |
| `VITE_UC3_API_BASE` | Path prefix the browser calls. Keep it **relative** (`/api`) so the proxy stays in the path and no CORS applies. |
| `VITE_UC3_USERNAME` / `VITE_UC3_PASSWORD` | PoC login for `POST {base}/auth/login`. Inlined into the bundle — demo credential only. |
| `VITE_GATEWAY_URL` | **Dev only** — where the Vite proxy forwards `/api`. Production resolves the gateway in `deploy/nginx.conf`, not here. Defaults to `http://localhost:8000`; if nothing is listening there, every `/api` call returns Vite's `ECONNREFUSED` 500. |

**Live AIS overlay** (real MarineTraffic positions via the gateway) — see `docs/LIVE_AIS.md`.
| Var | Purpose |
|---|---|
| `VITE_LIVE_AIS_ENABLED` | Master switch for the map's **Live AIS** toggle (default on). Requires `VITE_UC3_ENABLED`. |
| `VITE_LIVE_AIS_POLL_MS` | Poll period, clamped to a 60 s floor (the gateway's own cache TTL). |

**NLDS Logistics Data Bank container track** — see `docs/LDB.md` for the switch-over runbook.
| Var | Purpose |
|---|---|
| `VITE_LDB_ENABLED` | Master switch (default on) |
| `VITE_LDB_PROXY_BASE` | Relative proxy prefix (`/ldb-proxy`) → `https://ldb.co.in` |
| `VITE_LDB_ACCESS_TOKEN` | *Optional* bootstrap `searateToken`. Auth is **mobile OTP in-app** — there is no API key to provision. |
| `VITE_LDB_MOBILE_NO` | Pre-fills the OTP form |
| `VITE_LDB_SAMPLE_FALLBACK` | Serve the bundled sample when a live call fails — **only for CCLU7468361** (default on). Set **false** to prove the live path. |

> **`VITE_DATA_MODE` is validated at build time.** An unrecognised value (e.g. the
> `uc3` that circulated in a programme document) used to fall through to `mock`
> silently — a dashboard of invented vessels that looked like a working one. The
> build now fails with a descriptive message, and a value injected into an
> already-built bundle raises a header banner instead.

> Bringing a source live: provide its credential, then follow the go-live checklist on the **Connectors** tab. Until then that source runs on the mock driver and the twin keeps working.

Pre-flight the gateway before touching app code:
```bash
npm run dev                                        # in another terminal, then:
node scripts/probe-uc3.mjs                         # through the Vite dev proxy
node scripts/probe-uc3.mjs https://<host>/api      # straight at the gateway
```

## What is real in the deployed build

The CI-deployed EC2 artefact is a **mixed** build, deliberately. `VITE_DATA_MODE`
and `VITE_UC3_ENABLED` are orthogonal switches, so the AIS fleet being simulated
says nothing about whether the gateway panels are. Every switch that changes what
a reviewer sees is pinned explicitly in `.github/workflows/deploy.yml`, so a later
change to a default in `src/data/config.ts` cannot silently alter the artefact.

| Surface | In the deployed build | Why |
|---|---|---|
| Vessel fleet, berths, berthing plan | **Simulated** | `VITE_DATA_MODE=mock`; deterministic Nhava Sheva fixtures |
| Marine KPI wall, analytics, what-if | **Simulated** | Computed from the mock fleet; the what-if is a transparent linear stub |
| DUKC / tide & sea state | **Simulated** | Interim Open-Meteo source; no INCOIS data agreement yet |
| Shipping Lines (registry, advance lists, EDO) | **Real** | UC-3 gateway records |
| Vessel Calls, Pilotage, Bathymetry, Port Craft | **Real** | UC-3 gateway records |
| Performance & Reports | **Real** | UC-3 gateway, from NLDS/LDB monthly reports |
| **Live AIS** map overlay (on toggle) | **Real** | MarineTraffic positions proxied by the gateway — see `docs/LIVE_AIS.md` |
| Container track (Vessels ▸ Track by Container) | **Real once the operator verifies a mobile OTP**; otherwise a labelled sample, and only for CCLU7468361 | see `docs/LDB.md` |

In-app, this split is already carried by the header `DataModeChip`, the per-panel
`SourceBadge`, and the Methodology & Assumptions register. This table is the
written counterpart for reviewers who never open the app.

## Running the live demo locally (recommended over the deployed URL)

The deployed URL is the **submission artefact**. Drive the live expert demo from a
local `npm run dev` instead: a bad toggle or a rotated credential is then a
one-line fix, not a five-minute redeploy.

`.env` for the demo machine — fill the credentials from the programme's secret
store, and **never commit the file** (`.env` is gitignored; `.env.example` is not):

```bash
VITE_DATA_MODE=mock                                  # honest, labelled simulation
VITE_GATEWAY_URL=https://traffic-three.searchintech.in # dev-proxy target for /api
VITE_UC3_ENABLED=true
VITE_UC3_API_BASE=/api
VITE_UC3_USERNAME=<from secret store>
VITE_UC3_PASSWORD=<from secret store>
VITE_LIVE_AIS_ENABLED=true
VITE_LDB_ENABLED=true
VITE_LDB_MOBILE_NO=<presenter's mobile — pre-fills the OTP form>
# VITE_LDB_ACCESS_TOKEN is a bootstrap only; container track authenticates by
# mobile OTP in-app, so leave it blank and verify on the day.
```

Pre-flight, in order — do not skip step 2:

```bash
npm ci
node scripts/probe-uc3.mjs      # gateway reachable + credentials accepted?
npm run dev                     # http://localhost:5173
```

Then on screen: no amber config banner in the header; the map's **Live AIS**
toggle shows a vessel count when switched on; Shipping Lines loads real carriers.
For container track, verify the OTP **before** the audience is watching — the SMS
round-trip is the slowest step in the demo and it needs live mobile reception.
A `.env` change requires a dev-server restart — Vite inlines `import.meta.env` at
server start.

## Update / rollback (D-4)
- Versioned image tags (`uc1-vtms:<version>`). Deploy a new tag; roll back by re-pointing to the previous tag.
- No database migrations in the SPA tier. A staging profile = a second compose stack on a staging host to rehearse updates.
