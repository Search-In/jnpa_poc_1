# JNPA · Vessel Traffic Management & Optimisation (Digital Twin PoC — Use Case 1)

A production-grade, **ArcGIS-embeddable** dashboard for the Jawaharlal Nehru Port
Authority Digital Twin PoC. It shows live vessel traffic on an Esri map,
computes the marine KPIs the port cares about (turnaround, berthing/sailing
delay, just-in-time arrivals, forecast accuracy, berth occupancy), and embeds
back into the existing ArcGIS Dashboards app
(`086aad29b91c43428491496776e0d1db`).

It runs in **two interchangeable data modes** behind one adapter interface:

| Mode | `VITE_DATA_MODE` | Source | Needs credentials? |
|------|------------------|--------|--------------------|
| **Mock** (default) | `mock` | Deterministic Nhava Sheva fixtures + simulated AIS stream | **No** — demos instantly |
| **Live** | `live` | ArcGIS Velocity Stream Layer + Hosted Feature Layers, or AISStream.io fallback | Yes |

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
scripts/       publish-feature-layers.mjs
docs/          ARCHITECTURE.md, KPI_DEFINITIONS.md
```

## Quality bar

TypeScript strict · ESLint (0 warnings) + Prettier · Vitest unit tests for every
KPI function with fixtures · graceful empty/error/loading states (Calcite
notices, never blank panels) · keyboard focus + reduced-motion respected ·
Calcite light theme tokens, no colour literals outside `src/theme/tokens.ts`.
