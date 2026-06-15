# KPI definitions & targets — JNPA VTMS

All formulas are implemented as pure functions in
[`src/kpi/formulas.ts`](../src/kpi/formulas.ts) and unit-tested in
[`src/kpi/formulas.test.ts`](../src/kpi/formulas.test.ts). Targets and
tolerances live in [`src/config/targets.ts`](../src/config/targets.ts) — the
single place to tune them.

Abbreviations: **ATA** actual time of arrival (at anchorage) · **ATB** actual
time berthed · **ATD** actual time of departure · **ETA** estimated time of
arrival · **TAT** turnaround time.

| KPI | Definition | Target | Better |
|-----|------------|--------|--------|
| **Pre-Berthing Delay** | `ATB − (ATA + standard pilotage lead)`, rolling mean; clamped ≥ 0 | 2 h | lower |
| **Pre-Sailing Delay** | `ATD − (cargo-complete + clearance)`, rolling mean; clamped ≥ 0 | 2 h | lower |
| **Average Vessel TAT** | `mean(ATD − ATA)` over completed calls | 24 h | lower |
| **Just-In-Time %** | arrivals with `|ATA − recommended slot| ≤ tolerance`, as % of arrivals | 80 % | higher |
| **Forecast / Prediction Accuracy** | `(1 − MAPE) × 100`, MAPE over **lead time** (`eta − reference`); 0 % if none resolved | 90 % | higher |
| **Berth Occupancy** | `occupied-berth-hours / (berths × window-hours)`, clipped to window, capped 100 % | 75 % | higher |
| **Anchored Vessels** | count where `NAV_STATUS = anchored` | 5 | lower |
| **Approaching Vessels** | count where `NAV_STATUS = approaching` | 8 | higher |

### Constants ([`src/config/targets.ts`](../src/config/targets.ts))

- `JIT_TOLERANCE_MIN = 60` — a vessel is "on time" within ±60 min of its slot.
- `STANDARD_PILOTAGE_LEAD_H = 1.5` — expected lead from anchorage to berth.
- `STANDARD_CLEARANCE_H = 2` — expected post-cargo clearance before sailing.

### Notes on the tricky ones

**Forecast accuracy uses *lead time*, not absolute timestamps.** MAPE over raw
epoch-ms ETA vs ATA would have a denominator in the trillions and read ~100 %
regardless of how good the prediction was. Instead we score the *remaining
time-to-arrival* (`eta − reference` vs `actual − reference`), which is the
quantity the operator actually predicts. If **no** predictions have resolved
(every actual still null), accuracy is reported as **0 %**, not the 100 % that
`(1 − empty-MAPE)` would otherwise yield — "no data" is not "perfect".

**Delays are clamped at 0.** A vessel that berths faster than the standard lead
isn't "negative delay"; it just met the standard.

**Berth occupancy clips intervals to the window** so an occupancy event that
straddles the window boundary only counts the hours inside it, and the result is
capped at 100 %.

### Result shape

Every headline KPI is returned as a `KpiValue`
([`src/types/kpi.ts`](../src/types/kpi.ts)):

```ts
{ key, label, value, unit, target, deltaPct, trend: TrendPoint[] }
```

`deltaPct = (value − target) / target × 100`. The KPI card decides whether a
positive delta is good using the target's `lowerIsBetter` flag, and colours the
▲/▼ accordingly. `trend` feeds the per-card sparkline and is sourced from the
persisted `KPISnapshots` layer (or its mock equivalent).

### What-If (stub)

[`computeWhatIf`](../src/data/MockAdapter.ts) recomputes JIT % and avg TAT under
a hypothetical delay / berth shift / weather severity using a transparent linear
model: each hour of injected delay nudges arrivals out of the JIT window and
adds to dwell, scaled by `1 + weatherSeverity`. It's intentionally simple — the
live adapter can replace it with a real recompute over the feature data without
changing the UI.
