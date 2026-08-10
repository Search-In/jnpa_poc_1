# JNPA UC-1 — Runbook

**How to feed your own data to each of the eight models, and what comes back.**

Everything here was run against `Vessel_Training_Input_Sample.xlsx` on this machine; the outputs
quoted are real, not illustrative.

> **New to ports?** Read **[MODELS_EXPLAINED.md](MODELS_EXPLAINED.md)** first. It teaches the
> maritime concepts from scratch, then explains each model, every input field, every output field,
> and how to display the results in a UI. This runbook assumes you already know what a berth and a
> tidal window are.

---

## 1. Sixty-second start

```powershell
cd "d:\Search In\JNPA ML Models"

# 1. Check your file is readable before you run anything on it
python run.py input --input data/input/Vessel_Training_Input_Sample.xlsx --validate

# 2. Train the one model that actually learns (writes trained_models\*.pkl + *.json)
python run.py train --out trained_models/

# 3. Get the three target columns: ETB, TAT, ETD
python run.py predict --input data/input/Vessel_Training_Input_Sample.xlsx --out out/

# 4. Or run all eight models over the same file
python run.py models --model all --input data/input/Vessel_Training_Input_Sample.xlsx --out out/
```

Outputs land in `out\`:

| File | What's in it |
|---|---|
| `out\predictions.xlsx` | ETB / TAT / ETD per vessel, plus bands, drivers and a `Run_Info` sheet |
| `out\predictions.json` | The same, with the full per-row arithmetic |
| `out\predictions_dashboard.json` | M3 only, UI-shaped: one object per vessel, ~10 fields |
| `out\uc1_all_models.xlsx` | One sheet per model (M1…M8) + `Summary` + `Run_Info` |
| `out\uc1_all_models.json` | Every model's complete breakdown dictionaries |
| `out\uc1_all_models_dashboard.json` | All eight models, UI-shaped: one object per vessel, 5-9 fields per model, ~22 KB |

The `_dashboard.json` files carry the same numbers as their `.json` sibling
and none of the derivation. Read the big file to **defend** a number; read
the small one to **display** it.

---

## 2. Which file does what

```
Vessel_Training_Input_Sample.xlsx          <- your data
            |
    jnpa_input.py         schema, validation, IST->UTC, adapters to all 8 models
            |
            +--------------------------+--------------------------+
            |                          |                          |
   train_tat_model.py            predict.py                 run_model.py
   trains M3, writes             ETB / TAT / ETD            runs any of M1..M8
   trained_models\*.pkl + card           from the trained .pkl      on your rows
            |                          |                          |
            +----------> trained_models\uc1_m3_tat_lightgbm_v1.2.0.pkl <---+
```

| File | Purpose | Run it standalone? |
|---|---|---|
| `src/pipeline/jnpa_input.py` | Read + validate + normalise the input file | `python run.py input --selftest` → 42/42 |
| `src/pipeline/train_tat_model.py` | Train M3, write a versioned artefact + model card | `--selftest` → 10/10 |
| `src/pipeline/predict.py` | Score an input file → ETB / TAT / ETD | `--selftest` → 19/19 |
| `src/pipeline/run_model.py` | Run any model (or all 8) on your rows | `--selftest` → 17/17 |
| `src/pipeline/dashboard_json.py` | Build the small, UI-facing prediction file | `python src/pipeline/dashboard_json.py` → 5/5 |
| `src/pipeline/jnpa_paths.py` | Every default path, resolved from the repo root | — |
| `uc1_m1..m8_*.py` | The eight models. Self-contained, stdlib-only | `python src/uc1_models/uc1_m1_dukc.py` → 12/12 |
| `src/service/api.py` | FastAPI service exposing all 8 as REST | `python run.py serve --reload` |
| `src/pipeline/dsr_extract.py` | Parse real berth stays out of 54 Daily Status Report PDFs | `python run.py dsr` |

---

## 3. Your question about model files — answered directly

> *"for prediction model don't we create the model file and use it in the other file which takes
> input file and gives output… don't we do that for other models as well?"*

**Yes for M3. No for the other seven, and that is not a gap — it is what they are.**

Only M3 learns from history, so only M3 has weights to freeze. The other seven are deterministic:
DUKC is Barrass squat physics, M2 is tidal geometry, M4 is interval arithmetic, M5 is a constrained
optimiser, M6 is the propeller law, M7 is interval-aware allocation, M8 is a fixed causal graph.
Running them twice on the same input gives the same answer by construction — there is nothing to
fit, so a `.pkl` would contain nothing but the constants that already ship inside the module.

| | M3 | M1, M2, M4, M5, M6, M7, M8 |
|---|---|---|
| Kind | Supervised ML | Deterministic / physics / optimisation |
| "Model file" | `trained_models\uc1_m3_tat_lightgbm_v1.2.0.pkl` | The versioned constant block inside each module |
| Produced by | `src/pipeline/train_tat_model.py` | Nothing to produce |
| Inspect it | `trained_models\*.json` model card | `python run.py models --model m1 …`, or `GET /uc1/m1/constants` |
| Changes between runs? | Only when you retrain | Never |

So the pattern you described is exactly what's implemented — for the model where it means
something:

```powershell
python run.py train --out trained_models/                      # once: fit and freeze
python run.py predict --input your_file.xlsx --out out/          # many times: score, never refit
```

`src/pipeline/predict.py` verifies the artefact's SHA-256 against its model card before unpickling and refuses a
file that has changed since training.

### What the trained artefact currently is

```
trained_models\uc1_m3_tat_lightgbm_v1.2.0.pkl     1.3 MB   the fitted model
models\uc1_m3_tat_lightgbm_v1.2.0.json     12 KB   the model card (read this one)
models\uc1_m3_tat_additive_v1.2.0_portable.pkl      2 KB   zero-dependency fallback
```

From the model card, measured on a chronologically held-out 804 calls:

| | |
|---|---|
| Engine | `lightgbm` (won the fallback chain: lightgbm → sklearn_gbr → sklearn_rf → additive) |
| Trained on | 365 days, 4,016 calls, seed 20260807 |
| Split | Chronological, purge + 24 h embargo, `max(train ATB) < min(test ATB)` asserted |
| MAE | **2.49 h** |
| Forecast accuracy | **94.10 %** ((1 − MAPE) × 100) |
| 80 % band coverage | **85.7 %** |
| Leakage audit | PASS — `BANNED_FIELDS ∩ FEATURE_COLUMNS = ∅`, enforced at import time |

Retrain variants:

```powershell
python run.py train --days 540                       # longer history
python run.py train --engine additive --tag portable # no ML libraries needed
python run.py train --compare-engines                # table only, writes nothing
```

Training refuses to write an artefact that fails a quality gate (MAE ≤ 8 h, accuracy ≥ 80 %,
coverage between 60 % and 95 %). Override with `--force` if you know why.

---

## 4. The input file

`.xlsx`, `.csv` and `.json` are all accepted. Header matching ignores case, spaces, underscores,
hyphens and `%`, so `Berth Occupancy %`, `berth_occupancy_pct` and `BERTH-OCCUPANCY%` are the same
column. Unknown columns are carried through as context and reported, never silently dropped.

Get a blank template with every column documented:

```powershell
python run.py input --emit-template my_input.xlsx
```

**Only three columns are required: `Vessel`, `ATA`, `Draft_m`.** Everything else is optional and
either defaulted or derived — and every derivation is recorded in a `*_source` field so an estimate
can never be mistaken for a measurement.

### 4.1 The 25 columns in your sample workbook

| Column | Required | Type | Unit | Meaning |
|---|---|---|---|---|
| `Vessel` | **yes** | str | – | Vessel name. |
| `IMO` | no | str | – | IMO number; identity only, never a feature. |
| `Voyage` | no | str | – | Voyage / VIA number. |
| `ETA` | no | datetime | IST | Estimated arrival. |
| `ATA` | **yes** | datetime | IST | Actual arrival. Anchor for every downstream time. |
| `Import_TEU` | no | int | TEU | Import parcel. |
| `Export_TEU` | no | int | TEU | Export parcel. |
| `Total_TEU` | no | int | TEU | Total parcel; falls back to Import + Export. |
| `Cargo_Weight_MT` | no | float | MT | Cargo weight. |
| `Draft_m` | **yes** | float | m | Static arrival draft. Drives DUKC and berth fit. |
| `LOA_m` | no | float | m | Length overall; drives berth-length feasibility. |
| `Terminal` | no | str | – | NSFT / NSICT / NSIGT / APMT / BMCT / NSDT / BPCL / JJLTPL. |
| `Requested_Berth` | no | str | – | Canonicalised to the roster form. |
| `Pilot_Available` | no | str | – | Yes / Busy / No → a pilot count. |
| `Tug_Available` | no | str | – | Yes / Busy / No → a tug count. |
| `Cranes_Available` | no | int | count | **Context only — not an M3 feature.** See §7. |
| `DUKC_Status` | no | str | – | **M1's output, not its input.** Used only to score M1. See §7. |
| `Tide_Window_Start` | no | time | IST HH:MM | Stated window opening. |
| `Tide_Window_End` | no | time | IST HH:MM | Window close; earlier than start ⇒ crosses midnight. |
| `Weather` | no | str | – | Free text → 0–3 severity. |
| `Wind_Speed_kn` | no | float | kn | Sustained wind. |
| `Rain_mm_hr` | no | float | mm/hr | Rain intensity. |
| `Berth_Occupancy_%` | no | float | % | Port-wide occupancy at the time of the call. |
| `Channel_Depth_m` | no | float | m | Surveyed controlling depth; delta vs 15.0 m ⇒ siltation / dredging. |
| `Incident` | no | str | – | Free text → 0–3 severity. |

### 4.2 Optional columns that replace a guess with a fact

Supply any of these and the corresponding derivation is skipped entirely.

| Column | Type | Unit | Replaces |
|---|---|---|---|
| `Tide_Height_m` | float | m | The **synthetic** harmonic tide — the single most valuable column you can add |
| `Speed_kn` | float | kn | The reach speed cap (10 kn on CH-INNER) |
| `Distance_NM` | float | NM | M6's 240 NM default — fuel savings scale directly with this |
| `Berth_Ready` | datetime | IST | M6's fallback to the tidal-window opening |
| `Anchorage_Queue` | int | vessels | The occupancy-derived queue proxy |
| `Siltation_m` / `Dredging_Delta_m` | float | m | The `Channel_Depth_m` split |
| `Service_Hours` | float | h | M5's 24 h default |
| `Terminal_Max_Draft_m` | float | m | The berth-roster lookup |
| `Vessel_Class` | str | – | The LOA-band derivation (ULCV / POST_PANAMAX / PANAMAX / FEEDER) |
| `Cargo_Type` | str | – | The Cb choice (Container 0.65 / Bulk 0.80) |
| `Bow_Thruster` | str | Y/N | M7's assumed "fitted" (drives the extra-tug rule) |
| `Priority` | int | 1–9 | M5's default 5 |
| `Tide_Window_Date` | datetime | IST | Anchoring the `HH:MM` window to the ATA date |

### 4.3 Columns that must NOT be in the input

`ETB`, `TAT`, `ETD`, `ATB`, `ATD` and their variants are **targets**. If one appears in the input
file the loader raises a hard `ERROR` and refuses the run. Silently ignoring a target column is how
leakage gets into a pipeline.

### 4.4 What gets derived, and how

| Derived | Formula | Overridden by |
|---|---|---|
| `net_channel_depth_delta_m` | `Channel_Depth_m − 15.0` | `Siltation_m` / `Dredging_Delta_m` |
| `anchorage_queue_count` | `max(0, round((Berth_Occupancy_% − 60) / 5))` | `Anchorage_Queue` |
| `pilots_down` / `tugs_down` | Yes ⇒ 0 down, Busy ⇒ 1 down, No ⇒ full roster down | — |
| `weather_severity` | Clear 0, Light Rain 1, Moderate Rain 2, Heavy/Storm 3 | — |
| `severe_weather_flag` | severity ≥ 2 **or** wind ≥ 25 kn **or** rain ≥ 10 mm/hr | — |
| `calls_prev_24h` | Calls in this file with a strictly earlier ATA within 24 h | — |
| `extra_arrivals_24h` | `max(0, calls_prev_24h − 10)` | — |
| `vessel_class` | LOA ≥ 350 ULCV, ≥ 294 POST_PANAMAX, ≥ 225 PANAMAX, else FEEDER | `Vessel_Class` |
| `tide_height_m` | Harmonic `2.6 + 1.7·cos(ωt) + 0.3·sin(0.5ωt)` at ATA | `Tide_Height_m` |

Berth ids are canonicalised: `CB04` → `CB-04`, `BM05` → `BMCT-05`, `CCB-N` unchanged. Terminal
`JNPCT` → `NSFT` (the terminal's former name). Times are IST → UTC at the boundary, once.

---

## 5. Running each model

`src/pipeline/run_model.py` is the single entry point. `python run.py models --list` prints this table.

| Key | Model | Scope | Needs from your file | Gives back |
|---|---|---|---|---|
| `m1` | DUKC / RTUKC | per-row | `Draft_m`, `Channel_Depth_m`, tide | Net UKC, SAFE/MARGINAL/NO GO, min tide, max safe speed |
| `m2` | Tidal window | per-row | `Draft_m` | Windows, usable hours, dredging vs siltation delta |
| `m3` | TAT | per-row | `Total_TEU`, `Draft_m`, weather, resources | **ETB / TAT / ETD** + P10/P90 |
| `m4` | ETA & utilisation | per-batch | `ETA` | ETA bands; occupancy from the berthing log |
| `m5` | Berth plan | per-batch | `LOA_m`, `Draft_m`, `Requested_Berth`, `ATA` | Berth assignment, wait, cost breakdown |
| `m6` | JIT / RTA | per-row | `Distance_NM`, `Berth_Ready` | Speed advice, fuel, CO₂, USD saved |
| `m7` | Port craft | per-batch | `ATA`, `LOA_m` | Pilot/tug allocation, conflicts, swap proposals |
| `m8` | Causal chain | per-row | Weather, tide, siltation, resources | System confidence, root causes, 23-step log |

**Per-row** models produce one output line per vessel. **Per-batch** models need all the vessels at
once — a berth conflict or a craft conflict only exists *between* vessels.

### M1 — DUKC / under-keel clearance

```powershell
python run.py models --model m1 --input data/input/Vessel_Training_Input_Sample.xlsx --out out/
```

```
Row Vessel                Draft_m Speed_kn Cb   Tide_m Binding_Reach Squat_m Gross_UKC_m
2   HONG YONG CHANG SHENG 13.2    10.0     0.65 4.30   CH-INNER      0.65    5.852
3   KUO LUNG              12.8    10.0     0.65 1.26   CH-INNER      0.65    2.806
4   TSS AMBER             14.1    10.0     0.65 3.26   CH-INNER      0.65    3.107

validation_vs_sheet   {'scored': 3, 'agree': 2, 'disagree': 1, 'agreement_pct': 66.7}
```

Also returned per row: `Net_UKC_m`, `Status`, `Min_Tide_For_SAFE_m`, `Max_SAFE_Speed_kn`,
`Sensitivity_Robust`, `Recommendation`.

`Squat = min(2.5, Cb·V²/100)`; `Net UKC = (charted + tide − silt + dredge) − (draft + squat) − 1.0`.
Bands: ≥ 1.0 m SAFE, 0.6–1.0 m MARGINAL, < 0.6 m NO GO. The binding reach is `argmin(net UKC)`
across all four reaches each at *its own* speed cap — not simply the shallowest.

**On that 2/3 agreement:** the sheet says TSS AMBER was MARGINAL; the model says SAFE. The model is
using a *synthetic* tide of 3.26 m. The sheet's status was recorded at the real tide. Supply
`Tide_Height_m` and this becomes a genuine accuracy measurement instead of a comparison against a
guess.

### M2 — tidal window scanner

```powershell
python run.py models --model m2 --input data/input/Vessel_Training_Input_Sample.xlsx --horizon-hours 120
```

```
Row Vessel                Draft_m Required_Tide_m Windows Usable_Hours Availability_pct Max_Gap_h
2   HONG YONG CHANG SHENG 13.2    0.85            6       108.25       90.2             2.5
3   KUO LUNG              12.8    0.45            1       120.00       100.0            0.0
4   TSS AMBER             14.1    1.75            10       79.25        66.0             5.0
```

481 samples over 120 h at 15-minute steps. Headline windows require SAFE; MARGINAL periods are
reported separately as `Conditional_Extra_h` and never counted as usable. `Dredged_Delta_h` and
`Silted_Delta_h` are the "extend the tidal window" deliverable — they price a dredging campaign in
transitable hours.

Note the physical sense in that table: the 12.8 m vessel needs only 0.45 m of tide and is
essentially never constrained; the 14.1 m vessel needs 1.75 m and loses a third of the horizon.

### M3 — TAT, and the ETB / TAT / ETD targets

```powershell
python run.py predict --input data/input/Vessel_Training_Input_Sample.xlsx --out out/
# identical model, presented as one of the eight:
python run.py models --model m3 --input data/input/Vessel_Training_Input_Sample.xlsx
```

```
Row Vessel                 ATA (IST)         ETB (IST)         ETD (IST)         TAT h   p10   p90  wait  stay
2   HONG YONG CHANG SHENG  2026-07-29 07:45  2026-07-29 07:45  2026-07-31 03:16  43.52  38.1  46.6  0.00 43.52
3   KUO LUNG               2026-07-15 01:20  2026-07-15 01:20  2026-07-16 20:53  43.56  38.4  46.6  0.00 43.56
4   TSS AMBER              2026-07-29 05:18  2026-07-29 05:18  2026-07-31 10:05  52.78  46.5  53.1  0.00 52.78
```

How the three targets are built:

```
TAT  <- the trained model, p50 of predicted ATA -> ATD hours
ETB  <- ATA + pre-berth wait          (--wait-model: optimiser | queue | none)
ETD  <- ATA + TAT
stay <- TAT - wait  =  ETD - ETB      (floored at 6 h; flagged ETD_RECONCILED if it binds)
```

Choosing the wait model:

```powershell
python run.py predict --input data.xlsx --wait-model optimiser          # default: M5 contention
python run.py predict --input data.xlsx --wait-model queue --wait-percentile 90
python run.py predict --input data.xlsx --wait-model none               # ETB = ATA
```

**`optimiser` computes contention within your file only.** With three vessels arriving days apart
nothing competes, so wait = 0 and every row is flagged `WAIT_IS_LOWER_BOUND`. That is honest, not
broken — but it means ETB ≈ ATA on a small sample. Use `--wait-model queue` for a
distribution-based estimate, or feed the port's full arrival list.

### M4 — ETA uncertainty and berth utilisation

```powershell
python run.py models --model m4 --input data/input/Vessel_Training_Input_Sample.xlsx --ais-staleness-min 15
```

```
sigma = 0.06 * horizon_hours + 0.05 * AIS_staleness_minutes,  band = p50 +/- 1.28 sigma

occupancy         50.65 %   (363 records, 21 berths, from dsr_berth_stays.csv)
double-booked   4131.48 h   (union vs raw sum -- a data-quality signal, not an error)
waiting time    0 usable / 363 dropped -> NOT COMPUTABLE from this source
```

ETA bands are per-row. Occupancy and waiting need a berthing log, which the input file does not have
(ATB/ATD are targets), so they come from the DSR-derived log.

**Waiting time genuinely cannot be computed from the real corpus.** Daily Status Report section (H)
records *berthed on* and *expected completion* but never an arrival at anchorage, and waiting time
is `actual_atb − actual_ata`. All 363 records drop as `missing_ata_or_atb`. Recovering it needs the
PCS `VESARR` logs. `--wait-model queue` in `src/pipeline/predict.py` detects this and falls back to the
calibrated synthetic log, telling you why.

### M5 — berth plan optimisation

```powershell
python run.py models --model m5 --input data/input/Vessel_Training_Input_Sample.xlsx --cluster-gap-hours 72
```

On four ULCVs arriving 15 minutes apart (`scratch\overlapping_arrivals.csv`):

```
Row Vessel          Requested_Berth Assigned_Berth Wait_h Berth_Shift Algorithm
2   MSC ANNA        BMCT-01         BMCT-01        0.0    False       cpsat
3   EVER GIVEN      CB-06           BMCT-02        0.0    True        cpsat
4   CMA CGM MARCO   CB-04           BMCT-03        0.0    True        cpsat
5   MAERSK SEALAND  APMT-01         APMT-01        0.0    False       cpsat

component          quantity   weight   subtotal
wait hours             0.00      1.0       0.00
berth shifts              2      0.5       1.00
tide misses               0      2.0       0.00
TOTAL                                      1.00
```

CP-SAT chose two berth shifts over any waiting — correct, since a shift costs 0.5 and an hour of
waiting costs 1.0. LOA, draft and non-overlap (+ 0.5 h buffer) are hard constraints guaranteed by
construction; tide is a costed soft constraint by default (`--tide-policy hard` rejects instead).

Vessels more than `--cluster-gap-hours` apart are planned separately — three vessels arriving three
weeks apart do not compete for a berth, and optimising them in one 72 h horizon would invent
contention that does not exist.

### M6 — JIT arrival / RTA advisory

```powershell
python run.py models --model m6 --input data/input/Vessel_Training_Input_Sample.xlsx
```

```
Row Vessel                 RTA (IST)         RTA_Driver       Available_h Required_Speed_kn Feasible
2   HONG YONG CHANG SHENG  2026-07-29 06:30  MAX_SPEED_LIMIT  13.75       17.45             False
3   KUO LUNG               2026-07-15 01:30  BERTH_READY      15.17       15.82             True
4   TSS AMBER              2026-07-29 18:00  BERTH_READY      27.70        8.66             True

fleet_fuel_saved_t 34.97   fleet_co2_saved_t 108.908   fleet_bunker_saved_usd 20,984
```

`RTA = max(berth ready, tidal window start)`; `fuel = 3.2 t/h · (speed/16)³ · hours`;
`CO₂ = fuel × 3.114` (IMO). Row 2 needs 17.45 kn but the service speed is 16 — `MAX_SPEED_LIMIT`,
already on the optimal trajectory, no saving available. That edge case is handled, not ignored.

**Before quoting these numbers:** all three rows used the 240 NM default because the sample has no
`Distance_NM` column, and savings scale directly with distance. Bunker at USD 600/t is a SIMULATED
assumption. Add `Distance_NM` and `Berth_Ready` and the figures become defensible.

### M7 — port-craft assignment and conflicts

```powershell
python run.py models --model m7 --input data/input/Vessel_Training_Input_Sample.xlsx --roster-preset real
python run.py models --model m7 --input arrivals.csv --roster-preset poc --down-craft PL-01,PL-02
```

On the sample file: `FEASIBLE`, 0 conflicts — and none is *possible*, because none of the three
movements overlap in time. One pilot could serve all three in sequence; shrinking the roster cannot
manufacture a conflict. The runner says exactly that rather than implying you configured it wrong.

On four ULCVs arriving 15 minutes apart with the 9-craft PoC roster and 2 pilots down:

```
CONFLICT BLOCKS
  window (IST)                        role     peak severity movements
  2026-07-29 06:15 - 07-29 09:00      PILOT       3 HIGH     MV-C-0002..0005
  2026-07-29 06:15 - 07-29 09:00      TUG         8 HIGH     MV-C-0002..0005
  2026-07-29 06:30 - 07-29 08:45      MOORING     2 HIGH     MV-C-0002..0005

RECOMMENDED SINGLE-UNIT SWAPS
  [DELAY] Postpone MV-C-0005 [MAERSK SEALAND, not tide-locked] by 125 min so a PILOT frees up.
      gap closed: 600 min (SIMULATED delta vs do-nothing)
```

`--roster-preset real` is the 18 craft transcribed from `Details_of_Port_Crafts.pdf`; `poc` is the
WS2 spec's 9. The spec cites that PDF but reports 9 — we default to the PDF and keep the spec figure
as a preset. Allocation is interval-aware: a craft already committed to an overlapping movement
cannot be handed to a second one.

### M8 — reactive confidence chain

```powershell
python run.py models --model m8 --input data/input/Vessel_Training_Input_Sample.xlsx
```

```
Row Vessel                 DUKC_m Window_h Queue TAT_Delay_h Confidence Alert
2   HONG YONG CHANG SHENG   3.052    10.22  0.00        0.00      1.000 NORMAL
3   KUO LUNG               -0.394     2.64  0.79        0.72      0.418 CRITICAL
4   TSS AMBER               1.207     6.17  0.37        0.00      1.000 NORMAL
```

**Read `DUKC_Net_UKC_m` here carefully — it is not the same quantity as M1's.** M8's DUKC node is
the *reference deep-draft vessel* (15.0 m at 10 kn), because M8 answers "is the port open to
deep-draft traffic under these conditions". So row 3 reads −0.394 m CRITICAL while M1 says that
particular 12.8 m vessel is comfortably SAFE. Both are right; they answer different questions. The
low tide on 15 July closes the port to ULCVs while leaving the actual caller unaffected.

23 nodes, 30 edges, acyclic by construction. Every run logs one step per node — all 23, including
unchanged ones — so the audit trail is complete rather than only interesting. Only the 10 exogenous
nodes are set from your data. Of the 30 edges, 4 are exact physics, 1 is calibrated against M2's
scanner, and 25 are labelled `EXPERT_JUDGEMENT` — labelled, not hidden.

---

## 6. Command reference

### `src/pipeline/jnpa_input.py`

| Flag | Meaning |
|---|---|
| `--input`, `-i` | `.xlsx` / `.csv` / `.json` |
| `--sheet` | Worksheet name (default: first) |
| `--tide-policy` | `harmonic` (default) / `column` / `fixed` |
| `--tide-m` | Fixed tide for `--tide-policy fixed` |
| `--validate` | Validate only; exit 1 on any ERROR |
| `--emit-template PATH` | Write a documented blank template |
| `--json` | Emit normalised rows as JSON |
| `--verbose`, `-v` | Show INFO issues too |
| `--selftest` | 42 built-in checks |

### `src/pipeline/train_tat_model.py`

| Flag | Default | Meaning |
|---|---|---|
| `--days` | 365 | Days of history. 180 → ~68 % coverage; 365 → ~86 % |
| `--engine` | `auto` | `auto` / `lightgbm` / `sklearn_gbr` / `sklearn_rf` / `additive` |
| `--seed` | 20260807 | RNG seed |
| `--test-fraction` | 0.20 | Held-out fraction |
| `--embargo-hours` | 24 | Purge window at the split boundary |
| `--no-conformal` | off | Disable conformal band calibration (not recommended) |
| `--out` | `models` | Directory or explicit `.pkl` path |
| `--tag` | – | Filename suffix |
| `--compare-engines` | – | Table only, writes nothing |
| `--force` | – | Write even if a quality gate fails |

### `src/pipeline/predict.py`

| Flag | Default | Meaning |
|---|---|---|
| `--input`, `-i` | – | Input file |
| `--artifact`, `-a` | newest in `models\` | Trained `.pkl` to use |
| `--model-dir` | `models` | Where to look for an artefact |
| `--wait-model` | `optimiser` | `optimiser` / `queue` / `none` |
| `--wait-percentile` | 50 | 10 / 50 / 90, for `--wait-model queue` |
| `--cluster-gap-hours` | 72 | Berth-planning cluster split |
| `--tide-policy` | `harmonic` | `harmonic` / `column` / `fixed` |
| `--out`, `-o` | `out` | Output directory or file |
| `--format` | `both` | `xlsx` / `csv` / `json` / `both` |

### `src/pipeline/run_model.py`

| Flag | Default | Meaning |
|---|---|---|
| `--model`, `-m` | `all` | `m1`…`m8`, `all`, or `m1,m2,m8` |
| `--input`, `-i` | – | Input file |
| `--out`, `-o` | `out` | Output directory or file |
| `--format` | `both` | `xlsx` / `csv` / `json` / `both` |
| `--horizon-hours` | 120 | M2 scan horizon |
| `--ais-staleness-min` | 15 | M4 assumed AIS position age |
| `--roster-preset` | `real` | M7: `real` (18 craft) / `poc` (9 craft) |
| `--down-craft` | – | M7: e.g. `PL-01,PL-02` |
| `--wait-model` | `optimiser` | M3/M5 wait estimator |
| `--cluster-gap-hours` | 72 | M5 cluster split |
| `--list` | – | List the models and exit |

---

## 7. Read this before quoting any number

**1. `DUKC_Status` in your sheet is M1's output, not its input.** It is never fed to the model. M1
scores itself against it and prints an agreement percentage. That is the correct use of a label
column, and it is why the runner reports `Model_vs_Sheet` beside `Status` rather than substituting
one for the other.

**2. `Cranes_Available` is read but is not an M3 feature.** It is a real TAT driver, but it is not
in `FEATURE_COLUMNS`, and feeding it would violate the model's import-time allow-list assertion. It
is carried to the output as context and flagged on every affected row. Using it properly means
adding it to `FEATURE_COLUMNS` and retraining — a deliberate, versioned change, not something the
adapter should do behind your back.

**3. Tide height is SYNTHETIC by default.** The sheet has a tide *window* but no tide *height*, so
M1/M2/M6/M8 use the harmonic model `2.6 + 1.7·cos(ωt) + 0.3·sin(0.5ωt)`. Every affected row carries
`TIDE_SYNTHETIC`. **Adding a `Tide_Height_m` column is the single highest-value improvement you can
make to this pipeline** — it converts four models from plausible to defensible.

**4. `--wait-model optimiser` gives a lower bound on a partial file.** Contention is computed only
among the vessels present. Rows are flagged `WAIT_IS_LOWER_BOUND`.

**5. Waiting time is not recoverable from the DSR corpus.** No ATA. See §5/M4.

**6. When LightGBM supplies p50, the driver list explains the additive surrogate**, not the GBM's
internal splits. Every row carries `Attribution_Source` saying which. Do not present a LightGBM
number with an additive explanation and call it the model's reasoning.

**7. M6's commercial figures are SIMULATED** — bunker USD 600/t, anchorage idle 0.35 t/h — and all
three sample rows used the 240 NM default distance.

**8. M8's DUKC column is the reference ULCV, not the row's vessel.** See §5/M8.

---

## 8. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ERROR: no valid rows` | Run `python run.py input --input <file> --validate` — it prints the offending row, column and reason. |
| `target_column_in_input` | Your file has `ETB`, `TAT` or `ETD`. Remove them; the models predict them. |
| `missing_required_column` | Only `Vessel`, `ATA`, `Draft_m` are mandatory. Check the header spelling — matching is tolerant but the column must exist. |
| `artefact digest mismatch` | The `.pkl` changed since it was trained. Retrain: `python run.py train --out trained_models/`. |
| `No trained artefact found` | Expected on a fresh checkout. Either train one, or accept the additive fallback (the run says so loudly). |
| Model uses `additive` when you wanted LightGBM | `find_latest_artifact` picks the **newest** `.pkl`. Pin one with `--artifact trained_models\uc1_m3_tat_lightgbm_v1.2.0.pkl`. |
| `berth_not_in_roster` warning | The berth id isn't in the 21-berth roster; max draft 16.5 m was assumed. Add `Terminal_Max_Draft_m`. |
| M7 finds no conflicts | Your movements probably don't overlap. Craft conflicts need simultaneous demand — see §5/M7. |
| Excel dates read as numbers | Format the column as Date/Time in Excel, or supply `YYYY-MM-DD HH:MM` text. Both readers handle serial dates, but explicit is safer. |
| No `openpyxl` | `.xlsx` still reads — there's a stdlib `zipfile`+`ElementTree` fallback, verified to agree with openpyxl cell-for-cell. Output falls back to `.csv`. |

---

## 9. Verifying the install

```powershell
python run.py input   --selftest    # 42/42
python run.py train   --selftest    # 10/10
python run.py predict --selftest    # 19/19
python run.py models  --selftest    # 17/17
python src\pipeline\dashboard_json.py    # 5/5

foreach ($f in Get-ChildItem src\uc1_models\uc1_m*.py) { python $f.FullName --quiet; if ($LASTEXITCODE -ne 0) { "FAILED: $f" } }
python -m pytest -q                 # 217 passed
```

All of the above pass on this machine as of the last run.

### REST

```powershell
python run.py serve --reload
# GET http://127.0.0.1:8000/health?deep=true   -> 8/8 modules, 188 self-tests, 1 DUKC fingerprint
# GET http://127.0.0.1:8000/docs               -> all 8 routers
```

---

## 10. Getting more out of this than the sample allows

Ranked by how much each changes the answers:

1. **Add `Tide_Height_m`.** Converts M1/M2/M6/M8 from synthetic to measured, and turns M1's
   agreement score into a real accuracy metric.
2. **Feed the full arrival list, not a sample.** M5 and M7 need competing vessels to have anything
   to optimise or any conflict to detect; M3's wait stops being a lower bound.
3. **Add `Distance_NM` and `Berth_Ready`.** M6's fuel and CO₂ figures scale directly with distance.
4. **Get real TAT labels** (ATA and ATD per call, from the PCS `VESARR`/`VESDEP` logs) and retrain.
   Today's model is trained on calibrated synthetic history because the corpus has no ATA. Real
   labels would also let LightGBM beat the additive baseline — on synthetic data it cannot, because
   the additive model *generated* the labels and is therefore the oracle.
5. **Add `Anchorage_Queue`** to replace the occupancy proxy.

---

## 11. The dashboard JSON — every key explained

`out/uc1_all_models_dashboard.json` is the file a UI reads. It is built by
**selection** from the audit JSON, never by recomputation — a test asserts the
two agree — so anything here can be traced back to `out/uc1_all_models.json`
for its derivation.

The same glossary is embedded in the file under `glossary`, so the JSON
explains itself without this document. A self-test fails if a key is added
without an explanation.

```
run            what produced this file, from what input
glossary       every non-obvious key, one line each
vessels[]      one object per vessel: identity, input, data_quality, flags, models
port_summary   the batch-level numbers that belong to no single vessel
```

### Vessel identity

| Key | Meaning |
|---|---|
| `call_id` | Our id for this vessel call (one row of the input sheet). Not a port system id. |
| `vessel` | Vessel name as printed on the input sheet. |
| `imo` | IMO number: the vessel's permanent hull id, unchanged across renames and reflagging. |
| `voyage` | The carrier's voyage number for this specific trip. |
| `terminal` | Terminal the call is booked to. |

### `input` — what the sheet said about this call

| Key | Meaning |
|---|---|
| `ata_ist` | Actual Time of Arrival at the anchorage/pilot station, Indian Standard Time. |
| `eta_ist` | Estimated arrival the line declared, before the vessel actually arrived. |
| `terminal` | Terminal the call is booked to. |
| `requested_berth` | Berth the line asked for. |
| `vessel_class` | Size band: FEEDER / PANAMAX / ULCV. Sets craft requirements. |
| `loa_m` | Length Overall. A berth shorter than this cannot take the vessel. |
| `draft_m` | How deep the loaded hull sits below the waterline, in metres. Drives every depth check. |
| `teu_total` | Containers to move this call, in twenty-foot equivalent units. The main driver of TAT. |
| `teu_import` | Containers to discharge. |
| `teu_export` | Containers to load. |
| `cranes_available` | Quay cranes the terminal has free. Read from the sheet but not an M3 feature. |
| `tide_m` | Height of tide above chart datum at arrival. Adds directly to available water depth. |
| `channel_depth_m` | Charted depth of the approach channel before tide, siltation and dredging. |
| `weather` | Weather as recorded on the sheet. |
| `wind_kn` | Wind speed in knots. |
| `anchorage_queue` | Vessels already waiting at anchorage when this one arrived. |
| `berth_occupancy_pct` | How full the terminal's berths were at arrival, percent. |

### `data_quality` — where each estimated input came from

Four inputs are estimated when the sheet does not carry them. The value names
the source, so a modelled tide is never quoted as a measured one. JNPA's
acceptance criteria require exactly this: degraded and synthetic inputs stay
visibly badged rather than blended into the output.

| Key | Values you will see |
|---|---|
| `tide` | `COLUMN_Tide_Height_m` (from your sheet) · `FIXED_<n>m` (`--tide-m`) · `SYNTHETIC_HARMONIC_v1` (modelled — the sample sheet has no tide column) |
| `channel_depth` | `COLUMN_Channel_Depth_m` · `DEFAULT_REACH_CHART` |
| `anchorage_queue` | `COLUMN_Anchorage_Queue` (observed) · `DERIVED_FROM_OCCUPANCY` (inferred from berth occupancy) |
| `distance` | `COLUMN_Distance_NM` · `DEFAULT` (240 NM, the standing assumption for M6) |

### `flags` — caveats that apply to the whole row

| Key | Meaning |
|---|---|
| `flags` | Caveats attached to the row. TIDE_SYNTHETIC = tide was modelled, not measured. WAIT_IS_LOWER_BOUND = the wait was computed against this file only, so it under-states a real queue. QUEUE_DERIVED = anchorage queue was inferred from occupancy, not observed. |

### `models.m1_under_keel_clearance` — Can she safely transit the channel?

| Key | Meaning |
|---|---|
| `status` | SAFE / MARGINAL / NO GO. |
| `net_ukc_m` | Under-keel clearance after squat and the 1.0 m safety margin. This is the go/no-go number. |
| `squat_m` | Extra draft a moving hull gains from its own bow wave. Grows with the square of speed. |
| `binding_reach` | The channel section with the least clearance. It, not the shallowest section, sets the verdict. |
| `min_tide_for_safe_m` | Tide height at which this transit would become SAFE. Below it, wait for water. |
| `max_safe_speed_kn` | Fastest speed that still leaves a safe clearance, because slowing down cuts squat. |
| `matches_sheet` | Whether our verdict agrees with the DUKC_Status the sheet already recorded. A scoring check, never an input. |
| `recommendation` | One-line plain-English action for the duty officer. |

### `models.m2_tidal_window` — When is there enough water, and for how long?

| Key | Meaning |
|---|---|
| `required_tide_m` | Tide this vessel needs before the binding reach is passable. |
| `windows` | How many separate usable tidal windows the scan found. |
| `usable_hours` | Hours in the next 120 h during which the vessel could transit. |
| `availability_pct` | usable_hours as a share of the scan horizon. |
| `longest_window_h` | The single longest uninterrupted transit opportunity. |
| `max_wait_h` | Worst gap between windows -- the longest the vessel could be held waiting for tide. |
| `next_window_start_ist` | Start of the next usable window. |
| `dredging_gain_h` | Extra usable hours a +0.5 m dredge would buy. The investment case, in hours. |

### `models.m3_turnaround_time` — When does she berth, finish and leave?

| Key | Meaning |
|---|---|
| `tat_hours` | Turnaround time: arrival to departure, in hours. The headline prediction (p50). |
| `tat_p10_hours` | Optimistic end of the 80% band -- 10% of calls finish faster than this. |
| `tat_p90_hours` | Pessimistic end of the 80% band -- 90% of calls finish within it. Plan against this one. |
| `etb_ist` | Estimated Time of Berthing = arrival + waiting time. |
| `etd_ist` | Estimated Time of Departure = arrival + tat_hours. |
| `wait_hours` | Predicted wait between arrival and getting alongside. |
| `berth_stay_hours` | Time actually alongside working cargo = tat_hours - wait_hours. |
| `confidence` | HIGH/MEDIUM/LOW, from how wide the p10-p90 band came out. |
| `engine` | Which predictor produced the number: lightgbm, sklearn or the additive fallback. |
| `top_drivers` | The three input factors contributing most to this TAT, with their hours and share. |

### `models.m4_eta_confidence` — How certain is the arrival time?

| Key | Meaning |
|---|---|
| `eta_p50_ist` | Most likely arrival time from the current AIS fix. |
| `eta_p10_ist` | Earliest plausible arrival (10th percentile). |
| `eta_p90_ist` | Latest plausible arrival (90th percentile). |
| `eta_band_hours` | Width of the p10-p90 arrival window. Wider means less certain. |
| `sigma_hours` | Standard deviation of the arrival estimate. Grows with forecast horizon and stale AIS. |
| `confidence` | HIGH/MEDIUM/LOW, from how wide the p10-p90 band came out. |

### `models.m5_berth_plan` — Which berth, and starting when?

| Key | Meaning |
|---|---|
| `assigned_berth` | Berth the optimiser allocated, which may differ from the one requested. |
| `requested_berth` | Berth the line asked for. |
| `berth_changed` | True when the optimiser moved the vessel off its requested berth. |
| `start_ist` | When the assigned slot or movement starts. |
| `wait_hours` | Predicted wait between arrival and getting alongside. |
| `misses_tidal_window` | True when the assigned start falls outside every usable tidal window. |
| `algorithm` | Solver that produced this assignment: cpsat (exact) or greedy (fallback). |
| `reason` | One sentence on why the optimiser chose this berth and start time. |

### `models.m6_jit_arrival` — What does arriving just in time save?

| Key | Meaning |
|---|---|
| `rta_ist` | Requested Time of Arrival -- when the port actually wants the vessel, not when she can get there. |
| `recommended_speed_kn` | Speed to arrive just in time instead of early. Lower speed, less fuel. |
| `required_speed_kn` | Speed needed to hit the target arrival exactly. Above the vessel's cap it is not achievable. |
| `achievable` | False when the vessel cannot reach the RTA even at full speed -- there is no saving to take. |
| `fuel_saved_t` | Tonnes of bunker fuel saved by slow-steaming to the RTA instead of arriving early and waiting. |
| `co2_saved_t` | Tonnes of CO2 avoided, at 3.114 t CO2 per tonne of fuel. |
| `anchorage_hours_saved` | Hours of anchorage waiting removed by arriving just in time. |
| `recommendation` | One-line plain-English action for the duty officer. |

### `models.m7_port_craft` — Are pilots, tugs and mooring gangs available?

| Key | Meaning |
|---|---|
| `movement` | The berthing or unberthing manoeuvre this craft assignment serves. |
| `start_ist` | When the assigned slot or movement starts. |
| `pilots_tugs_mooring` | Craft assigned to the movement: pilot / tug / mooring-gang ids. |
| `shortfall` | Craft the movement needed but could not be given. Empty means fully resourced. |
| `response_gap_min` | Minutes by which the nearest craft is late for the movement start. |
| `resourced` | True when every required craft was assigned on time. |

### `models.m8_risk_chain` — What do today's disruptions do to the plan?

| Key | Meaning |
|---|---|
| `system_confidence` | 0-1 score for how much of the plan survives today's disruptions. 1.0 is undisturbed. |
| `alert_level` | NORMAL / WARNING / CRITICAL, from system_confidence and which rules fired. |
| `tat_delay_h` | Extra turnaround hours the causal chain attributes to the current disruptions. |
| `root_causes` | The exogenous conditions contributing most to the confidence drop, with their share. |
| `disruptions` | The conditions fed into the chain for this vessel, in plain words. |


### `port_summary` — the batch-level numbers

These belong to the port or the fleet, not to any one vessel, so they are not
repeated inside each vessel block.

| Block | What's in it |
|---|---|
| `transit_safety` | How many vessels came out SAFE / MARGINAL / NO GO, and how often M1 agreed with the sheet's own `DUKC_Status` |
| `turnaround` | Mean predicted TAT, which engine produced it, and M3's held-out MAE and band coverage |
| `berth_utilisation` | Overall berth occupancy, berth count, and whether occupancy came from the real DSR extract or the synthetic fallback |
| `berth_plan` | Requests vs assignments, total waiting hours, berth changes, tide misses, and which solver ran |
| `jit_savings` | Fleet fuel, CO2, bunker cost and anchorage hours saved. `figures_are: SIMULATED` — the bunker price is an assumption, not a quote |
| `port_craft` | Roster size, movements planned, conflicts found, and utilisation per craft role |
| `risk` | Lowest system confidence across the fleet and whether any vessel hit CRITICAL |
