# AI/ML predictions (the eight WS2 UC-I models)

**What it is.** The complete UC-I model suite from the JNPA WS2 delivery, vendored
into this repository under [`ml/`](../ml/) and served to the SPA over HTTP. It
answers, for any vessel in the AIS feed: *can she transit, when is there enough
water, when will she berth and sail, how certain is her ETA, which berth, what
does arriving just-in-time save, are pilots and tugs there, and what does today's
weather do to all of it.*

**Where it appears.** A **Predictions** column in **Vessels ▸ Live AIS Feed**.
Clicking it opens a side sheet with one card per model, the inputs those models
used, the fleet-level numbers, and — first — what had to be estimated.

---

## The one thing to read before trusting a number

An **AIS position report carries no draught, no cargo and no arrival time.** The
models need all three. The service estimates them from published bands and
**names every substitution** in a per-vessel ledger, which the panel renders
above the predictions, not in a footnote.

So: a `NO GO` under-keel clearance produced from an estimated draft is *advice to
check*, not a clearance. Send a real `DRAFT_M` on the row and that estimate — and
the badge — disappear. The estimate is never silent, and it is never averaged
into a figure that looks measured.

What is genuinely observed (and never estimated) when the feed provides it:
position, speed, course, heading, nav status, berth, ETA, vessel type, length.

### Reading the "5 estimated" chip

The status line above the model cards carries a chip like **`⚠ 5 estimated`**
(or **`✓ all inputs observed`**). Hover it for the full list.

That counts **input values, not models.** All eight models always run. The number
varies per vessel because the service only records the inputs it actually had to
resolve for that hull: a stopped vessel adds a `Speed_kn` substitution, a berthed
one adds `Terminal` / `Requested_Berth`. So one vessel shows 8 values and the
next shows 10 — neither has anything to do with the eight models.

The hover holds two kinds of line, and so does the **Model inputs** disclosure
below the cards (which is where to look on a touch screen, where there is no
hover):

| | What it means |
|---|---|
| A substitution | A value put INTO a model. `Draft_m` is the one that matters — every UKC figure rests on it |
| A note | Context that changed no input, e.g. "no measured tide supplied" (the harmonic curve was used, flagged `TIDE_SYNTHETIC`) |

The substitutions you will see most often, and why:

- **`LOA_m`** — the gateway's position feed carries no length, so the JNPA fleet
  median is assumed. Everything below derives from it.
- **`Draft_m`** — estimated from that length. **Send a real `DRAFT_M` on the row
  and both this line and the advisory badge disappear.**
- **`Total_TEU` / `Import_TEU`** — AIS carries no cargo at all; the parcel is a
  published share of the capacity the length implies. It drives the TAT.
- **`ATA`** — AIS never states an arrival. *approaching* → her reported ETA is
  used; *berthing* / *moored* → her last fix time. The rule per nav status is
  published at `GET /uc1/webapp/mapping`.
- **`Speed_kn`** — a hull at a berth reports 0 kn. A zero-speed squat would
  **overstate** clearance, so the 6 kn transit floor is used instead.

A vessel whose row carries draught, length and cargo gets a green
*"Every input value was observed"* notice instead.

---

## Data path

```
Vessels ▸ Live AIS Feed          browser              FastAPI (ml/)
  [Predict] on one row  ──▶  POST /ml-api/uc1/webapp/predictions  ──▶  8 models
      the WHOLE fleet             (Vite proxy / nginx,               one runner,
      travels, capped at 80        same-origin, no CORS)             one document
                          ◀──  uc1-dashboard/1.0.0 + mapping ledger
```

**The whole feed is scored, not one hull.** M4 (berth occupancy), M5 (the berth
plan) and M7 (craft conflicts) are *fleet* models — their answers are properties
of the arrival set. Scoring one vessel would produce a berth plan for a port with
one ship in it. One call therefore covers every row, and opening a second vessel
is instant (cached for 5 minutes, then re-scored because the feed has moved).

---

## The eight models

| | Answers | Headline field |
|---|---|---|
| **M1** Under-keel clearance | Can she safely transit the channel? | `net_ukc_m`, `status` |
| **M2** Tidal window | When is there enough water, and for how long? | `usable_hours` |
| **M3** Turnaround time | When does she berth, finish and leave? | `tat_hours` (P10/P50/P90) |
| **M4** ETA confidence | How certain is the arrival time? | `eta_band_hours` |
| **M5** Berth plan | Which berth, and starting when? | `assigned_berth` |
| **M6** Just-in-time arrival | What does arriving just in time save? | `recommended_speed_kn` |
| **M7** Port craft | Are pilots, tugs and mooring gangs available? | `resourced`, `shortfall` |
| **M8** Risk chain | What do today's disruptions do to the plan? | `system_confidence` |

Seven are deterministic (physics, interval arithmetic, an optimiser, a 23-node
causal DAG); only M3 has a trained artefact. Full detail — every formula with its
real numbers substituted in — is in [`ml/docs/MODELS_EXPLAINED.md`](../ml/docs/MODELS_EXPLAINED.md)
and [`ml/README.md`](../ml/README.md).

**The glossary ships inside the response.** Every field the panel renders carries
its own one-line definition as a tooltip, and the service's self-test fails the
build if a key is added without one. That is why the panel renders generically: a
field a model gains tomorrow shows up here with its definition, instead of being
silently dropped by a hand-written interface.

---

## Running it

```bash
cd ml
python -m venv .venv && .venv/bin/pip install -r requirements-service.txt
JNPA_PORT=8100 .venv/bin/python run.py serve      # http://127.0.0.1:8100/docs
```

Then `npm run dev` as usual — the Vite proxy forwards `/ml-api` to `:8100`.

Port **8100**, deliberately not the service's own `:8000` default: the UC-3
gateway already occupies 8000 in this app's dev proxy.

Verify without the UI:

```bash
curl -s localhost:8100/health | jq '.status, .live_ais_adapter.mounted'
curl -s localhost:8100/uc1/webapp/demo | jq '.dashboard.vessels[0].models | keys'
curl -s localhost:8100/uc1/webapp/mapping | jq '.defaults'    # what may be substituted
```

`GET /uc1/webapp/mapping-preview` shows the translation for one AIS row **without
running a model** — the fastest way to see why a number came out as it did.

### Configuration

| Var | Purpose |
|---|---|
| `VITE_ML_ENABLED` | Master switch. `false` hides the Predictions column |
| `VITE_ML_API_BASE` | Path prefix the app calls (default `/ml-api`, keep it relative) |
| `VITE_ML_API_URL` | Where the **dev** proxy forwards (default `http://127.0.0.1:8100`) |
| `VITE_ML_MAX_FLEET` | Vessels per scoring call, clamped 1–80 |
| `VITE_ML_TIMEOUT_MS` | Request deadline, floor 5 s (default 30 s) |

### Production

`docker compose up` builds both containers. The model service (`uc1-ml`) is
**not published to a host port** — it carries no auth of its own and is a
stateless calculator over whatever payload it is handed. nginx reaches it on the
compose network and fronts it at `/ml-api` (see `deploy/nginx.conf`). Exposing it
directly would let anyone run the optimiser at will.

---

## What is *not* in this repository

**UC-II (cargo handling) and UC-III (traffic decongestion).** The WS2 delivery
carries models for all three use cases; this is the UC-1 vessel-traffic PoC, so
only the eight vessel models are vendored here. Nothing in `ml/` imports the
others. If cargo handling is ever wired into this app, bring it in as its own
service rather than re-mixing the trees.

**The raw DSR document corpus** (`ml/data/corpus/`, 44 MB of PDFs). It is read
only by `dsr_extract.py`, and what the models need from it is already reduced
into `ml/data/reference/dsr_berth_stays.csv` — so M4 still reports the real
21-berth, 345-record occupancy rather than a synthetic one, and the full test
suite passes without it. See [`ml/data/corpus/README.md`](../ml/data/corpus/README.md)
to restore it.

---

## Failure modes and what the UI does

| Condition | What you see |
|---|---|
| Service not running | "Cannot reach the UC-1 model service…" with the command that starts it, and a Try again button |
| Request over 30 s | A timeout notice naming `VITE_ML_TIMEOUT_MS` — the optimiser is real computation |
| A model errors | The other seven render; a red notice names the failed model and its error |
| Feed larger than 80 | The panel says how many vessels the fleet models actually covered |
| Any input estimated | An `N estimated` chip in the status line; the substitutions on its hover and in the Model inputs disclosure |
| Nothing estimated | An `all inputs observed` chip — worth stating too |

---

## Extending it

The translation layer is [`ml/src/pipeline/uc1_webapp_adapter.py`](../ml/src/pipeline/uc1_webapp_adapter.py).
Its `SECTION 1` holds every constant it may substitute (draft-by-LOA bands, the
parcel share of capacity, the transit-speed floor, the ATA rule per nav status).
Change one there and it changes everywhere — including the `/uc1/webapp/mapping`
catalogue the UI shows the operator.

Do **not** add an estimate in the frontend. Two estimators is how two screens end
up showing different under-keel clearances for the same hull; the adapter exists
precisely to stop that.

```bash
cd ml
python src/pipeline/uc1_webapp_adapter.py --selftest   # 26 checks, the CI gate
python src/pipeline/uc1_webapp_adapter.py              # the demo fleet, as a table
pytest tests/test_uc1_webapp_adapter.py -q             # the response contract
```
