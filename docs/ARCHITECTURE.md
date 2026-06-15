# Architecture — JNPA VTMS

## Data flow

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

### The single seam: `DataAdapter`

Everything the UI knows about data is the [`DataAdapter`](../src/data/types.ts)
interface. Components and the store call its typed methods and nothing else.
This is what makes the same UI demo offline and run live:

```
                       ┌─────────────────────────────┐
   React UI ──────────►│        DataAdapter          │
   (components,        │  subscribeVessels, getKPIs, │
    Zustand store)     │  getBerthPlan, getWeather…  │
                       └──────────┬───────────┬──────┘
                                  │           │
              VITE_DATA_MODE=mock │           │ VITE_DATA_MODE=live
                                  ▼           ▼
                        ┌───────────────┐  ┌────────────────────────────┐
                        │  MockAdapter  │  │       ArcGISAdapter         │
                        │  fixtures +   │  │  StreamLayer / FeatureLayer │
                        │  fake stream  │  │  queries  ── or ──  AISStream│
                        └───────────────┘  └────────────────────────────┘
```

`getAdapter()` in [`src/data/index.ts`](../src/data/index.ts) constructs the
singleton from `VITE_DATA_MODE`.

### KPI engine

KPIs are **pure functions** in [`src/kpi/`](../src/kpi) with no I/O and no clock
reads (the `now` reference is always passed in), so they are deterministic and
unit-tested independently of any adapter. Both adapters feed the *same*
`buildKpiBundle()` so mock and live numbers are computed identically. See
[`KPI_DEFINITIONS.md`](KPI_DEFINITIONS.md).

### Live vessel path (live mode)

```
Velocity Stream Layer ──► AISMap adds the StreamLayer to the MapView
                          └─ layerview emits `data-received` per feature
                             └─ AISMap → ArcGISAdapter.pushStreamGraphic()
                                └─ adapter merges by MMSI → fans out to subscribers
                                   └─ Zustand store → KpiStrip / VesselFeed / map graphics

(no Stream Layer configured)
AISStream.io WebSocket ──► aisstream.ts maps PositionReport → Vessel
                           └─ ArcGISAdapter cache → subscribers (same path)
```

The per-feature `data-received` event lives on the **StreamLayerView** in ArcGIS
JS 4.x (it only exists inside a MapView), which is why the map observes
positions and routes them back to the adapter, rather than the headless adapter
polling the socket itself.

### State

A single Zustand store ([`useAppStore`](../src/store/useAppStore.ts)) holds the
live vessel set, connection state, last-update time, and the computed KPI
bundle. It subscribes to the adapter's vessel stream once and refreshes KPIs on
an interval. Report widgets that need their own slice (gantt, charts) query the
adapter directly through the [`useAdapterQuery`](../src/hooks/useAdapterQuery.ts)
hook, which standardises loading/error state.

## Embedding

### Path 1 — Dashboards Embedded Content (fastest)
1. `npm run build` → `dist/` (Vite `base: './'`, so it works under any path).
2. Host `dist/` on ArcGIS Online/Enterprise or any HTTPS host; register as an
   **app item**.
3. In the existing dashboard (`086aad29b91c43428491496776e0d1db`) add an
   **Embedded Content** element pointing at the hosted URL.

### Path 2 — Experience Builder custom widget (cleanest long-term)
Wrap these React components in an Experience Builder widget so they share the
portal's OAuth session and the same WebMap/Feature Layer items. No iframe; one
identity.

Both paths read the **same `VITE_WEBMAP_ID`** and Feature Layer items the
current dashboard uses, keeping vessel/berth data consistent across apps.

## Theming

Colour literals live **only** in [`src/theme/tokens.ts`](../src/theme/tokens.ts).
`main.tsx` seeds CSS custom properties from the tokens, and Chart.js defaults are
set from the same file. The app uses the Calcite **light** theme
(`html.calcite-mode-light`).
