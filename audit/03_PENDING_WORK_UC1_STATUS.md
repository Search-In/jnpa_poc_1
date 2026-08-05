# 03 — PENDING WORK · **programme-wide status overlay**

**Source:** `03_PENDING_WORK.md` (Phase-3 audit, 2026-08-03).
**This copy:** verified status of **all 48 tasks** as of **2026-08-04**, checked against
the actual code in all three repositories.
**Rebased** onto `origin/main` @ `6b6e75b` after the LDB OTP rework landed — see §M.

Repositories checked:

| Repo | Path | Covers |
|---|---|---|
| **poc_1** (UC-1 VTMS) | `/Users/rushikeshsusar/Projects/jnpa_poc_1` | A-0x, A-1x |
| **PoC_2** (UC-2 cargo) | `/Users/rushikeshsusar/Projects/jnpa_poc_2` | B-xx |
| **uc3** (shared gateway) | `/Users/rushikeshsusar/Projects/jnpa-uc3-poc` | C-xx, most D-xx |
| **suite / dtccc** | **not present on this machine** | A-06, A-07, A-08, C-10, D-06 — unverifiable |

**Work actually done this session:** the *integrity + blocker* tier in **poc_1 only**
(6 tasks, ✅ below). Everything else is a **verified status report**, not work — it
tells you what is genuinely still open, what the audit got wrong, and what it missed.

> Status overlay, not a replacement. The original's `Files involved` and
> `Acceptance criteria` columns are unchanged there and not repeated here.

### Legend

| Mark | Meaning |
|---|---|
| ✅ **DONE** | Implemented and verified this session (poc_1) |
| ⚠️ **PARTLY** | Some of it is already true / one repo's half is done |
| ❌ **OPEN** | Verified still true — real work remaining |
| ⏸ **DEFERRED** | In scope, consciously not built this tier |
| ❗ **AUDIT-WRONG** | The task's premise does not match the code — see §C |
| ❓ **UNVERIFIABLE** | Target repo not on this machine |
| 🔴 **NEW** | Not in the audit; found while verifying — see §N |

---

## Category A — MUST-FIX before demo

| Status | ID | PoC | Task | Prio | Verified state (2026-08-04) |
|---|---|---|---|---|---|
| ⚠️ **PARTLY** | A-01 | all | Stand up the full demo runtime + rehearse start order | **P1** | **poc_1 half ✅ done** — `VITE_DATA_MODE=uc3` (§C-1) now fails the build; probe script documented; start order + env table + presenter `.env` in `docs/DEPLOYMENT.md`. **uc3 half ❌ open** and harder than written: there is no `make test-e2e` (it is `make e2e`, `Makefile:314`), Docker is not installed on this machine, and — critically — `make tfc1/tfc2/tfc3` all end in `\| \|\| true` (`Makefile:250,255,260`), so **they exit 0 even when the stack is down**. They cannot serve as proof of a run. |
| ✅ **DONE** | A-02 | poc_1 | Kill the fictional-fleet trap | **P1** | Decision recorded: build stays `mock` — it is a *mixed* artefact (UC-3 panels, Live-AIS, LDB are real). Every switch pinned in `deploy.yml`; real-vs-simulated table in `docs/DEPLOYMENT.md`. Fixture hulls deliberately **not** renamed (§C-6). |
| ❌ **OPEN** | B-01 | PoC_2 | UC-2 env pre-flight + POC-3 credentials | **P1** | Still true, and the audit names the wrong file: **`.env.local` does not exist**; the only `.env.local.example` in that tree belongs to a second, UC-III project sharing the git root, and has no `POC3_URL`/`CARGO_*`. Correct file is `.env.example`, where `POC3_URL` is already set (`:17`) but **`VITE_CARGO_AUTH_USER/PASS` are commented out** (`:32-33`) — so `cp .env.example .env` fixes the proxy and still yields 401s. |
| ❌ **OPEN** | B-02 | PoC_2 | Re-enable the ISO 6346 check-digit | **P1** | Verbatim true: `apps/web/src/panels/ContainerMovements.tsx:355` — `const cnValid = cn.length > 0; // was: isValidContainerNo(cn)`. The validator is correct and tested (`packages/schemas/src/entities/iso6346.ts:50`), and still enforced on the *read* path (`poc3-cargo-adapter.ts:257`) — so junk can be written but never read back. **`XBXR0181500` is absent from the repo**, so nothing pins this. |
| ❌ **OPEN** | C-01 | uc3 | Prove the UC-3 live stack on the demo machine | **P1** | See A-01. Also: `docker-compose.override.yml` bind-mounts fixes over stale images (`:24-32`) and its own header calls itself "untracked" — **it is tracked**, so it applies on every clone including deploy, where its localhost nginx swap and port remap are wrong. |
| ❌ **OPEN** | C-03 | uc3 | Wire the real EIR photo-OCR into the dashboard | **P1** | Still true, verbatim: `gateway/routers/document_ocr.py:118` — `"fields": _mock_fields(doc_type, seed),  # field parsing TODO`. Even on the **success** path (real pytesseract text at `:114`) the structured fields are SHA-256-fabricated (`_mock_fields`, `:65-93`) yet tagged `"source": "OCR"`, `"confidence": 0.9`. The router **never calls :8210** — zero references to the OCR service outside `ingest/eir_ocr/` itself. The service is real and substantial (`extract.py`, 48 KB); this is purely a wiring job. |
| ⚠️ **PARTLY** | C-04 | uc3 | Decide and execute the ANPR story | **P1** | No weights present — confirmed (`ai/anpr/resources/` holds only a char list, a sample JPG and state codes). But **`ai/anpr/eval/metrics.json` does not exist and never has** (§C-8), so the "0.20 clean accuracy" figure cannot be verified from this repo. `scripts/download_anpr_weights.sh` exists — and **`exit 0`s on total download failure** (`:52`), so it "succeeds" while leaving the service degraded. |
| ❗ **AUDIT-WRONG** | C-05 | uc3 | Regenerate the evidence pack | **P1** | Stronger than the audit says: **there is no evidence pack at all**, stale or otherwise. `evidence/` contains only `.gitignore` and `screenshots/.gitkeep`; `metrics.json` is gitignored and has never existed in history. So the "13-Jun / 3.64 msg/s / null metrics" description came from a locally-generated artefact on another machine. `make evidence` exists (`Makefile:323`) and its generator does default every metric to `null` when a service is unreachable, with the ≥5 msg/s gate at `build_evidence.py:404`. |
| ❓ **UNVERIFIABLE** | A-06 | suite | Fix dtccc's pre-trigger state | **P1** | No `suite/` or `dtccc/` directory exists in either repo on this machine. |
| ❓ **UNVERIFIABLE** | A-07 | suite | Make dtccc's on-screen claims match its architecture | **P1** | As above. |
| ⚠️ **PARTLY** | D-09 | all | PII scrub for screens and the submission bundle | **P1** | **poc_1: N/A** — renders no personal data at all (verified). **uc3: the audit's evidence does not exist** — there is no `seed.sql`, and `pii_exposure` has **zero hits** repo-wide (§C-9). **But the substance holds and is worse than a corpus problem:** `web/src/screens/DriverMaster.tsx` renders **DOB unmasked** (`:389`) and **driving-licence numbers unmasked** (`:396`, `:597`), while other screens do mask (`Intelligence.tsx:347`, `PoliceReports.tsx:486`, `DriverEnrollments.tsx:637`). Clear-text `mobile`, `license_no`, `name`, `emergency_contact` columns exist in `infra/postgres/v3/0101_core_operational_ext.sql:754-761, 809-817`. |
| ❌ **OPEN** | D-10 | all | Assemble the submission bundle | **P1** | Programme task. **Do not zip before reading §N-1** — a live cloud credential is currently tracked in uc3. |
| ✅ **DONE** | A-03 | poc_1 | Fix the 5 lint warnings | P2 | `npm run lint` exits **0**. Two of the five were a real defect, not noise (§C-3); the audit's line numbers were stale and it **missed one**. `audit/PRODUCTION_ACCEPTANCE.md` corrected (it claimed the gate was clean; its test count was 158 vs an actual 525→569). New `ci.yml` makes the gate enforced. |
| ✅ **DONE** | A-04 | poc_1 | Replace raw technical error strings | P2 | Pure `friendlyError()` + `TechnicalDetails` disclosure, plugged into the single `PanelError` choke point → ~24 panels improved with a zero-line diff at each site. The one bypassing component (Container Track) switched over; its own validation text passes through verbatim. |
| ✅ **DONE** | A-05 | poc_1 | Put the demo-fixed advisory inputs on screen | P2 | All four JIT inputs now render under the advisory, each naming the production source it stands in for. `jit.ts` claimed its constants were "documented in the assumptions register" while they were **absent** — the register now imports them, with a drift-guard test. What-if `note` states the linear model; `ArcGISAdapter` records that **live mode runs the same stub** (§C-5). |
| ❌ **OPEN** | B-03 | PoC_2 | Repair the fresh-environment build chain | P2 | All three sub-claims verified. `package.json:15` builds `packages/*` then `apps/*` — **`services/kpi` is in neither filter**, yet `packages/data/tsconfig.json:11` references it → **TS6305 on a clean checkout**. `poc-selftest` imports `@jnpa/kpi` dist (`index.ts:16`) with no documented build step. `services/pyproject.toml` has no `[build-system]`/discovery → `pip install -e` fails on flat-layout ambiguity. |
| ⚠️ **PARTLY** | B-08 | PoC_2 | On-screen honesty labels | P2 | Worse than "missing". `ModelCards.tsx:183-191` discloses only that *training data* is synthetic — and the control at `:201` is labelled **"Run live inference demo"** while the "prediction" is a CSS keyframe (`:178-181`) over hardcoded literals (`:115`). The wording asserts the opposite of the required disclosure. Rail forecast has **no** note: the fixed +2/+6/+8.5 h offsets (`mock-adapter.ts:232-234`) are disclosed only in code comments. |
| ❗ **AUDIT-WRONG** | C-02 | uc3 | Run the four AI test modules green on 3.11/3.12 | P2 | The venv **is** Python 3.11.15, and **3 of the 4 collect cleanly** (65 tests). Only `test_eir_ocr.py` errors, and not for a Python-version reason: `ingest/eir_ocr` is simply **missing from the `make venv` install list** (`Makefile:100-111`). One-line fix, not a Python downgrade. |
| ⚠️ **PARTLY** | C-06 | uc3 | Make the master-data importers portable | P2 | **Embedded passwords: already fixed** — both cited scripts now read `os.environ.get("POSTGRES_DSN", "")`. **Hardcoded `/Users/pandurangdhage/…` paths: still true, in 10 files not 2** — and the 4 *test* files are the serious ones (`test_berthing_upload.py:42`, `test_berthing_full_extract.py:32`, `test_cfs_ecy.py:215`, `test_cfs_ecy_upload.py:41`): they `skipif` on a path only one developer has, so those suites are permanently **green-because-empty** everywhere else. |
| ❓ **UNVERIFIABLE** | A-08 | suite | Single-source the assumptions register | P2 | `suite/` absent. Note it touches `poc_1/src/config/suiteAssumptions.ts` as one of three hand-copies — not actioned unilaterally. |
| ❌ **OPEN** | D-12 | uc3 | Scrub real shipping-line prefixes from invented fixtures | P2 | Verbatim true, `gate-data/seed.py:250-251`: `MSCU1234566` (MSC prefix), `MAEU7654320` (Maersk prefix). **Aggravating factor the audit missed:** `MAEU7654320` is pinned to always carry `ESEAL_TAMPER` — a synthetic security violation permanently attached to a Maersk-prefixed box in demo output. Two-line fix. |
| ❗ **AUDIT-WRONG** | B-10 | PoC_2 | Fix the stale `?scenario=CGO-2` example | P3 | **The deep-link works.** `scenarioPlayer.ts:511-521` has a deliberate `LEGACY_SCRIPT_IDS` map (`CGO-2 → S2`, etc.), documented and mirrored in two other files. Only `docs/COVERAGE.md:23,54` is genuinely stale. Line is `Dashboard.tsx:178`, not 179. |

## Category B — COMPLETE the workflow

| Status | ID | PoC | Task | Prio | Verified state |
|---|---|---|---|---|---|
| ❌ **OPEN** | B-06 | PoC_2 | Surface corpus anomalies in UC-2 panels | **P1** | Confirmed. The only DQ surface is `console/faultStore.ts:233-244`, returning **hardcoded constants** keyed off the console's fault levers — no real record ever moves those meters. `dq_issue` has **zero hits** in PoC_2 (the ledger exists only in uc3, `0202_backfill_arch.sql:85,171,333`). Dirty IMOs render verbatim with no validity flag (`Igm.tsx:117,469`, `GateOps.tsx:535`, `EdoPanel.tsx:129`). |
| ⏸ **DEFERRED** | D-08 | all | KPI consistency sweep | **P1** | Not built. **poc_1 finding for whoever picks it up:** four divergent KPI code paths, and two different quantities both labelled "pre-berth delay" — `ATB − (ATA + 1.5 h assumed)` on the KPI Wall vs `ATA − ETA` (opposite sign) on the Vessel Calls card. Cheapest fix is a KPI source register + disambiguating labels, not a refactor. The audit's example (NLDS dwell 22.7 h) has no counterpart in poc_1 — there is no dwell metric here. |
| ❌ **OPEN** | B-04 | PoC_2 | Feed the rail panel with the real rail corpus | P2 | Confirmed: only two reference readers exist (EIR, shipping-lines). No Train-Intimation / CTO / Form-11 parser anywhere. Rail is **100 % simulator output in every cargo source** — `RailSide.tsx:39` → `mock-adapter.ts:217-224` (`sim.dataset.rakes`), and both real adapters delegate straight back to the mock. |
| ⚠️ **PARTLY** | B-05 | PoC_2 | Feed Empty-pool from the real ECY/CFS events | P2 | Empty Pool itself unchanged — still `sim.dataset.emptyPools` (`mock-adapter.ts:278`), and its `<SourceBadge source="Shipping Line" />` is misleading. **But a new `CfsEcy` tab (untracked) does hit real UC-3 `/api/cfs-ecy/*`.** The hero-container half of the task is **not achievable as written**: `poc3-cargo-adapter.ts:582-585` states the feed returns population statistics only and shares no container numbers with the manifests — `ONEU2122848`/`COSU4663595` appear nowhere in the repo. |
| ⚠️ **PARTLY** | B-07 | PoC_2 | Show IGM declared-vs-actual line counts | P2 | Both numbers **are** shown (`Igm.tsx:144-145`, and in the export at `:405-406`). What is missing is the **flag**: no mismatch chip, no sort, no filter on the delta — a viewer must eyeball ~200 rows to catch the planted trap. |
| ⚠️ **PARTLY** | B-11 | PoC_2 | Demo-console cross-tab | P2 | Audit's evidence is wrong — BroadcastChannel bridges **do** exist (`simStore.ts:161`, `faultStore.ts:80`, `workflowStore.ts:155`), so the in-app console and Simulator page sync fine. Its conclusion is right for the **separate** app: `apps/demo-console/src/controller.ts` has only an `InMemoryEventBus` (`:30`) and runs on its own port, so its events cannot reach the dashboard. |
| ❌ **OPEN** | B-09 | PoC_2 | Yard-planning zone quirk | P3 | Verified at `poc3-cargo-adapter.ts:372-375` ("A-12" → "A"). "Silently" is accurate: the only acknowledgement is a **JSX comment that never renders** (`YardBackendPlanning.tsx:124`). Request-payload-only, so it is a labelling gap, not data loss. |
| ❗⏸ | A-09 | poc_1 | Surface BERMAN berth-application detail | P2 | **Not buildable as written** (§C-4): drafts/DG/ISPS/route exist in **no repo** — not in the 21-field `VesselCallWire`, not in uc3's `CallOut`, not in the DDL, not in the BERMAN parser. Needs a cross-repo migration + parser change. Buildable now instead: 9 mapped-but-unrendered call fields, and `Pilotage.draftFwdM/draftAftM`, fetched today and never shown. |
| ⏸ **DEFERRED** | A-10 | poc_1 | Departure-chain view | P2 | Partly buildable (call → events → pilot card, joinable on `Pilotage.callId`), but **next-port exists nowhere in either repo**, so the stated AC cannot be met. Contains one high-value bug worth pulling forward: the `01-01-1900` sentinel survives `toEpochMs` as a finite negative epoch, renders as `01 Jan 05:30`, and sorts to the front of every timeline. |
| ⏸ **DEFERRED** | A-11 | poc_1 | Berthing-plan versioning/diff + replan reason | P3 | Drag-replan **already exists** (`BerthGantt5Day.tsx:214-251`); only versioning/diff/reason are missing, and uc3 exposes no plan-write endpoint so nothing could persist. Highest regression risk of the deferred set. |
| ⏸ **DEFERRED** | A-12 | poc_1 | Waiting-time decomposition | P3 | Every timestamp needed for a **measured** decomposition already exists on `Pilotage` (anchor down/up, pilot boarded, all fast, berth vacated) and is never joined to calls. Today's pilotage component is an assumed 1.5 h constant. |
| ❗⏸ | A-13 | poc_1 | XLSX export for reports | P3 | **`src/reports/exportReports.ts` already exists** (the audit implies otherwise) and produces print-HTML. No XLSX library in `package.json`; `planImport.ts:14` records a deliberate "no SheetJS" decision. Hand-rolled CSV over the existing Blob pattern beats a new dependency this close to a deadline. |
| ❌ **OPEN** | C-08 | uc3 | Decide the TOS-file story | P2 | Confirmed: `NLDS_FOIS` / `9-NLDS` have **zero hits** repo-wide. "TOS File" appears twice, both in prose comments. No parser, reader, fixture or importer. |
| ❗ **AUDIT-WRONG** | C-09 | uc3 | NLDS/LDB monthly PDF auto-parse | P3 | **A real parser already exists** — `services/performance/pdf_parsers.py:415` `parse_ldb()`, ~125 lines of genuine table extraction (port dwell, CFS facility dwell, weather-conditioned dwell, train/truck segmented dwell, de-dup), wired end to end through `upload_service.py:21,52` → `POST /api/performance/validate|upload`, with `pdfplumber` a hard dependency. The audit read `service.py:87`, which is the **query** side. Upload a PDF → auto-parsed. |

## Category C — NEW features / dataflows

| Status | ID | PoC | Task | Prio | Verified state |
|---|---|---|---|---|---|
| ⚠️ **PARTLY** | C-07 | uc3 (+UC-2) | SMTP transhipment panel | P2 | More exists than credited. Parser (`services/customs/parsers/chpoi13.py`), table + seed (`0102_arch_extensions.sql:143-150`, `0202_backfill_arch.sql:236`, 209 rows asserted in `tests/test_customs_repository.py:128`) and a **live endpoint** (`gateway/routers/customs.py:167`) all exist, and SMTP is surfaced as one line in a drawer (`CustomsDetailsDrawer.tsx:135,142,172`) plus a `TRANSHIP` filter (`ShippingLines.tsx:349`). No dedicated list/detail screen — and the drawer reads `view.smtp[0]`, discarding every permit after the first. |
| ❓ **UNVERIFIABLE** | C-10 | suite | Real suite event bus | P3 | `suite/` absent. |
| ❗⏸ | C-11 | poc_1 | Lifecycle evidence explorer (`flows.json`) | P3 | **Unbuildable today:** `Business_QA_run_v10/Data_Flow_Lifecycles_2026-07-30/flows.json` is not in poc_1 or uc3. Needs the data file before it can be planned. |
| ❌ **OPEN** | C-12 | uc3 | Multi-camera tracking continuity | P3 | Depends on D-01, which is open. |

## Category D — INTEGRATION preparation

| Status | ID | PoC | Task | Prio | Verified state |
|---|---|---|---|---|---|
| ❌ **OPEN** | D-01 | uc3 | Close the video-analytics vendor contract | **P1** | The proposed schema exists (`shared/jnpa_shared/schemas.py:76-89`), but a vendor has **no endpoint to POST to**: `gateway/routers/anpr.py:14` exposes only `POST /api/anpr/infer`, an image proxy. `emit.py` is producer-only. Nothing to hand a vendor yet. |
| ❌ **OPEN** | D-02 | uc3 | Vendor-JSON validation harness | **P1** | Confirmed absent: `find ingest -iname "*quarant*" -o -iname "*valid*" -o -iname "*reject*"` → **zero results**. `emit.py:61-77` catches only transport failure and silently drops the record. |
| ⚠️ **PARTLY** | D-04 | all | LDB demo-day drill on the venue network | **P1** | **poc_1 ✅ done, and materially stronger after the merge (§M):** upstream narrowed the sample to **CCLU7468361 only** — previously *any* number returned that container's journey with the typed number swapped in — and now re-throws auth failures instead of masking them with a demo track. On top of that, when the sample *is* served the notice names one of five classified reasons with the raw error behind *Technical details*. **PoC_2 ❌ open, and worse than stated:** its Origin spoof is **Vite-dev-server-only** (`vite.config.ts:56-62`), so LDB Track **breaks in any deployed build** unless a reverse proxy replicates the header rewrite; and it has no fallback badge at all. **uc3 ⚠️** — 100 % MOCK with an honest `/api/ldb/health` posture endpoint (`routers/ldb.py:412`). **New demo-day risk:** poc_1 now authenticates by **mobile OTP**, so the drill needs live SMS reception at the venue — verify before the audience is watching. |
| ❓ **UNVERIFIABLE** | D-06 | suite | Browser-profile rehearsal (popups for :5199) | **P1** | `suite/` absent. |
| ✅ **DONE** | D-03 | all | LDB switch-over readiness | P2 | **poc_1:** new `docs/LDB.md` — data path, the three OTP calls, config table, fallback semantics and a *"proving the live path"* runbook built around the trap that with `VITE_LDB_SAMPLE_FALLBACK=true` **a failure for CCLU7468361 still looks exactly like a success**. Rewritten after the merge (§M): the doc originally described a static-bearer model that no longer exists. Includes the three-app env-key mapping and the retest list (TC-024/025/057/090/116/117). **Note the mapping is now asymmetric** — poc_1 uses OTP, PoC_2 and uc3 still expect a static key. **Cross-repo gap found:** uc3's `LDB_BASE_URL`/`LDB_API_KEY` are **not in its `.env.local.example`**. |
| ❌ **OPEN** | D-05 | uc3 | Live-rung decision | P2 | All **seven** third-party keys are present-but-empty (Surepass, ULIP, TomTom, Google, HERE, OpenWeather, Bhuvan — measured length 0). `gateway/fallback.py` is a genuinely good three-chain degradation engine with an auditable `/api/debug/decisions` trail, but it is **pinned to its lowest rungs for want of credentials**. This is a procurement decision, not engineering. |
| ⚠️ **PARTLY** | D-07 | PoC_2+uc3 | Cross-twin deployed path | P2 | **The gap is one-sided, opposite to how the audit frames it.** uc3 **does** consume it — `gateway/crosstwin.py` supports KAFKA *and* HTTP, pinned by `tests/test_crosstwin_persistence.py` and surfaced in `WhatIfConsole.tsx:448`. PoC_2 is the side that never dials: its only emitter is `apps/demo-console/src/controller.ts:97-114` publishing to an `InMemoryEventBus`, and `CROSS_TWIN_TOPIC` has **zero producers and zero consumers** outside the contract file. UC-3 has a listening socket UC-2 never calls. |
| ❌ **OPEN** | D-11 | all | Record demo capture videos | P2 | Programme task; blocked behind A-01/C-01. |

---

## §M — Merge with `origin/main` @ `6b6e75b` (LDB OTP rework)

A pull landed a substantial LDB rework mid-way through this work — auth moved
from a static bearer to **mobile OTP** (`otp-sms/generate` → `verify` →
`sessionStorage.searateToken` → `POST /track/cntr/`), plus a custom
`ldbDevProxy()` Vite plugin because LDB's Azure WAF 403s a forwarded localhost
`Origin`. Two files conflicted; both are resolved and re-verified.

| Conflict | Resolution |
|---|---|
| `src/data/ldb/track.ts` | **Both sides kept.** Upstream's auth re-throw and its narrowing of the sample to `no === SAMPLE_CONTAINER_NO` — a *better* fix than mine for the honesty problem I had documented — plus my reason-carrying so a served sample still says why. |
| `ContainerTrackPanel.tsx` (error notice) | **Upstream kept.** Its notice distinguishes *"Sign in needed"* from *"Couldn't track"*, which the shared `PanelError` cannot know, and upstream made the connector emit operator language at the source — so the A-04 translation is redundant here. This panel is now a documented, commented exception to A-04. |
| `ContainerTrackPanel.tsx` (summary caption) | **Mine kept.** Upstream re-added a 10 px "Demo data" caption; the notice above the card already states the sample state *with its reason*. Two signals for one state is one too many. |

**One silent breakage the merge would have caused, caught and fixed:**
`classifyLdbFailure` was keyed on the old `[LDB] track → HTTP 401` /
`no container payload` strings. Upstream replaced **every one of them**, so all
failures would have bucketed to the generic `error` reason — and because the
tests used the same old literals, they would have kept passing while production
quietly degraded. `failure.ts` and `failure.test.ts` are rewritten against the new
messages, and auth detection is now **structural** (duck-typed on `needsAuth`)
rather than string-matched, since the auth path has several different sentences.

**Docs corrected in the same pass** — `docs/LDB.md`, `docs/DEPLOYMENT.md` (config
table, real-vs-simulated row, presenter `.env`) and `README.md` all still
described the static-token model. A doc that misdescribes the code is the exact
failure this overlay flags in §C.

**Post-merge verification:** lint 0 · typecheck clean · **581 tests / 53 files**
(up from 569; upstream added `token.test.ts` and more mapper tests) · build
succeeds · `VITE_DATA_MODE=uc3 npm run build` still fails as designed.

**Working-tree state:** conflict markers are gone and nothing is unmerged, but
**nothing is staged** and `stash@{0}` from the interrupted pop is **still
present** — drop it (`git stash drop`) once you are satisfied, or it will be
re-applied by accident later.

## §N — Findings NOT in the audit (found while verifying)

1. 🔴 **A live cloud credential is committed in uc3.** `.env` and `.env.local` are correctly
   gitignored, but **`.env.local.example` is tracked** and contains a real 16-character
   `POSTGRES_PASSWORD` plus five DSN lines pointing at a live `ap-south-1`
   `rds.amazonaws.com` endpoint (`:16-21`) — not placeholders. **This outranks every
   item on the Phase-3 list:** rotate the RDS credential and scrub it from git history
   **before** D-10 builds any bundle.
2. 🔴 **A large share of uc3's "green" signal cannot turn red.** `make tfc1/tfc2/tfc3`,
   `scenarios-verify`, `web-verify` and `pwa-verify` all terminate in `|| true`;
   `download_anpr_weights.sh:52` exits 0 on total failure; and four test files `skipif`
   on a path only one developer has. Strip the `|| true` guards **before** attempting C-01,
   or `make up && make e2e` will report success on a substantially mocked stack.
3. 🔴 **uc3's `make test` currently runs zero tests.** Collection aborts on 3 errors
   (`eir_ocr`, `empty_container`, `gate_data` not installed by `make venv`), and the target
   uses `-x`. The suite is **1016 tests**, not the 768 the audit cites — and that figure
   appears nowhere in the repo.
4. 🔴 **PoC_2's `pnpm build` fails on a clean checkout** (TS6305 — see B-03). Any
   "build it fresh and demo" instruction needs B-03 fixed first.
5. 🔴 **`/Users/rushikeshsusar/Projects/jnpa_poc_2` holds two projects in one git tree** —
   the UC-2 pnpm monorepo *and* a full copy of a UC-III tree (`web/package.json` →
   `jnpa-uc3-dashboard`). Several audit claims land on the wrong one. Also, its
   `.gitignore` ends with `*.md`, so **all markdown in that repo is untracked**.
6. 🔴 **uc3's `docker-compose.override.yml` describes itself as untracked but is tracked**,
   so its dev-only nginx/port overrides apply on every clone, including deploy.

## §C — Corrections: audit claims that do not match the code

1. **There is no `uc3` data mode** (A-01, poc_1). The env string was cast without validation and fell through to `MockAdapter` — so following the audit's instruction produced **invented vessels that looked like a working system**. Now fails the build.
2. **`scripts/probe-uc3.mjs` already exists** (A-01) and is self-documenting.
3. **A-03's line numbers were stale and one warning was missed.** Two of the five were a genuine performance defect — an unmemoised array identity rebuilt the tide raster on *every render* of the component driving the 3D scene.
4. **A-09's premise is wrong.** Drafts/DG/ISPS/route are parsed, stored and served **nowhere** — confirmed against `VesselCallWire`, uc3's `CallOut`, the DDL and the BERMAN parser.
5. **A-05 was partly done, and understated.** A `SIMULATED` pill and `SourceBadge` were already on the JIT card; conversely the audit missed that the what-if stub also runs in **live** mode.
6. **A-02 understates the deployed build** — it is *mixed*, not wholly fictional. The mock hulls were deliberately **not** renamed: realistic names make invented tracks *harder* to spot. Label, don't relabel.
7. **C-09 is wrong** — the LDB PDF parser exists and is wired end to end.
8. **C-05 and C-04 cite files that were never committed** (`evidence/metrics.json`, `ai/anpr/eval/metrics.json` — both gitignored generated artefacts). The audit appears to have been written against a different or older checkout.
9. **D-09's uc3 evidence does not exist** — no `seed.sql`, and `pii_exposure` has zero hits. The real exposure is DOB + licence numbers unmasked on `DriverMaster.tsx`.
10. **C-02's cause is wrong** — the venv is 3.11 and 3 of 4 modules collect fine; the 4th is a missing entry in `make venv`.
11. **B-10 is wrong** — the legacy `CGO-2` deep-link resolves via a deliberate alias map.
12. **B-11's evidence is wrong** — BroadcastChannel bridges exist in `apps/web`; only the separate `apps/demo-console` lacks one.
13. **D-07 is framed backwards** — uc3 consumes the cross-twin event; PoC_2 never emits it outside memory.
14. **The lint gate was never enforced by CI** in poc_1 — `deploy.yml` went straight from `npm ci` to `vite build`. Now `ci.yml` runs it.

---

## §V — How to verify

### poc_1 (the work actually done) — from a clean checkout

```bash
cd /Users/rushikeshsusar/Projects/jnpa_poc_1
npm ci
npm run lint        # A-03 → exits 0, silent   (was: 5 warnings, non-zero)
npm run typecheck   # clean
npm test            # 581 passed, 53 files     (was: 525 / 48 before this work)
npm run build       # succeeds

# A-01 — the footgun. This MUST fail, with a descriptive message:
VITE_DATA_MODE=uc3 npm run build
```

| Task | On-screen check |
|---|---|
| **A-04** | `VITE_UC3_ENABLED=false npm run dev` → Shipping ▸ Lines reads **"Gateway data is switched off in this build"**, raw `[UC3] …` collapsed under *Technical details*. Vessels ▸ Track by Container with an empty field → still exactly **"Enter a container number"**, no details toggle. |
| **A-05** | Analytics & JIT → the advisory ends with the **"Demo-fixed inputs: …"** line. Methodology → 7 new register rows. Any what-if → note ends with the model sentence. |
| **D-03/D-04** | `VITE_LDB_ENABLED=false npm run dev` → track `CCLU7468361` → notice reads *"Container tracking is switched off in this build"* with the raw message under *Technical details*. Enabled but **not** OTP-verified → *"Sign in needed"*, **not** a demo track. Track any container **other than** CCLU7468361 while unauthenticated → a real error, never a sample. |
| **A-02 / CI** | `deploy.yml` env block + comment; `docs/DEPLOYMENT.md` § *What is real in the deployed build*. Push a branch → the new **CI** workflow runs lint/typecheck/test/build (advisory, not wired into deploy). |

### Spot-checking the other two repos

```bash
# uc3 — the three highest-value confirmations
grep -n "field parsing TODO" jnpa-uc3-poc/gateway/routers/document_ocr.py   # C-03
grep -n "|| true" jnpa-uc3-poc/Makefile | head                              # §N-2
ls jnpa-uc3-poc/evidence/                                                   # C-05 — only .gitignore + .gitkeep
git -C jnpa-uc3-poc ls-files .env.local.example                             # §N-1 — MUST come back empty after the fix

# PoC_2
grep -n "was: isValidContainerNo" jnpa_poc_2/apps/web/src/panels/ContainerMovements.tsx  # B-02
grep -n "filter './packages/\*'" jnpa_poc_2/package.json                                # B-03
```

### Not verified by me

- **The on-screen poc_1 checks above need a browser**, which I could not drive here. I
  smoke-tested the dev server and confirmed the new strings ship in `dist/`.
- **Nothing was executed in uc3 or PoC_2** beyond read-only inspection and a pytest
  `--collect-only`. Docker is not installed on this machine, so `make up` / `make e2e` /
  the TFC runs are unverified — and per §N-2 they would report success regardless.
- **suite / dtccc** (A-06, A-07, A-08, C-10, D-06) could not be checked at all: the
  directory does not exist in either repo on this machine.
