# UC-1 PRODUCTION-READINESS SCORECARD — LOOP 1 (ASSESS)
## PoC_1: Vessel Traffic Management & Optimisation → client-site-deployable, stakeholder-operated system
## Anchor: `CLAUDE_CODE_PROMPT_UC1_Production_Readiness.md` (GeM Tender GEM/2026/B/7297343, Appendix C UC-1)

> **This is Loop 1 — assessment only. No code was changed.** The programme mandates a STOP here for approval before Loop 2 (HARDEN) begins.
> **Method:** static audit of the current codebase (four parallel read-only passes across Parts 1–5), cross-checked against the committed source with `file:line` evidence. Current gates were run read-only: **`tsc -b` clean · 56/56 tests pass · vitest green** (2026-07-11).

---

## 0. THE ONE FACT THAT REFRAMES THIS ENTIRE PROGRAMME

**`poc_1` is a frontend-only Vite + React + TypeScript single-page application.** Verified exhaustively:

- **No backend of any kind.** No Express/Fastify/Node server, no `server/`/`api/`/`backend/` directory, no `.listen()`.
- **No database.** Zero references to sqlite/postgres/mysql/mongo/prisma/typeorm/knex.
- **No containers / IaC.** No `Dockerfile`, no `docker-compose.yml`.
- **No CI.** No `.github/workflows`. Therefore no secrets scanning, no dependency-audit gate, no contract tests in CI.
- **Persistence is `sessionStorage` only** (`src/sim/simStore.ts`) for sim-clock/scenario/camera crash-recovery. The workflow ledger (`src/workflow/workflowStore.ts`) and integration audit log (`src/provenance/useDataModeStore.ts`) are in-memory, capped at 200 entries, and lost on reload.
- **The only "server-side" is Esri SaaS** (ArcGIS Online/Enterprise), reached in *live* mode via build-time `VITE_*` env vars. "Connectors" today = ArcGIS Stream/Feature layers + the free AISStream.io WebSocket + Open-Meteo. Switching mock↔live = editing `.env` and **rebuilding** — there is no admin UI, no per-source driver switch, no credential vault.

**Consequence.** The programme document (Parts 3–4 especially) assumes a multi-service deployed platform: an auth server, a user/role store, a persistent audit database, `/health` endpoints per service, scheduled backups, TLS termination, containers, a credential vault, a CI contract-test harness, a dead-letter queue. **None of that substrate exists.** This is not a defect in the PoC — it was built to be a compelling, honestly-labelled *simulation* demo, and at that job it is strong. But it means a large fraction of the production-readiness checklist is not "partially done" — it is **structurally absent**, and closing it is a build-a-backend programme, not a hardening pass.

Every verdict below therefore carries an explicit distinction:

- **FAIL (buildable in-SPA)** — can be delivered inside the current frontend with a mock/stub store or client-side simulation, consistent with the programme's "mock now, config-ready" bar. This is real Loop-2 scope.
- **FAIL (needs backend)** — cannot be a frontend feature; requires net-new server/DB/auth infrastructure. This is a scope-and-budget decision for the approver, not a code task Claude can quietly absorb.

The single most important output of Loop 1 is this fork in the road. **See §8 (Executive Summary) for the recommended decision before any Loop 2 work.**

---

## 1. SCORING LEGEND

- **PASS** — functions correctly on mock data (and, where the facet is claimed, is live-ready / operable).
- **PARTIAL** — real but incomplete, or works for one facet ([F]) while another ([L]/[O]) is missing.
- **FAIL** — absent. Annotated `(buildable in-SPA)` or `(needs backend)`.
- **N-A** — not applicable to a frontend PoC; justified inline.
- Facets: **[F]** functions on mock · **[L]** live-ready (config-switchable real connector contract) · **[O]** operable by a JNPA stakeholder via UI, no CLI.
- Effort: **S** = hours · **M** = 1–3 days · **L** = multi-day/structural.
- Tier (Loop 2 assignment): **T0** crash/corruption/mislead/blocks-install · **T1** connector arch + operability core + marine-logic edge cases · **T2** competitiveness + remaining edges + docs · **T3** polish/localisation/perf.

---

## 2. PART 1 — STRICT FUNCTIONAL SCOPE

### 1.1 Intended Use

| ID | Facets | Status | Evidence | Gap | Fix | Tier |
|---|---|---|---|---|---|---|
| IU-1 | [F][L][O] | **PASS** | 3D command centre `App.tsx:126-284`; live vessel stream `store/useAppStore.ts:34-47`; berth-occupancy KPI `kpi/bundle.ts:133-137`; anchored/approaching cards `components/KpiStrip.tsx:17-26`; DATA_MODE chip `App.tsx:130`; live path `data/ArcGISAdapter.ts:128-167` | "Pre-berthing status" is anchored/approaching counts + berth status, not an explicit pre-berthing pipeline state | S | T2 |
| IU-2 | [F][L][O] | **PARTIAL** | 5-day Gantt `BerthGantt5Day.tsx:32,92`; plan via adapter API path `ArcGISAdapter.getBerthPlan:233-251` | **Mock plan is only ~24h of data** (`fixtures.ts:241-266`, 8 entries/~21h) so the 5-day-ahead horizon renders mostly empty on mock. **No CSV/XLSX upload; no manual entry/edit UI.** No role-scoped visibility (see R-5). | L | T1 |
| IU-3 | [F][L][O] | **PASS** (L partial) | DUKC (predictive windows) + RTUKC (live gauge) as two distinct, correctly-named sections `DukcCorridor.tsx:218-404`; engine `dukc/ukc.ts`; weather `WeatherPanel.tsx`; tide `ukc.ts:90` | [L]: only weather has a real connector (Open-Meteo); pilot/channel-depth/tide have no live connector — INCOIS/IMD/MOSDAC are label strings (`sources.ts:59-83`) | M | T1 |
| IU-4 | [F][O] | **PASS** | Planner-facing scenario levers + parameter sliders + berth-outage toggles `ScenariosPanel.tsx:44-51,236-298`; drives twin via `simStore.ts`; no CLI | Berth-allocation "strategy" is lever perturbation + fixed heuristic narrative, not a selectable optimisation algorithm (see C-3) | M | T2 |

### 1.2 Requirements 1–8

| ID | Facets | Status | Evidence | Gap | Fix | Tier |
|---|---|---|---|---|---|---|
| R-1 | [F][L] | **PARTIAL** | Full AISStream request/response contract `data/aisstream.ts:79-198` (subscribe frame, PositionReport + ShipStaticData mapping); Velocity StreamLayer `ArcGISAdapter.ts:175-194`; served by mock `MockAdapter.ts:61-87` | **Only 1 of 6 named sources (AISStream) has a real contract.** AISHub, Global Fishing Watch, AISdb, MarineTraffic, VesselFinder are absent entirely. Tender asks ≥2 with full contracts. No VTS/pilotage connector. | M | T1 |
| R-2 | [F][L] | **PARTIAL** | Weather/tide/depth modelled `derive.ts:16-37`, `ukc.ts:90`; Open-Meteo live connector `weather.ts:33-63`; generic `VITE_WEATHER_FEED_URL` slot `ArcGISAdapter.ts:340-345` | INCOIS/IMD/MOSDAC/Copernicus/BHOONIDHI are descriptive strings only (`sources.ts:66-83`). No "JNPA sample data" import path. No bathymetry import. | M | T1 |
| R-3 | [F][O] | **PARTIAL** | Berthing Plan + Arrivals/Departures reports on-screen `App.tsx:259-261`; printable + header + timestamp + provenance on artifact `exportReports.ts:36-92`; toolbar `ExportToolbar.tsx` | **PDF = browser `window.print()` only** (`exportReports.ts:38`); **no XLSX export at all.** Provenance string is static "SIMULATED", not the live DATA_MODE value. | M | T2 |
| R-4 | [F] | **PASS** | 3D scene overlays vessels + berth status + approach: `channelLayer/anchorageLayer/pilotStationLayer` `PortScene.tsx:23-35,174-190`; nav-status symbolised `AISMap.tsx:88-95,390-397` | "Channel transit"/"pilot boarding ground" are geographic layers, not per-vessel symbolised states. 2D Weather + Channel/Bathymetry layers are empty placeholders (`AISMap.tsx:11-13`). | M | T2 |
| R-5 | [F][O] | **FAIL** (needs backend for enforcement; role-scoping UI buildable in-SPA) | No role state, no selector, no scoping, no enforcement. "role" strings are only ARIA + data-source descriptions. | **No RBAC of any kind.** The tender's headline stakeholder-matrix requirement (Marine Ops full / Terminal own berths / Shipping line own vessels / Pilot desk queue / read-only viewer) is entirely unmet. **Highest-risk functional gap.** Client-side role-scoping is buildable; true API enforcement needs a backend. | L | T1 |
| R-6 | [F][O] | **PARTIAL** | 8 fixed KPI cards `KpiStrip.tsx:17-26`; real-time + historical trend `bundle.ts:39-55`; targets `config/targets.ts`; pre/post framing labelled simulated `MethodologyPanel.tsx:172-181` | Only ~5 of 6 required KPIs are cards (K-5 Port-Craft is a board). **No custom-KPI builder** (pick metric/aggregation/target-band). Not admin-gated. | L | T2 |
| R-7 | [F][L][O] | **PARTIAL** | Port-craft roster + perf stats `PortCraftBoard.tsx:139-184`; weather/tide panels; DUKC+RTUKC `DukcCorridor.tsx` | Roster has no **assignment history** and no per-pilot performance-over-time. **Channel-depth layer has no dated bathymetry / survey-date watermark.** [L] tide/bathy/pilot have no live connector. | M | T1/T2 |
| R-8 | [F] | **PASS** | 3D SceneView with everything as Esri FeatureLayers (channel, anchorages, decks, berths, vessels) `PortScene.tsx:174-190`; 2D `<arcgis-map>` + GraphicsLayers `AISMap.tsx:228-236`; glTF assets `portAssets3d.ts` | Chart.js KPI charts sit beside the map in tabs — but those are KPI charts, not the geospatial layer; GIS-native ingestion holds for spatial data | — | — |

### 1.3 KPI set (each expected: correct unit, definition tooltip, computation-methodology page, drill-down, trend, target band)

| ID | Status | Evidence | Gap (against the six-facet card standard) | Fix | Tier |
|---|---|---|---|---|---|
| K-1 JIT arrival | **PARTIAL** | Half-gauge + trend + target tick `JustInTime.tsx:20-97`; formula `kpi/formulas.ts`; % unit; labelled simulated | No definition tooltip · no per-KPI methodology page · no drill-down | M | T2 |
| K-2 Pre-Sailing Delay | **PARTIAL** | `bundle.ts:113-117`; trend `DelayTrend.tsx` (target line 51-58); unit h; target `targets.ts:22` | In KPI strip but no dedicated panel; no tooltip/methodology/drill-down | M | T2 |
| K-3 Pre-Berthing Delay | **PARTIAL** | Card + panel `App.tsx:232-234`; `DelayTrend` target band; formula `formulas.ts` | No tooltip · no methodology page · no drill-down | M | T2 |
| K-4 Avg Vessel TAT | **PARTIAL** | Card + panel `App.tsx:235-237`; `DelayTrend field=AVG_TAT`; target 24h `targets.ts:23` | No tooltip · no methodology page · no drill-down | M | T2 |
| K-5 Port-Craft optimisation | **PARTIAL** | Resource board + utilisation + conflicts + simulated-delta recommendation `PortCraftBoard.tsx:139-355` | **Not a first-class KPI card** (absent from `KpiBundle` `types/kpi.ts:32-41` and `KpiStrip`); it's a board. No unit/target-band/trend/drill-down as a KPI. | M | T2 |
| K-6 Prediction-vs-real-time convergence | **PARTIAL** | Living convergence view w/ rolling MAE + MAPE, on-target band, per-tick `PredictionConvergence.tsx:75-269`; card `bundle.ts:128-132` | Rolling error is a **single aggregate, not per-horizon**; MAPE denominator is fixed `ISSUE_HORIZON_H`, not actual (`:142`). No methodology page beyond an inline caption. | M | T2 |

### 1.4 What-if & workflows

| ID | Status | Evidence | Gap | Fix | Tier |
|---|---|---|---|---|---|
| W-1 Scenario library | **PARTIAL** | All 5 named scenarios (monsoon hold, channel draft, berth outage, pilot shortage, bunching) runnable from UI, parameterized `sim/scenarios.ts:39-111`, `ScenariosPanel.tsx:142-195` | **"twin-vs-shadow deltas" is mostly narrative prose** ("Simulated: …"); real computed deltas exist only in gantt-replan (`BerthGantt5Day.tsx:180-205`) and craft board, not per-scenario | M | T2 |
| W-2 Reactive Causality Guide | **PASS** | Full WHICH/WHERE/HOW/WHY/WHAT-NOW over a real causal DAG `whatif/ReactiveGuide.tsx:118-415`; mechanism edges `whatif/causalGraph.ts:30-84`; map fly-to `:195-198` | WHICH ranked by chain order not quantified magnitude (labelled simulated `:282-284`); interventions are a static playbook, not computed effects | S | T3 |
| W-3 Workflow composer | **FAIL** (buildable in-SPA) | AUTO/ADVISORY governance + run ledger + ack/apply `workflow/workflowStore.ts:83-122`, `WorkflowRuns.tsx` | **No composer.** Triggers are 4 hardcoded buttons (`WorkflowRuns.tsx:39-92`). No build-in-UI trigger→conditions→actions, no save, no versioning, no per-workflow enable/disable. It fires canned workflows; it does not author them. | L | T1 |
| W-4 Berth-allocation replanning | **PARTIAL** | Drag-to-replan Gantt `BerthGantt5Day.tsx:151-205`; DUKC feasibility bands `derive.ts:99-124`; do-nothing-vs-replan caption `:414-447` | **Invalid moves are NOT rejected** — drag always succeeds; a no-go drop is only *labelled*, never blocked with a named constraint. No LOA-vs-length check, no pilot/tug-availability check. Drag is time-only (no cross-berth reassignment). | M | T1 |

**Part 1 tally:** PASS 6 · PARTIAL 13 · FAIL 2 (R-5, W-3). Two structural: **R-5 (roles+enforcement)** and connector breadth **R-1/R-2**.

---

## 3. PART 2 — GLOBAL-STANDARD COMPETITIVENESS

**`docs/COMPETITIVE_PARITY.md` does not exist.** (`docs/` holds only `ARCHITECTURE.md`, `GO_LIVE_INTEGRATION.md`, `KPI_DEFINITIONS.md`.)

| ID | Status | Evidence | Gap | Fix | Tier |
|---|---|---|---|---|---|
| C-1 JIT arrival orchestration | **FAIL** (buildable in-SPA) | JIT% gauge + trend `JustInTime.tsx:57-98`; "recommended slot" is aliased to `PLANNED_START` `kpi/bundle.ts:79`; re-sequencing is prose in `ReactiveGuide.tsx:35-68` | No per-inbound recommended-RTA from berth avail + tidal/DUKC window + pilot/tug schedule; no "steam slower / arrive just-in-time" advisory; no simulated bunker/emission savings; no per-vessel RTA update log | L | T2 |
| C-2 DUKC-class computation | **PARTIAL** | **Strong core:** Barrass squat `Cb·V²/100` (`dukc/ukc.ts:56-59`), water column `available=charted+tide`, `required=draft+squat+margin` (`:61-80`); assumptions register `config/assumptions.ts:30-33`; per-transit UKC profile + go/no-go windows `DukcCorridor.tsx:108-158,301-334`; `tidalWindows()` walks the tide curve `ukc.ts:109-151` | **Sensitivity view absent** (no draft ±0.2 m / tide ±0.1 m controls). Single squat formula, no comparison. | M | T2 |
| C-3 Berth-planning optimisation | **FAIL** (buildable in-SPA) | Manual drag-to-replan with feasibility shading `BerthGantt5Day.tsx:151-205` | **No optimiser:** no "optimize" button, no objective function (min weighted waiting + tidal-window misses + shifting moves), no auto-generated conflict-free proposal. Human drags; tool only classifies the result. | L | T2 |
| C-4 ML ETA with uncertainty | **FAIL** (buildable in-SPA) | Predicted-vs-realised over shrinking horizon `PredictionConvergence.tsx`; deterministic seeded ±2h residual `:98-105` | No ETA **distributions** (no p10/p50/p90); the "band" is a fixed ±0.5 h ribbon (`ON_TARGET_BAND_H=0.5`), not a horizon-dependent confidence band; no degradation-when-AIS-stale; no model cards | L | T2 |
| C-5 Port-call timestamp discipline | **PARTIAL** | ATA/ATB/ATD-equivalents in domain model `types/domain.ts:79-82`; formulas define ATA/ATB/ATD/cargo-complete `kpi/formulas.ts:8-30,56-61` | Only a 4-event skeleton. **No standard port-call vocabulary** (pilot on board / first line / all fast / last line / pilot off); no per-vessel timestamp-ladder UI; RTA/ATA not distinct events | M | T2 |
| C-6 Resource orchestration | **PARTIAL** | Pilots/tugs/mooring as finite resources: utilisation + `detectConflicts` `PortCraftBoard.tsx:95-122` + one swap recommendation `:139-184`; scenario levers knock units offline `derive.ts:53-67` | Conflict/swap is a **snapshot heuristic, not a scheduled timeline** — no time-phased bookings, no finite-slot calendar, single swap suggestion | M | T2 |
| C-7 Historical analytics | **FAIL** (buildable in-SPA) | Time-series only: `DelayTrend`, `ArrivalsDepartures` (4h bars), JIT trend, `PredictionAccuracy` | No berth-occupancy **heat calendar**, no waiting-time **distribution/histogram**, no **terminal-wise TAT comparison** (`BERTH_OCC` exists only as a scalar snapshot `domain.ts:111`) | L | T2 |

**Part 2 parity gap table:**

| Capability (category leader) | What we match | What we simplify | What production adds | Status |
|---|---|---|---|---|
| DUKC dynamic UKC (OMC) | UKC from first principles, Barrass squat, per-segment profile, go/no-go tidal windows | Single squat formula; static bathymetry; no sensitivity sweep | Certified UKC service + live survey feed + sensitivity | **PARTIAL** |
| Berth optimiser (Portchain) | Constraint-aware Gantt, drag replan, feasibility shading | No solver/objective — manual only | MILP/heuristic optimiser + accept/edit loop | **FAIL** |
| JIT arrival (PortXchange / IMO-GIA) | JIT% KPI, convergence view | No RTA recommendation engine, no bunker/emission model | Full RTA orchestration + advisory | **FAIL** |
| ML ETA (Awake.AI) | Prediction-vs-actual convergence, rolling MAE/MAPE | Point estimates, fixed tolerance band | Distributional ETA + confidence bands + model cards | **FAIL** |
| Ship-shore data exchange (Wärtsilä Navi-Port) | Port-call event fields in model | No standard event vocabulary / timestamp ladder | S-100/port-call-message-standard adoption | **PARTIAL** |
| Resource orchestration | Finite-resource utilisation + conflict + swap | Snapshot heuristic, not scheduled | Time-phased scheduler | **PARTIAL** |
| Historical analytics | Time-series trends | No heat calendar / distributions / terminal compare | Full analytics workbench | **FAIL** |

**Honest-parity documented:** 0 of 7 (no `COMPETITIVE_PARITY.md`). **Strong core to build on:** C-2 (DUKC), C-4 (convergence view). **Missing headline:** C-3 optimiser, C-1 JIT orchestration.

---

## 4. PART 3 — LIVE-READY CONNECTOR ARCHITECTURE

| ID | Status | Evidence | Gap | Fix | Tier |
|---|---|---|---|---|---|
| A-1 Driver interface per source (Mock/Replay/Live) | **FAIL** (partly buildable in-SPA; live drivers need backend) | Abstraction is **per-app, not per-source**: one `DataAdapter` (`data/types.ts:70-113`) with two impls — `MockAdapter` + `ArcGISAdapter` — selected by build-time env `data/index.ts:18-26`. `REPLAY` is a declared enum value `sources.ts:12` but never functional. Switching needs a rebuild, not an admin toggle. | No 3-driver-per-source model; no ReplayDriver; no per-source no-redeploy switch in an admin UI | L | T1 |
| A-2 Connector Readiness page | **FAIL** (buildable in-SPA) | The only integration surface is `IntegrationConsole.tsx` — a slide-over that **injects faults over the SIM store** (its own comment `:11-13`: "no network, no real vessel identities"). Shows per-source rung + latency slider + operator-action log. | No contract version, no real driver status, no credential status, no last-health-check, no sample-payload validator, no per-connector go-live checklist. "System complete; awaiting N credentials" view does not exist. **This is the tender's money screen for a 'ready solution provider' and it is absent.** | L | T1 |
| A-3 Contract tests / fixtures / drift | **FAIL** (buildable in-SPA + CI) | Tests are pure-logic only; **no CI** (no `.github/workflows`); **no schema lib** (no zod/ajv/yup in `package.json`). `types/schema.ts` is static ArcGIS field defs, not a runtime validator. | No recorded/synthetic per-source fixtures validated against JSON-schema contracts in CI; no drift detection | L | T1 |
| A-4 Credential vault | **FAIL** (needs backend) | All secrets are **plaintext build-time Vite env vars** (`data/config.ts:88-104`); `.env.example` + `GO_LIVE_INTEGRATION.md:178-183` both state they **ship in the client bundle**. `.env` currently blank (mock). | No vault: no encryption at rest, no admin-UI management, no masked display, no rotation. The design is the opposite of the requirement. **Audit memo §103 records previously-committed AISStream token + `ARCGIS_USER`/`ARCGIS_PASS` — treat as exposed, rotate.** | L | T1 |
| A-5 Ingest resilience per source | **FAIL** (needs backend for real ingest) | Live AIS is a bare WebSocket with **no resilience**: `openAisStream` `aisstream.ts:148-199` `onerror`/`onclose` only report state — no reconnect, no backoff. `'reconnecting'` state `types.ts:30` is never emitted. Weather has a single `.catch(()=>null)` `weather.ts:42`. | No timeout/retry + backoff/jitter, no circuit breaker, no rate-limit compliance, no message-ID dedup, no event-time windowing, no idempotency, no dead-letter queue + admin replay | L | T1 |
| A-6 Data-quality firewall | **FAIL** (buildable in-SPA) | Boundary mapping does **coercion, not validation**: `attrToVessel` `ArcGISAdapter.ts:74-89` + AIS mappers coerce with `Number()/String()` and silently swallow malformed frames (`aisstream.ts:178` `catch {}`). Console amber badges are operator-injected. | No schema validation at boundaries, no range/sanity checks, no quarantine bin + reason codes, no per-source DQ score, no DQ-driven amber propagation to KPI cards | L | T1 |
| A-7 Graceful degradation & recovery | **PARTIAL** (simulated only) | The *concept* is well modelled: fallback ladder LIVE→DEGRADED→CACHED→IMPUTED→OFFLINE with staleness notes `sources.ts:20-25,113-126`; reconciliation audit log `IntegrationConsole.tsx:188-254`; `degradedSince` watermark `useDataModeStore.ts:27` | **All operator-toggled UI over a Zustand store — no real mechanism.** No actual last-known-good cache on feed drop, no real imputation with widening bands, no manual-entry fallback *forms* (role-gated/audited), no buffered-event reconciliation on genuine recovery, no reconciliation *report*. The "recovery" entry is stamped on an operator click, not on feed restoration. | L | T1 |

**Part 3 tally:** 0 PASS · 1 PARTIAL (A-7, simulated) · 6 FAIL. **Every item requires net-new infrastructure** (vault service, CI harness, resilient ingest layer, DQ firewall, real degradation cache) with no current foundation. The strong integrity framing (everything labelled "simulated under stated assumptions") is genuine, but it does not substitute for the absent live/vault/CI/DLQ infrastructure the tender asks about here.

---

## 5. PART 4 — STAKEHOLDER OPERABILITY & DEPLOYABILITY

| ID | Status | Evidence | Gap | Fix | Tier |
|---|---|---|---|---|---|
| O-1 Admin console (users/roles, connectors, thresholds, workflow enable/disable, assumption editing + audit, branding) | **FAIL** (mixed) | No admin/settings/branding UI. KPI thresholds hardcoded `config/targets.ts:20-29`; assumptions hardcoded `config/assumptions.ts:23-34`; workflow has only a **global** AUTO/ADVISORY `setMode` `workflowStore.ts:88` (no per-workflow toggle); "connector management" is env-var + rebuild | User/role/MFA/password-reset + tamper-evident assumption-audit **need a backend**. Threshold/assumption/branding editors + workflow enable/disable are **buildable in-SPA** (mock store). | L | T1 |
| O-2 First-run wizard + per-persona tours + contextual help + searchable Help Centre | **FAIL** (buildable in-SPA) | `GuidedTour.tsx` is a **single scenario walk-through**, not per-persona; no first-run wizard; **zero `CalciteTooltip`/contextual help** anywhere; no Help Centre / in-app manual | All buildable in-SPA (static content + client search); none exist | L | T1/T2 |
| O-3 Notifications: in-app + email/SMS drivers (mock) + per-user prefs | **FAIL** (mixed) | Only "notifications" are workflow-ledger text + a scenario narrative string; no SMTP/SMS/twilio/sendgrid; no per-user prefs | In-app toasts buildable in-SPA. Email/SMS drivers + per-user prefs **need a backend** (and a user store). | M | T2 |
| O-4 Tamper-evident audit (who/what/when/before-after, hash-chained, filterable, export) | **FAIL** (needs backend for real) | The only "audit log" `useDataModeStore.audit:31-40,82-113` logs **source-rung transitions only** — no actor ("who": no users), no hash chain, in-memory cap 200 (lost on reload), no export | A true tamper-evident audit **requires a server-side append-only store** (a client hash-chain is forgeable and non-durable). A mock viewer is buildable but not compliant. | L | T1 |
| O-5 Localisation-ready strings + IST label + DD-MM-YYYY | **FAIL** (buildable in-SPA) | **No i18n** (all strings inline); `util/format.ts:3` uses a naive fixed `+5.5h` (not `Asia/Kolkata`), outputs carry **no "IST" label** and are **not DD-MM-YYYY**; only `exportReports.ts:15` appends "IST" but formats ISO `YYYY-MM-DD` | String externalisation + global "IST" label + DD-MM-YYYY are fully buildable in-SPA; currently non-compliant | M | T3 |
| D-1 One-command install (docker/script), idempotent, air-gap, HW sizing, TLS, non-root | **FAIL** (needs backend/packaging) | No Dockerfile/compose/install script; only `npm install && npm run dev` / static `dist/`. Dev-only self-signed TLS `vite.config.ts:12-15`; production TLS deferred to operator `GO_LIVE_INTEGRATION.md:133` | A static SPA has no services to compose; a Dockerfile serving `dist/` via nginx (+ HW sizing, non-root, TLS instructions) is buildable but absent | M | T1 |
| D-2 Health & monitoring: `/health` + System Health page + alert rules | **FAIL** (needs backend) | No `/health` (no server); no System Health page; closest is per-source rung dots (operator-injected demo state) | `/health` per service **impossible without services**; a read-only client-observable status page is buildable but shows no disk/memory/queues | M | T2 |
| D-3 Backup/restore (scheduled, tested drill, retention) | **FAIL** (needs backend) | No DB/config/audit to back up; only `simStore.restore()` rehydrates sim UI state from sessionStorage | **Impossible without a backend + datastore.** Nothing to back up in a static SPA. | L | — |
| D-4 Update path (versioned releases, migrations, rollback, release notes, staging) | **FAIL** (mixed) | Version stuck `0.1.0` `package.json:4`; no CHANGELOG/migrations/rollback/staging | Migrations/rollback **need a DB**; release-notes template + version bump + staging config buildable, absent | M | T3 |
| D-5 Log management (structured JSON, rotation, admin levels, no PII, SIEM hook) | **FAIL** (needs backend) | No logging framework; exactly **one** `console.warn` `basemapFallback.ts:88` | Structured server logs/rotation/SIEM **impossible in a browser SPA**; a client telemetry hook buildable, absent | M | T2 |
| D-6 Security hardening (authn/authz, input validation, CSRF/XSS/SQLi, headers, dep-audit, secrets scan) | **FAIL** (mixed) | **No authn/authz** (auth deleted); no routes to protect. XSS: export escapes fields `exportReports.ts:49-51`. **No CI → no secrets scan / dep-audit gate.** `npm audit`: **8 vulns (2 critical/1 high/5 moderate)** in the dev/build chain (not in `dist/`); `--omit=dev`: 2 moderate (`ajv` ReDoS via `@arcgis/charts-components`) | authn/authz half **needs a backend**; dep-audit + secrets-scan-in-CI buildable now (add workflows) but absent; CVEs unremediated | L (auth XL) | T0 (CVE) / T1 |
| D-7 Docs set (Operator, Admin, Connector, Troubleshooting, DR/Backup, Security) in-app + PDF | **PARTIAL** | `docs/` has `ARCHITECTURE.md`, `GO_LIVE_INTEGRATION.md` (≈ Connector guide), `KPI_DEFINITIONS.md` + root `README.md` | ~1 of 6 required docs partially exists; no Operator/Admin/Troubleshooting/DR/Security docs; no PDFs; nothing in-app | M/L | T2 |
| D-8 Cold-handover UAT `docs/UAT_HANDOVER.md` | **FAIL** (blocked by missing features) | File does not exist; only `UC1_VTM_PoC_QA_Checklist (1).md` (demo QA, not handover) | File absent, **and** half its steps (create user, import plan, backup, restore) have no feature to exercise | M | T3 (blocked) |

**Part 4 tally:** 0 PASS · 1 PARTIAL (D-7) · 12 FAIL. **~half the failures are structurally impossible in a static frontend** (O-1 users/MFA, O-3 email/SMS, O-4 tamper-evident audit, D-1/2/3/4/5 infra, D-6 authn/authz) and require the backend the programme assumes but the repo does not contain.

**Secrets scan (`src/` + `.env`): clean today** — no hardcoded credentials; `.env` sensitive vars all blank; `.env` git-ignored and untracked. (Historical exposure per audit memo §103 stands — rotate.)

---

## 6. PART 5 — EDGE-CASE COVERAGE

Only **7 test files** exist, all under `kpi/`, `dukc/`, `data/`. No tests for sim, whatif, workflow, provenance, security, map, or any component. No e2e/Playwright. "handled+tested" awarded only where a concrete test assertion covers the behaviour.

| Subsection | handled+tested | handled-only | not-handled | Notes |
|---|---|---|---|---|
| 5.1 AIS/position-feed (16) | 0 | 1 | 15 | Ingest path essentially unguarded: no teleport/SOG/heading/null-island/staleness/cross-source-dedup/backpressure. `mapAisMessage` defaults bad coords to (0,0) rather than rejecting `aisstream.ts:109-110`; **no WebSocket reconnect at all** `:196`. |
| 5.2 Tide/weather/bathy (7) | 0 | 1 | 6 | Only pilotage-hold-on-extreme-wind is handled (`derive.ts:39-43`, unclamped). No survey-date watermark, no unit guard, no gap-interpolation. |
| 5.3 UKC/berth-planning (12) | 1 | 1 | 10 | **Strongest tested area:** UKC≤0 hard-block tested (`ukc.test.ts:15-19`); worst-segment (controlling-depth) evaluation handled. But no LOA/beam-fit, no berth-time overlap, no plan-import, no pilot double-assignment guard. |
| 5.4 KPI/analytics math (11) | 3 | 3 | 5 | **Genuinely solid + tested:** empty→no-NaN, div-by-zero on all ratios, prediction-accuracy-no-mature→0 (`helpers.ts`, `formulas.ts`). Missing: variance/percentile, TZ-boundary test, leap day, server-authoritative time. |
| 5.5 Concurrency/multi-user (6) | 0 | 0 | 6 | All not-handled (no auth/RBAC/multi-user; single-user local drag; no WS reconnect). |
| 5.6 Session/browser/client (11) | 0 | 5 | 6 | Handled: sessionStorage state restore (partial — camera/tab not persisted), numeric-coercion, print stylesheets, loading states, partial CVD via DUKC labels. Missing: router safety, zoom, browser matrix doc, skeletons. |
| 5.7 Data volume/longevity (6) | 0 | 0 | 6 | All not-handled (no DB, no soak harness, no backup). |
| 5.8 Security-adjacent (6) | 0 | 2 | 4 | Handled: ArcGIS token-death → offline basemap `basemapFallback.ts:73-116` + `?offline=1` rehearsal; print-path HTML-escaping. Missing: TLS monitoring, brute-force, role-claim, file-upload abuse. |
| 5.9 Operational/demo-day (5) | 0 | 4 | 1 | Handled: all-offline navigable, deterministic seed mode, always-on DATA_MODE banner, partial empty states. Missing: maintenance page. |
| **TOTAL (~80 line-items)** | **4** | **~17** | **~59** | |

**Edge-case coverage: 4 handled+tested / ~17 handled-only / ~59 not-handled.** All four tested items live in the pure-function core (KPI math + DUKC). The marine-logic edge cases the tender most cares about (5.1 AIS pathologies, 5.3 berth-planning conflicts) are the emptiest.

---

## 7. TOP 10 RISKS

1. **Scope inversion (the meta-risk).** The programme document describes hardening a deployed multi-service product; the artifact is a frontend demo. Executing Parts 3–4 literally is a *build-the-backend* project (auth, DB, vault, ingest, CI, containers), not a hardening pass. Proceeding without an explicit scope decision risks weeks of misdirected effort. **Owner action required — see §8.**
2. **R-5 RBAC entirely absent** — the tender's headline "berthing-plan visibility to all stakeholders, role matrix API-enforced" requirement has zero implementation. Demo-visible and audit-visible gap.
3. **Connector breadth is label-only (R-1/R-2, A-1/A-2).** Six AIS providers + INCOIS/IMD/MOSDAC are strings in `sources.ts`; only AISStream + Open-Meteo are real. The Methodology "production feed" table presents them as integrated — the biggest **claims-exceed-implementation** risk if a technical evaluator probes.
4. **No credential vault; secrets ship in the client bundle by design (A-4)** + historical token/password exposure (audit memo §103) not yet rotated.
5. **AIS ingest is unguarded (5.1)** — (0,0) null-island fabricated rather than rejected, no teleport/SOG sanity, no reconnect. On a live feed this corrupts the twin silently.
6. **No real degradation mechanism (A-5/A-7).** The acclaimed fallback ladder is operator-toggled theatre over a store; a genuine feed drop has no last-known-good cache, no reconnect, no reconciliation.
7. **"Optimize" is claimed but absent (C-3, W-4).** Berth planning is manual drag with classification; invalid moves are labelled, not rejected. A category-leader comparison exposes this.
8. **Zero automated coverage outside pure math** — sim, workflow, provenance, map, security untested; ~59 edge cases unhandled. No e2e. No CI to keep any of it green.
9. **Cold-handover (D-8) is unachievable today** — half its steps (create user, import plan, backup, restore) have no feature to exercise. Loop 3's acid test cannot pass without T1 features first.
10. **Build-chain CVEs (D-6)** — 2 critical / 1 high in dev tooling (not shipped in `dist/`, but fail a naive `npm audit` and any CI gate); 2 moderate reach the bundle via `ajv`/charts.

---

## 8. EXECUTIVE SUMMARY & READINESS

### Current readiness (weighted against the full programme, backend items included)

| Part | PASS | PARTIAL | FAIL | N-A | Approx. credit |
|---|---|---|---|---|---|
| 1 Functional (21) | 6 | 13 | 2 | 0 | ~55% |
| 2 Parity (7) | 0 | 3 | 4 | 0 | ~30% |
| 3 Connectors (7) | 0 | 1 | 6 | 0 | ~10% |
| 4 Operability/Deploy (13) | 0 | 1 | 12 | 0 | ~8% |
| 5 Edge cases (~80) | — | — | — | — | ~26% handled |

**Current production-readiness: ≈ 25–30%** against the programme as literally written (which counts a full backend). **Against "a compelling, honest, demo-ready UC-1 simulation front-end," the same codebase is ≈ 75–80%** — the gap is almost entirely the backend/operability/live-infra tiers, not the demo surface.

**Projected post-hardening readiness depends entirely on the scope decision below.**

### The decision that gates Loop 2 (this is the STOP)

The programme cannot be executed as-written without first choosing a track, because Parts 3–4 assume infrastructure that does not exist:

- **Track A — Frontend-deep (recommended for a PoC/demo timeline).** Deliver everything **buildable in-SPA** with mock stores: client-side RBAC scoping (R-5), plan CSV/XLSX import + manual entry (IU-2), workflow composer (W-3), custom-KPI builder (R-6), Connector Readiness page + per-source driver-status UI with mock/replay drivers (A-1/A-2), DQ firewall + validation at boundaries (A-6), AIS ingest guards + reconnect (5.1), berth-constraint rejection + optimiser (W-4/C-3), JIT/RTA advisory (C-1), historical analytics (C-7), i18n + IST/DD-MM-YYYY (O-5), the docs set (D-7), and a Dockerfile serving `dist/` (D-1). **Projected: ≈ 70–75%** of the full programme; **≈ 95%** of a demo-credible UC-1. Marine logic, connector-readiness story, and operability all become real; backend-only items (real vault, tamper-evident server audit, `/health`, scheduled backups, server-side authz) remain honestly documented as "production adds."
- **Track B — Full-stack productisation.** Stand up a real backend (auth server + user/role DB, credential vault, persistent tamper-evident audit, resilient ingest workers, `/health`, backup/restore, CI, containers) to close Parts 3–4 literally. **Projected: ≈ 90–95%**, but this is a multi-week engineering programme, not a hardening pass, and changes the nature of the deliverable.

**Recommendation:** **Track A**, sequenced by the tiers already assigned in §2–6 (T0 CVEs → T1 connector-readiness UI + RBAC scoping + marine-logic edges + plan import + workflow composer → T2 competitiveness + docs → T3 localisation/polish), with every backend-only item explicitly listed in `docs/COMPETITIVE_PARITY.md` and the Connector Integration Guide as "production adds," never silently claimed. This keeps the app runnable at every step and makes "we are only waiting for live connections" **literally true for the buildable surface**, while being honest that a production deployment also adds the server tier.

### What is genuinely strong today (preserve, do not rebuild)
- DUKC/RTUKC engine (`dukc/ukc.ts`) — first-principles, tested, defensible.
- KPI engine (`kpi/*`) — div-by-zero/empty-state/MAPE guards, 56 passing tests.
- Reactive Causality Guide (W-2) + prediction-convergence view (K-6) — real, non-trivial.
- Provenance/DATA_MODE discipline — every figure labelled simulated; honest framing throughout.
- Clean `DataAdapter` seam and deterministic seeded sim — the right architecture to extend.

---

## 9. STOP — AWAITING APPROVAL

Per the programme: **"Do not change code until the scorecard is approved."** No source files were modified in Loop 1 (only this scorecard and the existing read-only test/typecheck run).

**To proceed, please confirm:**
1. **Track A or Track B** (§8). Track A recommended.
2. Whether backend-only items (real vault, server-side tamper-evident audit, `/health`, scheduled backups, server-side authz, containers-with-services) should be **(a)** documented as "production adds" and deferred (Track A), or **(b)** built now (Track B).
3. Approval to begin **Loop 2, Tier 0** (remediate `ajv`/build-chain CVEs; any crash/data-integrity fixes) as the first, self-contained, test-accompanied change.

_Generated Loop 1, 2026-07-11. Evidence base: full static read of `src/` + read-only `tsc -b`/`vitest` (56/56 green). Data mode: assessment of a SIMULATED-mode PoC; no live data touched._
