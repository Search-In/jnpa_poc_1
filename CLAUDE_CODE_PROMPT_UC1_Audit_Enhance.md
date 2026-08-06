# CLAUDE CODE PROMPT — AUDIT & SUPERIOR-QUALITY ENHANCEMENT OF EXISTING UC-1 PoC
## JNPA Digital Twin | Use Case I: Vessel Traffic Management & Optimization | GeM Tender GEM/2026/B/7297343

> **Role for you (Claude Code):** You are the principal engineer performing a forensic audit and then a disciplined, superior-quality upgrade of an EXISTING, working UC-1 PoC (ArcGIS Experience Builder / ArcGIS Maps SDK 5.x, Calcite dark shell). The PoC will be demonstrated live, offline-capable, in physical mode to an 11-member IIT PhD evaluation committee at JNPA. A version already works — your job is to make it bulletproof and impressive WITHOUT breaking what works.
>
> **Operating discipline — AUDIT FIRST, CODE SECOND:** Phase A produces reports only; you make ZERO code changes in Phase A. Phase B executes fixes/enhancements strictly in the approved priority order, one severity tier at a time, with a working demo maintained at the end of every work session. Never batch a P0 fix together with a P3 polish item in one change.

---

## PHASE A — FORENSIC AUDIT (deliverables: reports only)

### A0. Discovery & inventory (do this before judging anything)
1. Walk the entire repo. Produce `audit/00_INVENTORY.md`: directory map, tech stack + versions, build/run commands, external endpoints called at runtime, environment variables/secrets/tokens (flag every hardcoded credential), data files and their provenance, all feature pages/widgets and their entry points.
2. Locate and READ any existing project artefacts before forming opinions: the **156-item UC1 QA checklist**, demo scripts, assumptions docs, README, prior audit notes. Cross-reference: which checklist items are demonstrably passing today? Record per-item status (PASS / FAIL / UNVERIFIABLE / NOT-IMPLEMENTED) in `audit/01_QA156_STATUS.md`.
3. Run the app. Record a cold-start timeline (clone → running) and capture the default first-load view. Note anything requiring internet, and what breaks with network unplugged.

### A1. Tender-traceability audit — `audit/02_TRACEABILITY_MATRIX.md`
Build a requirement-by-requirement compliance matrix against Appendix C, Use Case I. Every row: requirement text (verbatim reference), where it is implemented (file/page/widget), evidence (screenshot instruction or reproduction step), status (FULL / PARTIAL / MISSING / MISREPRESENTED), and gap note. Rows must cover at minimum:

**Intended Use 1–4:**
- Real-time vessel positions + berth occupancy + pre-berthing status on a Command & Control dashboard.
- Berthing plan integration with **minimum 5-day-ahead schedule** visible to stakeholders.
- Display of **pilot availability & performance, channel depth, weather & tidal data, DUKC & RTUKC**.
- **Simulation-ready platform for testing berth allocation strategies** and vessel scheduling under scenarios.

**Requirements 1–8:**
- AIS feed integration (+ VTS/pilotage info + 3rd-party feed for global visibility) — for PoC via open-source APIs OR simulated adapters with identical contracts; check which we actually do and whether it is honestly labelled.
- Weather / tidal / channel-depth integration (INCOIS, IMD, MOSDAC-class sources or simulated equivalents).
- Marine KPI reports incl. Berthing Plan, Vessel Arrivals & Departures.
- Real-time vessel tracking dashboard: positions + berth status + **approach traffic overlaid**.
- Berthing-plan visibility to all stakeholders (role dimension!).
- KPI dashboard with all marine KPIs + **historical trend benchmarks pre- and post-Digital Twin** framing.
- Pilot availability & performance + channel depth + weather/tidal + DUKC & RTUKC display.
- GIS-platform ingestion (ArcGIS — confirm Esri-native data flow, not a bolt-on iframe).

**KPI coverage (all six must exist as first-class dashboard cards with correct units and honest framing):** Just-In-Time arrival, Pre-Sailing Delay, Pre-Berthing Delay, Average Vessel TAT, Port Craft (Pilot/Tug/Mooring) optimization, **Accuracy of prediction vs real-time**.

### A2. Scored-rubric readiness audit — `audit/03_RUBRIC_READINESS.md`
Score our own PoC harshly against the 5×2-mark scheme, per criterion: current estimated marks (0/1/2), what an evaluator sees today, what full marks require, gap list:
1. **Solution approach/methodology + assumptions** — is there an in-app Methodology & Assumptions panel? Is every assumed figure justified and sourced?
2. **AI/ML usage** — are there real models running (ETA, berth-occupancy forecast, TAT prediction), or hardcoded numbers? Model cards? Confidence intervals? A prediction-vs-actual convergence view (this is the direct answer to the "Accuracy of prediction vs real-time" KPI)?
3. **API/data integration plan + fallback on unavailability** — is there a per-source integration console with LIVE/SIM/DEGRADED/OFFLINE control? What visibly happens when AIS dies mid-demo? Stale-data watermarks? Reconciliation on recovery?
4. **Dashboard & KPI monitoring** — completeness, drill-downs, units, trend benchmarks.
5. **What-if + interdependencies + automated workflows (reactive nature)** — do scenarios exist? Do they demonstrate cross-domain interdependency (weather→tide→DUKC→berthing window→pilot/tug schedule→TAT)? Do automated workflows FIRE VISIBLY (notification, map pulse, ledger entry)?

### A3. Demo-integrity audit — `audit/04_INTEGRITY.md`
- **DATA_MODE:** Is a persistent SIM/REPLAY/LIVE provenance banner present on every screen and per data source? Any state where mock data could be mistaken for live? (Mandatory pre-flight gate — a single unlabelled screen is a P0.)
- **Metric framing:** grep the entire UI (and any narration text) for baseline-improvement claims. Banned patterns: "reduces X by", "improves baseline", "we achieve N% improvement". Everything must read as "target" or "simulated result under stated assumptions". JNPA published no baselines; IIT evaluators will attack any claimed one. List every violation with file+line.
- **Open-source honesty:** inventory every OSS component and confirm the About/Architecture panel presents them accurately (no from-scratch invention implied).
- **Synthetic data positioning:** synthetic/simulated feeds must be framed as designed, graded behaviour demonstrating capability — check the copy.

### A4. Reliability & SPOF audit — `audit/05_RELIABILITY.md`
- **ArcGIS token/licence expiry** (our known single point of failure): what exactly breaks when the token is dead? Is there an automatic offline basemap + local scene fallback? Test by revoking/blanking the key. If no fallback exists this is P0.
- Full offline kill-test: unplug network → enumerate everything that breaks.
- Crash/refresh recovery: does a browser refresh mid-demo restore state (scenario in progress, sim clock, camera) or reset to zero?
- Determinism: is there a fixed-seed demo mode so the rehearsed run is reproducible?
- Performance: FPS in the main scene with all layers on; memory over a 30-minute run; behaviour at projector resolutions (1920×1080 and 1280×720) and on the actual demo laptop spec.
- Error hygiene: console errors, unhandled promise rejections, failed network calls visible in devtools (evaluator committees have been known to open devtools).

### A5. Data-realism audit — `audit/06_REALISM.md`
Verify the marine picture is recognisably JNPA, and calibrate simulation parameters to public figures (each entry sourced in the assumptions register):
- Geometry: 5 container terminals (NSFT, NSICT, NSIGT, GTI/APMT, BMCT) with ~15 berths total, correct relative quay positions (BMCT ~5.5 km from the older cluster), NSDT shallow-water berth, coastal berth, BPCL-IOCL + JSW liquid berths as context; approach channel with anchorage areas; pilot boarding ground.
- Calibration targets (FY24-25 public performance figures): ~10–12 vessel calls/day; average berth stay ≈ 0.97 days; average pre-berthing waiting ≈ 0.23 days; TAT pilot-boarding-to-deboarding ≈ 1.10 days; overall vessel TAT ≈ 1.83 days; average container-vessel parcel ≈ 2,355 TEU. Simulated traffic whose statistics land near these numbers is instantly credible to a domain evaluator; simulated traffic that doesn't will be challenged.
- Vessel realism: plausible synthetic vessel names/IMO/MMSI (valid formats, no real-line branding), correct size classes per terminal (BMCT takes the largest calls), tidal-window logic tied to draft.
- DUKC/RTUKC: is the under-keel-clearance computation defensible (static draft + tide + squat allowance vs channel depth), and can we explain **the difference between DUKC (predictive, route/passage planning) and RTUKC (live measurement during transit)** if probed? If the app conflates them, flag it — this is a known kill-shot question.

### A6. UX & visual-quality audit — `audit/07_UX.md`
Calcite-dark consistency, typography/spacing discipline, the 60-second first impression (default view must be the living 3D scene with vessel movement + KPI rail), camera bookmarks per demo beat (Approach & anchorage, Channel & DUKC corridor, Berth line-up, Pilot station, KPI wall), popup quality on vessel/berth click, loading states, empty states, and legibility from 4 metres (projector test: minimum font sizes, contrast).

### A7. Q&A defensibility audit — `audit/08_KILLSHOTS.md`
For each probe, state what the app currently shows, whether it survives, and the fix: DUKC vs RTUKC distinction; tide model source & update cadence; AIS latency/dropout handling and dead-reckoning; how "Accuracy of prediction vs real-time" is actually computed (holdout methodology, horizon); why our JIT/TAT numbers are simulated targets not baselines; what happens when the berthing-plan feed conflicts with AIS reality (conflict-resolution rule); channel one-way-traffic constraints; monsoon behaviour.

### A8. Audit synthesis — `audit/09_FINDINGS.md`
Every finding gets: ID, severity (**P0** demo-breaking or integrity-violating / **P1** costs marks / **P2** weakens impression / **P3** polish), evidence, proposed fix, effort estimate (S/M/L), dependency links, and which rubric criterion it affects. End with a proposed execution order and a one-page executive summary (current estimated rubric score → post-fix projected score). **STOP after Phase A and present the findings for my approval before touching code.**

---

## PHASE B — ENHANCEMENT EXECUTION (after my approval of the ordered backlog)

Execute approved items strictly by severity tier. Regardless of audit findings, the following enhancements define what "superior quality" means for UC-1 and should appear in the backlog (merge/dedupe with audit findings):

### B1. Integrity & resilience upgrades (typically P0/P1)
1. **DATA_MODE system** to full parity with the UC2 build: global + per-source provenance chips, no unlabelled screen.
2. **Integration Simulator Console**: per-source adapters (AIS, VTS/pilotage, weather, tide, bathymetry/channel depth, berthing-plan feed, port-craft roster) with LIVE(sim)/DEGRADED/OFFLINE toggles, latency/error injection, stale-data mode; visible fallback (last-known-good with staleness watermark, model-based imputation with widening confidence bands, manual-entry fallback form) and recovery reconciliation with an audit-log notification. This alone secures criterion 3.
3. **ArcGIS token-death fallback**: automatic switch to bundled offline basemap + local scene; rehearsable via a "simulate token expiry" dev toggle.
4. **Deterministic demo seed** + free-run mode; crash-recovery state persistence (sim clock, scenario, camera restore on refresh).
5. Banned-phrase sweep and copy rewrite to targets/simulated-results framing; Assumptions Register panel with sourced calibration figures from A5.

### B2. Capability upgrades (criterion 2, 4, 5 marks)
6. **Prediction-vs-actual convergence chart**: for ETA and berth-occupancy forecasts, plot predicted vs realized as sim time advances, with rolling MAE/MAPE — the literal answer to the "Accuracy of prediction vs real-time" KPI.
7. **5-day berth Gantt** (berth × time) with vessel blocks, tidal-window shading, DUKC-constrained feasibility bands, drag-to-replan in what-if mode (replanning runs through the same engine; show do-nothing vs replanned deltas).
8. **Port-craft resource board**: pilots/tugs/mooring gangs as finite scheduled resources; utilisation, conflicts, and an optimization recommendation ("swap pilot P4/P7 to close the 40-min gap on Berth 9 unberthing") — feeds the Port Craft optimization KPI honestly (simulated delta).
9. **DUKC corridor visualization**: channel rendered with depth-coloured segments; per-vessel-transit UKC profile chart (depth + tide − draft − squat) with go/no-go windows; clicking a planned transit shows its window. Implement DUKC (predictive) and RTUKC (live readout during an in-progress transit) as visibly distinct features.
10. **What-If Engine with Reactive Causality Guide** (parity with UC2, shared design language): explicit causal DAG (weather → wave/wind limits → pilotage suspension; tide → DUKC → deep-draft window → berthing sequence → pre-berthing delay → TAT; tug availability → unberthing slip → berth release → next-vessel JIT). Every scenario answers **WHICH** factors are hit (ranked, magnitudes from twin-vs-shadow runs), **WHERE** (3D fly-to along the propagation path), **HOW** (mechanism-labelled animated edges), **WHY** (auto-composed plain-language narrative, template-based, fully offline), and **WHAT-NOW** (interventions + simulated effect).
11. **Scripted scenarios** (one-click runs + free-parameter mode; YAML-defined with talking points): 
    - **M1 Monsoon pilotage suspension** (4-hour weather hold → arrival queue → recovery sequencing), 
    - **M2 Channel draft restriction** (siltation/-0.5 m → deep-draft vessels lose windows → replan), 
    - **M3 Berth outage** (crane breakdown at GTI berth → reallocation across terminals), 
    - **M4 Pilot shortage** (2 pilots unavailable → JIT slippage → prioritisation policy), 
    - **M5 Vessel bunching** (fog lifts, 6 arrivals compress → anchorage management + JIT re-sequencing).
12. **Automated workflows firing visibly**: UKC-window breach → replan + stakeholder notify; ETA slip > threshold → berth plan re-optimization proposal; weather alert → pilotage-hold workflow; berth-release delay → cascade re-sequencing. AUTO vs ADVISORY governance toggle; Workflow Runs ledger.

### B3. Polish (P2/P3)
13. Camera bookmarks + scripted demo player with presenter notes; 60-second opening choreography.
14. Marine KPI report export (Berthing Plan, Arrivals & Departures) as clean printable views.
15. Performance pass (target steady 45+ fps default view), projector-resolution QA, console-clean run.

### Phase-B execution rules
- One tier at a time; after each tier, re-run the relevant QA-156 items plus a smoke script, and update `audit/01_QA156_STATUS.md`.
- No regressions: before/after screenshots for every visual change; any behaviour removal requires my sign-off.
- Every new number rendered must carry units + provenance mode; every new assumption goes into the register with justification.
- Update DEMO_SCRIPT.md continuously — each enhancement lands with its demo beat and one-line talking point mapped to a rubric criterion.
- Final gate: full offline kill-test, token-death test, seed-reproducibility test, and a timed 20-minute end-to-end rehearsal run documented in `audit/10_ACCEPTANCE.md`.

### Guardrails
No real shipping-line branding or real vessel identities in synthetic data; no personal data; no claimed JNPA baselines anywhere; no new runtime internet dependencies; all added OSS listed with licenses in the About panel; internal commercials/consortium details must never appear in any screen, comment, or doc in this repo.

**Begin now with Phase A0 discovery. Report findings tier by tier. Do not write a single code change until Phase A is approved.**
