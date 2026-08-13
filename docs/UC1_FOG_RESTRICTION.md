# UC-1 What-If — Fog / Night Navigation Restriction (visibility below 1 km)

## What it does

Simulates the schedule impact when vessel navigation at JNPA is restricted
because **visibility falls strictly below 1 km**. A **hypothesis, not an
action**: the operational berthing plan, ETAs/ETDs, events and notifications
are untouched. Same architecture as the vessel-omission scenario — a pure
engine over `DataAdapter` reads, presented with the audited-answer components.

## The threshold (exact)

```
restriction ACTIVE  ⇔  visibility < 1 km   (strictly less than)
```

- 0.5 km / 0.8 km / 0.99 km → **ACTIVE**
- 1.0 km exactly → **not** triggered
- 2.0 km → no restriction

Visibility in this system is measured in **nautical miles**
(`WeatherReading.visibilityNm` via `DataAdapter.getWeather()`); the reading is
converted at 1 NM = 1.852 km and compared unrounded, so the strict rule is
exact. The existing pilot-transfer minimum (~1 NM, `derive.ts`) is a separate
rule and is not used.

## Night condition

**Not evaluable.** No sunrise/sunset times or day/night flag exist anywhere in
this application or its feeds. Every result reports `night_condition` in its
"Not calculable from the data" section; the scenario evaluates the fog
(visibility) rule only, and says so in the UI.

## How to run it

1. Open the **What-If** tab.
2. In **"Fog / night navigation restriction — visibility below 1 km"**:
   the current visibility (adapter reading, sim-lever-aware) and the live
   restriction verdict are shown at the top.
3. **Visibility input** — keep the measured reading, or pick a declared
   hypothetical value (the ticket's own test points: 0.3 / 0.5 / 0.8 / 0.99 /
   1.0 / 1.5 / 2.0 km). Hypotheticals are chipped "you set this".
4. **Expected restriction duration** — pick a duration, or leave "Not known",
   in which case the restriction status is reported and the schedule impact is
   honestly *not calculable* (no feed carries a visibility forecast and no
   configured rule maps visibility to a hold length).
5. Select the vessel (and the specific call when there are several — the
   engine refuses to guess).
6. **Simulate** → verdict sentence, Original/Simulated/Impact table
   (visibility, navigation, ETA, ETD, deviation, downstream), and the
   collapsed working (method, provenance, unavailable inputs, data reads,
   audit line).

## Engine

```ts
import { simulateFogRestriction, evaluateVisibility } from '@/whatif/fogRestriction';

const outcome = simulateFogRestriction(plan, weather, {
  mmsi: '419998001',
  planId: 'PLAN-1006',        // optional when the vessel has exactly one call
  now: Date.now(),
  visibilityOverrideKm: 0.5,  // optional PARAMETER; absent → measured reading
  holdDurationH: 4,           // optional PARAMETER; absent → impact not calculable
  downstreamHorizonH: 48,     // optional; default 48
});
```

Errors: `NO_JNPA_CALL`, `CALL_NOT_FOUND`, `AMBIGUOUS_CALL`, `CALL_CANCELLED`.

## Impact model (when restriction is active and a duration is set)

Reuses the twin's existing weather-hold rule (M1/M6, `applyPlanLevers`):

- **Not yet berthed** → the whole call shifts: ETA and ETD both move by the
  hold; the turn is preserved.
- **Alongside** → the vessel cannot sail during a movement suspension: only
  the departure moves.
- **Departed** → a restriction now does not move a departed vessel: impact 0
  (zero is a result, not an error).

Deviation after = deviation before + delay. Downstream: the delayed departure
is compared with the next call at the same berth; the overrun into its planned
window is reported as an upper-bound knock-on (DERIVED — that vessel's own
readiness, and whether the fog holds it too, are unknown).

## Provenance

- **MEASURED** — the weather reading's visibility (with the NM value shown).
- **PARAMETER** — hypothetical visibility, restriction duration, the 1 km
  threshold, the downstream horizon.
- **DERIVED** — the NM→km conversion, the impact model, the knock-on bound.
- **Unavailable** — night condition (always), visibility when no reading
  exists, restriction duration when not set, missing plan times.

## Tests

`src/whatif/fogRestriction.test.ts` — 21 tests: the strict threshold at 0.5 /
0.8 / 0.99 / 1.0 / 2.0 km; measured NM→km conversion both sides of the rule;
visibility unavailable; night always reported unavailable; duration-unknown
honesty; per-state delay arithmetic (scheduled / alongside / departed);
downstream knock-on; frozen-input immutability; repeat-run non-accumulation;
publish-nothing; and the selection validation matrix.
