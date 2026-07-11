# Competitive Parity — UC-1 Vessel Traffic Management & Optimisation

Honest self-assessment against the recognised global category leaders. For every capability we state **what we match**, **what we simplify**, and **what production adds**. We never claim parity we do not have; we do claim the parity we build. Every quantitative output in the app is a **simulated result under stated assumptions** (see `src/config/assumptions.ts`), never a JNPA baseline.

Benchmarks: OMC International **DUKC** (dynamic under-keel clearance), **Portchain**-class berth optimisers, **PortXchange** / the IMO-GIA **Just-In-Time** arrival concept, **Awake.AI**-class ML ETA, **Wärtsilä Navi-Port**-class ship-shore data exchange.

---

## C-1 — JIT arrival orchestration (vs PortXchange / IMO-GIA)

| | |
|---|---|
| **Match** | Per-inbound **recommended RTA** = max(berth-ready, tidal/DUKC go-window). "Steam slower, arrive just in time" advisory with a recommended speed, and **simulated** bunker + CO₂ + cost saved from slowing. Engine: `src/planning/jit.ts` (tested). Surfaced in the Analytics & JIT tab. |
| **Simplify** | Bunker/emission factors are nominal constants (IMO 3.114 t CO₂/t fuel, cube-law speed→fuel). Single-leg passage; RTA from a simulated berth-ready offset, not a live berth-release feed. No per-vessel RTA negotiation loop. |
| **Production adds** | Live berth-release + pilot/tug schedule feeds; vessel-specific fuel curves from the operator or class data; a two-way RTA message exchange (S-211 / port-call message standard); an RTA update log per vessel call. |

## C-2 — DUKC-class computation (vs OMC DUKC)

| | |
|---|---|
| **Match** | UKC = charted depth + tide − draft − squat − safety margin, computed from first principles with a **stated Barrass-style squat** (`Cb·V²/100`); per-segment (worst-controlling-depth) evaluation; go/no-go **tidal windows** walked over the tide curve; predictive **DUKC** vs live **RTUKC** as distinct features. Engine: `src/dukc/ukc.ts` (tested). |
| **Simplify** | Single squat formula (no proprietary multi-parameter model); analytic tide model, not a live gauge; static bathymetry; **sensitivity sweep (draft ±0.2 m / tide ±0.1 m) is documented but not yet a UI control**. |
| **Production adds** | A certified UKC service and a live hydrographic-survey / tide-gauge feed; motion (heave/pitch/roll) response; a full sensitivity + confidence surface. This is explicitly a decision-support approximation, not a certified UKC authority. |

## C-3 — Berth-planning optimisation (vs Portchain)

| | |
|---|---|
| **Match** | One-click **"Optimise"** proposes a **conflict-free** berth plan under an **explainable objective**: minimise `w_wait·Σwait + w_tide·(tide-window misses) + w_shift·(moves)`, with the objective + breakdown shown. Length/draft-compatible berth selection, go-window alignment. Decision support — a planner accepts/edits; not a black box. Engine: `src/planning/optimiser.ts` (tested). |
| **Simplify** | Transparent **greedy** heuristic (earliest-feasible-berth), not a global MILP; fixed weights; no shifting-cost of already-berthed vessels beyond the move counter. |
| **Production adds** | A proper solver (MILP/CP) with tunable weights, multi-objective trade-off surface, crane/yard-side constraints, and rolling re-optimisation as the plan changes. |

## C-4 — ML ETA with uncertainty (vs Awake.AI)

| | |
|---|---|
| **Match** | ETA as a **distribution** (p10/p50/p90) whose band **widens with the forecast horizon and with AIS staleness** (degradation behaviour), plus the living prediction-vs-actual **convergence** view with rolling MAE/MAPE. Engine: `src/kpi/analytics.ts` `etaDistribution()` + `PredictionConvergence.tsx` (tested). |
| **Simplify** | Uncertainty is a **parametric model** (band ∝ horizon + staleness), not a trained probabilistic ML model; no learned features (weather, congestion). No published model card yet. |
| **Production adds** | A trained ETA model on historical AIS + port-call data, quantile regression, feature attributions, and a model card (data, metrics, limitations, refresh cadence). |

## C-5 — Port-call timestamp discipline (vs Wärtsilä Navi-Port)

| | |
|---|---|
| **Match** | The domain model carries planned/actual berth events (ATB/ATD-equivalents) and ETA; KPIs are computed from them. |
| **Simplify** | A 4-event skeleton (planned/actual start/end + ETA). The **full port-call vocabulary** (pilot on board / first line / all fast / last line / pilot off) and a per-vessel timestamp **ladder UI** are **not yet built** — noted as a gap. |
| **Production adds** | Adoption of the standard port-call event set so JNPA data maps 1:1, an event ladder per call, and RTA/ATA as first-class distinct timestamps. |

## C-6 — Resource orchestration (pilots/tugs/mooring)

| | |
|---|---|
| **Match** | Pilots/tugs/mooring as **finite resources** with utilisation, **conflict detection** (a unit double-booked across overlapping vessel windows) and a swap recommendation. `PortCraftBoard.tsx` + `src/planning/constraints.ts` `detectPilotDoubleBooking` (tested). |
| **Simplify** | Snapshot/heuristic detection on the current roster; not a fully time-phased finite-slot scheduler; single swap suggestion. |
| **Production adds** | A resource calendar with time-phased bookings, shift rosters, qualifications, and automated multi-resource conflict resolution. |

## C-7 — Historical analytics

| | |
|---|---|
| **Match** | **Berth-occupancy heat calendar** (per berth × day), **waiting-time distribution** (histogram + p50/p90), **terminal-wise mean TAT** comparison. Engine: `src/kpi/analytics.ts` (tested); Analytics & JIT tab. |
| **Simplify** | Computed over the current plan horizon (mock), not a 90-day warehouse; no drill-through to individual calls yet. |
| **Production adds** | A time-series store with 90-day retention, p95 query budgets proven by EXPLAIN, and configurable weekly/monthly review dashboards. |

---

## Summary

| Capability | Verdict |
|---|---|
| C-1 JIT/RTA | **Honest equivalent built** (simulated savings) |
| C-2 DUKC | **Strong equivalent** (sensitivity sweep pending) |
| C-3 Berth optimiser | **Honest equivalent built** (greedy, explainable) |
| C-4 ETA uncertainty | **Equivalent built** (parametric, not trained ML) |
| C-5 Timestamp discipline | **Partial** — full vocabulary + ladder pending |
| C-6 Resource orchestration | **Equivalent built** (snapshot, not time-phased) |
| C-7 Historical analytics | **Honest equivalent built** (mock horizon) |

Nothing above is claimed as certified or production-grade where it is a decision-support approximation; each "production adds" row is the honest gap a live deployment closes.
