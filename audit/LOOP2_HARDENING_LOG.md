# UC-1 LOOP 2 — HARDENING LOG (Track A, mock-data-primary)

Running log of Loop 2 changes. Scope decision: **Track A** (build everything achievable in the SPA over mock stores; document backend-only items as "production adds"). Each entry is a self-contained, test-accompanied change; the app stays runnable throughout. Gates recorded per tier.

Baseline at Loop 2 start (2026-07-11): `tsc -b` clean · **56/56 tests** · ESLint 0 warnings · `npm audit`: 8 vulns (2 critical / 1 high / 5 moderate).

---

## TIER 0 — crash / corrupt-data / silently-mislead / block-install

**Goal:** remove anything that can corrupt the twin, mislead a viewer, or fail a security gate before any feature work.

### T0.1 — Build-chain CVE remediation → 0 vulnerabilities
- **Bumped `vitest` 2.1.9 → 3.2.7 and `@vitest/coverage-v8` → 3.2.7** (`package.json`). This cleared the dev/test-chain advisories that were pulled in via vitest's bundled `vite@5.4.21` / `esbuild@0.21.5`:
  - CRITICAL — `vitest <3.2.6`: arbitrary file read/execute when the Vitest UI server is listening.
  - HIGH — `vite <=6.4.2`: `server.fs.deny` bypass on Windows alternate paths.
  - MODERATE ×3 — esbuild dev-server request reflection; vite optimized-deps path traversal; launch-editor NTLMv2 disclosure.
  - These never shipped in `dist/` (dev-only), but failed a naive `npm audit` / any CI gate. The 2→3 major bump was verified non-breaking: **all tests still pass** under vitest 3.2.7, coverage still runs.
- **Removed unused dependency `@arcgis/charts-components@4.34.9`** (`package.json`). It was the *only* source of the remaining production-reaching advisory:
  - MODERATE — `ajv <6.14.0` ReDoS via the `$data` option (transitive through charts-components).
  - Verified **zero references** anywhere in `src/` / `index.html` — the app charts with **Chart.js + react-chartjs-2** (see `src/charts/setup.ts`, `assumptions.ts:47`), and `ajv` was already tree-shaken out of the bundle. Removing the dead dependency **eliminates** the CVE outright rather than accepting it — strictly better than a documented waiver.
- **Result:** `npm audit` and `npm audit --omit=dev` both report **0 vulnerabilities**. No accepted/waived CVEs remain. (`eslint`'s transitive `ajv@6.15.0` is ≥6.14.0, i.e. already patched, and dev-only.)

### T0.2 — Integrity: AIS mapper no longer fabricates (0,0) "null island" positions
- **File:** `src/data/aisstream.ts`. Previously `mapAisMessage` defaulted a missing latitude/longitude to `0`/`0` (old lines 109–110), plotting a **ghost vessel at (0,0) off West Africa** on the JNPA twin as if it were a real contact — the exact "silently mislead / corrupt the twin" failure mode. AIS transmits 0/0 as its *no-fix sentinel*, so this actively manufactured bad data.
- **Fix:** added `isPlottablePosition(lat, lon)` — rejects non-number/NaN/Infinity, `|lat|>90`, `|lon|>180`, and the `(0,0)` sentinel. `mapAisMessage` now **drops** (returns `null`) any PositionReport without a real fix instead of inventing one. The live consumer (`ArcGISAdapter` `onVessel`, via `openAisStream`'s `if (vessel)` guard) already treats `null` as "no vessel," so no caller change was needed.
- **Scope discipline:** this is the hard integrity *floor* only. Richer AIS sanity (speed-implied teleport, land-mask, staleness/confidence decay, cross-source dedup, backpressure) is deliberately deferred to **Tier 1 / edge-case 5.1** — not folded in here.
- **Tests (+6):** `src/data/aisstream.test.ts` now covers: drop-when-no-position, drop-`(0,0)`-sentinel, drop-out-of-range/non-finite, accept-valid-MetaData-only-position, plus a direct `isPlottablePosition` truth table. **62/62 pass.**

### Tier 0 gates (all green)
- `npx vitest run` → **62/62** (was 56; +6 integrity tests).
- `tsc -b --noEmit` → clean.
- `npm run lint` (`--max-warnings 0`) → clean.
- `npm run build` → succeeds (`dist/` unaffected by the dev-dep bump and the dead-dep removal).
- `npm audit` → **0 vulnerabilities**.

**No baselines claimed, DATA_MODE discipline untouched, no new runtime internet dependency.** No unrelated changes bundled.

---

---

## TIER 1 — live-ready connector architecture + operability core + marine-logic edge cases

New modules are pure/deterministic where possible (no Date.now/Math.random) and each ships with its test. All UI is mock-first and provenance-labelled.

### T1.1 — AIS data-quality firewall (§5.1, A-6)
- **`src/data/quality.ts` (+ 17 tests):** `validateVessel()` (stateless: MMSI/position/AoI/SOG/heading-COG/name checks with FATAL-drop vs WARN-sanitise reason codes) and `TrackQuality` (stateful per-MMSI: teleport >50 kn → keep last good, timestamp regression on reconnect → drop, cross-source dedup, staleness watermark). Wired into `ArcGISAdapter.subscribeVessels` — every live contact now passes validate→vet before the cache, with quarantine reason tallies (`getQuarantineCounts`).
- **Backpressure:** the cache flush is coalesced to one per 250 ms, so a 10k-frame burst after reconnect can't freeze the UI (one render, not 10k).
- Covers 5.1 items: null-island, out-of-AoI, absurd/negative SOG, heading-vs-COG, 200-char names, teleport, timestamp regression, cross-source duplicate MMSI, stale track, burst backpressure.

### T1.2 — Berth-planning constraint engine (§5.3, W-4, C-3 foundation)
- **`src/planning/constraints.ts` (+ 14 tests):** `validatePlan()` aggregates LOA>berth-length, beam>pocket, draft>berth-depth, berth-maintenance, berth-time overlap, unknown-vessel (→ provisional flag), pilot double-booking, tidal-window<transit — each a named `PlanViolation` with a remedy. Vessel dimensions derived by type (documented as an assumption).

### T1.3 — W-4 constraint rejection on the Gantt
- **`BerthGantt5Day.tsx`:** a drag-to-replan drop that would overlap another call on the same berth is **rejected** (snaps back) with a named `⛔ BERTH TIME OVERLAP` alert — the spec's "invalid moves visibly rejected with the violated constraint named."

### T1.4 — Client-side RBAC scoping (R-5)
- **`src/auth/roles.ts` (+ 7 tests) + `roleStore.ts` + `RoleSwitcher.tsx`:** five roles (Marine Ops / Terminal / Shipping line / Pilot desk / Viewer) with pure `scopeData()` filtering — Terminal→own-terminal berths+calls, Shipping line→owned vessels+windows, Viewer/Marine Ops→all. Header role switcher (persisted); the Gantt is role-scoped (`ROLE-SCOPED` badge) and read-only roles have replan disabled. **Scope honesty:** client-side only; server-enforced authz documented as a production add.

### T1.5 — Plan import + manual entry (IU-2)
- **`src/planning/planImport.ts` (+ 13 tests) + `planStore.ts` + `PlanImportPanel.tsx`:** CSV upload / paste + a manual add-call form. Parser handles mixed dates (ISO, DD-MM-YYYY, epoch ms, Excel serial floats — all as IST), **neutralises CSV formula-injection** (`= + - @` → quoted), enforces size/row caps, and reports every rejected row with line + remedy (never silent). Imported calls overlay the adapter plan on the Gantt. New "Plan Import" tab.

### T1.6 — Workflow composer (W-3)
- **`src/workflow/rules.ts` (+ 8 tests) + `ruleStore.ts` + `WorkflowComposer.tsx`:** author trigger (metric+comparator+threshold) → AND-conditions → actions (notify role / raise alert / propose replan / hold pilotage) in the UI; rules are saved, **versioned** (bump on edit), individually **enable/disable**, deletable, persisted. Pure `evaluateRules(rules, signals)` decides firings. Mounted beside the existing AUTO/ADVISORY ledger in the Workflows tab.

### T1.7 — Connector Readiness page (A-1/A-2)
- **`src/data/connectors.ts` (+ 8 tests) + `ConnectorReadiness.tsx`:** a registry of all seven sources with contract version, driver tiers (mock/replay/live) implemented, candidate providers (probable + which have a real contract stub), credential presence (from env, never the secret), live runtime rung, and the 5-step go-live checklist per connector. Headline: **"System complete · awaiting N credentials."** New "Connectors" tab. This is the "money screen" the tender asks for.

### T1.8 — AIS ingest resilience (A-5/A-7)
- **`aisstream.ts`:** `openAisStream` now **auto-reconnects** on unexpected drop with exponential backoff + **deterministic jitter** (`reconnectDelayMs`, no Math.random), single-flight resubscribe, backoff reset on a good connection, and emits the previously-dead `'reconnecting'` state so the UI shows the fallback rung. (+ 2 tests.)

### Tier 1 gates (all green)
- `npx vitest run` → **129/129** (was 62; +67 across quality, constraints, roles, planImport, rules, connectors, backoff).
- `tsc -b --noEmit` clean · `npm run lint` clean · `npm run build` succeeds · `npm audit` 0 vulns.

**Scope honesty maintained:** client-side RBAC, mock/replay drivers, and env-presence credential checks are labelled as such; real server-side authz, a credential vault, and live drivers-with-secrets are documented as production adds (see COMPETITIVE_PARITY / Connector guide in T2).

---

---

## TIER 2 — competitiveness + remaining edge cases + docs

### T2.1 — Statistical helpers (§5.4)
- **`src/kpi/helpers.ts` (+ tests):** `variance`/`stddev` (0 for n<2, not NaN) and a linear-interpolation `percentile` (handles empty/single/small-n). Closes the 5.4 variance/percentile gaps.

### T2.2 — C-1 JIT/RTA orchestration
- **`src/planning/jit.ts` (+ 3 tests):** `recommendRta()` = latest feasible arrival (berth-ready ∩ tidal window); recommended slower speed; **simulated** bunker/CO₂/cost saved (cube-law speed→fuel, IMO CO₂ factor). All labelled SIMULATED.

### T2.3 — C-3 berth optimiser
- **`src/planning/optimiser.ts` (+ 5 tests):** `optimiseBerthPlan()` — conflict-free proposal via a transparent greedy (earliest-feasible-berth, go-window aligned) minimising an **explainable** objective (weighted waiting + tide-window misses + shifting moves). Decision support, not a black box. (Fixed a real bug caught by tests: now prefers a free berth over waiting on the preferred one.)

### T2.4 — C-4 ETA distributions + C-7 historical analytics
- **`src/kpi/analytics.ts` (+ tests):** `etaDistribution()` (p10/p50/p90 band widening with horizon + AIS staleness); `occupancyCalendar()` (heat), `waitingTimeDistribution()` (histogram + p50/p90), `terminalTat()` (comparison).

### T2.5 — Competitiveness UI
- **`src/planning/AnalyticsPanel.tsx`** — new "Analytics & JIT" tab: JIT/RTA advisory, occupancy heat calendar, waiting-time distribution, terminal-TAT bars, and an **Optimise** button with objective breakdown. All SIMULATED-labelled.

### T2.6 — Docs set (D-7)
- `docs/COMPETITIVE_PARITY.md` (C-1..C-7 match/simplify/production-adds — the honest parity register).
- `docs/EDGE_CASE_REGISTER.md` (every 5.1–5.9 item → handling → test id, with honest deferrals).
- `docs/UAT_HANDOVER.md` (D-8 executable cold-handover checklist).
- `docs/OPERATOR_MANUAL.md` (operator + admin + a 10-row troubleshooting runbook).

## TIER 3 — localisation, deployment, sensitivity, sign-off

### T3.1 — O-5 localisation + IST/DD-MM-YYYY
- **`src/util/format.ts` (+ tests):** `istDate` (DD-MM-YYYY) + `istStamp` (DD-MM-YYYY HH:MM IST); report export switched to DD-MM-YYYY.
- **`src/i18n/strings.ts` (+ tests):** externalised English catalogue + `t()` with fallback + interpolation; Hindi/Marathi stubs fall back to English (functional now, translation is data-only later).

### T3.2 — C-2 DUKC sensitivity
- **`src/dukc/ukc.ts` (+ 2 tests):** `ukcSensitivity()` — nominal + draft ±0.2 m / tide ±0.1 m corners + single-axis cases, so a "go" is shown as comfortable vs marginal-on-the-edge. Closes the one flagged gap in the strongest module.

### T3.3 — D-1 one-command install + D-2 health + deploy docs
- **`Dockerfile`** (multi-stage build → nginx, non-root) + **`docker-compose.yml`** (read-only, no-new-privileges, healthcheck) + **`deploy/nginx.conf`** (`/health` endpoint, SPA fallback, security headers).
- `docs/DEPLOYMENT.md`, `docs/SECURITY.md` (OWASP ASVS map + honest prod-adds), `docs/DR_BACKUP.md`.

### Tiers 2–3 gates (all green)
- `npx vitest run` → **158/158** · coverage **68.78% stmts / 90.22% branch**.
- `tsc -b` clean · `eslint` 0 warnings · `npm run build` succeeds · `npm audit` 0 vulns.
- **App proven runnable:** `vite preview` on the built bundle → HTTP 200 with correct title + mount.

**Loop 3 acceptance recorded in `audit/PRODUCTION_ACCEPTANCE.md`.** All buildable Track-A scope complete; backend-only items honestly documented as production adds.
