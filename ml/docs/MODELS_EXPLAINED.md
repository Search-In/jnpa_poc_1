# JNPA UC-1 — The Eight Models Explained

**Written for someone who has never worked in a port.**

Part 0 teaches you enough port operations to follow everything else. Parts 1–8 take one model each:
what it is, what you feed it, what it does inside, what comes out, and how to put that on a screen.
Every number quoted is real output from `Vessel_Training_Input_Sample.xlsx` on this machine.

---

## Contents

- [Part 0 — Ports in ten minutes](#part-0--ports-in-ten-minutes)
- [Part 1 — The eight models at a glance](#part-1--the-eight-models-at-a-glance)
- [M1 — Under-Keel Clearance (will the ship touch the bottom?)](#m1--under-keel-clearance)
- [M2 — Tidal Windows (when is the channel deep enough?)](#m2--tidal-windows)
- [M3 — Turnaround Time (how long will this ship take?)](#m3--turnaround-time)
- [M4 — ETA Uncertainty & Berth Utilisation (how sure are we, and how busy are we?)](#m4--eta-uncertainty--berth-utilisation)
- [M5 — Berth Plan Optimisation (which ship goes to which berth, when?)](#m5--berth-plan-optimisation)
- [M6 — Just-In-Time Arrival (how fast should the ship sail?)](#m6--just-in-time-arrival)
- [M7 — Port Craft Assignment (are there enough pilots and tugs?)](#m7--port-craft-assignment)
- [M8 — Reactive Confidence Chain (if this breaks, what else breaks?)](#m8--reactive-confidence-chain)
- [Part 9 — Cross-cutting UI rules](#part-9--cross-cutting-ui-rules)
- [Part 10 — Suggested screens](#part-10--suggested-screens)
- [Part 11 — Getting the data into your frontend](#part-11--getting-the-data-into-your-frontend)
- [Part 12 — Glossary](#part-12--glossary)

---

# Part 0 — Ports in ten minutes

## 0.1 What actually happens when a ship arrives

Jawaharlal Nehru Port Authority (JNPA) is India's largest container port, near Mumbai. Container
ships arrive from the open sea, sail up a dredged channel, tie up at a berth, exchange containers,
and leave. Here is one complete visit, called a **port call**:

```
  OPEN SEA          ANCHORAGE           CHANNEL            BERTH              SEA
     |                  |                  |                 |                 |
  ship is           ship waits         ship sails up     cranes load       ship leaves
  steaming          at anchor          a narrow          and unload
  towards port      if it can't        dredged lane      containers
                    go in yet
     |                  |                  |                 |                 |
    ETA ------------- ATA -------------- (transit) ------- ATB ------------- ATD
  estimated         actual             needs a pilot,    actual            actual
  arrival           arrival            tugs, and         berthing          departure
                                       enough water
                    <---- waiting ----><-- transit --><----- alongside ----->
                    <------------------------ TAT ------------------------->
```

- **TAT** (turnaround time) = total time from arrival to departure. JNPA's published average is
  **1.83 days ≈ 43.9 hours**.
- Of that, about **23.3 hours** is spent alongside the berth working cargo, and roughly **20.6 hours**
  is spent waiting.

That waiting is the expensive part. A large container ship costs tens of thousands of dollars a day.
Six of our eight models exist to shrink or predict that wait.

## 0.2 The single most important idea: will the ship touch the bottom?

Every ship sits in the water up to a certain depth. That depth is the **draft**.

```
        ======================  <- deck
       |                      |
  ~~~~~|~~~~~~~~~~~~~~~~~~~~~~|~~~~~~  <- waterline
       |                      |          ^
       |    ship's hull       |          |  DRAFT (e.g. 14.1 m)
       |______________________|          v
        ^^^^^^ keel (bottom of the hull)
                                         ^
                                         |  UNDER-KEEL CLEARANCE (UKC)
                                         v      = water left underneath
  ///////////////////////////////////////////   <- seabed
```

**Under-keel clearance (UKC)** is the gap between the bottom of the ship and the seabed. If it
reaches zero, the ship runs aground — potentially blocking the channel for days. Everything in M1
and M2 is about keeping that gap safe.

Four things change the gap:

**1. Charted depth.** Nautical charts print a depth for every stretch of water — but measured from a
low reference level called **chart datum** (roughly the lowest tide ever expected). So the charted
number is the *worst case*, and the real water is almost always deeper.

**2. Tide.** The sea rises and falls roughly twice a day because of the moon. **Tide height** is how
much water sits above chart datum right now. At JNPA it swings from about 0.4 m to 4.8 m, averaging
2.6 m. So:

> real water depth = charted depth + tide height

This is why a deep ship might have to wait six hours: not because anything is wrong, but because the
tide has not come in yet.

**3. Siltation and dredging.** Mud and sand settle in the channel over time — **siltation** — making
it shallower. **Dredging** is the (expensive) work of digging it back out. Siltation subtracts from
depth; dredging adds to it.

**4. Squat.** This one is unintuitive and it is why we need a model rather than subtraction.

When a ship moves through shallow, confined water, the water has to squeeze past the hull. It
accelerates, and faster-moving water has *lower pressure* — so the ship gets sucked downward and
sits lower than when it was stopped. That extra sinkage is called **squat**.

> **A moving ship is effectively deeper than a stationary one. The faster it goes, the deeper it
> gets.**

Squat rises with the *square* of speed. Doubling speed roughly quadruples squat. This gives the
harbour master a lever: a ship that is unsafe at 12 knots may be perfectly safe at 9.

We use the **Barrass formula**:

```
squat (m) = Cb × V² / 100          capped at 2.5 m
```

- **V** = speed in knots (1 knot = 1 nautical mile/hour ≈ 1.85 km/h).
- **Cb** = *block coefficient*: how boxy the hull is. Imagine the smallest rectangular box that
  encloses the underwater part of the hull. Cb is the fraction of that box the hull actually fills.
  A sleek container ship is about **0.65**; a blunt bulk carrier about **0.80**. Boxier ships shove
  more water aside, so they squat more.

Putting it together, the formula the whole system runs on:

```
effective depth = charted depth + tide - siltation + dredging
gross UKC       = effective depth - (draft + squat)
net UKC         = gross UKC - safety margin (1.0 m)
```

The **safety margin** is a deliberate reserve for wave action, survey error and human factors. We
then classify:

| Net UKC | Status | Meaning |
|---|---|---|
| ≥ 1.0 m | **SAFE** | Go. |
| 0.6 – 1.0 m | **MARGINAL** | Go only with extra precautions — slower speed, a senior pilot. |
| < 0.6 m | **NO GO** | Do not sail. Wait for tide, or lighten the ship. |

## 0.3 The channel is not one thing

Ships do not cross open water to reach the berth. They follow a dredged lane — the **channel** —
divided into named stretches called **reaches**. Each reach has its own depth and its own speed
limit.

| Reach | Charted depth | Speed limit | Length | What it is |
|---|---|---|---|---|
| `CH-OUTER` | 17.5 m | 12 kn | 12.0 NM | Approach from the open sea. Deepest, fastest. |
| `CH-MID` | 16.2 m | 11 kn | 5.0 NM | Middle section. |
| `CH-INNER` | 15.0 m | 10 kn | 6.5 NM | Final approach. **Shallowest — usually the constraint.** |
| `TURNING-CIRCLE` | 15.0 m | 6 kn | 1.2 NM | Wide spot where the ship spins around to berth. |

A subtlety worth understanding, because it drives a real design decision: **the shallowest reach is
not automatically the dangerous one.** The turning circle is as shallow as CH-INNER, but its 6-knot
limit means squat there is only 0.65 × 6² / 100 = **0.23 m**, versus 0.65 × 10² / 100 = **0.65 m**
on CH-INNER. So CH-INNER usually binds despite equal depth.

Our models therefore test **every reach at its own speed limit** and report the worst one — the
**binding reach**. Taking "minimum charted depth" would give the wrong answer.

## 0.4 The berths, the people, the boats

**Terminal** — a company operating a section of the quay with its own cranes and yard. JNPA has
several: NSFT (formerly called JNPCT), NSICT, NSIGT, APMT, BMCT, NSDT, plus liquid berths (BPCL,
JJLTPL). **Berth** — one parking space for one ship, e.g. `CB-04`, `BMCT-01`. JNPA has 21 in our
roster. Each berth has a maximum length and a maximum draft it can accept.

A ship cannot dock itself. Three kinds of help are needed, collectively **port craft**:

| Craft | What it does | Why it's needed |
|---|---|---|
| **Pilot** (in a *pilot launch*) | A local expert boards the ship at sea and directs it in | Only a local knows the channel, currents and bank effects |
| **Tug** | A small, very powerful boat that pushes and pulls the ship | Big ships have poor low-speed steering; tugs supply the sideways force |
| **Mooring boat** | Carries the ship's ropes to the bollards on the quay | The ropes are too heavy to throw |

**Bollard pull** measures a tug's strength in tonnes — JNPA's range from 50 T to 70 T. A **bow
thruster** is a sideways propeller in the ship's bow; ships that have one need one fewer tug.

Crucially, **a pilot or tug can only be in one place at a time.** If three big ships want to berth
in the same hour and only two pilots are free, one ship waits. That is what M7 detects.

## 0.5 Cargo and size

- **TEU** — "twenty-foot equivalent unit", one standard 20-foot container. A 40-foot container is
  2 TEU. A ship's **parcel** is how many TEU it exchanges at this port. More TEU = more crane hours
  = longer stay. This is the single biggest driver of turnaround time.
- **LOA** — length overall, in metres. Must be shorter than the berth.
- **Vessel class** by size: **FEEDER** (small, short regional runs) → **PANAMAX** → **POST_PANAMAX**
  → **ULCV** (Ultra Large Container Vessel, ~400 m, 20,000+ TEU). Bigger ships need more tugs.

## 0.6 The clocks

This trips people up constantly, so learn these six:

| | Estimated (a forecast) | Actual (a record) |
|---|---|---|
| **Arrival** at the port limit | **ETA** | **ATA** |
| **Berthing** — tied up at the quay | **ETB** | **ATB** |
| **Departure** — leaving the berth | **ETD** | **ATD** |

**Our system predicts ETB, TAT and ETD.** Those three are the deliverable. `ATA` is an input: we
know when the ship got here; we are forecasting what happens next.

Two derived quantities:

```
waiting time = ATB - ATA        (time spent at anchor before berthing)
TAT          = ATD - ATA        (total time in port)
berth stay   = ATD - ATB        (time alongside working cargo)
```

**All timestamps in JNPA documents are IST** (Indian Standard Time, UTC+05:30, no daylight saving).
Internally the system converts everything to UTC exactly once, at the point of reading the file, and
converts back to IST for display. You will see `_IST` suffixes on every output timestamp.

## 0.7 Who reads these outputs

| Role | Cares about |
|---|---|
| **Harbour Master** | Is this transit safe? (M1, M2) |
| **Deputy Conservator** | Channel depth, dredging spend, safety policy (M1, M2, M8) |
| **Berth planner** | Which ship, which berth, when (M4, M5) |
| **Marine control** | Pilots and tugs available for the next 12 hours (M7) |
| **Terminal operator** | When does the ship leave so the next one can come? (M3) |
| **Ship's master / line** | How fast should I sail? (M6) |
| **ICCC / executives** | Is the port healthy right now, and if not why? (M8) |

---

# Part 1 — The eight models at a glance

Map them onto the port call timeline:

```
  ship at sea          approaching        entering channel      alongside        departure
       |                     |                    |                 |                |
     [M6]                  [M4]              [M1] [M2]           [M3]             [M4]
   how fast to           how sure is        is it safe?         how long        how busy
   sail to arrive        the ETA?           when is there       will it         were we?
   just in time                             enough water?       take?
       |                     |                    |                 |                |
       +--------- [M5] which berth, when? --------+                 |                |
       +--------- [M7] enough pilots and tugs? ---+                 |                |
       +--------- [M8] if something breaks, what else breaks? ------+----------------+
```

| Model | One-line question | Kind | Runs per |
|---|---|---|---|
| **M1** DUKC | Will this ship touch the bottom? | Physics | vessel |
| **M2** Tidal window | When over the next 5 days is there enough water? | Physics + search | vessel |
| **M3** TAT | How long will this ship be in port? | **Machine learning** | vessel |
| **M4** ETA / utilisation | How accurate is the ETA? How busy are the berths? | Statistics | vessel + port |
| **M5** Berth plan | Which ship goes to which berth, when? | Optimisation | whole batch |
| **M6** JIT arrival | How fast should the ship sail? | Physics + economics | vessel |
| **M7** Port craft | Do we have enough pilots and tugs? | Scheduling | whole batch |
| **M8** Confidence chain | If X breaks, what else breaks and by how much? | Causal graph | vessel/scenario |

**Only M3 learns from data.** The other seven compute the same answer every time from fixed
formulas — which is exactly what you want for a safety decision. A harbour master will not accept
"the model felt differently today" about whether a ship runs aground.

---

# M1 — Under-Keel Clearance

> **The question: if this ship sails up the channel now, how much water is under its keel — and is
> that enough?**

## Why the port cares

A grounding closes the channel. In 2021 one ship blocking the Suez Canal cost world trade an
estimated $400 m per hour. At the other extreme, being *too* cautious is also expensive: refusing a
transit that was actually safe means a ship waits 6 hours for a tide it did not need.

M1 replaces a static rule of thumb ("keep 15% of draft under the keel") with the actual physics for
the actual ship at the actual tide. It also answers the two questions the harbour master asks next:
**what tide do I need?** and **how slow must she go?**

## Inputs

| Input field | In plain English | Why it matters | Example |
|---|---|---|---|
| `Draft_m` | How deep the ship sits in the water, in metres | The bigger this is, the less room underneath | `14.1` |
| `Speed_kn` | Planned speed through the channel, in knots | Faster = more squat = effectively deeper ship | `10.0` (defaults to the reach limit) |
| `Cargo_Type` | Container or bulk | Selects Cb: 0.65 container, 0.80 bulk. Boxier hulls squat more | `Container` |
| `Channel_Depth_m` | Surveyed depth of the channel today | The starting point. Compared to the charted 15.0 m; below ⇒ siltation, above ⇒ dredged | `14.6` |
| `Tide_Height_m` | Water height above chart datum at that moment | Added to depth. **The most valuable column you can supply** | `2.60` |
| `Siltation_m` | Depth lost to silt (optional; else derived) | Subtracts from depth | `0.4` |
| `Dredging_Delta_m` | Depth gained by dredging (optional; else derived) | Adds to depth | `0.5` |
| `DUKC_Status` | The status *your records* show | **Never fed to the model.** Used only to score it | `Marginal` |

If you don't supply `Tide_Height_m`, the system computes one from a synthetic tide model and marks
the row `TIDE_SYNTHETIC`. That is a plausible number, not a measured one — see [Part 9](#part-9--cross-cutting-ui-rules).

## What the model does, step by step

For **each of the four reaches**, at that reach's own speed limit:

```
1. Pick Cb            container -> 0.65,  bulk -> 0.80
2. Squat              squat = min(2.5, Cb x V^2 / 100)
3. Effective depth    charted + tide - siltation + dredging
4. Gross UKC          effective depth - (draft + squat)
5. Net UKC            gross UKC - 1.0 m safety margin
6. Status             >= 1.0 SAFE | 0.6-1.0 MARGINAL | < 0.6 NO GO
```

Then:

**7. Pick the binding reach** — the one with the *smallest* net UKC. That is the constraint on the
whole transit, and as explained in §0.3 it is not always the shallowest.

**8. Solve backwards for the two levers.** Rather than searching by trial and error, both are solved
in closed form:

- *Minimum tide for SAFE* — rearrange the formula for tide.
- *Maximum safe speed* — rearrange the squat formula: `V = sqrt(100 × allowance / Cb)`.

This is what turns M1 from a calculator into an advisor. It doesn't just say "NO GO"; it says
"NO GO — but SAFE at 9.6 knots, or after the tide reaches 2.65 m."

**9. Sensitivity check.** Re-run the whole thing over a 3×3 grid: draft ±0.2 m × tide ±0.1 m, nine
combinations. If all nine give the same status, the answer is **robust**. If a corner flips to NO GO,
the ship is on a knife-edge and a survey error could change the decision. That flag matters more to
a harbour master than the headline number.

## Outputs

| Output field | Plain English | Show to the user? |
|---|---|---|
| `Status` | **SAFE / MARGINAL / NO GO** | **Yes — the headline.** Big, colour-coded |
| `Net_UKC_m` | Metres of water under the keel after the safety margin | **Yes — the headline number** |
| `Gross_UKC_m` | The same before the safety margin | Secondary; shows what the margin costs |
| `Squat_m` | How much lower the ship sits because it is moving | Yes, in the breakdown — it surprises people |
| `Effective_Depth_m` | Actual water depth = charted + tide − silt + dredge | Yes, in the breakdown |
| `Binding_Reach` | Which stretch of channel is the constraint | **Yes** — tells the pilot where to be careful |
| `Charted_Depth_m` | Chart depth of that reach | Breakdown |
| `Tide_m` | Tide height used | **Yes** — and flag if synthetic |
| `Cb` | Block coefficient used (0.65 / 0.80) | Breakdown only |
| `Min_Tide_For_SAFE_m` | Tide needed to become SAFE | **Yes when not SAFE** — "wait until tide ≥ 2.15 m" |
| `Max_SAFE_Speed_kn` | Fastest speed that stays SAFE | **Yes when not SAFE** — "reduce to 9.6 kn" |
| `Sensitivity_Robust` | Does the verdict survive ±0.2 m draft / ±0.1 m tide? | **Yes** — a small "robust ✓" or "knife-edge ⚠" badge |
| `Recommendation` | One human sentence | **Yes** — put it under the status |
| `Sheet_DUKC_Status` | What your records said | Only on a validation/QA screen |
| `Model_vs_Sheet` | AGREE / DIFFER | Only on a validation/QA screen |

## Real output from the sample file

| Vessel | Draft | Tide | Squat | Effective depth | Net UKC | Status |
|---|---|---|---|---|---|---|
| HONG YONG CHANG SHENG | 13.2 m | 4.30 m | 0.65 m | 19.702 m | **4.852 m** | SAFE |
| KUO LUNG | 12.8 m | 1.26 m | 0.65 m | 16.256 m | **1.806 m** | SAFE |
| TSS AMBER | 14.1 m | 3.26 m | 0.65 m | 17.857 m | **2.107 m** | SAFE |

Trace TSS AMBER by hand to see there is no magic:

```
squat           = 0.65 x 10^2 / 100          = 0.650 m
effective depth = 15.0 + 3.26 - 0.4 + 0.0    = 17.857 m   (0.4 m siltation: surveyed 14.6 vs charted 15.0)
gross UKC       = 17.857 - (14.1 + 0.650)    = 3.107 m
net UKC         = 3.107 - 1.0                = 2.107 m    -> SAFE
```

Her records say MARGINAL and the model says SAFE. The model used a *synthetic* tide of 3.26 m; her
records were written at whatever the real tide was. Supply `Tide_Height_m` and this becomes a real
accuracy measurement instead of a comparison against a guess.

## UI suggestion

**Screen: "Transit Safety" — one card per inbound vessel.**

```
┌──────────────────────────────────────────────────────────┐
│  TSS AMBER              draft 14.1 m · 10 kn · CH-INNER   │
│                                                            │
│        ┌────────────┐                                      │
│        │    SAFE    │     Net UKC   2.11 m                 │
│        └────────────┘     ────────────────────             │
│         green            [====|=========] 2.11             │
│                          0   0.6  1.0        (NO GO|MARG|SAFE)
│                                                            │
│  Robust ✓  ·  tide 3.26 m  ⚠ estimated                     │
│                                                            │
│  ▸ How this was calculated                                 │
│      charted depth       15.000 m                          │
│      + tide               3.260 m   ⚠ synthetic            │
│      − siltation          0.400 m                          │
│      = effective depth   17.857 m                          │
│      − draft             14.100 m                          │
│      − squat              0.650 m   (0.65 × 10² ÷ 100)     │
│      = gross UKC          3.107 m                          │
│      − safety margin      1.000 m                          │
│      = NET UKC            2.107 m   → SAFE                 │
└──────────────────────────────────────────────────────────┘
```

Rules:
- Colour: SAFE `#2E7D32` green, MARGINAL `#F9A825` amber, NO GO `#C62828` red. Never colour alone —
  always pair with the text, for colour-blind users.
- The horizontal bar with markers at 0.6 and 1.0 turns an abstract number into an instant read.
- **When not SAFE, promote the two levers to buttons:** "Wait for tide ≥ 2.15 m (≈ 3 h)" and
  "Reduce to 9.6 kn". This is the difference between a dashboard and a decision tool.
- The step-by-step breakdown should be collapsible but present. Every number in it is in
  `details[call_id].steps[]` in the JSON, with the formula and the substituted values — you can
  render it generically without hard-coding the physics into the frontend.

---

# M2 — Tidal Windows

> **The question: over the next five days, during which time slots is there enough water for this
> ship to move — and how much would dredging change that?**

## Why the port cares

M1 answers "right now". A planner needs "when". A deep ship might have only four usable windows in
the next 24 hours, each 2 hours long. Berth plans, pilot rosters and vessel schedules all hang off
those slots.

The second half is a business case. Dredging costs crores. M2 prices it in the only currency that
matters operationally: **how many extra hours per five days does the channel become usable?**

## Inputs

| Input field | Plain English | Why it matters |
|---|---|---|
| `Draft_m` | How deep the ship sits | Deeper ships need more tide, so fewer windows |
| `ATA` | When to start scanning from | Anchors the 5-day forecast |
| `Speed_kn` | Planned channel speed | Sets squat at each reach |
| `Cargo_Type` | Container / bulk | Sets Cb |
| `Channel_Depth_m` | Surveyed depth | Baseline for the scenarios |

Plus one setting: `--horizon-hours` (default 120 = five days).

## What the model does, step by step

```
1. Build a tide curve      481 samples: every 15 minutes for 120 hours
2. At each sample:         run the full M1 DUKC check on ALL FOUR reaches
3. Mark each sample        feasible / not feasible (SAFE required by default)
4. Group runs of           consecutive feasible samples into WINDOWS
5. Discard windows         shorter than 30 minutes (too short to use)
6. Re-run steps 1-5        for "dredged +0.5 m" and "silted -0.3 m"
7. Compare                 delta hours and delta % versus baseline
```

The tide curve is a *mixed semi-diurnal* model — two high tides a day of unequal height:

```
tide(t) = 2.6 + 1.7·cos(ωt) + 0.3·sin(0.5ωt)      ω = 2π / 12.4206 hours
          ^mean  ^main lunar cycle   ^diurnal inequality
```

12.4206 hours is the real period of the moon's principal tidal push. The third term is what makes
successive high tides unequal — which is precisely what makes window widths unequal, and therefore
what makes the dredging comparison interesting rather than trivial.

**Design choices worth knowing:**

- Windows require **SAFE**, not MARGINAL. MARGINAL periods are scanned and reported separately as
  `Conditional_Extra_h` — real hours available under precautions, never mixed into the headline. A
  planner who spends "usable hours" that were actually marginal has been misled.
- Feasibility is tested at **every reach at its own speed cap**, not against a single minimum depth.

## Outputs

| Output field | Plain English | Show to the user? |
|---|---|---|
| `Windows` | How many separate usable slots in 5 days | **Yes** |
| `Usable_Hours` | Total transitable hours | **Yes — headline** |
| `Availability_pct` | Usable hours as % of the horizon | **Yes — headline** |
| `Next_Window_Start_IST` | When the next slot opens | **Yes — most actionable field** |
| `Max_Gap_h` | Longest unusable stretch | **Yes** — the number a planner acts on: worst-case wait |
| `Mean_Window_h` / `Longest_Window_h` | Typical / best slot length | Secondary |
| `Required_Tide_m` | Tide this ship needs | Yes, as context |
| `Binding_Reach` | Constraining stretch | Yes |
| `Dredged_Delta_h` / `_pct` | Extra hours if dredged +0.5 m | **Yes — the business case** |
| `Silted_Delta_h` / `_pct` | Hours lost if silted −0.3 m | **Yes — the risk case** |
| `Conditional_Extra_h` | Extra hours available at MARGINAL | Yes, clearly labelled as conditional |
| `Sheet_Window_vs_Model` | Does your stated window match ours? | QA screen |
| `Samples` | 481 | Debug only |

## Real output from the sample file

| Vessel | Draft | Tide needed | Windows | Usable h | Availability | Max gap |
|---|---|---|---|---|---|---|
| HONG YONG CHANG SHENG | 13.2 m | 0.85 m | 6 | 108.25 | 90.2 % | 2.5 h |
| KUO LUNG | 12.8 m | 0.45 m | 1 | 120.00 | 100.0 % | 0.0 h |
| TSS AMBER | 14.1 m | 1.75 m | 10 | 79.25 | 66.0 % | 5.0 h |

Read the physical sense in that: the 12.8 m ship needs only 0.45 m of tide, which the sea never
drops below, so it has one continuous 120-hour window — it is never constrained. The 14.1 m ship
needs 1.75 m, gets it only around each high tide, and so is chopped into 10 separate slots losing a
third of the horizon, with a worst-case 5-hour wait.

**That one row is the entire argument for tide-aware planning**: 1.3 m more draft costs 41 hours of
channel availability in five days.

## UI suggestion

**Screen: "Tidal Windows" — a timeline, not a table.**

```
  TSS AMBER · draft 14.1 m · needs tide ≥ 1.75 m
  ─────────────────────────────────────────────────────────────
  next window opens  29 Jul 05:18 IST
  79.25 usable hours of 120  ·  66.0 %  ·  worst wait 5.0 h

  Mon        Tue        Wed        Thu        Fri
  ██▁▁██▁▁▁██▁▁██▁▁▁██▁▁██▁▁▁██▁▁██▁▁▁██▁▁██▁▁▁██▁▁██▁▁
  ↑ green = transitable      ↑ grey = wait      ↑ amber = marginal

  ┌─ What dredging would buy ────────────────────────────┐
  │  baseline           79.25 h        66.0 %            │
  │  dredged +0.5 m     ██████  +18.00 h  (+22.7 %)      │
  │  silted  −0.3 m     ▼▼▼▼     −7.25 h   (−9.1 %)      │
  └──────────────────────────────────────────────────────┘
```

The full lever table across the three sample vessels — note how the benefit of
dredging depends entirely on how constrained the ship already is:

| Vessel | Draft | Baseline | Dredged +0.5 m | Silted −0.3 m |
|---|---|---|---|---|
| KUO LUNG | 12.8 m | 120.00 h | **+0.00 h** (already unconstrained) | −9.75 h (−8.1 %) |
| HONG YONG CHANG SHENG | 13.2 m | 108.25 h | +11.75 h (+10.9 %) | −5.50 h (−5.1 %) |
| TSS AMBER | 14.1 m | 79.25 h | **+18.00 h (+22.7 %)** | −7.25 h (−9.1 %) |

Dredging buys nothing for the 12.8 m ship because she was never blocked, and buys the most for the
deepest ship. **That is the argument for expressing a dredging business case per draft class rather
than as a single port-wide number.**

Rules:
- **Lead with "next window opens at…"** — that is what the user came for.
- Draw the tide curve behind the window bars with a horizontal line at `Required_Tide_m`. The
  windows then visibly *are* the parts of the curve above the line, and the whole model becomes
  self-explanatory. Get the 481 points from `GET /uc1/m2/tide-curve`.
- Render `Conditional_Extra_h` in amber *outside* the green total. Never add them together.
- The dredging comparison deserves its own panel — it is the slide that goes in front of a board.

---

# M3 — Turnaround Time

> **The question: this ship just arrived. When will it berth (ETB), how long will it be in port
> (TAT), and when will it leave (ETD)?**

**This is the only model that learns from history.** The other seven compute; this one is trained.

## Why the port cares

ETD drives everything downstream: when the berth frees up, when the next ship can be promised a
slot, when the trucks and trains should arrive, whether the port hits its published KPI. A wrong ETD
propagates into every plan for the next two days.

## Inputs

Grouped by what they represent:

**How much work is there?**

| Field | Plain English | Effect |
|---|---|---|
| `Total_TEU` | Containers to load + unload | **The biggest driver.** ≈ +1 hour per 250 TEU |
| `Import_TEU` / `Export_TEU` | The split | Used to fill in `Total_TEU` if blank |

**How hard is the ship to handle?**

| Field | Plain English | Effect |
|---|---|---|
| `Draft_m` | How deep it sits | +1.5 h per metre over 13 m — deep ships are tide-constrained |
| `Terminal_Max_Draft_m` | What the berth can take | Margin between the two |

**What is the weather doing?**

| Field | Plain English | Effect |
|---|---|---|
| `Weather` | "Clear" / "Light Rain" / "Moderate Rain" / "Heavy Rain" → 0–3 | +5 h once severe |
| `Wind_Speed_kn` | Wind speed | +0.15 h per knot over 20 — cranes stop in high wind |
| `Rain_mm_hr` | Rain intensity | +0.22 h per mm/hr — containers can't be opened in rain |

**Are the resources there?**

| Field | Plain English | Effect |
|---|---|---|
| `Pilot_Available` | Yes / Busy / No → a count | +1.5 h per pilot short |
| `Tug_Available` | Yes / Busy / No → a count | +1.0 h per tug short |

**How congested is the port?**

| Field | Plain English | Effect |
|---|---|---|
| `Berth_Occupancy_%` | How full the port is | Converted to a queue estimate: +0.6 h per waiting vessel |
| `Anchorage_Queue` | Ships actually waiting (better, if you have it) | Overrides the estimate |
| `Channel_Depth_m` | Surveyed depth | +4 h per metre lost to siltation |
| `Incident` | "No" / "Minor Delay" / "Major" / "Stoppage" → 0–3 | +2.5 h per level |

Two fields are handled specially, and you should know why:

> **`Cranes_Available` is read but deliberately NOT fed to the model.** It is a genuine driver, but
> it is not in the model's approved feature list, and the model refuses at import time to accept any
> field not on that list. Adding it means editing the feature list and retraining — a deliberate,
> versioned change. Slipping a new input into a trained model without retraining produces silently
> wrong predictions. The value is carried into the output as context and flagged.

> **`ETB`, `TAT`, `ETD`, `ATB`, `ATD` must NOT appear in the input.** They are what we predict. If
> the loader sees them it stops with a hard error. Letting a model see the answer during training is
> called **data leakage**: it scores brilliantly in testing and fails completely in production.

## What the model does, step by step

**Training** (`src/pipeline/train_tat_model.py`, run once):

```
1. Build history         365 days, 4,016 vessel calls, calibrated to JNPA's published 1.83 d TAT
2. Split by TIME         oldest 80% train, newest 20% test  -- never randomly
3. Purge the boundary    drop training calls still in progress at the split (24 h embargo)
4. Fit imputation        fill-in values computed from training data ONLY
5. Try engines in order  LightGBM -> sklearn GBR -> sklearn RF -> additive
6. Calibrate the band    conformal quantile regression, so "80%" really means 80%
7. Gate on quality       MAE <= 8 h, accuracy >= 80%, coverage 60-95%
8. Freeze to disk        trained_models/uc1_m3_tat_lightgbm_v1.2.0.pkl + a readable .json model card
```

Two of those steps deserve explanation.

**Why split by time, not randomly?** The obvious approach — shuffle all calls and take 20% at random
— is wrong here. Calls from the same day share weather, tide and yard congestion. Random splitting
puts the morning ship in training and the afternoon ship in testing, so the model effectively sees
the answer. It looks accurate and is not. We sort by time and cut, then throw away calls straddling
the boundary.

**Why 365 days rather than 180?** We measured. A model trained on 180 days sees one season; its
"80% band" covered only 68% of reality because the test period contained weather it had never met.
At 365 days it reached 85.7%. That gap was *covariate shift* — not a calibration bug — and the fix
was more data span, not more tuning.

**Prediction** (`src/pipeline/predict.py`, run any time):

```
1. Load the frozen model      verify its SHA-256 against the model card first
2. Score each vessel          -> TAT p10 / p50 / p90 (hours)
3. Estimate the wait          M5 berth contention, or the M4 queue distribution
4. Assemble the targets       ETB = ATA + wait
                              ETD = ATA + TAT
                              berth stay = TAT - wait
5. Sanity-check               if berth stay < 6 h the two estimates disagree;
                              floor it, push ETD out, flag ETD_RECONCILED
6. Explain                    rank each factor's contribution in hours
```

**p10 / p50 / p90** are the honest way to express a forecast. p50 is the middle estimate — as likely
to be over as under. p10 and p90 bracket it: about 80% of actual outcomes should land between them.
A prediction of "43.5 hours" is a guess; "43.5 hours, likely 38–47" is a plan you can staff to.

## Outputs

| Output field | Plain English | Show to the user? |
|---|---|---|
| `ETB_IST` | **Predicted berthing time** | **Yes — target #1** |
| `TAT_Hours` | **Predicted total port time** | **Yes — target #2** |
| `ETD_IST` | **Predicted departure time** | **Yes — target #3** |
| `TAT_Days` | The same in days (JNPA publishes days) | Yes, next to hours |
| `TAT_P10_Hours` / `TAT_P90_Hours` | Optimistic / pessimistic bounds | **Yes — always show with p50** |
| `Band_Width_Hours` | p90 − p10 | Drives the confidence label |
| `Confidence` | HIGH (≤ 8 h band) / MEDIUM (≤ 16 h) / LOW | **Yes — a badge** |
| `Wait_Hours` | Predicted anchorage wait | Yes |
| `Berth_Stay_Hours` | Predicted hours alongside | Yes |
| `Assigned_Berth` | Berth from the optimiser | Yes |
| `Top_Driver_1/2/3` | The three biggest contributors, in hours | **Yes — this is the "why"** |
| `Stressors` | Named conditions currently active | Yes, as chips |
| `Engine` | Which model produced it (`lightgbm`) | Small print / tooltip |
| `Attribution_Source` | Whether the driver list is exact or a surrogate | **Yes — see the caveat below** |
| `Wait_Source` | How the wait was estimated | Small print |
| `Flags` | Machine-readable caveats | **Yes — see [Part 9](#part-9--cross-cutting-ui-rules)** |

> **The attribution caveat, and please do respect it.** When LightGBM produces the p50, the driver
> list does *not* come from LightGBM — a gradient-boosted tree has no per-factor hours to report. It
> comes from a transparent additive model fitted alongside, a *surrogate*. It is a good explanation
> of roughly why the number is what it is; it is not a decomposition of the actual model's
> reasoning. `Attribution_Source` says `additive_surrogate` when this is the case. **Caption the
> chart accordingly.** Presenting surrogate attributions as the model's reasoning is how
> explainability features become misinformation.

## Real output from the sample file

| Vessel | ATA (IST) | ETB (IST) | ETD (IST) | TAT | p10–p90 | Confidence |
|---|---|---|---|---|---|---|
| HONG YONG CHANG SHENG | 29 Jul 07:45 | 29 Jul 07:45 | **31 Jul 03:16** | 43.52 h | 38.1–46.6 | MEDIUM |
| KUO LUNG | 15 Jul 01:20 | 15 Jul 01:20 | **16 Jul 20:53** | 43.56 h | 38.4–46.6 | MEDIUM |
| TSS AMBER | 29 Jul 05:18 | 29 Jul 05:18 | **31 Jul 10:05** | 52.78 h | 46.5–53.1 | HIGH |

Why TSS AMBER takes 9 hours longer, straight from her driver list:

```
base                      +34.00 h
parcel 4,800 TEU          +19.20 h    (+1 h per 250 TEU)
severe weather             +5.00 h    (22 kn wind, 8 mm/hr rain)
anchorage queue (6)        +3.60 h    (+0.6 h per waiting vessel)
incident: Minor Delay      +2.50 h
rain 8 mm/hr               +1.76 h
```

Model quality, measured on 804 held-out calls it never saw during training:

| | |
|---|---|
| Mean absolute error | **2.49 hours** |
| Forecast accuracy | **94.10 %** |
| 80 % band coverage | **85.7 %** (target 80) |

## UI suggestion

**Screen: "Vessel Forecast" — the flagship view.**

```
┌────────────────────────────────────────────────────────────────┐
│  TSS AMBER    IMO 9241918 · voy 2626 · NSFT CB-02              │
│                                                                 │
│   ARRIVED          BERTHS               DEPARTS                 │
│   29 Jul 05:18  →  29 Jul 05:18     →   31 Jul 10:05           │
│   (actual)         ETB                  ETD    ⓘ 46.5–53.1 h    │
│                                                                 │
│   TAT  52.8 h  (2.20 days)          ● HIGH confidence           │
│        ├────────[███████]────────┤                              │
│       46.5      52.8      53.1                                  │
│                                                                 │
│   Why this long?                                                │
│     base                   ████████████████████  34.0 h         │
│     4,800 TEU parcel       ███████████           19.2 h         │
│     severe weather         ███                    5.0 h         │
│     anchorage queue (6)    ██                     3.6 h         │
│     incident: minor delay  █                      2.5 h         │
│     rain 8 mm/hr           ▌                      1.8 h         │
│     ⓘ explains the additive surrogate, not the GBM's splits     │
│                                                                 │
│   ⚠ Wait is a lower bound (only 2 vessels in this plan window)  │
│   ⚠ Tide height is estimated, not measured                      │
└────────────────────────────────────────────────────────────────┘
```

Rules:
- **Never show p50 without p10–p90.** A bare number invites false precision. Render the band as a
  horizontal range with p50 marked — the width itself communicates uncertainty.
- The driver bar chart is the single most valuable widget in the whole system. It converts "the AI
  said 52.8" into "4,800 containers and a storm". Sort by absolute contribution, cap at 5–6 bars.
- Put the surrogate caveat as a small ⓘ under the chart, always.
- Surface `Flags` as inline warnings, not buried in a tooltip.

---

# M4 — ETA Uncertainty & Berth Utilisation

> **Two questions: how much should we trust this ETA? And how busy have our berths actually been?**

## Why the port cares

An ETA is not a fact, it is a forecast, and its reliability degrades in two specific ways:

1. **Distance in time.** An ETA 24 hours out is far less reliable than one 2 hours out.
2. **Staleness of the position report.** Ships broadcast their position by **AIS** (Automatic
   Identification System, a radio transponder). If the last message was 3 hours ago, the ETA is
   built on stale data.

M4 turns "ETA 06:00" into "06:00, probably between 04:07 and 07:52" — and a berth planner can staff
to a range where they cannot staff to a point.

The second half measures **occupancy**: what fraction of available berth-hours were actually
occupied. That is the port's core productivity metric.

## Inputs

**For ETA bands (per vessel):**

| Field | Plain English | Why |
|---|---|---|
| `ETA` | Forecast arrival time | The centre of the band |
| *(computed)* `Horizon_h` | Hours between now and the ETA | Further out = wider band |
| `--ais-staleness-min` | Age of the last AIS position, minutes | Older = wider band. Default 15 |

**For occupancy (port-wide):** a **berthing log** — for each past call, which berth, and when the
ship arrived, berthed, and left. The input file cannot supply this (ATB/ATD are the things we
predict), so occupancy is computed from the log extracted from JNPA's Daily Status Report PDFs.

## What the model does, step by step

**ETA band:**

```
sigma = 0.06 x horizon_hours  +  0.05 x ais_staleness_minutes
p10 = ETA - 1.28 x sigma      p90 = ETA + 1.28 x sigma
```

σ ("sigma") is the standard deviation — a measure of spread. ±1.28σ captures the middle 80% of a
normal distribution, so p10 and p90 bracket 80% of likely outcomes. The two coefficients say: each
extra hour of lead time adds ~3.6 minutes of uncertainty, and each extra minute of AIS staleness
adds 3 minutes.

Confidence label: σ ≤ 1.5 h **HIGH**, ≤ 4.0 h **MEDIUM**, above that **LOW**.

**Occupancy** — this is where naive implementations quietly go wrong, so all four cases are handled
explicitly:

1. **Clipping** — a ship berthed before the reporting window started only counts from the window
   start.
2. **Day bucketing** — a 40-hour stay spans three calendar days. Boundaries are computed in *local*
   IST, and each day's denominator is the *clipped* day length. Without that, a window starting at
   06:00 gives a first day that appears 133% occupied.
3. **Double-booking** — real logs sometimes show two ships at one berth simultaneously. We merge
   overlapping intervals (the *union*), which bounds occupancy at 100%, and report the discarded
   overlap separately as a **data-quality signal** rather than hiding it.
4. **Open-ended stays** — a ship that hasn't left yet is clipped to the window end and counted.

## Outputs

**Per vessel:**

| Output field | Plain English | Show? |
|---|---|---|
| `ETA_P50_IST` | The central ETA estimate | **Yes** |
| `ETA_P10_IST` / `ETA_P90_IST` | Earliest / latest realistic arrival | **Yes — as a range** |
| `Sigma_h` | The uncertainty in hours | Tooltip |
| `Band_Width_h` | p90 − p10 | Yes |
| `Confidence` | HIGH / MEDIUM / LOW | **Yes — a badge** |
| `Horizon_h` | Hours until the ETA | Tooltip — explains the width |
| `AIS_Staleness_min` | Age of the position report | Tooltip |

**Port-wide:**

| Field | Plain English | Show? |
|---|---|---|
| `overall_occupancy_pct` | % of berth-hours used | **Yes — headline KPI** |
| `berths` / `occupancy_records` | Scope of the measurement | Small print |
| `waiting_p50_h` / `waiting_p90_h` | Median / bad-case wait | **Yes when available** |
| `double_booked` hours | Overlap found in the data | **Yes — on a data-quality panel** |
| `occupancy_source` | Which dataset this came from | Small print |

## Real output from the sample file

```
Vessel                  ETA (IST)          p10 - p90                    sigma  confidence
HONG YONG CHANG SHENG   29 Jul 06:00       04:07 - 07:52  (3.76 h)      1.47   HIGH
KUO LUNG                15 Jul 01:00       23:07 - 02:52  (3.76 h)      1.47   HIGH
TSS AMBER               29 Jul 00:16       22:23 - 02:08  (3.76 h)      1.47   HIGH
```

Check it: horizon 12 h, staleness 15 min → σ = 0.06×12 + 0.05×15 = 0.72 + 0.75 = **1.47 h**.
Band = 2 × 1.28 × 1.47 = **3.76 h**.

Port-wide, from 363 real berth records across 21 berths:

```
occupancy      50.65 %
double-booked  4,131.48 h   <- the raw log claims more berth-hours than physically exist
waiting time   NOT COMPUTABLE
```

**That last line is important and honest.** Waiting time is `ATB − ATA`, and JNPA's Daily Status
Reports record *berthed on* and *expected completion* but never an arrival at anchorage. All 363
records drop. No amount of modelling recovers a quantity the data does not contain — it needs the
port community system's `VESARR` arrival logs. The system says so rather than returning a
confident-looking wrong number.

## UI suggestion

**Widget A — ETA with uncertainty**, embedded in every vessel row:

```
  ETA  29 Jul 06:00 IST   ● HIGH
       ├──────●──────┤
      04:07  06:00  07:52          ⓘ 12 h out · AIS 15 min old
```

**Widget B — Berth occupancy heat calendar:**

```
           Mon  Tue  Wed  Thu  Fri  Sat  Sun
  CB-01    ███  ███  ▓▓▓  ███  ███  ░░░  ▓▓▓     78 %
  CB-02    ▓▓▓  ███  ███  ███  ▓▓▓  ▓▓▓  ░░░     71 %
  BMCT-01  ███  ███  ███  ███  ███  ███  ▓▓▓     94 %
           ...
  ░ <40 %   ▓ 40-75 %   █ >75 %
```

Rules:
- Never render a cell above 100%. If your data would, that is the double-booking signal — show it in
  a "Data quality" panel with the overlap hours, not by drawing an impossible bar.
- When a statistic is not computable, **render a labelled empty state**, not a zero. "Waiting time
  unavailable — source has no arrival timestamps" is useful. "0.0 h" is a lie.

---

# M5 — Berth Plan Optimisation

> **The question: given the ships arriving and the berths we have, who goes where and when, at the
> lowest total cost?**

## Why the port cares

This is a genuinely hard combinatorial problem done by hand on whiteboards in most ports. Each ship
has a preferred berth, but that berth may be occupied, too short, too shallow, or reachable only
outside its tidal window. Every reassignment has a cost — moving a ship to a different terminal
means its containers are in the wrong yard.

## Inputs

| Field | Plain English | Role |
|---|---|---|
| `Vessel` | Ship name | Identity |
| `LOA_m` | Length overall | **Hard constraint** — must fit the berth |
| `Draft_m` | How deep it sits | **Hard constraint** — berth must be deep enough |
| `Requested_Berth` | The berth the line wants | Preferred; changing it costs 0.5 |
| `ATA` | When it's ready to berth | Earliest possible start |
| `Service_Hours` | Hours needed alongside | How long it blocks the berth. Default 24 |
| `Priority` | 1 (highest) to 9 | Ordering. Default 5 |

Plus the berth roster (21 berths with length and max draft) and the tidal windows from M2.

## What the model does, step by step

**The objective** — one number to minimise:

```
cost = 1.0 x (hours of waiting)
     + 2.0 x (number of tidal-window misses)
     + 0.5 x (number of berth changes)
```

Those weights are policy, not physics, and they are explicit so they can be argued about. As set, a
tide miss is worth 2 hours of waiting, and moving a ship to another berth is worth half an hour.

**Constraint types — the distinction matters:**

- **Hard** (never violated, guaranteed by construction): LOA ≤ berth length; draft ≤ berth max
  draft; no two ships at one berth at once, with a 0.5 h turnaround buffer. **The plan is always
  physically possible.**
- **Soft** (violated at a price): the tidal window. If no window exists within 72 hours, the ship is
  still berthed but carries a 2.0 penalty and is flagged. Otherwise a single tide-locked ship would
  make the whole plan "infeasible" and produce nothing.

**Two algorithms:**

1. **Greedy** — sort by priority and time; for each ship, try the requested berth, then others; pick
   the cheapest. Fast and always produces an answer.
2. **CP-SAT** — a constraint solver (Google OR-Tools) that searches the whole space for the true
   optimum, with a 10-second limit.

`auto` runs greedy as a floor, then CP-SAT, and returns whichever is cheaper. Measured on the demo
scenario: greedy **30.15**, CP-SAT **17.66** — a **41% improvement**. Without OR-Tools installed,
greedy is returned and the output says so.

**Planning clusters.** Ships arriving three weeks apart do not compete for a berth. Requests more
than 72 hours apart are optimised separately, so the model never invents contention that does not
exist.

## Outputs

| Output field | Plain English | Show? |
|---|---|---|
| `Assigned_Berth` | Where the ship actually goes | **Yes** |
| `Requested_Berth` | Where it asked to go | **Yes** — the contrast is the story |
| `Assigned_Start_IST` | When it can berth | **Yes** |
| `Wait_h` | Hours between wanting and getting a berth | **Yes** |
| `Berth_Shift` | true if moved from the requested berth | **Yes — a badge** |
| `Tide_Miss` | true if berthed outside a tidal window | **Yes — a warning badge** |
| `Rationale` | One sentence explaining this assignment | **Yes — essential for trust** |
| `Algorithm` | `greedy` or `cpsat` | Small print |
| `Cluster_Size` | How many ships competed | Tooltip — explains a zero wait |
| `total_cost` + component breakdown | The objective and its parts | **Yes — a cost panel** |

## Real output

On the sample (3 ships, days apart) everything gets its requested berth with zero wait — correct,
because nothing competes. To show the model working, four ULCVs arriving 15 minutes apart:

| Vessel | Requested | Assigned | Wait | Shift |
|---|---|---|---|---|
| MSC ANNA | BMCT-01 | BMCT-01 | 0.0 h | – |
| EVER GIVEN | CB-06 | **BMCT-02** | 0.0 h | ✔ |
| CMA CGM MARCO | CB-04 | **BMCT-03** | 0.0 h | ✔ |
| MAERSK SEALAND | APMT-01 | APMT-01 | 0.0 h | – |

```
component        quantity   weight   subtotal
wait hours           0.00      1.0       0.00
berth shifts            2      0.5       1.00
tide misses             0      2.0       0.00
TOTAL                                    1.00
```

CP-SAT chose **two berth shifts and zero waiting**. That is the right call under these weights: a
shift costs 0.5, an hour of waiting costs 1.0, so shifting two ships (1.00) beats making them wait
even one hour each (2.00). **The optimiser's behaviour is a direct, checkable consequence of the
weights** — which is why the weights are shown in the output.

## UI suggestion

**Screen: "Berth Plan" — a Gantt chart. Nothing else communicates this.**

```
              06:00   08:00   10:00   12:00   14:00   16:00   18:00
  BMCT-01     ▐████████ MSC ANNA ████████▌
  BMCT-02       ▐██████ EVER GIVEN ██████▌  ⇄ moved from CB-06
  BMCT-03         ▐████ CMA CGM MARCO ████▌ ⇄ moved from CB-04
  APMT-01           ▐██ MAERSK SEALAND ██▌
  CB-04       ·············· (free) ··············
  CB-06       ·············· (free) ··············

  ┌ Plan cost ────────────────────────────────────┐
  │  waiting        0.00 h  × 1.0  =  0.00        │
  │  berth shifts        2  × 0.5  =  1.00        │
  │  tide misses         0  × 2.0  =  0.00        │
  │  TOTAL                            1.00        │
  │  solved by CP-SAT · 1 cluster · 4 vessels     │
  └───────────────────────────────────────────────┘
```

Rules:
- One row per berth, time along the x-axis, one bar per ship. Click a bar → show its `Rationale`.
- Mark shifted ships with a `⇄` and a "was CB-06" note. Planners need to see what changed and why.
- Tide misses in red with a tide icon.
- Show the cost breakdown next to the chart, with the weights visible and ideally **adjustable** —
  "what if waiting cost 3× a berth shift?" is the question planners actually want to explore.

---

# M6 — Just-In-Time Arrival

> **The question: the berth won't be free until 20:00. The ship is 240 nautical miles away. How fast
> should it sail — and what does slowing down save?**

## Why the port cares

Ships traditionally sail at full speed and then sit at anchor. That is pure waste, and the reason it
persists is that the ship doesn't know when the berth will be free.

The saving is large because of a physical fact: **fuel consumption rises with the cube of speed.**

```
fuel per hour ∝ speed³
```

Drop from 16 to 12 knots — 25% slower — and fuel per hour falls to (12/16)³ = 42%. The voyage takes
longer, so the total is not 42%, but it is still a big win. This is called **slow steaming**, and
doing it deliberately to arrive exactly when the berth is ready is **Just-In-Time (JIT) arrival**.

It is also the port's most direct decarbonisation lever, which matters for IMO reporting.

## Inputs

| Field | Plain English | Why it matters |
|---|---|---|
| `Distance_NM` | Distance still to sail, nautical miles | **Everything scales with this.** Default 240 — supply the real value |
| `Berth_Ready` | When the berth will actually be free | The target time |
| `Tide_Window_Start` / `_End` | When the channel is passable | The ship can't arrive before the window opens |
| `Draft_m` | How deep it sits | Checked against the window's max draft |
| *(constant)* service speed | The ship's normal speed, 16 kn | The baseline to compare against |

## What the model does, step by step

```
1. RTA        = max(berth ready, tidal window start)     "Recommended Time of Arrival"
   and record WHICH of the two set it -- the "driver"
2. available  = RTA - now
3. required speed = distance / available
4. Clamp:     if required > 16 kn  -> impossible, sail at 16 (driver MAX_SPEED_LIMIT)
              if required < 8 kn   -> below steerage; sail at 8 and anchor for the remainder
5. Baseline   fuel at full speed + fuel burned idling at anchor
6. JIT        fuel at the recommended speed, no anchoring
7. Savings    tonnes, then CO2 = tonnes x 3.114 (IMO factor), then USD at 600/t
```

**Why the driver matters.** `RTA_Driver` says *what is holding the ship up*. `BERTH_READY` means
the terminal is the constraint — the ship's line can push for an earlier slot. `TIDAL_WINDOW` means
nature is the constraint and no amount of negotiation helps. Two completely different conversations.

**The 8-knot floor** is real seamanship: below about 8 knots a large ship loses steerage — the rudder
stops working properly. So the advice becomes "sail at 8 and anchor for the rest", not "sail at 5".

**Two savings figures, and we headline the conservative one.** Slow steaming saves fuel *and* avoids
burning fuel at anchor. Counting both gives a bigger number. We headline **steaming-only** and report
the anchorage-inclusive figure as clearly-labelled secondary. Understating a claim you are making to
a client is the right default.

## Outputs

| Output field | Plain English | Show? |
|---|---|---|
| `Recommended_Speed_kn` | **The advice: sail at this speed** | **Yes — the headline** |
| `RTA_IST` | Arrive at this time | **Yes** |
| `RTA_Driver` | What set that time — berth, tide, pilot, or max speed | **Yes — essential context** |
| `Fuel_Saved_t` | Tonnes of bunker fuel saved | **Yes** |
| `CO2_Saved_t` | Tonnes of CO₂ avoided | **Yes — the ESG number** |
| `Bunker_Saved_USD` | Money saved | **Yes — but label SIMULATED** |
| `Anchorage_h_Eliminated` | Hours of anchor waiting removed | **Yes** |
| `Required_Speed_kn` | Speed needed before clamping | Secondary |
| `Speed_Clamped` | true if clamped to 8 or 16 | Yes, as a note |
| `Feasible` | Can the ship actually make the RTA? | **Yes — a badge** |
| `Misses_Tidal_Window` | Would arrive outside the window | **Yes — a warning** |
| `Baseline_Fuel_t` / `JIT_Fuel_t` | Before and after | Yes, as a comparison |
| `Distance_Source` | Real value or the default | **Yes when `DEFAULT`** |
| `Recommendation` | One human sentence | **Yes** |

## Real output from the sample file

| Vessel | RTA | Driver | Required | Advice | Fuel saved | CO₂ saved | USD |
|---|---|---|---|---|---|---|---|
| HONG YONG CHANG SHENG | 29 Jul 06:30 | `MAX_SPEED_LIMIT` | 17.45 kn | 16.0 kn | 0.0 t | 0.0 t | 0 |
| KUO LUNG | 15 Jul 01:30 | `BERTH_READY` | 15.82 kn | 15.8 kn | 1.05 t | 3.27 t | 629 |
| TSS AMBER | 29 Jul 18:00 | `BERTH_READY` | 8.66 kn | 8.7 kn | **33.92 t** | **105.64 t** | **20,355** |

Three genuinely different situations, and the model distinguishes them:

- **HONG YONG** needs 17.45 kn but can only do 16. She is already going as fast as possible and will
  arrive late regardless. Correct advice: **do nothing**. There is no saving to claim, and the model
  says zero rather than inventing one.
- **KUO LUNG** shaves 0.2 kn. Marginal, but free.
- **TSS AMBER** has 27.7 hours for a 240 NM trip. Dropping 16 → 8.7 kn saves **33.92 tonnes of fuel
  and 105.6 tonnes of CO₂ on a single voyage**, and removes 12.7 hours of anchoring. That is the
  business case for JIT in one row.

Fleet total: **34.97 t fuel, 108.9 t CO₂, USD 20,984**.

> **Before quoting these:** all three rows used the 240 NM *default* because the sample has no
> `Distance_NM` column, and savings scale linearly with distance. The USD 600/t bunker price is a
> simulated assumption. Add the real distances first.

## UI suggestion

**Screen: "JIT Advisory" — one card per vessel at sea.**

```
┌──────────────────────────────────────────────────────────────┐
│  TSS AMBER                              240 NM to go ⚠ default │
│                                                                │
│         SLOW TO                                                │
│        ┌─────────┐        arrive 29 Jul 18:00 IST              │
│        │ 8.7 kn  │        because: BERTH READY                 │
│        └─────────┘        (from 16.0 kn)                       │
│                                                                │
│   ┌── What this saves ─────────────────────────────────┐       │
│   │   ⛽  33.92 t fuel     48.0 t → 14.1 t             │       │
│   │   🌍 105.64 t CO₂      IMO factor 3.114            │       │
│   │   💵 USD 20,355        ⚠ simulated @ 600/t         │       │
│   │   ⚓  12.7 h anchoring eliminated                   │       │
│   └────────────────────────────────────────────────────┘       │
│                                                                │
│   basis: steaming-only (the conservative figure)               │
└──────────────────────────────────────────────────────────────┘
```

Rules:
- **The speed is the product.** Make it enormous. Everything else is justification.
- **Always show the driver.** "Because the berth isn't ready" and "because the tide is out" lead to
  different actions.
- Add a speed-vs-fuel curve from `GET /uc1/m6/speed-sweep` (8–16 kn in 0.5 kn steps) with the
  recommendation marked. The cubic curve makes the saving obvious at a glance.
- When `Fuel_Saved_t` is 0, do not show an empty savings panel — show the `Recommendation` text
  ("already on the optimal trajectory"). A zero with no explanation reads as a broken feature.
- Mark simulated money clearly. Every time.

---

# M7 — Port Craft Assignment

> **The question: four ships want to move in the same two hours. Do we have enough pilots, tugs and
> mooring boats — and if not, what is the smallest change that fixes it?**

## Why the port cares

Pilots and tugs are the port's scarcest resource. A pilot shortage at 06:00 delays four ships, each
of which delays its berth, which delays the next ship. The cascade is expensive and it is invisible
until it happens — which is exactly what this model makes visible in advance.

## Inputs

| Field | Plain English | Why |
|---|---|---|
| `Vessel` | Ship name | Identity |
| `ATA` | When the movement starts | Movements overlapping in time compete |
| `LOA_m` | Length | Determines vessel class, which determines tug count |
| `Requested_Berth` | Destination | Context |
| `Bow_Thruster` | Y/N | A ship with one needs one fewer tug |
| `Priority` | 1–9 | Who yields in a conflict |

Plus the **craft roster** — `--roster-preset real` (18 craft transcribed from
`Details_of_Port_Crafts.pdf`: 10 tugs, 4 pilot launches, mooring/security/VIP launches) or `poc`
(the tender spec's 9). `--down-craft PL-01,PL-02` marks craft unavailable.

> **A documented contradiction:** the tender spec says JNPA has 9 craft while citing a PDF that lists
> 18. We default to the PDF and keep the spec figure as a named preset, rather than silently picking
> one.

Requirements are derived from vessel class, not read from the file:

| Class | Pilots | Tugs | Mooring | Duration |
|---|---|---|---|---|
| ULCV | 1 | 3 | 1 | 2.5 h |
| POST_PANAMAX | 1 | 2 | 1 | 2.0 h |
| PANAMAX | 1 | 2 | 1 | 2.0 h |
| FEEDER | 1 | 1 | 1 | 1.5 h |

## What the model does, step by step

```
1. Turn each vessel into a MOVEMENT with a start and end time
2. Look up how many pilots/tugs/mooring boats it needs
3. Allocate craft -- INTERVAL-AWARE: a craft busy on an overlapping
   movement cannot be given to a second one
4. Step through the window in 15-minute slices; where demand > supply,
   record a deficit
5. Merge consecutive deficit slices into CONFLICT BLOCKS
6. Propose SINGLE-UNIT swaps and score each by re-running the allocation
7. Reject any proposal that creates a new conflict elsewhere
```

**Step 3 is the whole point.** The obvious implementation keeps a pool of available craft and slices
off the first N for each movement — and hands the *same pilot* to two ships happening at once. The
conflict report looks fine; the plan is physically impossible. That defect existed in a prior
codebase and is now a permanent regression test here.

**Step 5** matters for usability: without merging you get one alert row per 15-minute slice — 12 rows
for a 3-hour shortage. Merged, you get one block with a start, an end, and a peak deficit.

**Step 6** proposes exactly three families, each changing **one** thing so marine control can act on
it without re-planning the day:

- **REASSIGN** — take a unit from a lower-priority movement.
- **SUBSTITUTE** — swap in an idle unit of the same type with a faster response time.
- **DELAY** — postpone the lowest-priority, *not tide-locked* movement until a unit frees.

Tide-locked movements are excluded from delay because delaying them can mean missing the tide
entirely — a much worse outcome.

## Outputs

**Per movement:**

| Field | Plain English | Show? |
|---|---|---|
| `Movement` / `Start_IST` / `End_IST` | The job and its window | **Yes** |
| `Class` | ULCV / POST_PANAMAX / … | Yes |
| `Req_Pilots` / `Req_Tugs` / `Req_Mooring` | What it needs | **Yes** |
| `Assigned_Pilots` / `Assigned_Tugs` / `Assigned_Mooring` | Actual craft IDs | **Yes** |
| `Shortfall` | What's missing, by type | **Yes — red** |
| `Feasible` | Fully crewed? | **Yes — a badge** |
| `Response_Gap_min` | Minutes short of being ready on time | Yes |

**Per conflict block:**

| Field | Plain English | Show? |
|---|---|---|
| `start_utc` / `end_utc` | When the shortage runs | **Yes** |
| `role` | PILOT / TUG / MOORING | **Yes** |
| `peak_deficit` | Worst-moment shortage | **Yes** |
| `severity` | CRITICAL / HIGH / MEDIUM | **Yes** |
| `movement_ids` | Which ships are caught up | **Yes** |

**Per proposal:**

| Field | Plain English | Show? |
|---|---|---|
| `action` | REASSIGN / SUBSTITUTE / DELAY | **Yes** |
| `rationale` | The plain-English change | **Yes — the actionable item** |
| `gap_closed_minutes` | Improvement if accepted | **Yes** |
| `creates_new_conflict` | Does it break something else? | **Yes** — never show one that does |

## Real output

On the sample: **FEASIBLE, 0 conflicts** — and none is possible, because the three movements never
overlap. One pilot could serve all three in sequence. The model says exactly that rather than
implying you configured something wrong.

With four ULCVs 15 minutes apart, the 9-craft roster, and 2 pilots down:

```
CONFLICT BLOCKS
  29 Jul 06:15 - 09:00   PILOT     peak 3   HIGH   MV-0002..0005
  29 Jul 06:15 - 09:00   TUG       peak 8   HIGH   MV-0002..0005
  29 Jul 06:30 - 08:45   MOORING   peak 2   HIGH   MV-0002..0005

RECOMMENDED
  [DELAY] Postpone MAERSK SEALAND (priority 5, not tide-locked) by 125 min
          so a PILOT frees up for the higher-priority movement.
          gap closed: 600 min
```

Four ULCVs need 4 pilots and 12 tugs simultaneously; one pilot and four tugs exist. The peak tug
deficit of 8 is arithmetic, not alarmism.

## UI suggestion

**Screen: "Marine Control" — a resource timeline plus an alert list.**

```
  CRAFT AVAILABILITY                06:00  07:00  08:00  09:00  10:00
  ─────────────────────────────────────────────────────────────────
  PILOTS   demand                    ▁▃██████████▇▅▃▁
           supply (1 of 3)           ────────────────────────────
                                       ▲ SHORT BY 3 ▲
  TUGS     demand                    ▁▃██████████▇▅▃▁
           supply (4)                ────────────────────────────
                                       ▲ SHORT BY 8 ▲

  ⚠ 3 CONFLICTS
  ┌─────────────────────────────────────────────────────────────┐
  │ HIGH  PILOT shortage  29 Jul 06:15 – 09:00   short by 3     │
  │       MSC ANNA, EVER GIVEN, CMA CGM, MAERSK SEALAND         │
  │                                                              │
  │  RECOMMENDED FIX                                             │
  │  ▸ DELAY MAERSK SEALAND by 125 min                          │
  │    frees a pilot for the higher-priority movement            │
  │    closes 600 gap-minutes · creates no new conflict ✓        │
  │                                    [ Apply ]  [ Dismiss ]    │
  └─────────────────────────────────────────────────────────────┘
```

Rules:
- **Demand-vs-supply over time is the right chart.** A table of movements hides the fact that the
  problem is a 45-minute overlap.
- Every proposal must show `gap_closed_minutes` *and* `creates_new_conflict`. Never surface a
  proposal that creates a new conflict — the model already filters these, but don't undo that.
- When there are no conflicts, show a green all-clear with the reason ("no overlapping movements"),
  not an empty table.

---

# M8 — Reactive Confidence Chain

> **The question: the wind just picked up to 30 knots. What does that do to pilot boarding, the
> anchorage queue, turnaround time, and our overall confidence in today's plan — and which of
> today's problems is doing the most damage?**

## Why the port cares

M1–M7 each answer one question. M8 answers how they interact. Port disruptions cascade:

```
  wind rises → pilot boarding gets risky → pilotage capacity drops
             → transits held → channel throughput falls
             → anchorage queue grows → TAT increases
             → system confidence drops
```

Nobody can hold that chain in their head while a storm is happening. M8 computes it in milliseconds
and reports both the downstream effect *and* which upstream cause is responsible.

## The idea: a causal graph

Picture 23 boxes connected by 30 arrows. Each box is a quantity; each arrow means "this affects
that", with a strength and a direction (+ or −).

```
  WEATHER            MARINE                PLANNING           OUTCOME
  ───────            ──────                ────────           ───────
  wind ────────┐
  swell ───────┼──→ pilot boarding ──→ pilotage ──┐
  visibility ──┘        risk              hold     ├─→ channel ──→ anchorage ──→ TAT ──┐
                                                   │  throughput     queue      delay  │
  pilots ──────────→ pilotage capacity ────────────┘                                   ├─→ SYSTEM
  tugs ────────────→ tug capacity ─────────────────┘                                   │  CONFIDENCE
                                                                                        │
  tide ────────┐                                                                        │
  siltation ───┼──→ controlling ──→ DUKC ──→ deep-draft ──→ berth plan ─────────────────┘
  dredging ────┘       depth        net UKC    window       feasibility

  rain ────────────────────────────────────→ crane productivity ───────────────────────┘
```

**23 nodes, 30 edges.** Ten are **exogenous** — set from the outside world (wind, swell, visibility,
rain, tide, siltation, dredging, pilots, tugs, arrival demand). The other 13 are *computed*.

Every edge runs from a lower-numbered node to a higher-numbered one, which makes cycles impossible
by construction — no feedback loop can make the calculation spin forever.

## Inputs

Only the ten exogenous nodes can be set. Everything else is derived.

| From your file | Node | Baseline | What it represents |
|---|---|---|---|
| `Wind_Speed_kn` | `WX_WIND_KN` | 12 kn | Wind at the pilot boarding ground |
| `Rain_mm_hr` | `WX_RAIN_MMHR` | 0 mm/hr | Rain intensity |
| *(optional)* | `WX_SWELL_M` | 0.8 m | Wave height — affects pilot boarding |
| *(optional)* | `WX_VIS_KM` | 8 km | Visibility — fog stops transits |
| `Tide_Height_m` | `TIDE_HEIGHT_M` | 2.6 m | Tide |
| `Siltation_m` | `SILTATION_M` | 0.0 m | Depth lost |
| `Dredging_Delta_m` | `DREDGING_DELTA_M` | 0.0 m | Depth gained — **this is the lever** |
| `Pilot_Available` | `PILOT_AVAIL_N` | 3 | Pilots on duty |
| `Tug_Available` | `TUG_AVAIL_N` | 4 | Tugs on duty |
| *(computed)* | `ARRIVAL_DEMAND_N` | 6 | Ships arriving per 12 h |

Values equal to the baseline are not listed as disruptions — the disruption list stays honest about
what actually changed.

## What the model does, step by step

```
1. Normalise      convert each change to a comparable scale:
                  delta_norm = (value - baseline) / scale
2. Propagate      walk the graph in order; for each node:
                  delta_norm(node) = sum over incoming edges of
                                     (polarity x weight x delta_norm(source))
3. De-normalise   value = baseline + delta_norm x scale, then clamp to physical limits
4. Apply rules    10 operational rules can FLOOR or CAP a node (see below)
5. Attribute      trace each final change back to the exogenous causes that produced it
6. Log            emit one step per node -- all 23, every run
```

**Why normalise?** Wind is in knots (0–60), tide in metres (0.4–4.8), pilots in whole people (0–3).
Converting each to "fraction of its normal range" lets them be added meaningfully. A 6-knot wind
rise and a 0.5 m tide drop become comparable quantities.

**Step 6 is deliberate.** Logging only the nodes that *changed* is the easy path. Logging all 23
every time, including zero-change nodes, is what satisfies "every propagation step logged" under
audit — a reviewer can see that a node was considered and was unaffected, rather than wondering
whether it was skipped.

**The 10 workflow rules** — these are hard operational policies that override the smooth arithmetic:

| Rule | Trigger | Effect | Severity |
|---|---|---|---|
| R1 `WIND_PILOTAGE_HOLD` | wind ≥ 30 kn | Force pilotage hold to 0.90 | CRITICAL |
| R2 `FOG_TRANSIT_SUSPEND` | visibility < 1 km | Force hold to 0.80 | CRITICAL |
| R3 `SWELL_BOARDING_RESTRICT` | swell ≥ 2.5 m | Raise boarding risk to 0.70 | WARNING |
| R4 `DUKC_NO_GO` | net UKC < 0.6 m | Cap berth-plan feasibility at 0.30 | CRITICAL |
| R5 `DUKC_MARGINAL` | net UKC < 1.0 m | Advisory: reduce speed 2 kn | ADVISORY |
| R6 `PILOT_SHORTAGE` | ≤ 1 pilot | Cap pilotage capacity at 0.34 | WARNING |
| R7 `TUG_SHORTAGE` | ≤ 2 tugs | Cap tug capacity at 0.50 | WARNING |
| R8 `RAIN_CRANE_SLOWDOWN` | rain ≥ 15 mm/hr | Cap crane productivity at 0.75 | ADVISORY |
| R9 `QUEUE_ESCALATION` | queue ≥ 8 | Activate anchorage sequencing | WARNING |
| R10 `CONFIDENCE_ALERT` | confidence < 0.6 | ICCC major-incident standup | CRITICAL |

Each carries the actions to take and who to notify — so the UI can render a workflow, not just a
number.

**About the edge weights, stated plainly:** of the 30 edges, **4 are exact physics** (siltation and
dredging on depth; depth and tide on UKC), **1 is calibrated** against M2's own scanner (UKC →
deep-draft window, verified within 1.1% of the exact answer), and **25 are expert judgement**. They
are labelled `EXPERT_JUDGEMENT` in the output rather than hidden. If a reviewer asks "where did 0.45
come from?", the honest answer is available.

## Outputs

| Output field | Plain English | Show? |
|---|---|---|
| `System_Confidence` | 0–1: overall confidence in today's plan | **Yes — the headline gauge** |
| `Alert_Level` | NORMAL / WARNING / CRITICAL | **Yes — drives the colour** |
| `Confidence_Delta` | Change from baseline | **Yes — an arrow** |
| `Root_Cause_1/2/3` | The biggest culprits with % share | **Yes — the executive answer** |
| `TAT_Delay_h` | Extra hours added to turnaround | **Yes** |
| `Anchorage_Queue` | Predicted ships waiting | **Yes** |
| `DUKC_Net_UKC_m` | UKC **for the reference deep-draft ship** | **Yes — but read the caveat** |
| `Deep_Draft_Window_h` | Hours per cycle the channel takes deep ships | **Yes** |
| `Pilotage_Hold` | 0–1 severity of pilotage restriction | Yes |
| `Channel_Throughput_vph` | Ships per hour the channel can pass | Yes |
| `Berth_Plan_Feasibility` | 0–1: how workable the plan still is | Yes |
| `Crane_Productivity` | 0–1 relative crane speed | Yes |
| `Rules_Fired` / `Critical_Rules` | Which policies triggered | **Yes — with their actions** |
| `Disruptions` | What changed from baseline | **Yes** |
| `Propagation_Steps` | 23 | Audit view only |

> **Read `DUKC_Net_UKC_m` carefully — it is not the same quantity as M1's.** M8's DUKC node tracks a
> **reference deep-draft vessel (15.0 m draft at 10 kn)**, because M8's question is "is the port open
> to deep-draft traffic?", not "is this particular ship safe?". So M8 can report NO GO on a row whose
> own, shallower ship M1 calls comfortably SAFE. Both are correct. Label the M8 value **"reference
> ULCV"** in the UI or your users will report it as a bug.

## Real output from the sample file

| Vessel | Disruptions | UKC (ref) | Window | Queue | TAT delay | Confidence | Alert |
|---|---|---|---|---|---|---|---|
| HONG YONG | wind 8 kn, tide 4.30, dredging +0.40 | 3.052 m | 10.22 h | 0.00 | 0.00 h | **1.000** | NORMAL |
| KUO LUNG | wind 15 kn, rain 2, tide 1.26 | **−0.394 m** | 2.64 h | 0.79 | 0.72 h | **0.418** | **CRITICAL** |
| TSS AMBER | wind 22 kn, rain 8, tide 3.26, silt 0.40, 2 pilots | 1.207 m | 6.17 h | 0.37 | 0.00 h | **1.000** | NORMAL |

KUO LUNG's row is the model earning its place. Nothing about *that ship* is alarming — she is a
12.8 m feeder that M1 calls SAFE with 1.8 m to spare. But the tide on 15 July is 1.26 m, far below
the 2.6 m normal, and for a **15 m reference ULCV** that means UKC of −0.394 m: **the port is closed
to deep-draft traffic at that moment.**

Three rules fire: **R4** (DUKC NO GO → cap berth-plan feasibility at 0.30), **R5** (marginal
advisory), **R10** (confidence below 0.6 → ICCC standup). Confidence drops 0.95 → **0.418**.

And the attribution answers the executive's question directly: **`TIDE_HEIGHT_M 93%`**. Not the
wind, not the rain — 93% of the damage is the tide. The corresponding action is "wait six hours",
not "call out more pilots".

Compare TSS AMBER, where the causes are spread: siltation 42%, wind 24%, pilots 16% — a different
kind of day needing a different response.

## UI suggestion

**Screen: "Port Confidence" — the executive dashboard.**

```
┌───────────────────────────────────────────────────────────────┐
│   PORT CONFIDENCE                            15 Jul 01:20 IST  │
│                                                                 │
│              ╭───────────╮                                      │
│              │   0.42    │   ▼ 0.53 from baseline               │
│              │  CRITICAL │                                      │
│              ╰───────────╯                                      │
│         0 ▁▁▁▁▁█▁▁▁▁▁▁▁▁▁▁▁▁▁ 1                                │
│                                                                 │
│   WHY                                                           │
│     tide 1.26 m         ███████████████████  93 %              │
│     wind 15 kn          █                     5 %              │
│     rain 2 mm/hr        ▌                     1 %              │
│                                                                 │
│   IMPACT                                                        │
│     UKC (ref ULCV 15 m)   −0.39 m   ⛔ port closed to deep draft│
│     deep-draft window      2.64 h   ▼ from 10.2 h              │
│     anchorage queue        0.79     ▲                          │
│     TAT delay             +0.72 h   ▲                          │
│                                                                 │
│   ⛔ ACTIONS REQUIRED                                            │
│     R4  DUKC NO GO       → defer deep-draft transits            │
│                          → recompute tidal windows              │
│                            notify: Deputy Conservator, HM       │
│     R10 CONFIDENCE ALERT → ICCC major-incident standup          │
│                          → publish revised KPI                  │
│                            notify: Chairman, ICCC               │
│                                                                 │
│   ▸ Show all 23 propagation steps                               │
└───────────────────────────────────────────────────────────────┘
```

Rules:
- **A single gauge is the right hero widget.** One number an executive can glance at.
- **Root causes must be immediately below it.** "Confidence is 0.42" without "because the tide is
  out" is an anxiety generator, not information.
- **Render the rules as an action list with the notify targets.** Each fired rule carries
  `workflow_actions` and `notify` — this is the difference between a dashboard and an operations
  tool.
- Offer a **what-if** control. `POST /uc1/m8/propagate` accepts any exogenous values, so sliders for
  wind/tide/pilots/dredging let a planner explore "what if we dredge 0.5 m?" live. That is the most
  compelling demo in the whole system: the same storm, but the dredging lever visibly claws back
  confidence.
- Keep the 23-step propagation log behind a disclosure. Nobody reads it daily; an auditor will need
  it once and will need all of it.

---

# Part 9 — Cross-cutting UI rules

## 9.1 Flags — always surface these

Every prediction carries a `Flags` list. They are not decoration; each marks a specific way the
number could mislead.

| Flag | Meaning | How to show it |
|---|---|---|
| `TIDE_SYNTHETIC` | Tide was estimated, not measured | ⚠ next to any tide value |
| `QUEUE_DERIVED` | Queue estimated from occupancy % | ⚠ next to the queue |
| `WAIT_IS_LOWER_BOUND` | Not enough vessels to show real contention | Banner: "wait may be understated" |
| `ETD_RECONCILED` | Wait and TAT estimates disagreed; ETD adjusted | ⚠ on ETD with the explanation |
| `TIDE_MISS` | Berthed outside a tidal window | Red badge |
| `BERTH_SHIFT` | Not the requested berth | ⇄ badge with the original |
| `QUANTILE_CROSSING_CORRECTED` | p10/p50/p90 came out of order and were sorted | Small print |
| `CLAMPED_AT_MIN_TAT` | Prediction hit the floor | Small print |

## 9.2 Provenance — measured or estimated?

Every input records where its value came from. Show it. A user who cannot tell a measurement from an
estimate will eventually treat an estimate as a measurement, and that is how a model loses trust
permanently.

| Field | Values | Meaning |
|---|---|---|
| `tide_source` | `COLUMN_Tide_Height_m` / `SYNTHETIC_HARMONIC_v1` / `FIXED_x` | Measured vs modelled |
| `depth_source` | `COLUMN_Channel_Depth_m` / `DEFAULT_15.0m` | Surveyed vs assumed |
| `queue_source` | `COLUMN_Anchorage_Queue` / `DERIVED_FROM_OCCUPANCY` | Counted vs estimated |
| `speed_source` | `COLUMN_Speed_kn` / `DEFAULT_REACH_CAP` | Planned vs assumed |
| `Distance_Source` | `COLUMN_Distance_NM` / `DEFAULT` | Real vs the 240 NM default |

Suggested convention: **a small dotted underline plus a ⓘ tooltip** on any estimated value. Solid,
unmarked text means measured.

## 9.3 Money and simulated figures

`Bunker_Saved_USD` uses an assumed USD 600/tonne. Always render it with a "simulated" marker, in a
lighter weight than the physical quantities. Fuel tonnes and CO₂ tonnes follow from physics; the
rupee figure follows from a price assumption that will be wrong next week.

## 9.4 Units and time

- **All display times are IST.** Suffix them: `29 Jul 06:00 IST`. The underlying JSON is UTC — never
  mix them in one view.
- Metres to 2 dp, hours to 1–2 dp, knots to 1 dp, percentages to 1 dp.
- Show hours *and* days for TAT — operations think in hours, JNPA publishes in days.

## 9.5 Confidence bands

Three models emit a confidence label; use one visual language for all of them.

| Label | M3/M4 meaning | Suggested |
|---|---|---|
| HIGH | Band ≤ 8 h (M3) / σ ≤ 1.5 h (M4) | Green dot |
| MEDIUM | Band ≤ 16 h / σ ≤ 4.0 h | Amber dot |
| LOW | Wider | Red dot + "treat as indicative" |

## 9.6 Empty states

When a statistic cannot be computed — like M4's waiting time from the DSR source — render **the
reason**, not a zero. "Waiting time unavailable: this source records berthing but not arrival" is
useful. `0.0 h` is a wrong answer displayed confidently.

---

# Part 10 — Suggested screens

Mapping the eight models onto five screens rather than eight tabs:

| Screen | Models | Primary user | Hero widget |
|---|---|---|---|
| **1. Port Overview** | M8 + M4 summary | Executive / ICCC | Confidence gauge + root causes |
| **2. Vessel Forecast** | M3 + M4 bands | Terminal / planner | ATA → ETB → ETD timeline with driver chart |
| **3. Transit Safety** | M1 + M2 | Harbour master | UKC status card + tidal window timeline |
| **4. Berth Plan** | M5 + M4 occupancy | Berth planner | Gantt chart + cost panel |
| **5. Marine Control** | M7 + M6 | Marine control | Craft demand/supply timeline + JIT advisories |

**Screen 1 — Port Overview**

```
┌─ PORT CONFIDENCE ──────┐  ┌─ TODAY ────────────────────────────┐
│      ╭────────╮        │  │  vessels in port          7        │
│      │  0.42  │  ▼0.53 │  │  at anchorage             3        │
│      │CRITICAL│        │  │  berth occupancy       50.7 %      │
│      ╰────────╯        │  │  mean TAT              46.6 h      │
│  tide       ███ 93 %   │  │  deep-draft window      2.6 h ▼    │
│  wind       ▌    5 %   │  └────────────────────────────────────┘
│  rain       ▌    1 %   │  ┌─ ACTIONS ──────────────────────────┐
└────────────────────────┘  │ ⛔ R4  defer deep-draft transits   │
                             │ ⛔ R10 ICCC standup                │
┌─ ARRIVALS (next 24 h) ─────┴────────────────────────────────────┐
│  vessel        ETA         ETB         ETD         TAT    conf   │
│  TSS AMBER     05:18 ●     05:18       31 Jul 10:05  52.8 h ●HIGH│
│  KUO LUNG      01:00 ●     01:20       16 Jul 20:53  43.6 h ●MED │
└──────────────────────────────────────────────────────────────────┘
```

---

# Part 11 — Getting the data into your frontend

## 11.1 Files

```powershell
python run.py models --model all --input your_file.xlsx --out out/
```

`out/uc1_all_models.json`:

```jsonc
{
  "generated_at_utc": "2026-08-01T14:36:00Z",
  "input": { "rows_valid": 3, "rows_read": 3, "errors": 0, "warnings": 0 },
  "results": [
    {
      "model_id": "UC1-M1",
      "title": "DUKC / Real-Time Under-Keel Clearance",
      "scope": "per-row",
      "ok": true,
      "summary": { "safe": 3, "marginal": 0, "no_go": 0 },
      "columns": ["Row", "Vessel", "Draft_m", "..."],
      "rows":    [ { "Row": 2, "Vessel": "...", "Net_UKC_m": 4.852, "Status": "SAFE" } ],
      "details": { "C-0002": { "steps": [ ... ], "constants": { ... } } },
      "notes":   [ "Cb = 0.65 for container, ..." ]
    }
  ]
}
```

- `rows[]` → your tables and cards. Flat, display-ready.
- `details[call_id].steps[]` → the "how was this calculated" panel. Each step has a `label`,
  `formula`, `substitution` (the formula with real numbers *and* the result), `value` and `unit`, so
  you can render the breakdown **generically** without hard-coding any physics in the frontend.
- `summary` → KPI tiles. `notes` → the caveat strip.

`out/predictions.json` has the same shape for the ETB/TAT/ETD targets, with per-row
`breakdown.targets` giving the exact arithmetic for each of the three.

## 11.2 REST

```powershell
python run.py serve --reload
```

| Endpoint | Returns |
|---|---|
| `GET /health?deep=true` | Service status, all 8 modules, self-test results |
| `GET /uc1/manifest` | Every route and version — use this to discover the API |
| `GET /uc1/m1/constants` | The versioned parameter block (any model) |
| `GET /uc1/m1/demo` | A worked example — perfect for building UI against |
| `POST /uc1/m1/evaluate` | UKC for one vessel |
| `POST /uc1/m2/windows` | Tidal windows |
| `GET /uc1/m2/tide-curve` | 481 points for charting the tide |
| `POST /uc1/m3/predict` | TAT for one vessel |
| `POST /uc1/m4/eta-band` | ETA uncertainty |
| `POST /uc1/m5/optimise` | Berth plan |
| `POST /uc1/m6/advise` | JIT speed advice |
| `GET /uc1/m6/speed-sweep` | Speed-vs-fuel curve |
| `POST /uc1/m7/evaluate` | Craft allocation and conflicts |
| `POST /uc1/m8/propagate` | Run a disruption through the graph |
| `GET /uc1/m8/graph` | Nodes and edges for D3/Cytoscape |
| `GET /docs` | Interactive OpenAPI explorer |

Start with `GET /uc1/mN/demo` for every model — it returns a complete, realistic response so you can
build and style the UI before wiring the real inputs.

## 11.3 A sensible build order

1. **Screen 2 (Vessel Forecast)** — ETB/TAT/ETD is the headline deliverable and the driver chart is
   the most persuasive widget you will build.
2. **Screen 3 (Transit Safety)** — M1's step-by-step breakdown renders generically; high value for
   modest effort.
3. **Screen 1 (Port Overview)** — the confidence gauge with root causes. The executive demo.
4. **Screen 4 (Berth Plan)** — the Gantt is the most work; do it once the rest is proven.
5. **Screen 5 (Marine Control)** — needs the demand/supply timeline component.

---

# Part 12 — Glossary

| Term | Meaning |
|---|---|
| **AIS** | Automatic Identification System — the radio transponder broadcasting a ship's position |
| **Anchorage** | Designated area where ships wait at anchor before entering |
| **ATA / ATB / ATD** | Actual Time of Arrival / Berthing / Departure |
| **Ballast** | Water carried for stability when not fully loaded |
| **Berth** | One parking space for one ship at the quay |
| **Block coefficient (Cb)** | How boxy a hull is, 0–1. Container ≈ 0.65, bulk ≈ 0.80 |
| **Bollard pull** | A tug's pulling strength in tonnes |
| **Bow thruster** | Sideways propeller in the bow; a ship with one needs fewer tugs |
| **Bunker** | Ship's fuel |
| **Chart datum** | The low reference level charted depths are measured from |
| **Charted depth** | Depth printed on a nautical chart, above chart datum |
| **Conformal calibration** | Statistical method making an "80% band" genuinely cover 80% |
| **Controlling depth** | The shallowest depth along a route — the binding constraint |
| **Covariate shift** | When live conditions differ from the ones a model was trained on |
| **CP-SAT** | Google OR-Tools constraint solver, used for exact berth optimisation |
| **Data leakage** | Letting a model see the answer during training; looks accurate, isn't |
| **Draft** | How deep a ship sits in the water |
| **Dredging** | Excavating the seabed to deepen a channel |
| **DUKC** | Dynamic Under-Keel Clearance — UKC computed from live conditions |
| **ETA / ETB / ETD** | Estimated Time of Arrival / Berthing / Departure |
| **IMO** | International Maritime Organization; its CO₂ factor is 3.114 t per t of fuel |
| **IST** | Indian Standard Time, UTC+05:30, no daylight saving |
| **JIT arrival** | Sailing at the speed that arrives exactly when the berth is ready |
| **Keel** | The bottom of a ship's hull |
| **Knot (kn)** | One nautical mile per hour ≈ 1.85 km/h |
| **LOA** | Length Overall — a ship's total length |
| **MAE** | Mean Absolute Error — average size of a prediction's error |
| **Mooring** | Securing a ship to the quay with ropes |
| **Nautical mile (NM)** | 1,852 metres |
| **p10 / p50 / p90** | Percentiles: 10% of outcomes fall below p10, 50% below p50, 90% below p90 |
| **Pilot** | Local navigation expert who boards and directs the ship in |
| **Reach** | A named stretch of the channel with its own depth and speed limit |
| **Siltation** | Gradual accumulation of mud reducing channel depth |
| **Slow steaming** | Deliberately sailing slower to save fuel |
| **Squat** | Extra sinkage of a moving ship in shallow water |
| **TAT** | Turnaround Time — total time in port, ATA to ATD |
| **TEU** | Twenty-foot Equivalent Unit — one standard 20-ft container |
| **Terminal** | A company-operated section of the port with its own berths and cranes |
| **Tide** | Periodic rise and fall of sea level caused by the moon |
| **Tidal window** | A period when the tide is high enough for a given ship to transit |
| **Tug** | Powerful small boat that pushes and pulls large ships |
| **UKC** | Under-Keel Clearance — water between the keel and the seabed |
| **ULCV** | Ultra Large Container Vessel — ~400 m, 20,000+ TEU |
| **VTS** | Vessel Traffic Service — the port's marine traffic control |

---

## Where to go next

- **[RUNBOOK.md](RUNBOOK.md)** — every command, every flag, every input column
- **[README.md](../README.md)** — architecture, verified results, honest limitations
- `python run.py models --list` — the models and how to run them
- `GET /docs` — interactive API explorer once `python run.py serve` is running
