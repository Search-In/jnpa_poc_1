# JNPA · Vessel Traffic Management & Optimisation (Digital Twin PoC — Use Case-1)

A production-grade, **ArcGIS-native** command-and-control twin for the Jawaharlal
Nehru Port Authority (Nhava Sheva). The **3D sea-port scene is the default view**:
a georeferenced JNPA approach with a depth-graded navigation channel, outer/waiting
anchorages, the pilot boarding ground, extruded terminal quays (NSICT, NSIGT,
GTI/APMT, NSFT, BMCT), status-coloured berths and heading-rotated vessels driven
by a live (simulated) AIS stream. Around it: the marine KPI wall (turnaround,
berthing/sailing delay, just-in-time, prediction accuracy, berth occupancy), a
5-day berth Gantt with tidal + DUKC feasibility shading, a DUKC/RTUKC channel
corridor, a port-craft resource board, a what-if simulator with a reactive
causality guide, an integration-fault console, and an automated-workflow ledger.

Every screen carries a **DATA_MODE provenance chip** (default **SIMULATED**), so a
viewer can never mistake demo data for a live JNPA feed. No claimed JNPA baselines;
every figure is framed as a target or a simulated result under stated assumptions
(see the in-app Methodology & Assumptions register).

It runs in **three interchangeable data modes** behind one adapter interface:

| Mode | `VITE_DATA_MODE` | Source | Needs credentials? |
|------|------------------|--------|--------------------|
| **Mock** (default) | `mock` | Deterministic Nhava Sheva fixtures + simulated AIS stream + sim clock | **No** — demos instantly, fully offline |
| **Live** | `live` | ArcGIS Velocity Stream Layer + Hosted Feature Layers, or AISStream.io fallback | Yes |
| **Hybrid** | `hybrid` | The mock fleet **with real AISStream/AISHub vessels composited on top**, badged LIVE on the map and feed | Yes (`VITE_AISSTREAM_TOKEN`) |

> **There is no `uc3` data mode.** UC-3 gateway data — shipping lines, vessel calls,
> pilotage, bathymetry, performance, the live-AIS map overlay — is **orthogonal** to
> `VITE_DATA_MODE` and switched by `VITE_UC3_ENABLED` (see *UC-3 shared backend* in
> `.env.example`). The two are independent on purpose: gateway records are real
> whether or not the AIS fleet is simulated.
>
> An unrecognised `VITE_DATA_MODE` now **fails the build**. It used to fall through
> to `mock` silently, which meant a typo produced a dashboard of invented vessels
> that looked exactly like a working one.

> **Live AIS coverage note.** JNPA/Indian waters have no *free* public AIS feed.
> The demo runs on JNPA geography with a simulated feed by default. Only if you
> explicitly set `VITE_AIS_BBOX` (e.g. to Rotterdam) does the live-AIS demo
> re-centre on a covered region purely to show genuine real-time motion — and that
> region is always flagged in-UI as a **coverage stand-in**, never as JNPA.

## What's new in this rebuild (vs the earlier 2D dashboard)

- **3D marine PortScene** (`src/map/`) — SceneView with channel/anchorage/berths/
  vessels, camera bookmarks + a 60-second opening choreography, and automatic
  **offline basemap fallback on ArcGIS token death** (`?offline=1` to rehearse).
- **DATA_MODE provenance system** (`src/provenance/`) — global chip + per-panel
  source badges + the fallback ladder LIVE→DEGRADED→CACHED→IMPUTED→OFFLINE.
- **Integration Simulator Console** (`src/console/`) — per-source LIVE/DEGRADED/
  OFFLINE + latency injection + reconciliation audit log.
- **What-If simulator + Reactive Causality Guide** (`src/sim/`, `src/whatif/`) —
  scenarios M1–M5, a WHICH/WHERE/HOW/WHY/WHAT-NOW causal DAG, guided tour.
- **DUKC/RTUKC** (`src/dukc/`) — a defensible under-keel-clearance engine
  (depth + tide − draft − squat) with predictive tidal windows *and* a live RTUKC
  readout, plus a 5-day berth Gantt and a prediction-vs-actual convergence chart.
- **Automated workflow ledger** (`src/workflow/`) — marine triggers with an
  AUTO/ADVISORY governance toggle.

---

## Quick start (mock mode — zero credentials)

```bash
npm install
npm run dev          # http://localhost:5173
```

That's it. The whole UI + KPI engine runs offline against the mock adapter.

### Other scripts

```bash
npm test             # Vitest unit tests (KPI engine + adapters)
npm run typecheck    # tsc --noEmit (strict)
npm run lint         # ESLint (0 warnings enforced)
npm run build        # production build → dist/
npm run preview      # serve the production build
npm run publish:layers   # publish seed CSVs as Hosted Feature Layers (see below)
```

Connectivity pre-flight — run these **before** debugging app code, so a dead
gateway or a missing credential is ruled out first:

```bash
node scripts/probe-uc3.mjs                    # UC-3 gateway through the Vite dev proxy
node scripts/probe-uc3.mjs https://<host>/api # …or straight at a deployed gateway
node scripts/probe-aisstream.mjs              # AISStream token + coverage
```

---

## Tech stack

- **ArcGIS Maps SDK for JavaScript** via `@arcgis/core` + the **web-component**
  packages `@arcgis/map-components` (`<arcgis-map>` — *not* the deprecated widget
  classes). `@arcgis/charts-components` is available for portal-driven charts.
- **React 18 + TypeScript (strict) + Vite**.
- **@esri/calcite-components(-react)** for the shell/panels/inputs, **Calcite
  light theme** (`html.calcite-mode-light`).
- **Chart.js 4** (`react-chartjs-2`) for the KPI report charts.
- **Zustand** for lightweight state (live vessels, connection, KPI bundle).

> **Version note.** The PoC brief targets "ArcGIS 5.x". At build time the latest
> publicly resolvable releases were `@arcgis/core` **4.34** / Calcite **3.3.3**,
> which is what's pinned so `npm install` works today. The web-component approach
> is identical in 5.x; bumping is a version change in `package.json`, not a
> rewrite.

---

## The one hard rule: all data goes through `src/data/`

The UI **never** calls AIS / Feature Service APIs directly. Every component
talks to a single `DataAdapter` ([`src/data/types.ts`](src/data/types.ts)) with
typed methods: `subscribeVessels`, `getBerths`, `getBerthPlan`, `getKPIs`,
`getArrivalsDepartures`, `getDelaySeries`, `getPrediction`, `getPortCraft`,
`getWeather`, `getKpiHistory`, `runWhatIf`.

Two implementations sit behind it, selected by `VITE_DATA_MODE`:

- [`MockAdapter`](src/data/MockAdapter.ts) — offline fixtures + a simulated stream.
- [`ArcGISAdapter`](src/data/ArcGISAdapter.ts) — StreamLayer + Feature Layer
  queries, with the [AISStream](src/data/aisstream.ts) WebSocket as fallback.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full data-flow diagram.

---

## Configuration

Copy [`.env.example`](.env.example) to `.env` and fill in what you need. All
vars are build-time (`import.meta.env`) — only put **public** keys / item ids
there, never named-user secrets.

| Var | Purpose |
|-----|---------|
| `VITE_DATA_MODE` | `mock` (default) or `live` |
| `VITE_PORTAL_URL` | Portal base (default `https://www.arcgis.com`) |
| `VITE_ARCGIS_API_KEY` | **Public** key — basemaps/geocode only |
| `VITE_OAUTH_APPID` | OAuth 2.0 named-user app id (org items) |
| `VITE_WEBMAP_ID` | WebMap item shared with the existing dashboard |
| `VITE_STREAM_LAYER_URL` | Velocity-published Stream Layer (live vessels) |
| `VITE_FS_VESSELS_URL` … `VITE_FS_KPI_SNAPSHOTS_URL` | Hosted Feature Layer URLs |
| `VITE_AISSTREAM_TOKEN` | AISStream.io token (free fallback) |
| `VITE_WEATHER_FEED_URL` | Weather/tidal/channel-depth feed (optional) |

---

## Connectors (build all three)

### 1. Primary — ArcGIS Velocity (Kpler AIS) → Stream Layer + history

1. In **ArcGIS Velocity**, create a **feed** from the Kpler AIS source (or any
   AIS provider). Key tracks on **MMSI**.
2. Build a **real-time analytic** that writes to:
   - a **Stream Layer** (live positions) → set `VITE_STREAM_LAYER_URL`;
   - a **spatiotemporal Feature Layer** (position history) for TAT/delay → set
     `VITE_FS_VESSELS_URL`.
3. The app consumes the Stream Layer via `StreamLayer`. In ArcGIS JS 4.x the
   per-feature `data-received` event is delivered through the **layerview**
   (inside the MapView), so `AISMap` adopts the adapter's StreamLayer instance
   and feeds positions back to the adapter via `pushStreamGraphic()`.

### 2. PoC open-source fallback — AISStream.io WebSocket (free)

1. Get a token at <https://aisstream.io> → set `VITE_AISSTREAM_TOKEN`
   (leave `VITE_STREAM_LAYER_URL` empty to use this path).
2. [`src/data/aisstream.ts`](src/data/aisstream.ts) opens the WS, subscribes to
   the **JNPA / Nhava Sheva bounding box**, maps `PositionReport` messages to
   the domain `Vessel` type, and pushes them through the same code path as
   Velocity. **Marine Cadastre / HTTP simulator** sample AIS can replay into the
   same connector for repeatable demos.

### 3. Berths / plan / craft / KPI history → Hosted Feature Layers

Schemas are defined in [`src/types/schema.ts`](src/types/schema.ts) and seeded
by the CSVs in [`seed/`](seed/). Publish them with:

```bash
ARCGIS_USER=you ARCGIS_PASS=secret \
  [ARCGIS_PORTAL=https://www.arcgis.com] \
  npm run publish:layers
```

The script authenticates, uploads each CSV, publishes it as a Hosted Feature
Layer, and prints the service URLs — paste those into the `VITE_FS_*_URL` vars.

---

## OAuth app registration (org items)

1. In your ArcGIS org → **Content → New item → Application → register**.
2. Set the **redirect URI** to your dev (`http://localhost:5173`) and prod host.
3. Copy the **App ID** into `VITE_OAUTH_APPID`. The app uses ArcGIS
   `IdentityManager` / OAuth 2.0 (named user) for org Feature Layers; the public
   API key is only for basemaps/geocode.

---

## Embedding in the existing ArcGIS Dashboards app

Two documented paths (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#embedding)):

1. **Dashboards → Embedded Content element** pointing at this app's hosted URL.
   Fastest; keeps the current dashboard `086aad29b91c…` intact. Build with
   `npm run build` (base is `./`, so it works under any embed path) and host the
   `dist/` on ArcGIS Online / Enterprise or any HTTPS host, then register it as
   an **app item**.
2. **ArcGIS Experience Builder custom widget** wrapping these components.
   Cleanest long-term; shares the same portal items and OAuth session.

Both read the **same WebMap** (`VITE_WEBMAP_ID`) and portal items the current
dashboard uses, so vessel data stays consistent.

---

## Project layout

```
src/
  data/        DataAdapter interface + MockAdapter / ArcGISAdapter / aisstream / selector
  kpi/         pure, unit-tested KPI engine (helpers, formulas, bundle)
  types/       domain types + ArcGIS field schemas + KPI result types
  config/      KPI targets + tolerances
  components/  HeaderBar, KpiStrip, AISMap, VesselFeed, WeatherPanel, reports/*
  charts/      Chart.js registration + shared light-theme options
  store/       Zustand store (live vessels, connection, KPIs)
  theme/       tokens.ts — the ONLY place colour literals live
seed/          one CSV per Feature Layer
scripts/       publish-feature-layers.mjs, probe-uc3.mjs, probe-aisstream.mjs
docs/          ARCHITECTURE.md, KPI_DEFINITIONS.md, DEPLOYMENT.md
```

### External connectors — one doc each

| Connector | Doc | What it needs |
|---|---|---|
| Live AIS (MarineTraffic, via the UC-3 gateway) | [`docs/LIVE_AIS.md`](docs/LIVE_AIS.md) | `VITE_UC3_*` (no credential of its own) |
| NLDS / LDB container track | [`docs/LDB.md`](docs/LDB.md) | mobile **OTP** in-app + the `/ldb-proxy` proxy (no API key to provision) |
| AISHub public station overlay | [`docs/AISHUB.md`](docs/AISHUB.md) | none (station map.json, proxied) |
| INCOIS tide / ocean state | [`docs/INCOIS.md`](docs/INCOIS.md) | data agreement — runs on Open-Meteo meanwhile |

## Quality bar

TypeScript strict · ESLint (0 warnings) + Prettier · Vitest unit tests for every
KPI function with fixtures · graceful empty/error/loading states (Calcite
notices, never blank panels) · keyboard focus + reduced-motion respected ·
Calcite light theme tokens, no colour literals outside `src/theme/tokens.ts`.
