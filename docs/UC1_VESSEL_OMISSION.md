# UC-1 What-If — Vessel Omission (line skips JNPA for schedule recovery)

## What it does

An authorised user simulates a shipping line **omitting a vessel's JNPA port
call** to evaluate how much schedule time the service recovers and what the
omission does downstream. It is a **hypothesis, not an action**: the
operational berthing plan, schedules, events and notifications are untouched.

## How to run it

1. Open the **What-If** tab on the dashboard.
2. In the **"Vessel omission — line skips JNPA"** section, select a vessel
   (the list is every vessel with a JNPA call in the ±48 h berthing-plan
   window).
3. The vessel's call sequence is shown. Previous/next port are labelled *not
   in the JNPA feed* — the system holds no port-rotation data and does not
   invent any.
4. If the vessel has more than one JNPA call in the window, select the
   specific call — the engine refuses to pick one arbitrarily.
5. Press **"Omit JNPA call — simulate"**.
6. Read: the one-sentence verdict, the Original / Simulated / Impact
   comparison table, the downstream impact, and (collapsed) the working —
   method, input provenance, unavailable inputs, data reads, and the audit
   line.

## API / engine

There is no UC-1 backend: like the rest of this dashboard, the answer is
computed client-side over `DataAdapter` reads (mock or live — the UI's only
data path). The engine is a **pure function**:

```ts
import { simulateVesselOmission } from '@/whatif/vesselOmission';

const outcome = simulateVesselOmission(plan /* BerthingPlanEntry[] */, {
  mmsi: '419000123',     // vessel id — the key the berthing plan uses
  planId: 'PLAN-1000',   // the JNPA call; optional when the vessel has exactly one
  now: Date.now(),       // evaluation instant (kept as an input for determinism)
  downstreamHorizonH: 48 // optional; default 48 h, same horizon as Notice I-B
});
// outcome.kind === 'result' → VesselOmissionResult
// outcome.kind === 'error'  → { code, message, candidates? }
```

The result reuses the shared engine envelope (`figures`, `assumptions` with
MEASURED / DERIVED / PARAMETER provenance, `queries`, `data_available`,
`notes`) from `engineClient.ts`, plus typed `original` / `simulated` /
`downstream` schedule blocks and an `unavailable` list.

Error codes: `NO_JNPA_CALL`, `CALL_NOT_FOUND`, `AMBIGUOUS_CALL`,
`ALREADY_CANCELLED`.

## Calculation

All times are epoch ms (displayed in IST via the shared format helpers).

- **Pass-by** (simulated) — when the vessel would proceed past JNPA instead of
  calling: the **earlier of planned and actual berthing start**. Declared
  DERIVED: the true anchorage arrival time is not recorded, so this is the
  conservative lower bound.
- **Original departure** — ATD when it exists, else the planned end
  (MEASURED; `END_ESTIMATED` is surfaced as a note when the feed defaulted it).
- **Recovered time** = original departure − pass-by, floored at 0. Zero is a
  legitimate result.
- **Schedule deviation** — before: ATD vs plan (or ATB vs plan when the call
  has not departed; stated). After: before − recovered.
- **Downstream** — two parts:
  - *Beyond JNPA:* reported **only as a shift** (next-port ETA advances by the
    recovered time). Absolute downstream ETAs are not restated because no
    port-rotation data exists in this system.
  - *At JNPA:* the freed berth window is compared with later calls at the same
    berth inside the horizon; the next call's potential advance is bounded by
    `min(recovered, its planned start − freed start)` — an upper bound from
    berth availability alone, declared as such.

## Assumptions (each declared in the result)

- Pass-by uses the earlier of planned/actual berthing start (anchorage arrival
  not recorded).
- Next-call advance is a berth-availability upper bound; that vessel's own
  readiness is unknown.
- Downstream horizon 48 h (PARAMETER, caller-overridable).

## Limitations / unavailable data (reported, never fabricated)

- **No port rotation**: previous/next port identity and downstream ETAs are
  not in any feed this system reads — downstream impact is a delta, not
  absolute times.
- **No voyage number** in the adapter data (calls are keyed PLAN_ID, vessels
  MMSI).
- Entries missing a usable window return `recoveredH: null` with
  `data_available: false` and the missing inputs listed in `unavailable`.

## Non-destructive guarantee

`simulateVesselOmission` reads its inputs and returns a value: no store write,
no network call, no BroadcastChannel, no storage write, no event. Covered by
tests (frozen-input and publish-nothing tests).

## Tests

`src/whatif/vesselOmission.test.ts` — 14 tests covering the UC-1 matrix:
valid run; omitted-in-result-only; operational plan unchanged (frozen input);
recovered-time arithmetic; downstream recalculation + horizon bound; vessel
without JNPA call; invalid call id; already-cancelled call; missing schedule
input → no fabricated result; multiple JNPA calls (refusal + explicit
selection); publishes nothing; zero recovery; selection-helper ordering.
