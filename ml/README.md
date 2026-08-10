# JNPA Digital Twin — UC-I Vessel Traffic Management & Optimization

Production-grade Python for all eight UC-I models in `docs/WS2_AI_ML_Tools.md`.
Tender ref **GeM/2026/B/7297343** · PoC pilot, 07 Aug 2026.

Every model is a **standalone file** that runs on a bare Python install, and all
eight are mounted behind **one FastAPI surface** so a React / Next.js / Vue
frontend can consume them as JSON.

```bash
python src/uc1_models/uc1_m1_dukc.py          # any model, no dependencies, exits 0 on success
pytest -q                                     # 232 tests
python run.py serve --reload                  # :8000/docs
```

> **UC-1 only.** The WS2 delivery also contains seven UC-II cargo-handling models
> and a UC-III set. This is the vessel-traffic PoC: they are not part of it, not
> in this tree, and nothing here imports them. If cargo handling is ever wired
> into this app, bring it in as its own service rather than re-mixing the trees —
> the UC-II models read a 43 MB document corpus that the vessel models do not.

---

## Where this copy lives

This tree is vendored inside the **UC-1 web app** repository (`jnpa_poc_1`), and
it powers the **Predictions** column in *Vessels ▸ Live AIS Feed*. Two things
follow from that, and neither changes any model:

1. **`src/pipeline/uc1_webapp_adapter.py` is new here.** It translates an AIS
   *position report* — which carries no draught, no cargo and no ATA — into the
   vessel call the eight models take, runs them through the same `run_model` and
   the same `dashboard_json.build()` the spreadsheet path uses, and returns a
   per-vessel **ledger naming every value it had to assume**. Mounted at
   `/uc1/webapp` (see `src/service/api.py`).

   ```bash
   python src/pipeline/uc1_webapp_adapter.py --selftest    # 26 checks, a CI gate
   python src/pipeline/uc1_webapp_adapter.py --mapping     # what it may substitute
   pytest tests/test_uc1_webapp_adapter.py -q              # the response contract
   ```

2. **`data/corpus/` is not checked in** — 44 MB of Daily Status Report PDFs that
   only `dsr_extract.py` reads. What the models need was already reduced into
   `data/reference/dsr_berth_stays.csv`, which *is* checked in, so M4 keeps its
   real 21-berth occupancy and **the whole test suite still passes**. See
   [`data/corpus/README.md`](data/corpus/README.md) to restore it.

The web app runs this service on **:8100** (`JNPA_PORT=8100 python run.py serve`)
because its dev proxy already uses :8000 for the UC-3 gateway. Wiring, failure
modes and configuration: [`../docs/ML_MODELS.md`](../docs/ML_MODELS.md).

---

## The eight models

| | Module | WS2 row | What it answers | Type |
|---|---|---|---|---|
| **M1** | [uc1_m1_dukc.py](src/uc1_models/uc1_m1_dukc.py) | 1 | Is there enough water under the keel, per reach? | deterministic physics |
| **M2** | [uc1_m2_tidal_window.py](src/uc1_models/uc1_m2_tidal_window.py) | 2 | When can she transit in the next 5 days — and what does dredging buy? | window scan |
| **M3** | [uc1_m3_tat_predict.py](src/uc1_models/uc1_m3_tat_predict.py) | 3 | How long until she sails, and how confident are we? | dual engine (additive + learned) |
| **M4** | [uc1_m4_berth_utilisation.py](src/uc1_models/uc1_m4_berth_utilisation.py) | 4 | How full are the berths, how long do ships wait, how good is this ETA? | deterministic analytics |
| **M5** | [uc1_m5_berth_optimiser.py](src/uc1_models/uc1_m5_berth_optimiser.py) | 5 | Re-plan the berths now, and show me the cost. | greedy + CP-SAT |
| **M6** | [uc1_m6_jit_rta.py](src/uc1_models/uc1_m6_jit_rta.py) | 6 | Slow-steam or arrive-and-wait? What does it save? | deterministic physics |
| **M7** | [uc1_m7_port_craft.py](src/uc1_models/uc1_m7_port_craft.py) | 7 | Enough pilots and tugs — and if not, what single change fixes it? | conflict heuristic |
| **M8** | [uc1_m8_causal_chain.py](src/uc1_models/uc1_m8_causal_chain.py) | 8 | One thing changed. What cascades, and how much do I still trust the plan? | 23-node causal DAG |

Supporting: [dsr_extract.py](src/pipeline/dsr_extract.py) (real data), [api.py](src/service/api.py) (HTTP),
[uc1_webapp_adapter.py](src/pipeline/uc1_webapp_adapter.py) (live-AIS ingest for
the web app), [tests/](tests/) (regression suite).

---

## Quick start

```bash
# 1. Nothing installed? The models still run.
python src/uc1_models/uc1_m1_dukc.py
python src/uc1_models/uc1_m2_tidal_window.py --draft 16.0
python src/uc1_models/uc1_m8_causal_chain.py --scenario S5

# 2. Full stack
pip install -r requirements.txt
pytest tests -q
python run.py serve --reload

# 3. Real data — already reduced into data/reference/. Re-derive it only if you
#    have restored the DSR corpus (see data/corpus/README.md).
python run.py dsr --emit-berths data/reference/berths.json
python src/uc1_models/uc1_m4_berth_utilisation.py        # reads the real 345 rows

# 4. The web app's path: an AIS feed through all eight models
python src/pipeline/uc1_webapp_adapter.py                # the demo fleet, as a table
JNPA_PORT=8100 python run.py serve                       # http://127.0.0.1:8100/docs
```

Every module accepts `--json`, `--selftest` and (where it trains) `--seed`, and
exits non-zero if any self-check fails — so each file doubles as a CI gate.

---

## Project layout

```
run.py                      one entry point: models | predict | train | input | dsr | serve
conftest.py                 puts the src/ folders on sys.path for pytest

src/uc1_models/             the eight UC-I models. Stdlib-only, no imports of each other
src/pipeline/               everything that feeds and follows them
    jnpa_paths.py             where every default path is defined
    jnpa_input.py             read + validate the vessel-call sheet, adapt to each model
    run_model.py              run any model (or all eight) over a file
    predict.py                M3 only: ETB / TAT / ETD
    train_tat_model.py        fit and freeze the one learned model
    dashboard_json.py         build the small, UI-facing prediction file
    uc1_webapp_adapter.py     live-AIS row -> all eight models, with a ledger
                              naming every input it had to assume
    dsr_extract.py            pull real berth stays out of the DSR PDF corpus
src/service/api.py          FastAPI: all eight models over HTTP (:8000; :8100 for the web app)

data/input/                 vessel-call spreadsheets you feed in
data/reference/             berth roster + extracted berth stays (real data)
data/corpus/                the raw DSR corpus, read-only — not checked in
trained_models/             the M3 .pkl artefact and its model card
out/                        generated predictions; the dashboard samples are tracked
docs/                       runbook, model explainer, specs
tests/                      232 tests
```

`run.py` exists so the source can live under `src/` without every caller setting
`PYTHONPATH`. Anything after the sub-command is passed straight through, so every
flag in the runbook still applies.

---

## Running the models on your own data

The commands above run each model's built-in demo. To run them on a real vessel
call sheet, use the integration layer.

**Two guides, depending on what you need:**

| Document | For |
|---|---|
| **[MODELS_EXPLAINED.md](docs/MODELS_EXPLAINED.md)** | No port background needed. Teaches the maritime concepts, then explains each model in detail — what it does, every input field, every output field, and how to render it in a UI |
| **[RUNBOOK.md](docs/RUNBOOK.md)** | Every command, every flag, every input column. Assumes you know the domain |

```bash
# Validate your file before running anything on it
python run.py input --input data/input/Vessel_Training_Input_Sample.xlsx --validate

# Train the one model that learns; writes trained_models/*.pkl + a model card
python run.py train --out trained_models/

# The three targets the sample workbook asks for: ETB, TAT, ETD
python run.py predict --input data/input/Vessel_Training_Input_Sample.xlsx --out out/

# Any model, or all eight, over the same file
python run.py models --list
python run.py models --model m1  --input data/input/Vessel_Training_Input_Sample.xlsx
python run.py models --model all --input data/input/Vessel_Training_Input_Sample.xlsx --out out/
```

| File | Purpose | Self-test |
|---|---|---|
| `src/pipeline/jnpa_input.py` | Read/validate/normalise the input; IST→UTC; adapters for all 8 models | 42/42 |
| `src/pipeline/train_tat_model.py` | Train M3, write a versioned artefact + model card | 10/10 |
| `src/pipeline/predict.py` | Score an input file → ETB / TAT / ETD | 19/19 |
| `src/pipeline/run_model.py` | Run any model (or all 8) on your rows | 17/17 |

Only **three columns are required**: `Vessel`, `ATA`, `Draft_m`. Everything else
is optional and either defaulted or derived, with a `*_source` field recording
which. `python run.py input --emit-template my_input.xlsx` writes a documented
blank template.

**Only M3 has a trained model file.** The other seven are deterministic — physics,
geometry, interval arithmetic, an optimiser, a causal graph — so their "weights"
are the versioned constant block inside each module, served at
`GET /uc1/mN/constants`. See [RUNBOOK.md §3](docs/RUNBOOK.md).

`ETB`, `TAT` and `ETD` are targets: if they appear in an input file the loader
raises a hard error rather than ignoring them.

---

## Two output files, on purpose

Every JSON run writes a pair. They carry the same numbers; they answer different
questions.

| File | Size (3 vessels) | Read it when you want to |
|---|---|---|
| `out/uc1_all_models.json` | ~780 KB | **defend** a number — every formula, every substituted value, every intermediate node, the full constant block of each model |
| `out/uc1_all_models_dashboard.json` | ~22 KB | **display** a number — one object per vessel, its inputs, and 5–9 fields per model |

`python run.py predict` writes the same pair as `predictions.json` and
`predictions_dashboard.json`, M3 only.

The dashboard file is built by selection, never recomputation — a test asserts
its values equal the audit file's. Its shape:

```jsonc
{
  "run":      { "input_file": "...", "vessels": 3, "models_run": [...] },
  "glossary": { "net_ukc_m": "Under-keel clearance after squat and the 1.0 m margin ...", ... },
  "vessels": [{
    "call_id": "C-0002", "vessel": "HONG YONG CHANG SHENG", "imo": "1103316",
    "input":        { "ata_ist": "...", "draft_m": 13.2, "teu_total": 3600, ... },
    "data_quality": { "tide": "SYNTHETIC_HARMONIC_v1", ... },
    "flags":        ["WAIT_IS_LOWER_BOUND", "TIDE_SYNTHETIC"],
    "models": {
      "m1_under_keel_clearance": { "status": "SAFE", "net_ukc_m": 4.85, ... },
      "m3_turnaround_time":      { "tat_hours": 43.5, "etb_ist": "...", ... },
      // ... one block per model that ran
    }
  }],
  "port_summary": { "berth_utilisation": {...}, "jit_savings": {...}, ... }
}
```

**`glossary` is shipped inside the file.** Every key that is not self-evident
from its name has a one-line explanation there, so the file needs no side
document — and a self-test fails the build if a new key is added without one.

`port_summary` holds the batch-level numbers — berth occupancy, fleet fuel
savings, the craft roster. They belong to the port, not to any one vessel, so
repeating them per vessel would be both noisy and wrong.

The rule for what gets in: a key belongs in the dashboard file only if a UI
would render it. If it exists to prove *how* a number was reached, it stays in
the audit file. See [dashboard_json.py](src/pipeline/dashboard_json.py).

---

## Architecture

### Eight self-contained flat files

Each module imports **nothing outside the standard library** above its FastAPI
section. That is a deliberate requirement: any single file can be copied out and
run in isolation. The cost is duplication — the DUKC core, the time helpers and
the table formatter appear in several files, each marked
`# DUPLICATED BY DESIGN — do not factor out`.

### The fingerprint gate

M1, M2, M6 and M8 each carry a **byte-identical** copy of the DUKC core. Drift
between those copies would mean two different definitions of "safe under-keel
clearance", so it is made *detectable* rather than merely discouraged:

1. `DUKC_CORE_FINGERPRINT` changes whenever any constant or formula changes.
2. `_dukc_core_selftest()` asserts golden values and runs from every `__main__`.
3. **`src/service/api.py` refuses to start** unless all four fingerprints match *and* all four
   golden-value self-tests pass.
4. `GET /health` re-exposes the fingerprint, so drift is visible in production.

### Explainability

Every deterministic model returns a `breakdown` dict whose steps each carry
`formula`, `terms`, and — the field that makes it audit-grade — `substitution`:
the formula with the real numbers already plugged in **and** the result.

```
[2] Barrass squat          min(2.5, 0.650 * 10.0^2 / 100) = 0.650   (clamp_active=False)
[3] Effective water depth  15.00 + 2.60 - 0.00 + 0.00 = 17.600      (reach CH-INNER)
[4] Gross UKC              17.600 - (15.00 + 0.650) = 1.950
[5] Net UKC                1.950 - 1.000 = 0.950
[6] Status classification  net 0.950 -> MARGINAL
```

A reviewer can verify the arithmetic without running the code.

### `GET <prefix>/constants`

Every module serves its versioned coefficient block over HTTP. That endpoint
*is* the tender's "Link to Model Weights" column.

---

## Verified results

All numbers below come from the committed code; reproduce with the command shown.

### M1 — DUKC (`python src/uc1_models/uc1_m1_dukc.py`)

Reference ULCV, draft 15.0 m at 10 kn, CH-INNER, tide 2.60 m:

```
squat 0.650 m -> gross 1.950 m -> net 0.950 m -> MARGINAL
min tide for SAFE 2.650 m  |  max SAFE speed 9.61 kn
```

Closed-form inverse solves (no search loop) turn M1 from a calculator into an
advisor: *"reduce to 9.6 kn, or wait for 2.65 m of tide."*

The binding reach is `argmin(net UKC)`, **not** the shallowest charted depth. The
turning basin shares CH-INNER's 15.0 m but its 6 kn cap produces a quarter of the
squat, so it stays SAFE while CH-INNER binds.

### M2 — Tidal windows (`python src/uc1_models/uc1_m2_tidal_window.py`)

Draft 15.5 m, 481 samples over 120 h, binding reach CH-INNER at 3.150 m required tide:

| Scenario | Windows | Total h | Mean h | Max gap h | Availability |
|---|---|---|---|---|---|
| Baseline | 10 | 46.50 | 4.65 | 8.25 | 38.8% |
| Dredged +0.5 m | 10 | **59.25** | 5.92 | 7.00 | 49.4% |
| Silted −0.3 m | 10 | 39.25 | 3.92 | 9.00 | 32.7% |

**Dredging adds +12.75 h (+27.4%) and cuts the worst wait by 1.25 h.** That table is
the "extend tidal window" deliverable.

`min_status` defaults to **SAFE**. MARGINAL periods (a further 9.75 h) are scanned
and reported separately as *conditional windows* and are never counted as usable —
claiming transits at 0.6 m net UKC is not defensible.

### M3 — TAT prediction (`python src/uc1_models/uc1_m3_tat_predict.py`)

Dual engine: a transparent additive model (always available, zero dependencies)
and a learned quantile regressor (LightGBM → sklearn GBR → sklearn RF → additive).
On 365 days of calibrated synthetic history:

| Engine | MAE h | RMSE h | Forecast accuracy | 80% coverage |
|---|---|---|---|---|
| additive | 2.39 | — | 94.40% | — |
| lightgbm | 2.49 | — | 94.10% | **85.7%** |

Calibration against the published JNPA anchors passes: mean TAT **1.850 d** (target
1.83 ± 0.05), mean berth stay **0.984 d** (target 0.97 ± 0.05).

### M4 — ETA & berth utilisation (`python src/uc1_models/uc1_m4_berth_utilisation.py`)

`sigma = 0.06 · horizon_h + 0.05 · staleness_min`. The interesting result is that
**staleness dominates at short range**: a 2 h horizon on a 3-hour-old fix (σ 9.12 h)
is far more uncertain than a 24 h horizon on a fresh one (σ 1.44 h).

On the real extracted data: **345 records, 21 berths, 56.01% occupancy, 0 dropped.**

### M5 — Berth optimiser (`python src/uc1_models/uc1_m5_berth_optimiser.py`)

Cost = `1.0·Σwait_h + 2.0·tide_misses + 0.5·berth_shifts`.

| Scenario | Cost | Δ vs baseline |
|---|---|---|
| Baseline (greedy) | 30.15 | — |
| Baseline (**CP-SAT**) | **17.66** | **−41%** |
| Tide narrowed to 50% | 39.53 | +9.38 |
| BMCT-01 outage | 67.41 | +37.26 |
| Deep-draft ULCV added | 86.38 | +56.23 |
| +5 unplanned arrivals | 132.42 | +102.26 |

CP-SAT is the production upgrade WS2 names; it activates automatically when
`ortools` is installed and `auto` keeps the greedy plan as a **floor**.

### M6 — JIT arrival (`python src/uc1_models/uc1_m6_jit_rta.py`)

240 NM to go, service 16 kn, berth ready in 20 h, window opens in 19 h:

| Leg | Speed | Transit | Steaming t | Wait h | Total t |
|---|---|---|---|---|---|
| Baseline full speed | 16.00 | 15.00 h | 48.00 | 5.00 | 49.75 |
| **JIT slow steam** | **12.00** | 20.00 h | **27.00** | 0.00 | 27.00 |

**Headline: 21.00 t bunker · 65.39 t CO₂ · USD 12,600 · 5.00 h anchorage eliminated.**

The headline is the **steaming-only** comparison, resting on nothing but the cube
law. The anchorage-inclusive figure (22.75 t / 70.84 t CO₂ / USD 13,650) is computed
and shown as a clearly-labelled secondary line — it is larger, but the 0.35 t/h
hotel-load rate is itself an assumption an evaluator can challenge.

### M7 — Port craft (`python src/uc1_models/uc1_m7_port_craft.py`)

Real 18-craft roster: **FEASIBLE**, 0 conflicts on 8 movements.
Spec 9-craft roster minus 2 pilots: **7 conflict blocks**, top proposal
`DELAY MV-1006 by 125 min`, closing 480 gap-minutes.

### M8 — Reactive confidence chain (`python src/uc1_models/uc1_m8_causal_chain.py`)

23 nodes, 30 edges, acyclic by construction. Every run logs **all 23 propagation
steps**, including unchanged nodes.

| | Scenario | DUKC m | Window h | Queue | TAT h | Confidence | Alert |
|---|---|---|---|---|---|---|---|
| S1 | Nominal fair weather | 0.95 | 5.60 | 2.00 | +0.00 | 0.950 | NORMAL |
| S2 | Moderate wind 22 kn | 0.95 | 5.60 | 3.16 | +2.33 | 0.829 | ADVISORY |
| S3 | Siltation 0.3 m | 0.65 | 4.94 | 2.40 | +1.03 | 0.792 | ADVISORY |
| S4 | **Dredging +0.5 m** | 1.45 | 6.70 | 1.34 | +0.00 | **1.000** | NORMAL |
| S5 | Compound squall | 0.65 | 4.94 | 8.80 | +14.56 | **0.094** | CRITICAL |
| S6 | **Squall + dredging lever** | 1.15 | 6.04 | 8.14 | +12.84 | **0.358** | CRITICAL |

**S6 is the payoff: the same storm, but the dredging lever claws back +0.263 of
confidence and +1.10 h of deep-draft window.** One graph, one engine, showing both
the disruption and the mitigation.

Note S1: the reference ULCV at mean tide is already MARGINAL (0.95 m net UKC —
the identical figure M1 reports for the same case, because they share the core).
That is not a modelling artefact; it is why JNPA is tide-dependent for deep-draft
calls at all, and it is what makes the S4 lever worth anything.

Root-cause attribution for S5: `WX_WIND_KN 38% · PILOT_AVAIL_N 25% · SILTATION_M 25%
· WX_RAIN_MMHR 13%`.

---

## Real data

`src/pipeline/dsr_extract.py` parses section (H) *"Vessels Under Operation"* from all 54 JNPA
Daily Status Reports — the one source in the UC-I corpus that is tabular,
machine-readable and consistently formatted.

```
54 PDFs -> 1,113 rows (744 occupied, 369 vacant), 0 rejected, 0 read failures
Feb-May 2026 | 21 berths | 7 terminals
Berth stay: p10 13.79 h · p50 26.70 h · p90 48.81 h · mean 29.48 h
```

**Berth-id normalisation matters.** The reports spell the same berth both ways —
`BMCT-01` and `BMCT01`, `LB-01` and `LB-01 [SOUTH]`. Left alone that inflates the
roster from 21 physical berths to 32 and halves the apparent occupancy of every
affected berth. Both the raw string and the canonical id are emitted so the
mapping is auditable.

Everything else (tide tables, bathymetry, the five terminal berthing-report
layouts) sits behind documented loader stubs whose `NotImplementedError` message
**is** the extraction contract — source path, field list, date format, join key,
reject rules, and the dependency to add.

---

## Honest limitations

These are stated here because an evaluator who finds an unlabelled guess stops
trusting the exact physics too.

- **The Daily Status Reports have no ATA.** Berth stay (ATB→ATD) is derivable;
  **waiting time and full TAT are not.** Those need the PCS VESARR/VESDEP logs
  joined on VCN. `DailyStatusReportLoader.load_calls()` raises rather than
  pretending otherwise.
- **"Expected Completion" is a forecast**, not a recorded departure. Rows carry
  `completion_is_forecast`.
- **The spec's craft roster contradicts its own source.** `WS2_AI_ML_Tools.md`
  row 7 says "9 craft: 3 pilots, 4 tugs, 2 mooring" and cites
  `Details_of_Port_Crafts.pdf`; that PDF lists **18 craft**. The real roster is the
  default (`JNPA_ROSTER_REAL`), the spec figure is kept as the `poc` preset, and the
  discrepancy is stated in the module docstring and served at `GET /uc1/m7/roster`.
- **Craft response times are assumed** — they are not in the PDF. Every craft
  carries `response_time_source="ASSUMED"`.
- **25 of M8's 30 edges are `EXPERT_JUDGEMENT`** and labelled as such. Only E04–E07
  are exact physics; E14 is regressed against the embedded M2 scanner with
  residuals printed (+0.3% and −1.1%).
- **M3's contribution chart explains the additive surrogate**, not the
  gradient-boosted model, whenever a learned engine supplies P50. The response
  carries `attribution_source` and a note; render it in the UI caption.
- **On synthetic data the additive model is the oracle** — it generated the labels,
  so no learned model can beat it. That is a property of synthetic data, not
  evidence about production. WS2 agrees: the GBM is the upgrade triggered by
  "≥ 6 months of ingested call history".
- **A model trained on 5 dry months cannot band a monsoon.** Measured: at 180 days
  of history the LightGBM 80% band covers 68.4%; at 365 days it covers 85.7%.
  `DEFAULT_HISTORY_DAYS = 365` for that reason.
- **M6's commercial figures are SIMULATED** under named assumptions (USD 600/t
  bunker, 0.35 t/h at anchor). Weather, current and hull fouling are not modelled.
- **The greedy optimiser is explicitly not globally optimal.** CP-SAT beats it by
  41% on the demo scenario. Greedy is kept because it is instant and feasible by
  construction, which is what a live what-if demo needs.
- **CORS is wide open** (`allow_origins=["*"]`) because this is a PoC serving a
  separate frontend dev server. Tighten before any public exposure.

---

## Data-leakage policy (UC1-M3)

Leakage is the failure mode that makes a TAT model look excellent in validation
and useless in production. Four controls, the first enforced **at import time**:

1. **Structural separation.** `TATFeatures` (pre-berthing only) and `TATLabel`
   (target + outcome timestamps) are different frozen dataclasses. No code path
   passes a `TATLabel` to a model.
2. **Explicit allow-list, never `asdict()`.** `FEATURE_COLUMNS` (16 numerics) and
   `BANNED_FIELDS` (11). `_assert_no_leakage()` runs on import — add `atd_utc` to
   the feature list and you get an `AssertionError`, not a suspiciously good MAPE.
   `atb_utc` is **banned as a predictor**: it is the split key only.
3. **Chronological split with purge.** Sort by ATB, cut at the 80th percentile of
   *time*, then purge from train any call whose outcome had not been observed at
   the boundary. `max(train ATB) < min(test ATB)` is asserted. We never call
   `train_test_split(shuffle=True)` or `KFold` — random splitting puts calls from
   the same day, sharing yard state, weather and tide, on both sides.
4. **No fit statistics from test.** Imputation medians come from train only;
   hyperparameters are selected on expanding-window folds *inside* the train slice.
   The conformal calibration slice is likewise carved from the tail of train.

Verify: `GET /uc1/m3/leakage-audit`, or `pytest tests -k leakage`.

---

## API

```bash
python run.py serve --reload
```

| Endpoint | Purpose |
|---|---|
| `/docs` | Interactive OpenAPI — **61 routes** across 8 modules |
| `/health` | All modules + the DUKC fingerprint. `?deep=true` runs every self-test |
| `/uc1/manifest` | Route and version discovery, so a frontend hard-codes nothing |
| `/uc1/constants` | Every module's versioned coefficients in one call |
| `/uc1/demo-all` | Runs all 8 demos — a one-call smoke test after deploy |
| `/uc1/m8/graph.dot` | Graphviz source for the tender document |
| `POST /uc1/webapp/predictions` | **Whole AIS feed → all eight models**, dashboard-shaped, one ledger per vessel |
| `POST /uc1/webapp/vessel-predictions` | One AIS row (fleet models then describe a port of one) |
| `POST /uc1/webapp/mapping-preview` | The translation for one row **without running a model** |
| `/uc1/webapp/mapping` | Every constant the adapter may substitute for a field AIS never sends |

Per module: `<prefix>/demo`, `<prefix>/constants`, `<prefix>/health`.

---

## Testing

```bash
pytest -q                        # 232 tests, ~3 s
pytest tests -q -m "not slow"    # skip the model-training tests

# the standalone gates — every model file is its own CI check
for f in src/uc1_models/uc1_m*.py; do python "$f" > /dev/null || echo "FAIL $f"; done
python run.py input       --selftest    # 42/42
python run.py train       --selftest    # 10/10
python run.py predict     --selftest    # 19/19
python run.py models      --selftest    # 17/17
python src/pipeline/uc1_webapp_adapter.py --selftest   # 26/26
```

`tests/test_uc1_webapp_adapter.py` covers what the adapter cannot check about
itself: the response contract the web app renders, agreement with the audited
spreadsheet path, and the refusals that stop a wrong prediction reaching a screen
(an unknown model id, an empty fleet, a non-object row, an over-large feed).

Beyond the happy paths, the suite pins the specific failure modes found during
the build:

- DUKC squat clamp and the exact 0.6 / 1.0 status-band boundaries
- M2's 481-sample count and the window-duration off-by-one
- M3's import-time leakage assert, chronological ordering, quantile crossing,
  and `OSError` fallthrough (LightGBM on Windows without VC++ raises `OSError`,
  not `ImportError` — a guard that catches only `ImportError` crashes the module)
- M4's union-vs-sum occupancy, cross-midnight day cells, no cell over 100%
- M5's berth exclusivity and independent cost recomputation
- **M7's craft double-allocation** — the defect confirmed in the prior codebase,
  where an availability pool was sliced per movement and handed the same pilot to
  overlapping jobs. The conflict report looked fine; the plan was impossible.
- M8's acyclicity, 23/30 shape and full-log completeness
- Cross-module DUKC fingerprint agreement, including numeric agreement
- **Portability**: a subprocess blocks `fastapi`, `pydantic`, `lightgbm`, `sklearn`,
  `ortools`, `numpy` and `pandas` at the import hook, then imports each module and
  runs its self-test. The only honest way to verify "runs on a bare install".

`tests/test_integration.py` covers the input-file → prediction path:

- a target column (`ETB`/`TAT`/`ETD`/`ATB`/`ATD`) in the input is a hard error
- IST → UTC happens exactly once, and an already-offset timestamp is not shifted again
- the stdlib `.xlsx` reader agrees with openpyxl cell for cell
- a trained artefact round-trips to identical predictions, and a modified `.pkl` is refused
- `ETD − ATA == TAT` and `ETB − ATA == wait` on every row
- the coverage gate rejects a band that covers 99% as well as one that covers 41%
- M8's DUKC column is declared as the reference vessel, not the row's vessel

---

## Production upgrade path

Per WS2's own table, and implemented or contracted here:

| PoC component | Production replacement | Status |
|---|---|---|
| Additive TAT model | LightGBM quantile regressor | **Implemented**, auto-selected when available |
| Greedy berth optimiser | MILP / CP-SAT, same schema | **Implemented**, auto-selected when `ortools` present |
| Analytic tide curve | INCOIS / tide-gauge assimilation | Contracted in `BerthingReportTideProvider` |
| ETA fixtures | Learned model on AIS tracks | Contracted in `AisFleetProvider` |
| M8 judgement edges | Structure learning on incident logs | Documented; every edge carries its `basis` |

---

## Files

```
uc1_m1_dukc.py                DUKC / RTUKC engine          (owns the DUKC core)
uc1_m2_tidal_window.py        120 h window scanner
uc1_m3_tat_predict.py         TAT prediction, dual engine
uc1_m4_berth_utilisation.py   ETA uncertainty + occupancy
uc1_m5_berth_optimiser.py     greedy + CP-SAT berth plan
uc1_m6_jit_rta.py             JIT arrival / RTA advisory
uc1_m7_port_craft.py          craft assignment + conflicts
uc1_m8_causal_chain.py        23-node / 30-edge causal DAG

jnpa_input.py                 input schema, validation, IST->UTC, model adapters
train_tat_model.py            trains M3 -> models/*.pkl + model card
predict.py                    input file -> ETB / TAT / ETD
run_model.py                  run any model (or all 8) on your rows
MODELS_EXPLAINED.md           port primer + every model, input, output and UI
RUNBOOK.md                    how to run each model on your own data

dsr_extract.py                real Daily Status Report extractor
api.py                        unified FastAPI app
tests/test_uc1_models.py      138-test model regression suite
tests/test_integration.py     74-test suite for the input -> prediction path
requirements.txt              all optional; models need none
```
