# Claude Code Project Prompt — JNPA Use Case 1 (Vessel Traffic Management & Optimisation)

Paste the block below into Claude Code (`claude` in an empty folder, or "New project"). It is written to scaffold an **ArcGIS-compatible** web app that connects to **real AIS + Feature Layer data** and embeds back into your existing ArcGIS Dashboards app (`086aad29b91c43428491496776e0d1db`).

---

## PROMPT (copy from here ↓)

You are building a production-grade **Vessel Traffic Management & Optimisation** dashboard for the JNPA (Jawaharlal Nehru Port Authority) Digital Twin PoC, Use Case 1. It must be a first-class citizen of the Esri/ArcGIS ecosystem and integrate with our existing ArcGIS Dashboards app.

### Stack (pin these)
- **ArcGIS Maps SDK for JavaScript 5.x** via `@arcgis/core` and the web-component packages `@arcgis/map-components` (use `<arcgis-map>` / `<arcgis-scene>` components — **do not use the deprecated widget classes**, removed at 6.0). Scaffold with `npm create @arcgis -- -t vite` (React + TypeScript template).
- **React 18 + TypeScript + Vite**.
- **@esri/calcite-components-react** for shell, panels, chips, loaders, theming (Calcite dark).
- **Chart.js 4** (or ECharts if you prefer) for the KPI report charts.
- **@arcgis/charts-components** where a native Esri chart is enough (so charts stay portal-driven).
- State: lightweight (Zustand or React context). No Redux.

### Architecture (respect this separation)
```
AIS source ─┐
            ├─► ArcGIS Velocity (feed → real-time analytic) ─► Stream Layer (live positions)
Berth/Pilot │                                              └─► Hosted Feature Layer (history/KPIs)
data        │
            └─► (PoC fallback) direct AISStream.io WebSocket ─► client-side FeatureLayer
                                                                 (feature collection)

React app ── reads ──► WebMap/WebScene item + Stream Layer + Feature Layers
          ── computes KPIs ──► KPI report widgets
          ── publishes ──► embeddable build for ArcGIS Dashboards "Embedded Content"
```
**Hard rule:** the UI must never call AIS APIs directly. All data access goes through a single `src/data/` adapter module exposing typed methods (`subscribeVessels`, `getBerthPlan`, `getKPIs`, `getArrivalsDepartures`, `getDelaySeries`, `getPrediction`, `getPortCraft`). Provide two interchangeable implementations behind one interface: `MockAdapter` (for offline dev/demo) and `ArcGISAdapter` (real). Select via `VITE_DATA_MODE=mock|live`.

### Data connectors (build all three; document setup in README)
1. **Primary — ArcGIS Velocity Kpler AIS feed** → real-time analytic → outputs a **Stream Layer** (live vessel positions, keyed on MMSI as track ID) and a **spatiotemporal Feature Layer** (position history for TAT/delay computation). The app consumes the published Stream Layer URL via `StreamLayer` and subscribes to `data-received`.
2. **PoC open-source fallback — AISStream.io WebSocket** (free). Build a thin connector `src/data/aisstream.ts` that opens the WS, filters to a JNPA bounding box (Nhava Sheva approaches), and pushes positions into a client-side `FeatureLayer` feature collection so the same map/KPI code runs without Velocity. Also support **Marine Cadastre / HTTP Simulator** sample AIS for repeatable demos.
3. **Berths, berthing plan, pilot/tug/mooring, KPI history → Hosted Feature Layers** in our ArcGIS Online org. Define the schemas (see below) and seed each with a sample CSV the app can publish.

### Feature Layer schemas (create as TypeScript types + matching FS fields)
- **Vessels (stream)**: `MMSI, VESSEL_NAME, VESSEL_TYPE, NAV_STATUS, SOG, COG, HEADING, LAT, LON, ETA, BERTH_ID, TIMESTAMP`.
- **Berths**: `BERTH_ID, BERTH_NAME, TERMINAL, LENGTH_M, DRAFT_M, STATUS, GEOM(polygon)`.
- **BerthingPlan**: `PLAN_ID, BERTH_ID, MMSI, VESSEL_NAME, PLANNED_START, PLANNED_END, ACTUAL_START, ACTUAL_END, STATUS`.
- **PortCraft**: `CRAFT_ID, TYPE(pilot|tug|mooring), STATUS, ASSIGNED_MMSI, DEPLOYED_AT, RESPONSE_MIN`.
- **KPISnapshots**: `TS, PRE_BERTH_DELAY, PRE_SAIL_DELAY, AVG_TAT, JIT_PCT, FORECAST_ACC, BERTH_OCC, ANCHORED, APPROACHING`.

### KPI computation (do this in `src/kpi/` with unit tests)
- **Pre-Berthing Delay** = ATB − (ATA at anchorage + standard pilotage lead). **Pre-Sailing Delay** = ATD − (cargo-complete + clearance). **Average Vessel TAT** = ATD − ATA, rolling mean. **Just-In-Time %** = arrivals where |ATA − recommended slot| ≤ tolerance, as % of arrivals. **Forecast / Prediction Accuracy** = 1 − MAPE of predicted ETA vs actual ATA. **Berth Occupancy** = occupied-berth-hours / available-berth-hours. Each KPI returns `{value, target, deltaPct, trend[]}`. Targets configurable in `src/config/targets.ts`.

### Screens / components to build (match our reference layout)
1. `<HeaderBar>` — title, live status dot + "updated Ns ago", IST clock.
2. `<KpiStrip>` — 8 cards: Pre-Berthing Delay, Pre-Sailing Delay, Avg Vessel TAT, JIT %, Forecast Accuracy, Berth Occupancy, Anchored Vessels, Approaching Vessels (value, unit, ▲/▼ vs target).
3. `<AISMap>` — the live `<arcgis-map>`/`<arcgis-scene>` bound to our **WebMap item** + Stream Layer; renderers colour vessels by NAV_STATUS (underway/anchored/berthing/moored/approaching); layers toggle: Vessel Tracks, Berth Overlay, Weather Layer, Channel/Bathymetry. Popups show MMSI/SOG/COG/ETA.
4. `<VesselFeed>` — live list sorted approaching→berthing→anchored→underway→moored.
5. **Marine KPI Reports** (each its own component, each backed by a Feature Layer query):
   - `<BerthingPlan>` — 24h gantt (berths × scheduled/actual windows, NOW line).
   - `<ArrivalsDepartures>` — grouped bar by time block.
   - `<PreBerthingDelay>` / `<PreSailingDelay>` — trend line vs target band.
   - `<AvgTAT>` — trend + breakdown.
   - `<JustInTime>` — half-gauge + trend.
   - `<PortCraftPerformance>` — pilot/tug/mooring utilisation bars + avg response.
   - `<PredictionAccuracy>` — predicted ETA vs actual overlay + MAPE.
6. `<WeatherPanel>` — wind/sea-state/visibility/tide from the JNPA-committed weather/tidal/channel-depth PoC feed (open-source met source as fallback). Surface a **What-If** stub (delayed vessel / berth shift / weather impact) that recomputes JIT and TAT.

### Integration with the existing ArcGIS Dashboards app
- Produce a build deployable to ArcGIS Online / Enterprise (or any HTTPS host) and register it as an **app item**. Document two embed paths:
  1. **ArcGIS Dashboards → Embedded Content element** pointing at the hosted app URL (fastest; keeps the current dashboard `086aad29b91c...`).
  2. **ArcGIS Experience Builder custom widget** wrapping these components (cleanest long-term; shares the same portal items and OAuth session).
- Share the **same WebMap and portal items** the current dashboard uses so vessel data is consistent. Read the WebMap by item id from `VITE_WEBMAP_ID`.

### Auth & config
- Use `IdentityManager` / ArcGIS **OAuth 2.0** (named user) for org items; use an **API key** only for public basemap/geocode. Never hard-code secrets — `.env` with `VITE_ARCGIS_API_KEY`, `VITE_OAUTH_APPID`, `VITE_PORTAL_URL`, `VITE_WEBMAP_ID`, `VITE_STREAM_LAYER_URL`, `VITE_FS_*_URL`, `VITE_AISSTREAM_TOKEN`, `VITE_DATA_MODE`. Commit a `.env.example`.

### Quality bar
- TypeScript strict; ESLint + Prettier; Vitest unit tests for every KPI function with fixture data; graceful empty/error states (Calcite notices, never blank panels); responsive to tablet; keyboard focus + reduced-motion respected; Calcite dark theme tokens, no inline colour literals outside a `tokens.ts`.

### Deliverables
1. Running app: `npm install && npm run dev` works in **mock** mode with zero credentials (so it demos immediately).
2. `README.md` with: Velocity feed setup (Kpler + Marine Cadastre simulator), AISStream fallback, Feature Layer publishing steps, OAuth app registration, and the two Dashboards-embed paths.
3. `docs/ARCHITECTURE.md` (the data-flow above) and `docs/KPI_DEFINITIONS.md` (formulas + targets).
4. Seed CSVs for each Feature Layer + a script to publish them.

**Start by** scaffolding with `@arcgis/create` (Vite + React + TS), wiring Calcite dark shell, then build the `data/` interface with `MockAdapter` first so the whole UI runs offline. Then add `ArcGISAdapter` (Stream Layer + Feature Layer queries), then the AISStream fallback. Build the KPI engine with tests before the report widgets. Show me the folder structure and the `data/` interface before writing the widgets.

## (end prompt ↑)

---

### Why this shape (quick notes for you)
- **Velocity Kpler AIS feed** is the supported, no-glue-code path to live vessels as a Stream Layer (released Feb 2026). For the open-source PoC posture in our bid, **AISStream.io** + **Marine Cadastre simulator** give you the same UI with zero licensing — keep both.
- Building as a **custom app embedded in Dashboards** (vs. trying to bend native Dashboards elements) is what unlocks the gantt berthing plan, JIT gauge, and prediction-accuracy overlay that Dashboards can't draw natively.
- The `data/` interface + `mock|live` switch means the same code demos to JNPA evaluators offline and runs live post-award when TOS/VTS feeds open up.
- Versions are current as of Jun 2026: `@arcgis/core` 5.x, web components replacing widgets, `@arcgis/create` scaffolder.
