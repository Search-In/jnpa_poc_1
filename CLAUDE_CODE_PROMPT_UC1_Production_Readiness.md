# CLAUDE CODE PROMPT — UC-1 PRODUCTION-READINESS PROGRAMME
## PoC_1: Vessel Traffic Management & Optimization → Client-Site-Deployable, Stakeholder-Operated System
## Anchor document: Appendix C, Use Case I — GeM Tender GEM/2026/B/7297343 (strict scope)

> **Role for you (Claude Code):** You are the production-hardening lead for an already-functional UC-1 PoC. The mission changes from "demo that impresses" to "**system that ships**": deployable at JNPA's site, operated day-to-day by JNPA stakeholders themselves with minimal vendor support, competitive with the global state of the art in vessel-traffic/berth-optimization software, and **LIVE-READY** — every workflow fully functional on mock data today, with live APIs connectable by configuration, not code change. "We are only waiting for live connections" must be literally, demonstrably true.
>
> **Method:** Three loops, strictly in order. **Loop 1 — ASSESS:** run the full checklist below against the current codebase and produce a scored readiness report (no code changes). **Loop 2 — HARDEN:** fix/build by tier. **Loop 3 — PROVE:** run the validation gates, including the cold-handover test. Keep the app runnable at all times; never bundle unrelated changes.

---

# PART 1 — STRICT FUNCTIONAL SCOPE (Appendix C UC-1, verbatim-anchored checklist)

Every item below is checked three ways: **[F]** functions correctly on mock data, **[L]** live-ready (real connector contract exists, config-switchable), **[O]** operable by a JNPA stakeholder without vendor help (discoverable UI, documented, no CLI).

### 1.1 Intended Use
- [ ] IU-1 Real-time vessel positions, berth occupancy, and pre-berthing status on a Digital Twin Command & Control Centre dashboard. [F][L][O]
- [ ] IU-2 Berthing plan integrated "as received/available at JNPA system", **minimum 5-day-ahead schedule**, visible to all stakeholders (role-scoped). Plan import path must accept the formats JNPA realistically produces: API, CSV/XLSX upload, and manual entry/edit UI. [F][L][O]
- [ ] IU-3 Display of pilot availability & performance, channel depth, weather & tidal data, **DUKC and RTUKC as two distinct, correctly-named features** (DUKC = predictive under-keel-clearance for passage/berthing-window planning; RTUKC = live under-keel readout during an in-progress transit). [F][L][O]
- [ ] IU-4 Simulation-ready platform: berth-allocation strategies and vessel scheduling testable under user-defined scenarios by a JNPA planner, not a developer. [F][O]

### 1.2 Requirements 1–8
- [ ] R-1 Vessel position pipeline: AIS + VTS + pilotage info + 3rd-party global-visibility feed. Connector slots for each of the tender's suggested sources (AISStream, AISHub, Global Fishing Watch, AISdb, MarineTraffic, VesselFinder) — at least the two most probable production picks with full request/response contract stubs; all currently served by the mock driver. [F][L]
- [ ] R-2 Weather / tidal / channel-depth integration with connector slots for INCOIS, IMD, MOSDAC (+ Copernicus/BHOONIDHI as bathymetry options), plus a "JNPA sample data" import path since the tender says JNPA may provide sample data. [F][L]
- [ ] R-3 Marine KPI reports: Berthing Plan report, Vessel Arrivals & Departures report — on-screen, printable, and exportable (PDF/XLSX) with report headers, generation timestamp, and DATA_MODE provenance printed on the artifact itself. [F][O]
- [ ] R-4 Real-time tracking dashboard: vessel positions + berth status + **approach traffic overlaid** (anchorage, channel transit, pilot boarding ground states distinctly symbolized). [F]
- [ ] R-5 Berthing-plan visibility to all stakeholders — role matrix implemented and API-enforced (JNPA Marine Ops full; Terminal sees own berths; Shipping line sees own vessels; Pilot desk sees pilotage queue; read-only viewer role for VIP/committee use). [F][O]
- [ ] R-6 KPI dashboard: all six KPIs + slots for "any specific pointed KPI provided by Marine department JNPA" — i.e., a **custom-KPI builder** (pick metric, aggregation, target band) usable by an admin stakeholder. Real-time values + historical trend benchmarks with explicit pre-/post-Digital-Twin framing labelled as simulated/target until live data exists. [F][O]
- [ ] R-7 Pilot availability & performance module (roster, assignment history, performance stats), channel depth display (dated bathymetry layer with survey-date watermark), weather/tidal panels, DUKC & RTUKC views. [F][L][O]
- [ ] R-8 GIS-native: all of the above ingested into the ArcGIS platform properly (feature layers/streams on the Esri stack — not iframes or bolt-on canvases beside the map). [F]

### 1.3 KPI set (each a first-class card: correct unit, definition tooltip, computation methodology page, drill-down, trend, target band)
- [ ] K-1 Just-In-Time arrival (% — simulated/target framing)
- [ ] K-2 Pre-Sailing Delay
- [ ] K-3 Pre-Berthing Delay
- [ ] K-4 Average Vessel TAT
- [ ] K-5 Port Craft (Pilot/Tug/Mooring) optimization
- [ ] K-6 **Accuracy of prediction vs real-time** — implemented as a living prediction-vs-actual convergence view (rolling MAE/MAPE per horizon), not a static number.

### 1.4 What-if & workflows (tender: reactive nature + JNPA will request specific workflows during pilot)
- [ ] W-1 Scenario library (monsoon pilotage hold, channel draft restriction, berth outage, pilot shortage, vessel bunching) — runnable by a stakeholder from the UI, parameterized, with twin-vs-shadow honest deltas.
- [ ] W-2 Reactive Causality Guide on every scenario: WHICH factors impacted (ranked, quantified), WHERE (map fly-to), HOW (mechanism-labelled edges), WHY (plain-language narrative), WHAT-NOW (interventions + simulated effect).
- [ ] W-3 **Workflow composer** operable by JNPA staff: trigger (event/threshold) → conditions → actions (notify role, raise alert, propose replan, hold pilotage) built in UI in ≤3 minutes, saved, versioned, enable/disable, AUTO vs ADVISORY mode, full run ledger.
- [ ] W-4 Berth-allocation replanning: drag-to-replan Gantt with constraint validation (draft vs channel/berth depth, LOA vs berth length, tidal window, pilot/tug availability) — invalid moves visibly rejected with the violated constraint named.

---

# PART 2 — GLOBAL-STANDARD COMPETITIVENESS BAR

Benchmark against the capability set of the recognised global category leaders — OMC International DUKC (dynamic under-keel clearance), Portchain/other berth-planning optimizers, PortXchange and the IMO/GIA Just-In-Time arrival concept, Awake.AI-class ML ETA services, Wärtsilä Navi-Port-class ship-shore data exchange. For each capability: implement an honest equivalent, and document in `docs/COMPETITIVE_PARITY.md` what we match, what we simplify, and what production adds. Never claim parity we don't have; DO claim the parity we build.

- [ ] C-1 **JIT arrival orchestration:** recommended RTA (requested time of arrival) per inbound vessel computed from berth availability + tidal/DUKC window + pilot/tug schedule; "steam slower, arrive just in time" advisory with simulated bunker/emission savings (labelled simulated); RTA update log per vessel.
- [ ] C-2 **DUKC-class computation, honestly scoped:** UKC = (charted depth + tide − draft − squat − safety margin), squat via a stated formula (e.g., Barrass) with parameters in the assumptions register; per-transit UKC profile chart along the channel; go/no-go windows; sensitivity view (draft ±0.2 m, tide error ±0.1 m). Document explicitly that production integrates a certified UKC service/bathymetry survey feed.
- [ ] C-3 **Berth planning optimization:** conflict-free berth Gantt generation under constraints with an explainable objective (minimise weighted waiting + tidal-window misses + shifting moves); "optimize" button produces a proposal a planner accepts/edits — decision support, not black box.
- [ ] C-4 **ML ETA with uncertainty:** per-vessel ETA distributions (not point estimates), horizon-dependent confidence bands, degradation behaviour when AIS is stale; model cards.
- [ ] C-5 **Port-call timestamp discipline:** adopt the standard port-call event vocabulary (ETA/RTA/ATA, pilot on board, first line, all fast, last line, pilot off) so JNPA data later maps 1:1; show the timestamp ladder per vessel call.
- [ ] C-6 **Resource orchestration:** pilots/tugs/mooring gangs as scheduled finite resources with conflict detection and swap recommendations.
- [ ] C-7 Historical analytics: berth occupancy heat calendar, waiting-time distributions, terminal-wise TAT comparisons — the views a Marine department actually reviews weekly.

---

# PART 3 — LIVE-READY CONNECTOR ARCHITECTURE ("only waiting for the APIs")

- [ ] A-1 Every external dependency behind a **driver interface**: `MockDriver` (current), `ReplayDriver` (recorded/synthetic history), `LiveDriver` (real API client, fully implemented against the documented public contract, credential-gated). Switching = config change in the admin UI, per source, no redeploy.
- [ ] A-2 **Connector Readiness page** (this is the money screen for "ready solution provider"): every source listed with — contract version, driver status (mock/replay/live), credential status (absent/present/valid), last health-check result, sample-payload validator, and a "go-live checklist" per connector (credentials → sandbox test → contract test pass → shadow-run vs mock → cutover). A stakeholder should be able to see at a glance: *system complete; awaiting N credentials.*
- [ ] A-3 Contract tests: recorded/synthetic fixtures per source validated against JSON-schema contracts in CI; drift detection (if a live API changes shape, the system flags it rather than corrupting the twin).
- [ ] A-4 Credential vault: encrypted at rest, admin-UI managed, masked display, rotation supported, never in code or logs.
- [ ] A-5 Ingest resilience per source: timeout/retry with exponential backoff + jitter, circuit breaker, rate-limit compliance, dedup on message IDs, out-of-order tolerance (event-time windows), idempotent processing, dead-letter queue with an admin replay UI.
- [ ] A-6 Data-quality firewall at every boundary: schema validation, range/sanity checks (see Part 5), quarantine bin for rejects with reason codes, per-source DQ score (freshness/completeness/validity) surfaced on the Connector Readiness page and propagated as amber badges on downstream KPI cards.
- [ ] A-7 Graceful degradation & recovery (already the demo behaviour — now productionised): last-known-good with staleness watermark, model imputation with widening confidence bands, manual-entry fallback forms (role-gated, audited), buffered-event reconciliation on recovery with a reconciliation report.

---

# PART 4 — STAKEHOLDER OPERABILITY & DEPLOYABILITY (minimal vendor support)

### Operations by JNPA staff, not engineers
- [ ] O-1 **Admin console** (UI, zero CLI): user & role management (create/disable users, assign roles, reset passwords/MFA), connector management (A-1/A-4), threshold & target-band editing per KPI, workflow enable/disable, assumption-register editing (with change audit), branding/port-parameters page.
- [ ] O-2 First-run wizard + guided tours per persona (Marine Ops, Planner, Pilot desk, Admin, Viewer); contextual help on every panel; searchable in-app Help Centre containing the full user manual.
- [ ] O-3 Notification delivery to real channels stubs: in-app (working), email/SMS gateway drivers (mock now, config-ready), per-user notification preferences.
- [ ] O-4 Every operator action audited: who/what/when/before-after, tamper-evident (hash-chained) log, filterable audit viewer for admins, export for compliance.
- [ ] O-5 Localisation-ready UI strings (English now; externalised for Hindi/Marathi later); date/time everywhere in IST with explicit "IST" labelling; DD-MM-YYYY display convention.

### Deployment & lifecycle
- [ ] D-1 One-command install on a clean Ubuntu server (`docker compose up` or install script): idempotent, air-gap capable (all images/assets bundled), documented hardware sizing, TLS termination with provided-cert instructions, runs under non-root.
- [ ] D-2 Health & monitoring: `/health` per service, an in-app **System Health page a non-engineer can read** (green/amber/red per component, disk/memory, queue depths, last-backup time), alert rules for the admin.
- [ ] D-3 Backup/restore: scheduled automated backups (DB + config + audit logs), one-click restore drill documented AND tested; retention policy configurable.
- [ ] D-4 Update path: versioned releases, migration scripts, rollback procedure, release notes template; a staging profile so updates can be rehearsed.
- [ ] D-5 Log management: structured JSON logs, rotation, levels adjustable from admin UI, no secrets/PII in logs; SIEM-forwarding hook (CERT-In-aligned retention note in docs).
- [ ] D-6 Security hardening: OWASP ASVS-guided review — authn (session expiry, lockout, MFA-ready), authz on every API route (deny-by-default, role claims verified server-side), input validation everywhere, CSRF/XSS/SQLi protections, security headers, dependency audit (no known-critical CVEs at ship time), secrets scanning in CI.
- [ ] D-7 Documentation set shipped in-app and as PDFs: Operator Manual, Admin Manual, Connector Integration Guide (the exact steps + contracts for JNPA/OEM teams to bring each live API online), Troubleshooting Runbook (symptom → cause → fix, no vendor call needed for the top 25 issues), DR/Backup Runbook, Security & Compliance overview.
- [ ] D-8 **Cold-handover test (the acid test):** a person who has never seen the system, given only the deployment guide and manuals, must — install it, create a user, import a berthing plan, run a scenario, build a workflow, simulate a connector outage and recovery, take a backup, and restore it. Script this as an executable UAT checklist in `docs/UAT_HANDOVER.md`; Loop 3 requires a clean pass.

---

# PART 5 — EXHAUSTIVE EDGE-CASE CATALOGUE (handle, test, and document EVERY item)

Implement handling + an automated test per item (unit/integration/e2e as appropriate). Where handling = "reject with clear user-facing message", the message must name the problem and the remedy. Maintain `docs/EDGE_CASE_REGISTER.md` mapping each item → handling strategy → test ID.

### 5.1 AIS / position-feed pathologies
Duplicate MMSI from two sources; MMSI/IMO mismatch; position teleport (>50 kn implied speed) — flag & dead-reckon, don't render the jump; stale track (no update > N min) — staleness watermark + confidence decay; vessel on land / outside AoI bounding box; lat/long (0,0) or null island; heading vs COG contradiction; draft missing or zero or > channel depth; negative/absurd SOG; unicode & emoji in vessel names; 200-character vessel names; vessel type unknown; two vessels claiming the same berth; AIS spoof pattern (impossible route) — quarantine + alert; feed replays old data after reconnect (timestamp regression) — event-time guard; burst of 10,000 messages after outage — backpressure without UI freeze.

### 5.2 Tide / weather / bathymetry
Missing tide window (gap in series) — interpolate with flag, never silently extend; tide source disagreement (two drivers differ > threshold) — show both + precedence rule; negative surge beyond chart datum; weather API returns stale timestamp; bathymetry survey date > 15 days old — mandatory watermark (tender expects 15-day cadence in production); depth units confusion guard (m vs ft — reject ft-looking magnitudes); monsoon extreme values (wind > operating limits) — pilotage-hold workflow must trigger, UI must not clamp/hide the value.

### 5.3 UKC / berth-planning logic
Computed UKC ≤ 0 — hard-block transit with named constraint; draft + squat > depth at only ONE channel segment — window must respect worst segment, and the profile chart must show which; vessel LOA > berth length; beam vs berth pocket; two plan entries overlapping same berth-time; berthing plan references unknown vessel — create provisional record, flag for confirmation; plan import with mixed date formats / TZ offsets / Excel float dates; 5-day plan where day 3 is missing entirely; plan revision arriving mid-scenario — versioned plans with diff view, active scenario pinned to its plan version; tidal window shorter than transit time; pilot assigned to two vessels simultaneously — conflict detection; berth maintenance block colliding with optimizer proposal.

### 5.4 KPI / analytics math
Empty dataset (day one, no history) — every KPI card must render a defined empty state, never NaN/∞; division-by-zero guards on all ratios; single-vessel days (variance undefined); percentile computation with n<4; timezone boundary double-count (23:59 IST vs UTC storage — store UTC, display IST, test the boundary); DST-free but test IST offset handling anyway for imported UTC feeds; leap day; clock skew between server and client — server-authoritative time; KPI target band edited while chart open — live re-render; prediction-accuracy KPI when no predictions have matured yet.

### 5.5 Concurrency & multi-user
Two planners drag the same Gantt block — optimistic locking + merge prompt; admin disables a user mid-session — session revoked gracefully; role changed while page open — scope re-fetch; workflow edited while executing — versioned execution (running instance completes on old version); simultaneous scenario runs — queue or isolate, never interleave state; WebSocket reconnect storm after network blip — exponential backoff, single-flight resubscribe, no duplicate event application (idempotency keys).

### 5.6 Session / browser / client
Refresh mid-scenario — full state restore (sim clock, scenario, camera, open panels); browser back/forward — router-safe; session expiry during form edit — draft preserved, re-auth inline; double-click/double-submit guards on every mutating action; copy-paste of formatted junk into numeric fields; 1280×720 projector and 4K wall; browser zoom 75–150%; Chrome + Edge minimum (document supported matrix); color-vision-deficiency safe palette (status never encoded by hue alone — add shape/label); print stylesheets for the two mandated reports; slow-network mode (throttled 3G) — skeletons, no spinners-forever, no layout jumps.

### 5.7 Data volume & longevity
90-day history at full ingest rate — query performance budgets (p95 < 500 ms for dashboard queries) with indexes proven by EXPLAIN; retention/archival job; DB disk-full behaviour — ingest pauses with loud admin alert, UI stays read-available; log growth bounded; memory soak 72-hour run without leak (automated soak test in CI-lite form); restore of a 90-day backup within documented RTO.

### 5.8 Security-adjacent edge cases
Expired ArcGIS token — automatic offline basemap fallback (never a blank map); expired TLS cert — documented renewal, admin health warning 14 days prior; brute-force login attempts — lockout + audit; API called with tampered role claim — server-side rejection test; injection attempts in vessel-name/search fields; file upload abuse on plan import (size cap, type sniffing, formula-injection neutralisation for CSV/XLSX opened in Excel).

### 5.9 Operational/demo-day states
Fresh install, zero data — every screen has a designed empty state with a "get started" pointer; mid-migration visit — maintenance page; all connectors OFFLINE simultaneously — system remains navigable, clearly degraded, nothing crashes; deterministic seed mode still available for rehearsals; DATA_MODE banner correct in every one of the above states.

---

# PART 6 — EXECUTION LOOPS & GATES

**Loop 1 — ASSESS (no code changes):** Run Parts 1–5 as an audit. Produce `audit/PRODUCTION_READINESS_SCORECARD.md`: every checklist ID with status (PASS / PARTIAL / FAIL / N-A + justification), evidence, fix, effort (S/M/L), and tier assignment. Include a competitive-parity gap table (Part 2) and an edge-case coverage count (X of Y handled+tested). End with an executive summary: current readiness %, projected post-hardening %, top 10 risks. **STOP for my approval.**

**Loop 2 — HARDEN (tiered):**
- Tier 0: anything that can crash, corrupt data, silently mislead (integrity), or block install.
- Tier 1: live-ready connector architecture (Part 3) + operability core (admin console, audit, backup) + all 5.1/5.3 marine-logic edge cases.
- Tier 2: competitiveness features (Part 2) + remaining edge cases + docs set.
- Tier 3: polish, localisation scaffolding, performance headroom.
Rules: one tier at a time; test accompanies every fix (no fix merges without its test); before/after screenshots for visual changes; every new assumption → shared assumptions register with source; DATA_MODE and no-baseline-claims discipline applies to every new surface, including PDFs/exports.

**Loop 3 — PROVE:** Execute and document in `audit/PRODUCTION_ACCEPTANCE.md`:
1. Full automated test suite green (report coverage; critical paths — ingest, UKC, Gantt constraints, RBAC — at ≥90% branch coverage).
2. Clean-machine install from docs alone, air-gapped, timed.
3. **Cold-handover UAT** (D-8) executed step-by-step with zero deviations needed from the manual.
4. Connector go-live rehearsal: take one source (e.g., weather) through the full mock→sandbox→contract-test→shadow→cutover checklist against a recorded fixture server, proving the "waiting only for credentials" claim end-to-end.
5. Chaos drill: kill each service one at a time + all connectors at once + token expiry + disk-90% — system degrades and recovers per spec.
6. 72-hour soak: no leak, no drift, backups fired, KPIs continuous.
7. Security pass: dependency audit clean of critical CVEs, authz matrix test green, secrets scan clean.
8. Sign-off table: every Part 1 item [F][L][O] all green, every Part 5 item tested, every Part 2 item honest-parity-documented.

**Guardrails (unchanged and absolute):** DATA_MODE provenance on every screen, report, and export; all improvement figures framed as simulated results under stated assumptions or targets — never JNPA baselines; honest OSS inventory; no real shipping-line branding or real vessel identities in synthetic data; no consortium commercials anywhere in repo, UI, or docs; no new undocumented runtime internet dependencies.

**Begin with Loop 1 now. Do not change code until the scorecard is approved.**
