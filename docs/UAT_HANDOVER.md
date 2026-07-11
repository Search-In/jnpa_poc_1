# Cold-Handover UAT Checklist — UC-1

**Purpose (spec D-8):** a person who has never seen this system, given only this checklist and the manuals, can install it, operate every core workflow, and exercise degradation/recovery — with **zero deviations** needed. Each step has an expected result. Tick as you go.

**Scope note:** this PoC is a **frontend SPA over mock data** (Track A). Steps that require a production backend (real user provisioning, server-side backup/restore, live credential vault) are marked **[PROD]** and validated at the documented boundary rather than in the SPA; their in-SPA equivalent (session-persisted state, config files) is what you exercise here.

---

## 0. Prerequisites
- [ ] Node.js ≥ 20 and npm installed (`node -v`, `npm -v`).
- [ ] This repository checked out.

## 1. Install (clean machine)
- [ ] `npm install` → completes with **0 vulnerabilities** (`npm audit`).
- [ ] `npm run build` → `dist/` is produced, build succeeds.
- [ ] `npm run preview` (or `docker compose up` — see `docs/DEPLOYMENT.md`) → the app serves and the browser shows the **3D JNPA sea-port** as the first view.
- **Expected:** header shows `JNPA · Vessel Traffic Management & Optimisation`, a **SIMULATED** DATA_MODE chip, and a **Role** selector.

## 2. Roles (R-5)
- [ ] Change the **Role** selector to **Terminal Operator**.
- **Expected:** the **5-Day Berthing** tab shows a `ROLE-SCOPED` badge and fewer berths (only NSICT).
- [ ] Change to **Read-only Viewer**.
- **Expected:** a `READ-ONLY` badge appears; the "What-if replan" switch on the Gantt is disabled.
- [ ] Return to **JNPA Marine Ops** for the remaining steps.

## 3. Import a berthing plan (IU-2)
- [ ] Open the **Plan Import** tab.
- [ ] Click **Load template**, then **Import pasted rows**.
- **Expected:** a success notice ("Imported 1 row"); the row appears under "Overlay calls".
- [ ] Add a bad row by hand (leave MMSI blank) and click **Add call**.
- **Expected:** the call is **rejected** with a line + field message (e.g. "Missing MMSI"), not silently added.
- [ ] Open the **5-Day Berthing** tab.
- **Expected:** the imported call appears on the Gantt.

## 4. Constraint rejection on replan (W-4)
- [ ] On the **5-Day Berthing** tab enable **What-if replan**.
- [ ] Drag a block so it overlaps another call on the **same berth**.
- **Expected:** the move is **rejected** (snaps back) with a red **⛔ BERTH TIME OVERLAP** alert naming the conflict.
- [ ] Drag a block to a free slot.
- **Expected:** the move sticks and a "simulated replan — do-nothing vs replanned" caption appears.

## 5. Run a scenario (IU-4 / W-1)
- [ ] Open the **What-If** tab; run the **Monsoon pilotage hold** scenario.
- **Expected:** the twin perturbs (weather severity up); the **Reactive Causality Guide** shows WHICH/WHERE/HOW/WHY/WHAT-NOW.

## 6. Build a workflow (W-3)
- [ ] Open the **Workflows** tab → **Workflow composer**.
- [ ] Name a rule, set trigger `Wind speed ≥ 30`, add action `Hold pilotage`, click **Save rule**.
- **Expected:** the rule appears under "Saved rules" as **v1**, enabled.
- [ ] Edit the rule (change the threshold), save.
- **Expected:** version increments to **v2**.
- [ ] Toggle the rule **disabled**, then re-enable.
- **Expected:** the enabled/disabled state flips and persists.

## 7. Analytics & JIT (C-1/C-3/C-7)
- [ ] Open the **Analytics & JIT** tab.
- **Expected:** a JIT/RTA advisory (SIMULATED), a berth-occupancy heat calendar, a waiting-time distribution, terminal-wise TAT.
- [ ] Click **Optimise**.
- **Expected:** a conflict-free proposal with an objective breakdown (waiting / tide misses / shifts) and "decision support — a planner accepts or edits".

## 8. Connector readiness (A-2)
- [ ] Open the **Connectors** tab.
- **Expected:** headline "**System complete · awaiting N credentials**"; each of 7 connectors shows a contract version, driver tiers (MOCK/REPLAY/LIVE), providers, credential status, and a 5-step go-live checklist.

## 9. Simulate a connector outage + recovery (A-7)
- [ ] Open the **Integration Console** (via the DATA_MODE chip).
- [ ] Drop the **AIS** source to **OFFLINE**.
- **Expected:** the DATA_MODE chip shows a degraded/worst-rung state; the app stays navigable; a reconciliation log entry is written.
- [ ] Restore **AIS** to **LIVE**.
- **Expected:** the rung returns to LIVE and a recovery entry is logged.

## 10. Token-death rehearsal (5.8)
- [ ] Append `?offline=1` to the URL and reload (or use the "Simulate token expiry" button).
- **Expected:** the map falls back to a bundled offline basemap — **never a blank map**.

## 11. Backup / restore (state persistence; [PROD] for server data)
- [ ] With an imported plan + a saved rule present, **reload the page**.
- **Expected:** the sim clock, scenario, camera, **role**, **imported plan**, and **workflow rules** all restore (sessionStorage crash-recovery).
- [ ] **[PROD]** Full DB+config+audit backup/restore is validated against the production backend per `docs/DR_BACKUP.md`.

## 12. Automated gates (evidence)
- [ ] `npm test` → all tests pass.
- [ ] `npm run lint` → 0 warnings.
- [ ] `npx tsc -b --noEmit` → clean.

---

**Pass criteria:** every non-[PROD] box ticks with the expected result and no manual deviation. Record the run in `audit/PRODUCTION_ACCEPTANCE.md`.
