# Phase-3 pending work — UC-1 (poc_1) completion report

**To:** owner of `03_PENDING_WORK.md`
**From:** UC-1 / poc_1
**Date:** 2026-08-04 · against `origin/main` @ `6b6e75b`

**Summary.** The *integrity + blocker* tier for `poc_1` is complete: **5 tasks
closed** (A-02, A-03, A-04, A-05, D-03) and **2 more with the UC-1 half done**
(A-01, D-04). All 48 tasks in your document were then verified against the actual
code in all three repositories, which turned up **7 items whose premise does not
match the code** and **6 findings that are not in the audit at all** — one of which
should be actioned before anything else ships (§5.1).

Verification on this repo: `npm run lint` **0** · `npm run typecheck` **0** ·
`npm test` **581 passed / 53 files** · `npm run build` **0**.

---

## 1. Completed

### A-03 — lint gate (P2) ✅
`npm run lint` (`eslint . --max-warnings 0`) exits **0**. It had drifted to 5
warnings; `PRODUCTION_ACCEPTANCE.md` §Gate 2 asserted it was clean, and its test
count (158) was ~4× out of date — both corrected.

Two of the five were **not** lint noise: an unmemoised array identity made the
tide-field effect rebuild its raster layer on *every render* of the component
that also drives the 3D scene. Fixed properly. The remaining exemption surface is
two commented `eslint-disable-next-line`s (explaining why the scene-init effect's
`[]` is load-bearing — a changing dep re-initialises the SceneView mid-demo) and
one scoped override for the app entry.

**Also:** no CI job ran lint, typecheck or tests at all — `deploy.yml` went
straight from `npm ci` to `vite build`. A new `ci.yml` now runs all four on every
push and PR. It is deliberately **advisory** (not wired into `deploy.yml`) until
the demo window closes, so one flaky test cannot block a demo-morning hotfix.

### A-02 — deployed-build honesty (P1) ✅
**Decision: the deployed build stays `mock`.** It is already a *mixed* artefact —
UC-3 panels, the Live-AIS overlay and LDB container track are real regardless of
`VITE_DATA_MODE`. The fix was to state the split, not change it. Switching to
`live` would need Feature-Layer URLs that are in no secret store; `hybrid` layers
real hulls over invented ones, which is a worse honesty position.

Every switch that changes what a reviewer sees is now pinned explicitly in
`deploy.yml` with a comment, so a later default change cannot silently alter the
submission build. `docs/DEPLOYMENT.md` carries a real-vs-simulated table and the
presenter's local `.env`.

**We did not rename the mock fixture hulls** (`MV BHARAT EXPRESS` etc.). More
realistic names make invented tracks *harder* to spot, not easier. Label, don't
relabel — the labelling already exists via `DataModeChip` and `SourceBadge`.

### A-04 — plain-language errors (P2) ✅
A pure `friendlyError()` classifier turns raw connector strings
(`[UC3] /marine/calls → HTTP 502 …`) into an operator sentence plus a suggested
action, with the original demoted to a collapsed *Technical details* disclosure.
Because it plugs into the single `PanelError` component, **~24 panels improved
with a zero-line diff at each call site**. Already-human messages (e.g. "Enter a
container number") pass through untouched.

### A-05 — demo-fixed advisory disclosures (P2) ✅
All four JIT/RTA inputs (150 nm, ETA+5 h, ETA+3 h, 16 kn) now render under the
advisory, each naming the production source it stands in for.

Two things your document did not have:
- `jit.ts` claimed its bunker/CO₂ constants were "documented in the assumptions
  register" — **they were not there**. The register now *imports* them, with a
  test that fails if the two drift.
- The linear what-if stub **also runs in `live` mode**, not just mock. Now stated
  in the result note and in the register.

### D-03 — LDB switch-over readiness (P2) ✅
New `docs/LDB.md`: data path, the auth calls, config table, fallback semantics,
the three-app env-key mapping, and the retest list (TC-024/025/057/090/116/117).

It is built around the trap that makes this task matter: **with
`VITE_LDB_SAMPLE_FALLBACK=true`, a failure looks exactly like a success** — the
panel fills with a plausible track either way. The runbook therefore proves the
live path with the fallback *off*.

### A-01 — demo runtime (P1) ⚠️ UC-1 half done
The gateway/Postgres standup is not this repo's. What UC-1 owned is done — and
one instruction in your document was actively dangerous; see §2.1.

### D-04 — LDB demo-day drill (P1) ⚠️ UC-1 half done
The sample-fallback badge existed but said only *that* the sample was used, never
*why*. It is now a notice naming one of five classified reasons, with the raw
error behind *Technical details*. The venue-network drill itself is still to run.

---

## 2. Corrections — tasks whose premise does not match the code

These cost real time to discover; please fold them back into the source document.

**2.1 A-01: there is no `uc3` data mode.** The document instructs
`VITE_DATA_MODE=uc3`. That value was cast without validation and fell through to
`MockAdapter`, so following the instruction produced **a dashboard of invented
vessels that looked exactly like a working one** — nothing failed, nothing warned.
UC-3 data is orthogonal, switched by `VITE_UC3_ENABLED`. An unrecognised value now
**fails the build**, with a message that also points at the right switch.

**2.2 A-01: `scripts/probe-uc3.mjs` already exists** and is self-documenting.

**2.3 A-03: the line numbers are stale and one warning was missed** — the real set
was 5, not 4.

**2.4 A-09 is not buildable as written.** Drafts, hazardous-cargo flag, ISPS level
and route are parsed, stored and served **nowhere** — not in the 21-field vessel-call
payload, not in UC-3's `CallOut`, not in the DDL, not in the BERMAN parser.
It needs a UC-3 migration + parser change first. What *is* available today: 9
mapped-but-unrendered call fields, and pilotage fore/aft drafts that are fetched
and never displayed.

**2.5 A-10's acceptance criterion cannot be met.** Next-port/last-port exists in
**neither** repo. The rest (call → events → pilot card) is buildable.

**2.6 A-13's target file already exists.** `src/reports/exportReports.ts` is
present and produces print-HTML today.

**2.7 C-11 cannot be started.** `Business_QA_run_v10/…/flows.json` is not in
poc_1 or uc3.

**2.8 A-05 was partly done already** — a `SIMULATED` pill and per-panel source
badge were on the JIT card before this work.

**2.9 D-09 does not apply to UC-1** — poc_1 renders no personal data at all.

Cross-repo corrections, verified for you: **C-09** (the NLDS/LDB PDF parser exists
and is wired end to end — the audit read the query side), **C-05** and **C-04**
(both cite `metrics.json` files that are gitignored and have never existed in
history), **C-02** (the venv is already Python 3.11 and 3 of the 4 modules collect
— the 4th is a missing entry in `make venv`), **B-10** (the legacy `CGO-2`
deep-link resolves through a deliberate alias map), **B-11** (BroadcastChannel
bridges *do* exist; only the separate demo-console app lacks one), and **D-07**
(framed backwards — UC-3 *does* consume the cross-twin event; PoC_2 never emits it
outside memory).

---

## 3. Deferred in UC-1 — disclose rather than build

| ID | Why |
|---|---|
| A-11 | Drag-replan already exists; only versioning/diff/reason are missing, and UC-3 exposes no plan-write endpoint so nothing could persist. Highest regression risk — it touches the pointer-drag on the most-demoed screen. |
| A-12 | Buildable: every timestamp for a **measured** decomposition already exists on the pilotage record and is never joined to calls. Today's pilotage component is an assumed 1.5 h constant. |
| D-08 | UC-1 has four divergent KPI code paths, and **two different quantities are both labelled "pre-berth delay"** — `ATB − (ATA + 1.5 h assumed)` on the KPI wall vs `ATA − ETA` (opposite sign) on the vessel-calls card. Cheapest fix is a KPI source register + disambiguating labels, not a refactor. Note the example metric in the audit (NLDS dwell 22.7 h) has no counterpart in UC-1. |
| A-09, A-10, A-13, C-11 | Blocked or mis-specified — see §2. |

One small, high-value bug found while scoping A-10, not yet fixed: UC-3's
`01-01-1900` "not recorded" sentinel survives the date parser as a finite negative
epoch, renders as `01 Jan 05:30` (the formatter omits the year, so it is
indistinguishable from a real time), and sorts to the front of every timeline.
One-line fix in one shared helper; benefits six connectors.

---

## 4. Cross-repo verification (no work done, status confirmed)

**UC-3 (`jnpa-uc3-poc`)** — genuinely still open: **C-03** (the OCR router
fabricates structured fields on the *success* path while tagging them
`"source": "OCR", "confidence": 0.9`, and never calls the working :8210 service),
**D-01/D-02** (a vendor has no endpoint to POST to and no validation harness —
`find ingest -iname "*quarant*" -o -iname "*valid*"` returns nothing), **C-08**,
**D-05** (all seven third-party keys are present-but-empty), **D-12** (confirmed
verbatim — and `MAEU7654320` is pinned to always carry `ESEAL_TAMPER`, i.e. a
synthetic security violation permanently attached to a Maersk-prefixed box).

**UC-2 (`jnpa_poc_2`)** — **B-01** (still true, but the file named is wrong:
`.env.local` does not exist; and after `cp .env.example .env` the auth credentials
are still commented out, so you get 401s), **B-02** (verbatim), **B-03**,
**B-04**, **B-06**, **B-09**. On **B-08** the wording is worse than "missing": the
control is labelled *"Run live inference demo"* while the prediction is a CSS
animation over hardcoded literals.

---

## 5. Findings not in the audit

**5.1 — action before anything else ships. Handle privately.**
In `jnpa-uc3-poc`, `.env.local.example` is **tracked in git** and contains a real
database password plus five DSNs pointing at a live `ap-south-1` RDS endpoint —
not placeholders. **Rotate the credential and scrub it from history before D-10
builds any submission bundle.**

**5.2 — much of UC-3's "green" signal cannot turn red.** `make tfc1/tfc2/tfc3`,
`scenarios-verify`, `web-verify` and `pwa-verify` all terminate in `|| true`;
the ANPR weights script `exit 0`s on total download failure; and four test files
skip on a path only one developer has. Strip the `|| true` guards **before**
attempting C-01, or `make up && make e2e` will report success on a substantially
mocked stack.

**5.3 — UC-3's `make test` currently runs zero tests.** Collection aborts on three
packages missing from `make venv`, and the target uses `-x`. The suite is **1016
tests**, not the 768 quoted; that figure appears nowhere in the repo.

**5.4 — UC-2's `pnpm build` fails on a clean checkout** (TS6305: `services/kpi` is
never built but is referenced). Any "build fresh and demo" instruction needs B-03
first.

**5.5 — `jnpa_poc_2` contains two projects in one git tree** (the UC-2 monorepo and
a full copy of a UC-III tree). Several audit claims land on the wrong one. Its
`.gitignore` also ends with `*.md`, so all markdown there is untracked.

**5.6 — UC-3's `docker-compose.override.yml` describes itself as untracked but is
tracked**, so its dev-only nginx/port overrides apply on every clone, including
deploy.

---

## 6. How to verify the UC-1 work

```bash
npm ci
npm run lint && npm run typecheck && npm test && npm run build
VITE_DATA_MODE=uc3 npm run build     # MUST fail — this is A-01 working
```

On screen (`npm run dev`):

| Task | Check |
|---|---|
| A-04 | With `VITE_UC3_ENABLED=false`: Shipping ▸ Lines reads "Gateway data is switched off in this build", raw string collapsed under *Technical details* |
| A-05 | Analytics & JIT → advisory ends with "Demo-fixed inputs: …"; Methodology → 7 new register rows |
| D-04 | With `VITE_LDB_ENABLED=false`: container track shows a notice naming the reason, not a bare demo track |
| A-02 | `docs/DEPLOYMENT.md` § *What is real in the deployed build* |

Full per-task detail for all 48 tasks, including file:line evidence for every
claim above, is in `audit/03_PENDING_WORK_UC1_STATUS.md` in this repo.

**Not verified by us:** the on-screen checks above need a browser we could not
drive in the working environment; nothing was executed in UC-2 or UC-3 beyond
read-only inspection and a `pytest --collect-only`; and `suite`/`dtccc` (A-06,
A-07, A-08, C-10, D-06) does not exist on this machine, so those five are
unverified rather than assessed.
