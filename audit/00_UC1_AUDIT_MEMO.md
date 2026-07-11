# UC-1 Vessel Traffic Management — Condensed Audit Memo & Rebuild Backlog

**Scope:** `poc_1/` (JNPA Digital Twin UC-1: Vessel Traffic Management & Optimisation).
**Method:** Static audit of `poc_1` cross-referenced against the UC-2 gold-standard app (`PoC_2/apps/web`) and the audit brief `CLAUDE_CODE_PROMPT_UC1_Audit_Enhance.md`. This is the condensed memo you approved in place of the 12-file report set — the gap list is already clear from the UC-2/UC-3 audit and a read of the UC-1 source.
**Decision on file:** Rebuild **in place**, keep the real tested KPI engine + DataAdapter + fixtures, execute **B1+B2+B3 in one pass**.

---

## A. What UC-1 has today (preserve)

- **Real, unit-tested KPI engine** (`src/kpi/*` with `.test.ts` for helpers/formulas/bundle). This is genuine and stays.
- **Clean `DataAdapter` contract** (`src/data/types.ts`) with Mock + ArcGIS implementations — the "all data through one adapter" discipline UC-2 also uses.
- **Correct JNPA geography & domain model**: Nhava Sheva terminals (NSICT/NSIGT/GTI/BMCT), berths with draft, berthing plan with planned-vs-actual, port craft (pilot/tug/mooring), predictions, weather+tide. Fixtures are Nhava Sheva-centred (~18.95°N, 72.95°E).
- **Deterministic seeded PRNG** for repeatable demos (`seededRandom`).
- Six KPI report widgets (Arrivals/Departures, JIT, delay trends, port-craft, prediction accuracy) + a 24h berthing gantt.

## B. Findings (severity-ranked)

| ID | Sev | Finding | Evidence | Fix |
|---|---|---|---|---|
| **U01** | **P0** | **Rotterdam branding** throughout — a JNPA demo that says "Rotterdam" is an instant integrity kill-shot | `App.tsx:55` "Live AIS Map — Rotterdam approaches"; `README.md:1` title; `data/config.ts:69-96` Rotterdam bbox + "Rotterdam (live AIS coverage demo)" label | Rebrand to JNPA/Nhava Sheva; keep Rotterdam only as an *optional* live-AIS-coverage fallback region, honestly labelled, never the default framing |
| **U02** | **P0** | **No DATA_MODE provenance system** — no persistent SIM/REPLAY/LIVE banner, no per-source chips. A single unlabelled screen is a P0 per the brief | grep: no `data_mode` chip infra; header is a plain `HeaderBar` | Port UC-2's global DATA_MODE chip + per-source `SourceBadge` pattern; default = **SIMULATED** |
| **U03** | **P0** | **No 3D scene** — the brief's mandated "living 3D scene as the default first-load view" is absent; only a flat 2D `<arcgis-map>` | no `SceneView` anywhere in `src/` | Build marine `PortScene` (SceneView): approach channel, anchorage, berth line-up, extruded quays, moving vessels, pilot station — mirroring UC-2's `PortScene`/`scene3d` |
| **U04** | **P1** | **No Integration Simulator Console** — no per-source LIVE/DEGRADED/OFFLINE control, no fallback/reconciliation. This is rubric criterion 3 | absent | Port UC-2 `IntegrationConsole`+`faultStore`, marine sources (AIS, VTS/pilotage, weather, tide, bathymetry, berthing-plan, port-craft) |
| **U05** | **P1** | **No What-If engine with Reactive Causality Guide** — the current `runWhatIf` is a numeric stub in the adapter with no causal DAG, no WHICH/WHERE/HOW/WHY/WHAT-NOW | `data/types.ts:45` `WhatIfScenario`; no `causalGraph`/`ReactiveGuide` | Port UC-2 `causalGraph.ts`+`ReactiveGuide.tsx`; marine DAG (weather→wave/wind→pilotage; tide→DUKC→deep-draft window→berthing→pre-berth delay→TAT; tug avail→unberth slip→berth release→JIT) |
| **U06** | **P1** | **No Simulator / scenario player** — no sim clock, no scripted scenarios, no guided tour | absent | Port UC-2 `SimAdapter`+`simStore`+`scenarioPlayer`+`GuidedTour`; scenarios M1–M5 (monsoon hold, draft restriction, berth outage, pilot shortage, vessel bunching) |
| **U07** | **P1** | **No 5-day berth Gantt** — current gantt is 24h only; brief mandates ≥5-day-ahead schedule with tidal-window shading + DUKC feasibility bands + drag-to-replan | `App.tsx:72` "Berthing Plan — 24h" | Rebuild as berth×time 5-day Gantt with tidal shading, DUKC bands, what-if drag |
| **U08** | **P1** | **No DUKC/RTUKC corridor** — no depth-coloured channel, no per-transit UKC profile, no DUKC(predictive) vs RTUKC(live) distinction (a known kill-shot) | absent | Build DUKC corridor viz + UKC profile chart (depth+tide−draft−squat) with go/no-go windows; RTUKC live readout during in-progress transit |
| **U09** | **P1** | **Prediction-vs-actual is a static snapshot**, not a convergence-over-sim-time chart with rolling MAE/MAPE (the literal answer to "Accuracy of prediction vs real-time" KPI) | `reports/PredictionAccuracy.tsx` | Add convergence chart driven by the sim clock with rolling error |
| **U10** | **P1** | **No ArcGIS token-death fallback** — brief's known SPOF; no offline basemap + local scene fallback, no "simulate token expiry" toggle | no `basemapFallback` in `src/` | Port UC-2 `basemapFallback.ts` (offline base + world-elevation fallback) + dev toggle |
| **U11** | **P1** | **No port-craft resource board** — current widget is a read-only utilisation view, not a finite-resource scheduler with conflicts + optimization recommendation | `reports/PortCraftPerformance.tsx` | Add pilots/tugs/mooring as scheduled resources with utilisation, conflicts, and a simulated swap recommendation |
| **U12** | **P1** | **No automated-workflow ledger** — no visibly-firing workflows (UKC breach→replan, ETA slip→re-optimize, weather→pilotage hold), no AUTO/ADVISORY toggle | absent | Port UC-2 `WorkflowRuns`+`workflowStore`; marine triggers |
| **U13** | **P2** | **No Methodology & Assumptions register** — no in-app panel with sourced FY24-25 calibration figures (10–12 calls/day, berth stay ≈0.97d, pre-berth wait ≈0.23d, TAT ≈1.83d, parcel ≈2355 TEU) | absent | Port UC-2 `MethodologyPanel`; add sourced assumptions register |
| **U14** | **P2** | **No banned-phrase discipline in copy** — needs a sweep to ensure no "reduces X by / improves baseline / N% improvement"; all framing as target / simulated result | to verify during build | Sweep + copy pass; frame every number as target/simulated under stated assumptions |
| **U15** | **P2** | **Calcite LIGHT theme** — UC-2/UC-3 use Calcite **dark** shell; the brief specifies "Calcite dark shell" | `App.tsx:2` comment "Calcite light theme"; `index.css` | Switch to Calcite dark to match the suite |
| **U16** | **P2** | **No camera bookmarks / scripted demo player / 60s opening choreography** | absent | Add camera presets (Approach & anchorage, Channel & DUKC, Berth line-up, Pilot station, KPI wall) + opening choreography |
| **U17** | **P3** | **No marine KPI report export** (Berthing Plan, Arrivals & Departures printable) | absent | Add printable export views |
| **U18** | **P3** | **No deterministic demo seed toggle + crash-recovery** (sim clock/scenario/camera restore on refresh) | seed exists in fixtures but no UI toggle/persistence | Add seed toggle + state persistence |

## C. Rubric estimate

| | C1 Method/Assumptions | C2 AI/ML | C3 Integration+Fallback | C4 Dashboard/KPI | C5 What-If/Reactive | **Now** | **After rebuild** |
|---|---|---|---|---|---|---|---|
| **UC-1** | 1 | 1 | 0–1 | 2 | 0–1 | **4–6 /10** | **9 /10** |

The dashboard/KPI layer (C4) is already strong; every other criterion is gated by a **module UC-2 already proved out** — this is a port + marine re-skin, not net-new architecture.

## D. Execution order (the rebuild I will now run, B1→B2→B3)

**Tier 0 (P0):** U01 rebrand → U02 DATA_MODE system → U03 3D marine PortScene (+ U10 basemap fallback, U15 dark theme come in here as they're structural). Re-grep for Rotterdam + unlabelled screens after.

**Tier 1 (P1):** U04 Integration Console → U05 What-If + Reactive Guide → U06 Simulator + scenarios M1–M5 → U07 5-day Gantt → U08 DUKC/RTUKC corridor → U09 prediction convergence → U11 port-craft board → U12 workflow ledger.

**Tier 2 (P2):** U13 Methodology/Assumptions → U14 banned-phrase sweep → U16 camera bookmarks + demo player.

**Tier 3 (P3):** U17 export → U18 seed toggle + crash recovery → final offline/token-death/seed-repro rehearsal.

**Guardrails honoured throughout:** no real shipping-line branding or real vessel identities; no claimed JNPA baselines; no new runtime internet dependencies; OSS listed with licences; all numbers carry units + provenance mode.

---

## E. Rebuild completion status (executed this session)

All tiers executed in one pass. **Preserved:** the tested KPI engine (`kpi/*`), `DataAdapter`, Nhava Sheva fixtures, the 6 report widgets, and the clean KpiStrip (already showed vs-target, not vs-baseline — no F01-style violation).

| Finding | Status | Where |
|---|---|---|
| U01 Rotterdam rebrand | ✅ | `App.tsx`, `index.html`, `README.md`, `package.json`, `config.ts` (Rotterdam now an opt-in, clearly-flagged live-AIS coverage stand-in only) |
| U02 DATA_MODE provenance | ✅ | `src/provenance/` (chip + per-panel `SourceBadge` + fallback ladder), wired in header |
| U03 3D marine PortScene | ✅ | `src/map/PortScene.tsx` + `scene3d.ts` + `portGeometry.ts` — default first-load view |
| U04 Integration Console | ✅ | `src/console/IntegrationConsole.tsx` + `useDataModeStore` (per-source LIVE/DEGRADED/OFFLINE + latency + reconciliation log) |
| U05 What-If + Reactive Guide | ✅ | `src/whatif/` (`causalGraph.ts` + `ReactiveGuide.tsx`) |
| U06 Simulator + M1–M5 | ✅ | `src/sim/` (`simStore`, `scenarios`, `ScenariosPanel`, `GuidedTour`, `useSimClock`, `SimControls`) |
| U07 5-day berth Gantt | ✅ | `src/components/reports/BerthGantt5Day.tsx` (tidal + DUKC bands + drag-to-replan) |
| U08 DUKC/RTUKC corridor | ✅ | `src/dukc/ukc.ts` (+ tests) + `DukcCorridor.tsx` (predictive windows vs live RTUKC) |
| U09 Prediction convergence | ✅ | `src/components/reports/PredictionConvergence.tsx` (rolling MAE/MAPE over sim clock) |
| U10 Token-death fallback | ✅ | `src/map/basemapFallback.ts` + "Simulate token expiry" button |
| U11 Port-craft board | ✅ | `src/components/reports/PortCraftBoard.tsx` |
| U12 Workflow ledger | ✅ | `src/workflow/` (`workflowStore` + `WorkflowRuns`, AUTO/ADVISORY) |
| U13 Methodology/Assumptions | ✅ | `src/config/assumptions.ts` + `MethodologyPanel.tsx` |
| U14 Banned-phrase discipline | ✅ | Repo-wide sweep clean; all framing target/simulated |
| U15 Theme | ✅ (light) | Kept Calcite **light** per direction (not dark) |
| U16 Camera bookmarks/demo player | ✅ | `src/sim/DemoPlayer.tsx` |
| U17 KPI report export | ✅ | `src/reports/exportReports.ts` + `ExportToolbar.tsx` |
| U18 Seed toggle + crash recovery | ✅ | sim state persisted to sessionStorage + fixed demo seed shown |

**Quality gates green:** `tsc -b` clean · ESLint 0 warnings · 56/56 tests pass (incl. 8 new DUKC tests) · production `vite build` succeeds · dev/preview server serves. Static verification only — a live in-browser smoke on the demo machine (devtools open, network unplugged, `?offline=1` token-death rehearsal) remains the recommended final gate before the demo.

## F. Shared geometry embed (positions.json from PoC_2)

To make UC-1 render on the **same surveyed JNPA geography as UC-2** (and close audit **F08**: split geometry + NSFT-vs-JNPCT naming divergence):
- Copied `PoC_2/data/positions.json` → `poc_1/data/positions.json` and augmented it with UC-1 marine anchors (`terminal:<ID>` derived from the surveyed asset clusters, plus `pilot:PBG`, `anchorage:OUTER/WAIT`). 112 placements.
- Ported the placement store → `src/map/placementStore.ts` (build-time seed from the committed JSON; Export/Import/Reset workflow, no hidden localStorage).
- `src/map/portGeometry.ts` now **derives** terminal positions, berthed-vessel spots, pilot station, anchorage rings and the approach-channel centreline from the embedded data (with fallbacks). Terminal naming adopts the shared convention **NSICT / NSIGT / GTI / BMCT / JNPCT**.
- `src/data/mock/fixtures.ts` re-anchors berths + moored vessels onto the real quay spots (one berth per terminal, 7 total).
- `PlacementToolbar` (Export/Import/Reset) added to the 3D panel header, mirroring the UC-2 editing workflow; `resolveJsonModule` + `data/` added to tsconfig so the JSON imports and bundles.

## G. Credential-free / no ArcGIS login (parity with UC-2)

UC-2 runs mock with zero credentials and never prompts for an ArcGIS sign-in; UC-1 now matches:
- `.env` rewritten to **`VITE_DATA_MODE=mock`** with a **blank `VITE_OAUTH_APPID`** and all live URLs cleared → no OAuth flow is ever registered or triggered. Default geography is JNPA (not the old Rotterdam live config).
- Deleted `src/arcgis/identity.ts`; removed `configureAuth()` (main.tsx), the auth lifecycle + state from `useAppStore`, and the Sign-in/Sign-out UI from `HeaderBar` and `AISMap`. `ArcGISAdapter` (live-only) is documented as needing an OAuth flow *only* if live mode targets private org items.
- **⚠️ Rotate the keys that were previously in `.env`** (an `VITE_AISSTREAM_TOKEN` and plaintext `ARCGIS_USER`/`ARCGIS_PASS`) — they have been removed from the file but should be treated as exposed and rotated (audit F17).

**Re-verified green:** `tsc -b` clean · ESLint 0 warnings · 56/56 tests pass · production build succeeds.
