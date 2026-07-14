# INCOIS tide & sea-state (Tide & Sea State feature)

The **Tide & Sea State** tab and map overlay show per-station tide height + trend,
significant wave height (sea state), swell and wind for the JNPA / Nhava Sheva
monitoring points. Its intended **production source is INCOIS Ocean State
Forecast (OSF)** — the backend behind the SAMUDRA app — which serves per-location
tide predictions and wave forecasts along the Indian coast.

Code: [`src/data/tide.ts`](../src/data/tide.ts) (station roster + fetch),
[`src/components/TideSeaStatePanel.tsx`](../src/components/TideSeaStatePanel.tsx) (table),
[`src/components/AISMap.tsx`](../src/components/AISMap.tsx) (map overlay layer),
[`src/data/connectors.ts`](../src/data/connectors.ts) (`TIDE` connector),
[`vite.config.ts`](../vite.config.ts) (`/incois-osf-proxy` dev stub).

## Why the INCOIS feed is not live today

INCOIS does **not** publish a free, public, CORS-enabled API for tide + sea-state
forecast. Verified against the live endpoints:

- **Open ERDDAP** (`erddap.incois.gov.in`) is reachable and returns JSON, but its
  catalog carries only **satellite winds / SST / ARGO floats — no wave, tide, or
  OSF grid.** It also sends **no `Access-Control-Allow-Origin` header**, so a
  direct browser `fetch()` from the SPA origin is blocked regardless.
- The **OSF product** (waves + tides the SAMUDRA app shows) is served through a
  separate **authenticated backend with no documented public REST/WMS endpoint.**
- The **SAMUDRA mobile API** is private/undocumented (guessed paths 404).

So a real INCOIS OSF feed needs **two things this PoC can't provide on its own**:

1. A **server-side proxy** — to attach credentials and add the CORS header the
   browser requires (same shape as the AISHub proxy; see [`AISHUB.md`](./AISHUB.md)).
2. An **INCOIS data-access agreement / MoU** for the OSF product.

Both are **production adds**, tracked on the `TIDE` connector's go-live checklist
in the Connectors tab.

## Interim live source: Open-Meteo Marine

So the feature shows **genuine data now** rather than only mock, the live driver
uses the free, no-key **Open-Meteo Marine API** per station lat/lon
([`src/data/tide.ts`](../src/data/tide.ts)):

- `wave_height` → sea state (significant wave height)
- `swell_wave_height` → swell
- `sea_level_height_msl` → tide (height above datum), with the hourly series
  giving the rising / falling / slack trend
- `wind_speed_10m` / `wind_direction_10m` → wind

This is **honestly labelled** everywhere it renders: the panel carries the `TIDE`
[`SourceBadge`](../src/provenance/SourceBadge.tsx) (`Source: Tide · … · Simulated`
in sim mode) and an info notice reading *"Interim live source: Open-Meteo Marine …
Production source is INCOIS Ocean State Forecast (SAMUDRA) — pending a server-side
proxy + INCOIS data agreement."*

In `mock` mode the same stations run on a deterministic semidiurnal tide model
(`makeTideStations` in [`src/data/mock/fixtures.ts`](../src/data/mock/fixtures.ts)),
and What-If tide-offset / weather-severity levers flow through
`applyTideStations` ([`src/sim/applySim.ts`](../src/sim/applySim.ts)) so the tide
table stays consistent with the Weather panel and DUKC under a scenario.

## Cutover to real INCOIS

When an INCOIS OSF endpoint + data agreement land:

1. Point the `/incois-osf-proxy` target in [`vite.config.ts`](../vite.config.ts)
   at the real host (and stand up an equivalent server-side proxy in production).
2. Switch `fetchTideStations` in [`src/data/tide.ts`](../src/data/tide.ts) to hit
   `/incois-osf-proxy/…` and map the OSF response fields onto `TideStation`.
3. Update the `TIDE` `SourceBadge` `prodSource` to drop the "(interim …)" note.

The rest — the table, the map overlay, the station roster, the sim overrides —
is source-agnostic and needs no change.
