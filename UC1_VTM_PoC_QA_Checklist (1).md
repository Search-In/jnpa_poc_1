# UC1 — Vessel Traffic Management & Optimization
## PoC QA / Demo-Readiness Checklist (ArcGIS Experience Builder build)

**Tender:** GEM/2026/B/7297343 · JNPA AI/ML-Enabled, Cyber-Aware Digital Twin
**Scope of this document:** QA of the UC1 PoC built on ArcGIS Maps SDK 5.x / Experience Builder + Calcite dark shell + Simulator Demo Console, ahead of the physical-mode PoC demonstration before the IIT expert panel.
**Target:** Lock all 10/10 marks for UC1 and over-deliver ("20/10") on the dimensions an expert panel rewards.

---

### How marks are actually awarded (the only scoring map that matters)

Per Appendix C / Corrigendum D.2, **each use case is marked out of 10**, split as five independent 2-mark criteria. You can lose a full 2 marks on any single criterion regardless of how good the others are, so the checklist is organised so **every item is tagged to the criterion it defends**.

| Tag | Criterion (verbatim) | Max |
|---|---|---|
| **[M1]** | Solution approach / Methodology, assumptions made | 2 |
| **[M2]** | Usage of AI/ML tools | 2 |
| **[M3]** | API/data integration plan, fall back mechanism in the event of unavailability of data | 2 |
| **[M4]** | Dashboard view & KPI monitoring | 2 |
| **[M5]** | What-if scenarios clearly demonstrating impact of interdependencies, automated workflow demonstrating reactive nature of the proposed JNPA Digital Twin | 2 |

**Appendix C requirement tags** (test every word — each is a scored pointer): `[R1]`–`[R8]` = the eight numbered Requirements; `[BC1]`–`[BC4]` = the four Intended-Use/Business-Context items; `[KPI]` = the six mandated KPIs; `[ACC]` = Acceptance Criteria.

**Severity / priority tiers:**
- **[MUST]** — omission costs you the 2 marks on that criterion. Non-negotiable.
- **[STRONG]** — separates a 7–8/10 from a 10/10. Expert evaluators look for these.
- **[EDGE]** — the over-delivery that earns the "wow" and the headroom. Optional but high-leverage.

**Pass states:** `[ ]` not checked · `[~]` partial / with caveat · `[x]` verified on the actual demo build, on the actual demo machine.

> **Golden rule for this panel:** 11+ IIT domain experts will not reward screenshots and claims — they reward a *live, reactive, traceable* system where every number on screen can be traced to a source and every "improvement %" can be traced to a stated baseline. Build and test to that bar.

---

## 0. Pre-conditions & test-environment integrity

- [ ] **[MUST]** The build under test is the **exact** artefact that will run on demo day (same branch, same commit, same machine/browser). No "it works on my other laptop."
- [ ] **[MUST]** `DATA_MODE` switch is present, explicit, and visible to the operator (`LIVE` / `MOCK` / `REPLAY`). No silent mocking — honest API-boundary handling per project principle.
- [ ] **[MUST]** App loads cleanly with **zero console errors** and zero failed network requests (open DevTools → Console + Network, hard-reload, confirm).
- [ ] **[MUST]** No secrets in client: ArcGIS API key / AIS API key / weather key are **not** exposed in page source, network calls, or app JSON config (proxy or token-served).
- [ ] **[STRONG]** App runs on a **clean profile / incognito** (no cached login, no extensions) to mirror the JNPA projector machine.
- [ ] **[STRONG]** Tested on the **two browsers** most likely on-site (Chrome + Edge) at projector resolution (1920×1080) and on the video-wall aspect if applicable. (You hit a Mermaid v11 render bug before — cross-browser rendering is a known risk; verify.)
- [ ] **[STRONG]** ArcGIS trial-account quota / token expiry checked — confirm the trial does **not** lapse or throttle mid-demo window.
- [ ] **[EDGE]** A **fully offline / poor-Wi-Fi** path exists: `MOCK`/`REPLAY` dataset that *looks* live (moving vessels, ticking clock) so a dead conference-hall network never kills the demo.
- [ ] **[EDGE]** Backup: second machine pre-loaded + a recorded screen-capture of the full happy-path as last-resort fallback.

---

## 1. [M1] Solution approach, methodology & assumptions

*This criterion is partly earned by what's on screen and partly by your narration/deck — but the panel cross-checks the two. The PoC must visibly embody the methodology.*

- [ ] **[MUST]** An **Assumptions Register** is visible in-app (panel/tab) or on a companion slide, listing every assumption (e.g., "5-day-ahead berthing schedule simulated from sample data," "open AIS feed used in lieu of JNPA VTS for PoC," "baseline TAT = X hrs from JNPA public reports"). Appendix C explicitly requires assumptions to be *clearly listed*.
- [ ] **[MUST]** The on-screen story maps to the stated method: **ingest → fuse → predict → visualise → decide → act (automated workflow)**. The panel should be able to point at the screen for each stage.
- [ ] **[MUST]** Methodology framing states UC1 delivers **predictive optimization + automated workflows**, not mere visualisation (JNPA's own clarification answer to "visibility vs recommendations" was *Predictive Optimization and Automated Workflows* — match it).
- [ ] **[STRONG]** Scope boundary is explicit: PoC-grade open APIs now, JNPA VTS/HMS/POS/FOCUS/SAP at production — shown as a labelled "PoC vs Production" data-source map so the panel sees you understand the real integration surface.
- [ ] **[STRONG]** Each assumption carries a **justification** (Appendix C: "bidder can assume required data giving valid justification"). An assumption without a reason reads as a gap.
- [ ] **[STRONG]** A one-line **traceability statement** per major feature back to Appendix C requirement number (reinforces the "no invented content" discipline and signals rigour).
- [ ] **[EDGE]** A visible **architecture-to-PoC mapping**: which of the 7 logical layers / M01 Marine Twin sub-modules (AIS Tracking, Vessel ETA/ETB, Berth Planning, Channel & Depth Monitoring, VTMS Integration) this PoC exercises.
- [ ] **[EDGE]** "What-if" methodology (the simulation kernel) is named and its calibration basis stated (historical replay; QA acceptance ≤8% deviation on reference KPIs — your own committed bar).

---

## 2. [M3] Data sources, API integration & **fallback** (the most commonly-lost 2 marks)

> The criterion literally says *"fall back mechanism in the event of unavailability of data."* A PoC that breaks when an API is down scores zero here even if everything else is perfect. **Test the failure path harder than the happy path.**

### 2.1 AIS / vessel position [R1][BC1]
- [ ] **[MUST]** Real-time vessel positions render from a live AIS source (one of: AISStream / AISHub / Global Fishing Watch / AISdb / MarineTraffic / VesselFinder — i.e., the Appendix C suggestive list; **free/free-trial tier only** per PoC principle).
- [ ] **[MUST]** Positions **update** without manual refresh; movement is visible over the demo window (not a static snapshot dressed as live).
- [ ] **[MUST]** Vessel identity attributes present and correct: **MMSI**, name, type, **draft**, length/beam, **SOG (knots)**, **COG/heading (deg)**, nav-status, last-report timestamp.
- [ ] **[MUST]** Heading/COG drives marker **rotation** (ship icons point the right way) — a port expert spots wrong-way ships instantly.
- [ ] **[STRONG]** **Global visibility** demonstrated: at least one inbound vessel trackable on its *approach voyage* (beyond port limits), not only inside the harbour — Req 1 says "global visibility of the vessel."
- [ ] **[STRONG]** Feed cadence and freshness shown: a visible "last updated / data age" indicator; target **5-sec cadence, p95 latency ≤ 4 s** per your action-plan commitment.
- [ ] **[STRONG]** AIS geofiltered to JNPA AoI + approaches; no irrelevant global clutter on the demo extent.
- [ ] **[EDGE]** Redundancy story shown/narrated: primary AIS + secondary AIS (e.g., NavIC/DG-Shipping aggregator + commercial) — matches the resilience you committed.

### 2.2 VTS / VTMS & pilotage [R1]
- [ ] **[MUST]** VTS/Pilotage information layer present (even if PoC-simulated) and **fused** with AIS, not a disconnected layer.
- [ ] **[STRONG]** Where AIS and VTS disagree, a **correlation/reconciliation** behaviour is shown (your committed VTMS correlation ≥ 95%); panel may ask "which source wins?" — have the answer on screen.

### 2.3 Weather, tidal, channel depth / bathymetry [R2][R7][BC3]
- [ ] **[MUST]** Weather data integrated from an Appendix-C-listed open source (INCOIS / IMD / MOSDAC / Copernicus / S2Shores / ISRO-BHOONIDHI) **or** clearly-labelled JNPA sample data.
- [ ] **[MUST]** **Tidal data** displayed with correct units and **chart datum** reference; tide curve / next HW-LW shown.
- [ ] **[MUST]** **Channel depth / bathymetry** layer present and tied to chart datum (not arbitrary).
- [ ] **[STRONG]** Weather overlay includes wind (speed/dir), and at least one of wave/current/visibility — the inputs your ETA model claims to consume.
- [ ] **[STRONG]** **Cyclone / surge advisory** ingest path exists (feeds the cyclone what-if scenario in §11).
- [ ] **[EDGE]** Units localised and labelled everywhere: knots, metres (CD), °C, IST timestamps with timezone label, coordinates **WGS84** stated.

### 2.4 Berthing plan ingest [R5][BC2]
- [ ] **[MUST]** A **minimum 5-day-ahead** berthing schedule is loaded and visualised (Appendix C explicitly allows/expects ≥5-day for PoC).
- [ ] **[MUST]** Schedule is consumable by "all stakeholders" view (Req 5) — i.e., it's not buried; it drives the berth occupancy display.

### 2.5 Fallback mechanism — **test every one** [M3][MUST]
- [ ] **[MUST]** **Kill the AIS API** (block domain / pull network) → app must **degrade gracefully**: switch to `MOCK`/cached, show a clear banner ("Live AIS unavailable — showing last-known / simulated"), keep running. No white screen, no infinite spinner.
- [ ] **[MUST]** **Weather API down** → last-good cached values shown with stale-timestamp warning; KPIs/ETA still compute on cached inputs.
- [ ] **[MUST]** **Rate-limit (HTTP 429)** simulated → retry/back-off + cache-TTL behaviour visible, not a crash.
- [ ] **[MUST]** **Malformed / partial payload** (missing draft, null position, NaN) → record skipped or flagged, app does not throw.
- [ ] **[STRONG]** A **Fallback Matrix** panel/slide: for each data source — primary → secondary → cached → mock, with TTL. This is the exact artefact Appendix C asks bidders to submit ("APIs/data/infrastructure needed for pilot & fallback mechanism in case of non-availability").
- [ ] **[STRONG]** The fallback **transition is reversible** live: restore network → app re-attaches to live feed and clears the banner (proves it's real, not staged).
- [ ] **[EDGE]** Fallback events are **logged** (visible event log / toast history) — ties to the cyber-aware/audit theme the panel cares about.

---

## 3. [M2] AI/ML usage (must be *demonstrably* AI, not a lookup table)

> The panel are ML domain experts. "We use AI" with a static curve will be caught. Show the model, its inputs, its output, and ideally its confidence/error.

- [ ] **[MUST]** **Vessel ETA prediction** is a working model output, not a fixed field: changing an input (weather, speed, position) shifts the predicted ETA. Committed bar: **MAE < 30 min at T-24h**, back-test **MAPE < 12%** — surface at least one of these as on-screen model quality.
- [ ] **[MUST]** **Berth-planning optimiser** produces an allocation/sequence that *changes* when constraints change (tide window, draft, LOA, gang/crane availability). Committed objective: minimise pre-berthing delay & TAT; target **≥15% PBD reduction vs baseline**.
- [ ] **[MUST]** The technique is **named and correct** for each model (ETA: temporal-fusion/boosted regressor on AIS+met-ocean; berth: constraint-programming + ML + slot-packing). Wrong/buzzword technique labels lose credibility.
- [ ] **[STRONG]** **Prediction vs actual** shown for at least one vessel (predicted ETA vs realised) — this is also the `[KPI]` "Accuracy of prediction vs real-time."
- [ ] **[STRONG]** Model output carries **uncertainty**: ETA confidence interval / band, or optimiser objective score. Experts reward calibrated uncertainty.
- [ ] **[STRONG]** Clear separation of **rule-based vs learned** components (don't claim ML for what is a threshold rule; honesty scores with this panel).
- [ ] **[EDGE]** A minimal **MLOps note** visible/narrated: training window (e.g., 12 months historical AIS), retraining trigger, drift check — shows production-thinking, not a toy.
- [ ] **[EDGE]** Model **explainability**: top features driving an ETA shift (e.g., "current +0.8 kn, headwind 18 kn → +22 min").

---

## 4. GIS / ArcGIS Experience Builder build quality (the platform under test)

*ArcGIS is the mandated GIS platform [R8]. These are GIS-engineer-grade checks a port GIS reviewer will run.*

### 4.1 Map / scene fundamentals
- [ ] **[MUST]** Correct **basemap** (dark/ocean basemap consistent with Calcite dark shell), correct initial **extent** centred on JNPA + approaches, sensible min/max scale.
- [ ] **[MUST]** All layers in a **consistent CRS**; vessel points (WGS84) align correctly over basemap and over berth/channel layers (no projection drift / offset).
- [ ] **[MUST]** Data **ingested into the GIS platform** (Req 8) — vessels, berths, channel, anchorage are real feature/graphics layers, queryable, not a picture overlay.
- [ ] **[STRONG]** Scale-dependent rendering / clustering so the map isn't a blob at zoom-out and shows detail at berth zoom.
- [ ] **[STRONG]** **Approach traffic overlaid** with vessel positions and berth status on **one** view (Req 4 demands all three layered together).

### 4.2 Symbology & legibility
- [ ] **[MUST]** Vessel symbology encodes **status/type** (e.g., colour by nav-status: under-way / at-anchor / moored; or by vessel class) with a **legend**.
- [ ] **[MUST]** Berth polygons are **status-driven** (occupied / vacant / reserved / pre-berthing) and unambiguous on the dark theme (contrast checked).
- [ ] **[STRONG]** Channel/fairway, anchorage, turning circle, restricted zones drawn correctly to real port geometry (a port expert checks these against reality).
- [ ] **[EDGE]** Depth shown as graduated colour / contours with a readable depth legend at CD.

### 4.3 Widgets & interactions (Experience Builder)
- [ ] **[MUST]** **Pop-ups** on vessels and berths show the right attributes, formatted (no raw field names, no nulls shown as "null").
- [ ] **[MUST]** **Vessel list / table** widget stays in sync with the map (count and contents match).
- [ ] **[MUST]** **Search** (by vessel name / MMSI) and **filter** (by type/status) work and zoom/select correctly.
- [ ] **[STRONG]** **Time slider / temporal** control for the 5-day schedule and historical KPI trend works and is smooth.
- [ ] **[STRONG]** **Demo bookmarks / views** pre-saved (one per scenario) so navigation during the demo is one click, not fumbling.
- [ ] **[STRONG]** Selection sync across widgets: pick a vessel on the map → it highlights in the list, its ETA shows in the panel, its berth highlights.
- [ ] **[EDGE]** Calcite components consistent (panels, icons, action bars), keyboard-navigable, no broken/unstyled native controls breaking the dark theme.

### 4.4 GIS performance [ties to demo robustness]
- [ ] **[MUST]** Map interaction stays responsive with the full demo vessel count; **Twin/map view refresh ≤ 2 s**, **alarm/alert surfacing ≤ 500 ms** (your committed latency budgets).
- [ ] **[STRONG]** Live layer refresh updates geometry **without flicker / full redraw** (smooth vessel movement, not teleport).
- [ ] **[STRONG]** No memory leak over a 30–45 min run (leave it running; watch it not degrade — your demo + Q&A is ~that long).

---

## 5. [M4][R3][R4][R6] Real-time tracking dashboard & KPI monitoring

### 5.1 Real-time situational dashboard [R4][BC1]
- [ ] **[MUST]** Single command-centre view shows **vessel positions + berth status + approach traffic** together (Req 4) — the "Command & Control Centre dashboard" of Business Context (1).
- [ ] **[MUST]** **Pre-berthing status** visible per inbound vessel (Business Context 1).
- [ ] **[MUST]** **Berth occupancy** at-a-glance (which berths busy/free, with vessel names).
- [ ] **[STRONG]** Live counters: vessels at anchor, under pilotage, at berth, ETA-next-6h — and they reconcile with the map.

### 5.2 KPI dashboard — the six mandated KPIs [KPI][R6]
> Appendix C names exactly six. **Label them verbatim** — wrong wording is an avoidable own-goal with a literal-minded panel.

- [ ] **[MUST]** **Just-In-Time** — present, defined on-screen, expressed as **% improvement vs current baseline operations**.
- [ ] **[MUST]** **Pre-Sailing Delay** — present, % improvement vs baseline.
- [ ] **[MUST]** **Pre-Berthing Delay** — present, % improvement vs baseline. (Not "berthing delay" — exact label.)
- [ ] **[MUST]** **Average Vessel TAT** — present, % improvement vs baseline.
- [ ] **[MUST]** **Port Craft (Pilot/Tug/Mooring/performance) optimization** — present, % improvement vs baseline.
- [ ] **[MUST]** **Accuracy of prediction vs real-time** — present, % improvement vs baseline.
- [ ] **[MUST]** Every KPI shows **real-time value AND historical trend** with **pre- vs post-Digital-Twin** benchmark (Req 6 demands both pre- and post-Twin).

### 5.3 KPI integrity (where experts probe hardest)
- [ ] **[MUST]** Each KPI has a **stated baseline** with a **source** (JNPA public reports / ULIP / clearly-justified assumption). A "% improvement" with no visible baseline is the #1 way to lose credibility — the panel *will* ask "improvement over what?"
- [ ] **[MUST]** **KPI formula/lineage** is traceable: each KPI → its input fields → its data source. No KPI should be a hard-coded number.
- [ ] **[STRONG]** KPI values **react** when a what-if scenario runs (e.g., reorder berths → PBD% moves) — proves they're computed, not painted.
- [ ] **[STRONG]** Marine KPI **reports** generatable: Berthing Plan, Vessel Arrival & Departures (Req 3) — exportable view/report, not just on-screen.
- [ ] **[STRONG]** KPI definitions match marine convention (TAT = arrival-at-anchorage → departure; Pre-Berthing Delay = anchorage-wait attributable to berth unavailability; JIT = arrival timed to berth availability). A port expert checks the *definition*, not just the number.
- [ ] **[EDGE]** KPIs grouped along JNPA's five strategic dimensions (Efficiency/Visibility/Sustainability/Security/Strategic impact) for management framing — business-acumen signal.
- [ ] **[EDGE]** Sustainability tie-in: JIT/anchorage reduction → CO₂e saved (carbon-cost calculator) — connects to JNPA's CPPI-rank / green ambitions.

### 5.4 Pilotage, tug & port-craft [R7][BC3]
- [ ] **[MUST]** **Pilot availability & performance** displayed (Req 7) — roster/availability + a performance metric.
- [ ] **[MUST]** **Channel depth, weather, tidal data, DUKC & RTUKC** all displayed to JNPA (Req 7 — all five named items).
- [ ] **[STRONG]** **Tug/Pilot dispatch board** with assignment view and a **Manual Override Mechanism (MOM)** for the harbour master (your committed feature) — proves human-in-the-loop control.
- [ ] **[STRONG]** **Pilotage workflow** visualised through its stages: boarding station → channel → fairway → turning circle → berth approach, with pilot-card data / hazard alerts.

### 5.5 DUKC / RTUKC correctness (don't get this wrong in front of marine experts)
- [ ] **[MUST]** **DUKC vs RTUKC distinguished**: DUKC = *predicted/planned* under-keel clearance from tide + met-ocean **forecast**; RTUKC = *measured/live* clearance from real-time tide/sensor. They are not the same number and must not be conflated.
- [ ] **[MUST]** UKC computation is directionally correct: **available depth (charted depth + tide height at CD) − required draft (static draft + squat + heel + wave-response allowance) = UKC**, with a safety margin / % policy shown.
- [ ] **[STRONG]** A **negative/insufficient UKC** condition raises a clear alert (red) and feeds the tide-window logic for berth allocation.
- [ ] **[STRONG]** Squat increases with **speed and shallow-water ratio** — if squat is modelled, sanity-check it moves the right way when speed/depth change.
- [ ] **[EDGE]** Tide window for a deep-draft vessel computed and shown ("can transit channel only between HH:MM–HH:MM at HW") — high-value, very port-real.

---

## 6. [M5][BC4] What-if scenarios, interdependencies & automated reactive workflow

> This is the criterion that most separates winners. Appendix C/D.2 want *"what-if scenarios clearly demonstrating impact of **interdependencies**, automated workflow demonstrating **reactive** nature."* The General Guidelines also demand *"orchestration of multi-player, cross-domain, inter-dependent what-if scenarios."* A single-variable toggle is **not** enough.

### 6.1 Simulator Demo Console basics
- [ ] **[MUST]** A **scenario console** lets the operator inject a change (delay a vessel, change berth priority, drop a tide window, raise a cyclone advisory) and **run** it live.
- [ ] **[MUST]** Running a scenario produces a **visible, automatic** cascade on the map + KPIs + alerts — without the operator hand-editing downstream values.
- [ ] **[MUST]** A **baseline vs scenario** comparison is shown (before/after, side-by-side or delta) so impact is legible to the panel.

### 6.2 Interdependency / cascade (the "wow")
- [ ] **[MUST]** At least one scenario shows a **cross-effect chain**, e.g.: *deep-draft vessel + falling tide → UKC breach → channel transit deferred → berth slot reshuffled → pilot/tug re-dispatched → Pre-Berthing Delay KPI moves → downstream arrival re-sequenced.* The panel must **see** the dependency propagate.
- [ ] **[STRONG]** A **cross-domain** scenario touching UC2/UC3 even lightly (e.g., vessel bunching → yard/gate pressure) — directly answers the "multi-player, cross-domain" instruction and signals the integrated twin.
- [ ] **[STRONG]** Scenario library has **named, repeatable run-books** (your committed reference set, e.g., berth-priority change cascade; cyclone/surge advisory operational impact). At least **2–3 UC1 scenarios** rehearsed.
- [ ] **[EDGE]** Operator can author a **new** scenario live if the panel requests one (Appendix C warns: "JNPA will also ask for specific workflows … to evaluate capabilities"). Don't be caught flat-footed by an off-script ask.

### 6.3 Automated workflow / reactive nature
- [ ] **[MUST]** The twin **reacts**: a triggering condition auto-fires an alert/notification + a recommended action (e.g., "UKC breach forecast at 14:20 — recommend deferring transit / re-sequencing berth 7"). Reactive, not just descriptive.
- [ ] **[STRONG]** Recommended action is **actionable**: operator can accept/override (MOM) and the plan updates — closes the decide→act loop, matching JNPA's "Predictive Optimization and Automated Workflows" answer.
- [ ] **[STRONG]** Notifications have **severity + timestamp + clear owner** (who acts) — operational realism.
- [ ] **[EDGE]** A short **event timeline / audit trail** of "trigger → alert → recommendation → action" for the scenario, reinforcing the cyber-aware/auditable theme.

### 6.4 Simulation-ready platform [BC4]
- [ ] **[MUST]** Demonstrates "testing **berth allocation strategies** and evaluating **vessel scheduling** under various scenarios" (Business Context 4) — i.e., the optimiser can be re-run under different inputs and the schedule changes.
- [ ] **[STRONG]** Simulation calibration credibility: results stay within your stated **≤8% deviation** on reference KPIs; don't show implausible 60% gains that invite challenge.

---

## 7. Data-content correctness (sea-port domain QA — the expert's eye)

*These are the errors a 25-year port operator catches in five seconds and that quietly destroy credibility.*

- [ ] **[MUST]** Units sane and labelled: **SOG in knots** (not km/h), **draft/depth in metres at CD**, distances in NM where marine-appropriate, bearings in °T.
- [ ] **[MUST]** Vessel **draft ≤ available depth + tide** wherever a vessel is shown at/approaching a berth — no ships sitting in water shallower than their draft.
- [ ] **[MUST]** Timestamps in **IST** with timezone label; "last updated" never shows a future time or a frozen clock.
- [ ] **[MUST]** Vessel **type vs berth compatibility** is sane (container ship → container berth, not a liquid-bulk jetty).
- [ ] **[STRONG]** Geometry realism: anchorage where the real anchorage is; channel follows the real fairway; turning circle near the real basin. (Compare against the JNPA peripheral boundary you already have.)
- [ ] **[STRONG]** Berth count / IDs / names match a credible JNPA configuration (don't invent berths; label PoC-simulated ones as such).
- [ ] **[STRONG]** Tide phase consistency: if tide curve shows ebb, UKC and "available depth" trend down accordingly across the view.
- [ ] **[STRONG]** No two vessels occupying the **same berth** simultaneously unless explicitly a conflict the system is flagging.
- [ ] **[EDGE]** ETA monotonic sanity: a vessel slowing/anchoring shouldn't show an *earlier* ETA than when steaming.
- [ ] **[EDGE]** MMSI/IMO format validity (MMSI 9 digits) on any displayed identifiers.

---

## 8. Consistency, state & cross-widget reconciliation (manual-tester core)

- [ ] **[MUST]** **One source of truth:** vessel count and KPI values are identical across map, list, counters, and any report. No "12 on the map, 9 in the table."
- [ ] **[MUST]** Selecting/filtering in one widget reflects everywhere; clearing a filter restores full state.
- [ ] **[MUST]** Time slider position is consistent across all temporal widgets (move the clock → map + KPIs + schedule all move together).
- [ ] **[STRONG]** Scenario run → **reset** returns the app cleanly to baseline (critical for running multiple scenarios for the panel back-to-back).
- [ ] **[STRONG]** Re-running the same scenario yields the **same** result (deterministic for demo; or seed fixed) — no surprise variance in front of evaluators.

---

## 9. Negative, boundary & stress testing

- [ ] **[MUST]** **Zero vessels** in feed → empty-state message, not a crash or blank panic.
- [ ] **[MUST]** **One vessel with missing fields** (no draft / no name / null position) → handled gracefully, flagged.
- [ ] **[MUST]** **Network loss mid-session** → fallback engages (see §2.5), recovery on restore.
- [ ] **[STRONG]** **High vessel count** (stress the layer) → still ≤2s view refresh; clustering/generalisation holds.
- [ ] **[STRONG]** **Rapid scenario toggling** → no stuck state, no duplicated alerts, no leaked listeners.
- [ ] **[STRONG]** **Clock-edge cases:** day boundary, HW/LW crossing, 5-day schedule end — display stays correct.
- [ ] **[EDGE]** **Resize / projector aspect change** mid-demo → layout reflows without clipping panels off-screen.
- [ ] **[EDGE]** Browser **zoom 90–110%** → no overlap/clipping (presenters often zoom for the room).

---

## 10. UX, accessibility & demo-stage legibility

- [ ] **[MUST]** Calcite **dark theme** has adequate contrast for a projected room (test from the back of a room / at 50% brightness).
- [ ] **[MUST]** Panels don't overlap or hide the map's critical area; key KPIs visible **without scrolling** in the default view.
- [ ] **[STRONG]** **Role-based view** demonstrable (Harbour Master / Marine Controller / Viewer) — RBAC is a recurring evaluation theme across the bid.
- [ ] **[STRONG]** Loading and transition states are clean (skeletons/spinners, not flashes of unstyled content).
- [ ] **[EDGE]** Tooltips/labels explain any acronym on screen (DUKC, RTUKC, TAT, PBD) — the deck defines them but the *screen* should too, for self-evident demos.

---

## 11. Security / cyber-aware surface (the bid's signature theme)

- [ ] **[MUST]** Login via **MFA + RBAC** demonstrable (or at minimum a role gate) — the bid's Part-B demo explicitly surfaces "MFA and RBAC; audit log evidence for every privileged action."
- [ ] **[MUST]** **Audit log** captures privileged actions (override a dispatch, run a scenario, change a plan) with user + timestamp.
- [ ] **[STRONG]** No PII leakage in pop-ups/logs beyond what's needed (DPDP-aware framing).
- [ ] **[STRONG]** Transport security note: API calls over TLS; no mixed-content warnings on the demo page.
- [ ] **[EDGE]** A small "compliance overlay" the operator can toggle (DPDP/CERT-In/IEC-62443 posture) ties UC1 to the cyber-aware narrative the whole programme is sold on.

---

## 12. Evidence pack & traceability for the panel (closes the loop on M1/M3)

- [ ] **[MUST]** **Assumptions list** (printed + on-screen) — Appendix C requires it.
- [ ] **[MUST]** **API & fallback table** (printed) — Appendix C requires "APIs/data/infrastructure needed for pilot & fallback mechanism."
- [ ] **[MUST]** **KPI baseline & source sheet** — one line per KPI: definition, baseline value, source, formula. This single sheet pre-empts 80% of hostile questions.
- [ ] **[STRONG]** **What-if run-books** (one per scenario): trigger → expected cascade → KPIs affected → recommended action.
- [ ] **[STRONG]** **Requirement-to-feature traceability matrix**: Appendix C R1–R8 / BC1–BC4 / 6 KPIs → where each is demonstrated in the app. Hand this to the panel; it makes scoring you 10/10 effortless.
- [ ] **[EDGE]** A 60-sec **recorded** happy-path as insurance, and a printed one-pager "what you'll see" for each evaluator.

---

## 13. Day-of-demo dry-run (run this the morning of, on-site)

- [ ] **[MUST]** Full happy-path rehearsed end-to-end on the **actual demo machine + actual display** at the venue.
- [ ] **[MUST]** All bookmarks/scenarios load in the intended order in **one click** each.
- [ ] **[MUST]** Fallback path tested **on venue network** (or confirmed `MOCK`/`REPLAY` runs fully offline).
- [ ] **[MUST]** ArcGIS token / API keys valid for the full demo window (check expiry that morning).
- [ ] **[STRONG]** Clock/timezone correct on the machine (drives all "live"/"last updated" displays).
- [ ] **[STRONG]** Screen brightness, resolution, scaling set; panels legible from the back row.
- [ ] **[STRONG]** Console open once to confirm zero errors, then closed for the show.
- [ ] **[EDGE]** Roles for the team during demo assigned: driver, narrator, Q&A-catcher, backup-machine owner.

---

## Scoring self-audit (use before you call it "done")

For each criterion, you should be able to point at the **live screen** (not the deck) and a **printed artefact**:

| Criterion | "Live screen proof" you can point to | "Paper proof" in hand |
|---|---|---|
| **[M1]** Approach/assumptions | In-app assumptions panel + ingest→act flow | Assumptions list, traceability matrix |
| **[M2]** AI/ML | ETA/optimiser output changing with inputs + error/CI | Model card (technique, training, metrics) |
| **[M3]** API + fallback | Live feed + a *killed* API degrading gracefully | API & fallback matrix |
| **[M4]** Dashboard & KPI | 6 KPIs live, pre/post baseline, reacting to scenarios | KPI baseline & source sheet |
| **[M5]** What-if + reactive | Cross-dependency cascade auto-firing alert + action | What-if run-books |

> If any cell above is empty, that's where the marks leak. Fix the empty cell first.

---

*Built traceable to: Appendix C (UC1 Capability, Business Context 1–4, Requirements 1–8, six KPIs, Acceptance Criteria) and Corrigendum D.2 marking scheme; cross-checked against the consortium Technical Bid (M01 Marine Twin, AI/ML model SLAs) and the Implementation Action Plan (AIS 5-sec/≤4s, ETA MAPE <12%, VTMS ≥95%, Twin ≤2s/alarm ≤500ms, sim deviation ≤8%, dispatch board + MOM, pilotage/anchorage/weather workflows).*
