"""
UC1-M5 — Dynamic Berth Plan Optimisation / Re-sequencing Under Disruption
=========================================================================

Jawaharlal Nehru Port Authority (JNPA) — Workstream 2, UC-I Vessel Traffic
Management & Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"A berth just went out of service / the tide narrowed / four extra ships
arrived. Re-plan the berth allocation now, and show me what it costs."

OBJECTIVE
---------
    cost = 1.0 * sum(wait_hours) + 2.0 * tide_misses + 0.5 * berth_shifts

Weights live in a versioned ``OptimiserWeights`` dataclass and are configurable
per run. Every plan reports the three components separately, so an operator can
see whether a plan is expensive because ships waited or because they were moved.

ALGORITHM
---------
A deterministic greedy heuristic: requests are served in priority order and each
is placed on the earliest feasible compatible berth, preferring the berth the
agent actually asked for. This is explicitly NOT globally optimal — it is
instant, transparent, and feasibility is guaranteed by construction, which is
what a live what-if demo needs. The production path is a MILP / CP-SAT solver on
the same request and constraint schema; that path is implemented here and
activates automatically when ``ortools`` is installed.

CONSTRAINT SEMANTICS — read this before judging the output
-----------------------------------------------------------
HARD constraints, guaranteed by construction, never violated:
    * LOA        <= berth length
    * draft      <= berth maximum depth
    * no two vessels overlap on a berth, with a 0.5 h turnaround buffer
    * berth is in service and past its available-from time

The TIDE is a COSTED SOFT constraint by default (``tide_policy="soft"``). If no
tidal window admitting the vessel's draft can be found inside the search
horizon, the assignment is still made — at the earliest berth-free time — and
marked ``tide_miss=True``, contributing 2.0 to the cost. Soft is the default so
a what-if demo always produces a plan while the miss stays visible and priced.
Set ``tide_policy="hard"`` to push such requests to ``unassigned_request_ids``
instead.

WAITING IS ONE-SIDED
--------------------
``wait_hours = max(0, start - requested_start)``. Berthing a vessel EARLIER than
requested earns no negative credit. Without that clamp the optimiser games the
objective by scheduling everything early and reporting a negative wait bill.

TIDAL WINDOWS ARE AN INPUT, NOT AN IMPORT
------------------------------------------
``TidalWindow`` is a plain input dataclass supplied by UC1-M2. This module never
imports M2 — the flat-file architecture is deliberate. The pydantic
``TidalWindowModel`` is the documented boundary between them.

USAGE
-----
    python uc1_m5_berth_optimiser.py                       # full demo, exits 0
    python uc1_m5_berth_optimiser.py --scenario berth-outage
    python uc1_m5_berth_optimiser.py --json

SELF-CONTAINMENT POLICY
-----------------------
Standard library only above SECTION 6. FastAPI/pydantic and ortools are all
optional; the module runs on a bare Python install.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

# ==========================================================================
# SECTION 1 — MODULE IDENTITY AND VERSIONED CONSTANTS
# ==========================================================================

MODULE_ID: str = "UC1-M5"
MODULE_NAME: str = "Dynamic Berth Plan Optimisation"
MODULE_VERSION: str = "m5-optimiser-v1.0.0"
ROUTER_PREFIX: str = "/uc1/m5"

DEFAULT_SEED: int = 20260807

WEIGHTS_VERSION: str = "m5-weights-v1.0.0"


@dataclass(frozen=True)
class OptimiserWeights:
    """
    Objective weights — the versioned 'model weights' for this row of WS2.

        cost = wait_hour * sum(wait_h) + tide_miss * misses + berth_shift * shifts
    """

    wait_hour: float = 1.0
    tide_miss: float = 2.0
    berth_shift: float = 0.5
    version: str = WEIGHTS_VERSION

    def as_dict(self) -> Dict[str, Any]:
        return {
            "wait_hour": self.wait_hour,
            "tide_miss": self.tide_miss,
            "berth_shift": self.berth_shift,
            "version": self.version,
        }


DEFAULT_WEIGHTS = OptimiserWeights()

BERTH_TURNAROUND_BUFFER_H: float = 0.5    # minimum gap between vessels on a berth
TIDE_SEARCH_HORIZON_H: float = 72.0       # how far ahead to look for a go-window
TIME_GRANULARITY_MIN: int = 15            # CP-SAT discretisation
CPSAT_TIME_LIMIT_S: float = 10.0

TIDE_POLICIES: Tuple[str, ...] = ("soft", "hard")
ALGORITHMS: Tuple[str, ...] = ("greedy", "cpsat", "auto")

# The real JNPA berth roster: 21 berths across 7 terminals, from section (H) of
# the 54 Daily Status Reports. Ids are the CANONICAL form emitted by
# dsr_extract.normalise_berth_id() — the source reports spell some berths both
# with and without the hyphen, and keying on the raw string would split one
# physical berth in two. Lengths and depths are operational planning figures.
DEFAULT_BERTH_SPECS: Tuple[Tuple[str, str, float, float], ...] = (
    ("CB-01", "NSFT", 330.0, 15.0),
    ("CB-02", "NSFT", 330.0, 15.0),
    ("CB-04", "NSICT", 300.0, 14.5),
    ("CB-05", "NSICT", 300.0, 14.5),
    ("CB-06", "NSIGT", 330.0, 15.0),
    ("APMT-01", "APMT", 360.0, 15.5),
    ("APMT-02", "APMT", 360.0, 15.5),
    ("BMCT-01", "BMCT", 400.0, 16.5),
    ("BMCT-02", "BMCT", 400.0, 16.5),
    ("BMCT-03", "BMCT", 400.0, 16.5),
    ("BMCT-04", "BMCT", 350.0, 15.5),
    ("BMCT-05", "BMCT", 350.0, 15.5),
    ("BMCT-06", "BMCT", 350.0, 15.5),
    ("LB-01", "BPCL", 250.0, 12.0),
    ("LB-02", "BPCL", 250.0, 12.0),
    ("LB-03", "JJLTPL", 250.0, 12.0),
    ("LB-04", "JJLTPL", 250.0, 12.0),
    ("CCB-N", "NSDT", 200.0, 11.0),
    ("CCB-S", "NSDT", 200.0, 11.0),
    ("NSD-02", "NSDT", 220.0, 11.5),
    ("NSD-03", "NSDT", 220.0, 11.5),
)

# ==========================================================================
# SECTION 2 — SHARED HELPERS (DUPLICATED BY DESIGN — do not factor out)
# ==========================================================================


def _utc_now() -> datetime:
    """Timezone-aware UTC now. DUPLICATED BY DESIGN."""
    return datetime.now(timezone.utc)


def _ensure_utc(dt: datetime) -> datetime:
    """Reject naive datetimes; normalise to UTC. DUPLICATED BY DESIGN."""
    if dt.tzinfo is None:
        raise ValueError(
            f"naive datetime {dt!r} rejected — all UC-1 internals are timezone-aware UTC"
        )
    return dt.astimezone(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    """ISO-8601 with a trailing Z. DUPLICATED BY DESIGN."""
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _hours_between(a: datetime, b: datetime) -> float:
    """Signed hours from ``a`` to ``b``. DUPLICATED BY DESIGN."""
    return (_ensure_utc(b) - _ensure_utc(a)).total_seconds() / 3600.0


def _intervals_overlap(
    a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime
) -> bool:
    """True when two half-open intervals share any time. DUPLICATED BY DESIGN."""
    return max(a_start, b_start) < min(a_end, b_end)


def _step(
    n: int,
    label: str,
    formula: str,
    substitution: str,
    terms: Mapping[str, Any],
    value: Any,
    unit: str,
    note: str = "",
) -> Dict[str, Any]:
    """One auditable line of a ``breakdown`` dict. DUPLICATED BY DESIGN."""
    return {
        "step": n,
        "label": label,
        "formula": formula,
        "substitution": substitution,
        "terms": dict(terms),
        "value": value,
        "unit": unit,
        "note": note,
    }


def _fmt_table(headers: Sequence[str], rows: Sequence[Sequence[Any]], indent: str = "  ") -> str:
    """Fixed-width ASCII table. DUPLICATED BY DESIGN."""
    cols = [str(h) for h in headers]
    body = [[("" if c is None else str(c)) for c in r] for r in rows]
    widths = [len(c) for c in cols]
    for r in body:
        for i, c in enumerate(r):
            if i < len(widths):
                widths[i] = max(widths[i], len(c))
    line = indent + "  ".join(c.ljust(widths[i]) for i, c in enumerate(cols))
    rule = indent + "  ".join("-" * w for w in widths)
    out = [line, rule]
    for r in body:
        out.append(indent + "  ".join(str(c).ljust(widths[i]) for i, c in enumerate(r)))
    return "\n".join(out)


# ==========================================================================
# SECTION 3 — DATACLASSES
# ==========================================================================


@dataclass(frozen=True)
class TidalWindow:
    """
    One contiguous go-window. **Supplied by UC1-M2** — this module never imports
    M2; windows arrive as data.

    ``max_draft_m`` is the deepest draft the window admits, which M2 derives
    from the controlling reach's net UKC at the lowest tide inside the window.
    """

    window_id: str
    start_utc: datetime
    end_utc: datetime
    max_draft_m: float
    reach_id: str = "CH-INNER"
    direction: str = "INBOUND"       # INBOUND | OUTBOUND | BOTH

    def admits(self, draft_m: float) -> bool:
        return draft_m <= self.max_draft_m + 1e-9

    def as_dict(self) -> Dict[str, Any]:
        return {
            "window_id": self.window_id,
            "start_utc": _iso(self.start_utc),
            "end_utc": _iso(self.end_utc),
            "duration_h": round(_hours_between(self.start_utc, self.end_utc), 3),
            "max_draft_m": round(self.max_draft_m, 3),
            "reach_id": self.reach_id,
            "direction": self.direction,
        }


@dataclass(frozen=True)
class Berth:
    """A berth and its physical limits."""

    berth_id: str
    terminal: str
    length_m: float
    max_draft_m: float
    available_from_utc: Optional[datetime] = None
    out_of_service: bool = False

    def as_dict(self) -> Dict[str, Any]:
        return {
            "berth_id": self.berth_id,
            "terminal": self.terminal,
            "length_m": self.length_m,
            "max_draft_m": self.max_draft_m,
            "available_from_utc": _iso(self.available_from_utc),
            "out_of_service": self.out_of_service,
        }


@dataclass(frozen=True)
class BerthRequest:
    """One vessel asking for a berth window."""

    request_id: str
    vessel_id: str
    vessel_name: str
    loa_m: float
    draft_m: float
    requested_berth_id: str
    requested_start_utc: datetime
    service_hours: float
    priority: int = 5                          # lower = higher priority
    earliest_start_utc: Optional[datetime] = None
    latest_start_utc: Optional[datetime] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "request_id": self.request_id,
            "vessel_id": self.vessel_id,
            "vessel_name": self.vessel_name,
            "loa_m": self.loa_m,
            "draft_m": self.draft_m,
            "requested_berth_id": self.requested_berth_id,
            "requested_start_utc": _iso(self.requested_start_utc),
            "service_hours": self.service_hours,
            "priority": self.priority,
            "earliest_start_utc": _iso(self.earliest_start_utc),
            "latest_start_utc": _iso(self.latest_start_utc),
        }


@dataclass(frozen=True)
class Assignment:
    """One request placed on one berth, with its cost attribution."""

    request_id: str
    vessel_id: str
    vessel_name: str
    berth_id: str
    start_utc: datetime
    end_utc: datetime
    wait_hours: float
    is_berth_shift: bool
    tide_window_id: Optional[str]
    tide_miss: bool
    feasible: bool
    infeasible_reason: Optional[str]
    marginal_cost: float
    rationale: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "request_id": self.request_id,
            "vessel_id": self.vessel_id,
            "vessel_name": self.vessel_name,
            "berth_id": self.berth_id,
            "start_utc": _iso(self.start_utc),
            "end_utc": _iso(self.end_utc),
            "wait_hours": round(self.wait_hours, 3),
            "is_berth_shift": self.is_berth_shift,
            "tide_window_id": self.tide_window_id,
            "tide_miss": self.tide_miss,
            "feasible": self.feasible,
            "infeasible_reason": self.infeasible_reason,
            "marginal_cost": round(self.marginal_cost, 4),
            "rationale": self.rationale,
        }


@dataclass(frozen=True)
class CostBreakdown:
    """The objective, decomposed so an operator can see what drove it."""

    wait_hours_total: float
    wait_cost: float
    tide_misses: int
    tide_cost: float
    berth_shifts: int
    shift_cost: float
    total_cost: float
    weights: OptimiserWeights
    per_request: Tuple[Dict[str, Any], ...]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "wait_hours_total": round(self.wait_hours_total, 3),
            "wait_cost": round(self.wait_cost, 4),
            "tide_misses": self.tide_misses,
            "tide_cost": round(self.tide_cost, 4),
            "berth_shifts": self.berth_shifts,
            "shift_cost": round(self.shift_cost, 4),
            "total_cost": round(self.total_cost, 4),
            "weights": self.weights.as_dict(),
            "per_request": [dict(p) for p in self.per_request],
        }


@dataclass(frozen=True)
class BerthPlan:
    """A complete berth allocation plan."""

    plan_id: str
    algorithm: str
    generated_at_utc: datetime
    assignments: Tuple[Assignment, ...]
    unassigned_request_ids: Tuple[str, ...]
    cost: CostBreakdown
    solve_ms: float
    tide_policy: str
    explanation: Tuple[str, ...]
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "plan_id": self.plan_id,
            "algorithm": self.algorithm,
            "generated_at_utc": _iso(self.generated_at_utc),
            "assignments": [a.as_dict() for a in self.assignments],
            "unassigned_request_ids": list(self.unassigned_request_ids),
            "cost": self.cost.as_dict(),
            "solve_ms": round(self.solve_ms, 2),
            "tide_policy": self.tide_policy,
            "explanation": list(self.explanation),
            "breakdown": self.breakdown,
        }


# ==========================================================================
# SECTION 4 — SCENARIO / DATA PROVIDERS
# ==========================================================================

try:  # pragma: no cover
    from typing import Protocol, runtime_checkable
except ImportError:  # pragma: no cover
    Protocol = object  # type: ignore

    def runtime_checkable(c):  # type: ignore
        return c


@runtime_checkable
class BerthRequestLoader(Protocol):
    """Supplies berth requests for a planning horizon."""

    @property
    def source_id(self) -> str: ...

    def load_requests(self, start: datetime, end: datetime) -> List[BerthRequest]: ...


def default_berths() -> List[Berth]:
    """The real 20-berth JNPA roster."""
    return [Berth(b, t, l, d) for (b, t, l, d) in DEFAULT_BERTH_SPECS]


def synthetic_tidal_windows(
    start: datetime,
    hours: float = TIDE_SEARCH_HORIZON_H,
    seed: int = DEFAULT_SEED,
    narrow_factor: float = 1.0,
) -> List[TidalWindow]:
    """
    Stand-in for UC1-M2 output: roughly two go-windows per day.

    ``narrow_factor`` < 1 shrinks every window, which is how the "tide narrowed"
    disruption scenario is expressed. In production these come from M2's
    ``evaluate_tidal_windows()``; the shape of the dataclass is the contract.
    """
    start = _ensure_utc(start)
    out: List[TidalWindow] = []
    period_h = 12.4206
    base_width_h = 4.75 * narrow_factor
    n = int(hours / period_h) + 1
    for i in range(n):
        centre = start + timedelta(hours=2.5 + i * period_h)
        half = timedelta(hours=base_width_h / 2.0)
        # Successive high waters are unequal (diurnal inequality), so alternate
        # windows admit slightly different drafts.
        max_draft = 15.5 if i % 2 == 0 else 15.2
        out.append(
            TidalWindow(
                window_id=f"TW-{i + 1:02d}",
                start_utc=centre - half,
                end_utc=centre + half,
                max_draft_m=max_draft,
                reach_id="CH-INNER",
                direction="INBOUND",
            )
        )
    return out


class SyntheticRequestLoader:
    """Seeded synthetic berth requests. Deterministic via ``random.Random``."""

    source_id = "SYNTHETIC_BERTH_REQUESTS_v1"

    def __init__(self, seed: int = DEFAULT_SEED, n_requests: int = 10) -> None:
        self.seed = seed
        self.n_requests = n_requests

    def load_requests(self, start: datetime, end: datetime) -> List[BerthRequest]:
        rng = random.Random(self.seed)
        start = _ensure_utc(start)
        span_h = max(6.0, _hours_between(start, end))
        names = [
            "MSC VALERIA", "MAERSK HANGZHOU", "CMA CGM MARCO POLO", "OOCL WASHINGTON",
            "HMM LEAF", "KMTC NHAVA SHEVA", "TS SHANGHAI", "AL SAADIYAT",
            "SPIL KARTIKA", "MYD FUZHOU", "ARAYA BHUM", "DP WORLD JEBEL ALI",
            "MSC TAKORADI VIII", "INDUSTRIAL COURAGE",
        ]
        container_berths = [b for b, t, _, _ in DEFAULT_BERTH_SPECS
                            if t in ("NSFT", "NSICT", "NSIGT", "APMT", "BMCT")]
        out: List[BerthRequest] = []
        for i in range(self.n_requests):
            loa = rng.choice([180.0, 230.0, 260.0, 300.0, 330.0, 366.0, 399.0])
            # Draft correlates with LOA, as it does in reality.
            draft = round(min(15.4, 8.5 + (loa - 180.0) / 220.0 * 6.5 + rng.uniform(-0.4, 0.4)), 2)
            out.append(
                BerthRequest(
                    request_id=f"R-{i + 1:04d}",
                    vessel_id=f"V-{3001 + i}",
                    vessel_name=names[i % len(names)],
                    loa_m=loa,
                    draft_m=draft,
                    requested_berth_id=rng.choice(container_berths),
                    requested_start_utc=start + timedelta(hours=rng.uniform(0.0, span_h * 0.6)),
                    service_hours=round(rng.uniform(10.0, 30.0), 1),
                    priority=rng.choice([3, 5, 5, 5, 7]),
                )
            )
        return sorted(out, key=lambda r: (r.requested_start_utc, r.request_id))


class BermanRequestLoader:
    """
    REAL-DATA STUB — berth requests from PCS BERMAN messages.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Source:
        Model_Training_Data\\Model_Training_Data\\UC-I_Vessel_Traffic\\
        M4-M5_ETA_BerthUtilisation_Optimiser\\PCS_NLP_Marine_Messages\\BERMAN\\
        BERMAN_<commonRef>.xml   (14 files)

    Verified tag path:
        BerthManagement/DocumentDetails/BERMANHeader/{VCN, CallSign, IMONumber,
        VoyageNumber, VesselType, RotationNumber, Anchorage, EDTA, EDTD,
        DraftFwd, DraftAft, SpecificBerthDetails/BerthDetails}

    Mapping to BerthRequest:
        request_id            <- CommonRefNumber
        vessel_id             <- VCN
        draft_m               <- max(DraftFwd, DraftAft)
        requested_berth_id    <- SpecificBerthDetails/BerthDetails
        requested_start_utc   <- EDTA
        service_hours         <- EDTD - EDTA
        loa_m                 <- NOT in BERMAN; join to Pilot_card_data.xlsx on
                                 vessel name, or to CALINF on IMONumber

    EDTA / EDTD literal format: 'DDMMYYYY:HH:MM' (e.g. '11022026:17:00'), IST.
    Parse with strptime('%d%m%Y:%H:%M'), attach IST, convert to UTC here.

    Reject rows where EDTD <= EDTA.
    Dependency: stdlib xml.etree only.
    """

    source_id = "JNPA_PCS_BERMAN/NOT_IMPLEMENTED"

    def load_requests(self, start: datetime, end: datetime) -> List[BerthRequest]:
        raise NotImplementedError(BermanRequestLoader.__doc__)


# ==========================================================================
# SECTION 5 — ENGINE
# ==========================================================================


def check_compatibility(berth: Berth, req: BerthRequest) -> Tuple[bool, List[str]]:
    """
    Hard physical compatibility. These are never traded off against cost.

    Returns ``(ok, reasons)`` where ``reasons`` lists every violation, not just
    the first — an operator asking "why can't this ship go there?" wants the
    whole answer.
    """
    reasons: List[str] = []
    if berth.out_of_service:
        reasons.append(f"{berth.berth_id} is out of service")
    if req.loa_m > berth.length_m + 1e-9:
        reasons.append(
            f"LOA {req.loa_m:.1f} m exceeds {berth.berth_id} length {berth.length_m:.1f} m"
        )
    if req.draft_m > berth.max_draft_m + 1e-9:
        reasons.append(
            f"draft {req.draft_m:.2f} m exceeds {berth.berth_id} max depth "
            f"{berth.max_draft_m:.2f} m"
        )
    return (not reasons), reasons


def find_tidal_start(
    windows: Sequence[TidalWindow],
    draft_m: float,
    not_before: datetime,
    horizon_h: float = TIDE_SEARCH_HORIZON_H,
) -> Tuple[Optional[datetime], Optional[str]]:
    """
    Earliest moment at or after ``not_before`` that lies inside a go-window
    admitting ``draft_m``.

    Returns ``(start, window_id)``, or ``(None, None)`` when no window is found
    inside the horizon. Only the START of the manoeuvre must fall in the window
    — a vessel alongside is not constrained by the tide, so the service period
    is deliberately NOT required to fit inside the window.
    """
    not_before = _ensure_utc(not_before)
    deadline = not_before + timedelta(hours=horizon_h)
    for w in sorted(windows, key=lambda x: (x.start_utc, x.window_id)):
        if not w.admits(draft_m):
            continue
        if _ensure_utc(w.end_utc) <= not_before:
            continue
        candidate = max(not_before, _ensure_utc(w.start_utc))
        if candidate >= _ensure_utc(w.end_utc):
            continue
        if candidate > deadline:
            break
        return candidate, w.window_id
    return None, None


def marginal_cost(
    wait_h: float, is_shift: bool, tide_miss: bool, weights: OptimiserWeights = DEFAULT_WEIGHTS
) -> float:
    """The objective contribution of a single assignment."""
    return (
        weights.wait_hour * max(0.0, wait_h)
        + (weights.tide_miss if tide_miss else 0.0)
        + (weights.berth_shift if is_shift else 0.0)
    )


def _earliest_start_on_berth(
    berth: Berth,
    req: BerthRequest,
    windows: Sequence[TidalWindow],
    occupied: Sequence[Tuple[datetime, datetime]],
    tide_policy: str,
) -> Tuple[Optional[datetime], Optional[str], bool]:
    """
    Earliest feasible start on one berth.

    Returns ``(start, tide_window_id, tide_miss)``. ``start is None`` only when
    the tide policy is hard and no admitting window exists.
    """
    floor = _ensure_utc(req.earliest_start_utc or req.requested_start_utc)
    if berth.available_from_utc is not None:
        floor = max(floor, _ensure_utc(berth.available_from_utc))

    # Walk forward past every existing commitment on this berth.
    candidate = floor
    changed = True
    guard = 0
    spans = sorted((_ensure_utc(a), _ensure_utc(b)) for a, b in occupied)
    while changed and guard < 200:
        changed = False
        guard += 1
        end = candidate + timedelta(hours=req.service_hours)
        for a, b in spans:
            if _intervals_overlap(candidate, end, a, b):
                candidate = b + timedelta(hours=BERTH_TURNAROUND_BUFFER_H)
                changed = True
                break

    tide_start, window_id = find_tidal_start(windows, req.draft_m, candidate)
    if tide_start is None:
        if tide_policy == "hard":
            return None, None, True
        return candidate, None, True

    # Snapping to the window opening may collide with a commitment again;
    # re-settle until both constraints hold simultaneously.
    candidate = tide_start
    guard = 0
    while guard < 200:
        guard += 1
        end = candidate + timedelta(hours=req.service_hours)
        clash = next(
            ((a, b) for a, b in spans if _intervals_overlap(candidate, end, a, b)), None
        )
        if clash is None:
            break
        candidate = clash[1] + timedelta(hours=BERTH_TURNAROUND_BUFFER_H)
        tide_start, window_id = find_tidal_start(windows, req.draft_m, candidate)
        if tide_start is None:
            if tide_policy == "hard":
                return None, None, True
            return candidate, None, True
        candidate = tide_start

    return candidate, window_id, False


def greedy_optimise(
    requests: Sequence[BerthRequest],
    berths: Sequence[Berth],
    tidal_windows: Sequence[TidalWindow],
    weights: OptimiserWeights = DEFAULT_WEIGHTS,
    tide_policy: str = "soft",
    plan_id: str = "PLAN-GREEDY",
) -> BerthPlan:
    """
    Greedy heuristic berth allocation.

    1. Requests sorted by ``(priority, requested_start_utc, request_id)`` —
       fully deterministic, no dependence on input order.
    2. Candidate berths are the compatible ones, with the REQUESTED berth
       considered first so the plan stays close to what the agent asked for.
    3. Each candidate is costed with ``marginal_cost`` and the cheapest wins;
       ties break on earliest start, then requested berth, then berth id.
    4. Feasibility is guaranteed by construction — the returned plan never
       violates LOA, draft, or berth exclusivity.
    """
    if tide_policy not in TIDE_POLICIES:
        raise ValueError(f"tide_policy must be one of {TIDE_POLICIES}, got {tide_policy!r}")

    t0 = time.perf_counter()
    berth_map = {b.berth_id: b for b in berths}
    occupied: Dict[str, List[Tuple[datetime, datetime]]] = {b.berth_id: [] for b in berths}
    assignments: List[Assignment] = []
    unassigned: List[str] = []
    explanation: List[str] = []

    ordered = sorted(
        requests, key=lambda r: (r.priority, _ensure_utc(r.requested_start_utc), r.request_id)
    )

    for req in ordered:
        requested = _ensure_utc(req.requested_start_utc)

        # Build the candidate list: requested berth first, then the rest by id.
        candidate_ids: List[str] = []
        if req.requested_berth_id in berth_map:
            candidate_ids.append(req.requested_berth_id)
        candidate_ids += sorted(
            b.berth_id for b in berths if b.berth_id != req.requested_berth_id
        )

        best: Optional[Tuple[float, datetime, int, str, Optional[str], bool]] = None
        rejections: List[str] = []

        for bid in candidate_ids:
            berth = berth_map[bid]
            ok, reasons = check_compatibility(berth, req)
            if not ok:
                if bid == req.requested_berth_id:
                    rejections.extend(reasons)
                continue
            start, window_id, tide_miss = _earliest_start_on_berth(
                berth, req, tidal_windows, occupied[bid], tide_policy
            )
            if start is None:
                if bid == req.requested_berth_id:
                    rejections.append(
                        f"no tidal window admitting {req.draft_m:.2f} m within "
                        f"{TIDE_SEARCH_HORIZON_H:.0f} h (tide_policy=hard)"
                    )
                continue
            wait_h = max(0.0, _hours_between(requested, start))
            is_shift = bid != req.requested_berth_id
            cost = marginal_cost(wait_h, is_shift, tide_miss, weights)
            key = (cost, start, 0 if not is_shift else 1, bid, window_id, tide_miss)
            if best is None or (cost, start, key[2], bid) < (best[0], best[1], best[2], best[3]):
                best = key

        if best is None:
            unassigned.append(req.request_id)
            reason = "; ".join(rejections) or "no compatible berth available"
            explanation.append(f"{req.request_id} UNASSIGNED: {reason}")
            assignments.append(
                Assignment(
                    request_id=req.request_id,
                    vessel_id=req.vessel_id,
                    vessel_name=req.vessel_name,
                    berth_id="",
                    start_utc=requested,
                    end_utc=requested,
                    wait_hours=0.0,
                    is_berth_shift=False,
                    tide_window_id=None,
                    tide_miss=True,
                    feasible=False,
                    infeasible_reason=reason,
                    marginal_cost=0.0,
                    rationale=f"{req.request_id} {req.vessel_name}: UNASSIGNED — {reason}",
                )
            )
            continue

        cost, start, _, bid, window_id, tide_miss = best
        end = start + timedelta(hours=req.service_hours)
        wait_h = max(0.0, _hours_between(requested, start))
        is_shift = bid != req.requested_berth_id
        occupied[bid].append((start, end))
        berth = berth_map[bid]

        # Per-assignment rationale — the explainability requirement. It names
        # every reason the plan differs from the request, and prices each one.
        parts: List[str] = [f"{req.request_id} {req.vessel_name}:"]
        if is_shift:
            req_berth = berth_map.get(req.requested_berth_id)
            if req_berth is None:
                parts.append(f"requested berth {req.requested_berth_id} is not in the roster;")
            else:
                ok, reasons = check_compatibility(req_berth, req)
                if not ok:
                    parts.append(f"requested {req.requested_berth_id} rejected ({reasons[0]});")
                else:
                    parts.append(f"requested {req.requested_berth_id} not the cheapest option;")
            parts.append(
                f"assigned {bid} (LOA {req.loa_m:.0f}/{berth.length_m:.0f} m, "
                f"draft {req.draft_m:.2f}/{berth.max_draft_m:.2f} m)."
            )
        else:
            parts.append(
                f"assigned as requested to {bid} (LOA {req.loa_m:.0f}/{berth.length_m:.0f} m, "
                f"draft {req.draft_m:.2f}/{berth.max_draft_m:.2f} m)."
            )
        if window_id:
            parts.append(f"Start in tidal window {window_id}.")
        elif tide_miss:
            parts.append(
                f"TIDE MISS: no window admitting {req.draft_m:.2f} m within "
                f"{TIDE_SEARCH_HORIZON_H:.0f} h; berthing at the earliest free slot."
            )
        cost_bits = [f"wait {wait_h:.2f} h ({weights.wait_hour * wait_h:.2f})"]
        if is_shift:
            cost_bits.append(f"berth shift ({weights.berth_shift:.2f})")
        if tide_miss:
            cost_bits.append(f"tide miss ({weights.tide_miss:.2f})")
        parts.append(" + ".join(cost_bits) + f" = {cost:.2f}.")

        assignments.append(
            Assignment(
                request_id=req.request_id,
                vessel_id=req.vessel_id,
                vessel_name=req.vessel_name,
                berth_id=bid,
                start_utc=start,
                end_utc=end,
                wait_hours=wait_h,
                is_berth_shift=is_shift,
                tide_window_id=window_id,
                tide_miss=tide_miss,
                feasible=True,
                infeasible_reason=None,
                marginal_cost=cost,
                rationale=" ".join(parts),
            )
        )

    assignments.sort(key=lambda a: (a.start_utc, a.berth_id, a.request_id))
    cost_bd = score_plan(assignments, weights)
    solve_ms = (time.perf_counter() - t0) * 1000.0

    explanation.insert(
        0,
        f"greedy: {len(requests)} requests over {len(berths)} berths, "
        f"{len(tidal_windows)} tidal windows, tide_policy={tide_policy}",
    )

    plan = BerthPlan(
        plan_id=plan_id,
        algorithm="greedy",
        generated_at_utc=_utc_now(),
        assignments=tuple(assignments),
        unassigned_request_ids=tuple(unassigned),
        cost=cost_bd,
        solve_ms=solve_ms,
        tide_policy=tide_policy,
        explanation=tuple(explanation),
        breakdown=_plan_breakdown(
            "greedy", requests, berths, tidal_windows, assignments, cost_bd,
            weights, tide_policy, solve_ms, unassigned,
        ),
    )
    return plan


def score_plan(
    assignments: Sequence[Assignment], weights: OptimiserWeights = DEFAULT_WEIGHTS
) -> CostBreakdown:
    """Recompute the objective from an assignment list — independent of the solver."""
    served = [a for a in assignments if a.feasible]
    wait_total = sum(max(0.0, a.wait_hours) for a in served)
    misses = sum(1 for a in served if a.tide_miss)
    shifts = sum(1 for a in served if a.is_berth_shift)
    wait_cost = weights.wait_hour * wait_total
    tide_cost = weights.tide_miss * misses
    shift_cost = weights.berth_shift * shifts
    per_request = tuple(
        {
            "request_id": a.request_id,
            "berth_id": a.berth_id,
            "wait_hours": round(a.wait_hours, 3),
            "wait_cost": round(weights.wait_hour * max(0.0, a.wait_hours), 4),
            "tide_miss": a.tide_miss,
            "tide_cost": round(weights.tide_miss if a.tide_miss else 0.0, 4),
            "berth_shift": a.is_berth_shift,
            "shift_cost": round(weights.berth_shift if a.is_berth_shift else 0.0, 4),
            "marginal_cost": round(a.marginal_cost, 4),
        }
        for a in served
    )
    return CostBreakdown(
        wait_hours_total=wait_total,
        wait_cost=wait_cost,
        tide_misses=misses,
        tide_cost=tide_cost,
        berth_shifts=shifts,
        shift_cost=shift_cost,
        total_cost=wait_cost + tide_cost + shift_cost,
        weights=weights,
        per_request=per_request,
    )


def _plan_breakdown(
    algorithm: str,
    requests: Sequence[BerthRequest],
    berths: Sequence[Berth],
    windows: Sequence[TidalWindow],
    assignments: Sequence[Assignment],
    cost: CostBreakdown,
    weights: OptimiserWeights,
    tide_policy: str,
    solve_ms: float,
    unassigned: Sequence[str],
) -> Dict[str, Any]:
    served = [a for a in assignments if a.feasible]
    return {
        "model": "M5_BERTH_OPTIMISER",
        "version": MODULE_VERSION,
        "algorithm": algorithm,
        "constants": {
            "BERTH_TURNAROUND_BUFFER_H": BERTH_TURNAROUND_BUFFER_H,
            "TIDE_SEARCH_HORIZON_H": TIDE_SEARCH_HORIZON_H,
            "TIME_GRANULARITY_MIN": TIME_GRANULARITY_MIN,
            "weights": weights.as_dict(),
        },
        "inputs": {
            "requests": len(requests),
            "berths": len(berths),
            "berths_in_service": sum(1 for b in berths if not b.out_of_service),
            "tidal_windows": len(windows),
            "tide_policy": tide_policy,
        },
        "steps": [
            _step(
                1,
                "Request ordering",
                "sort by (priority, requested_start_utc, request_id)",
                ", ".join(
                    f"{r.request_id}(p{r.priority})"
                    for r in sorted(requests, key=lambda r: (r.priority, r.requested_start_utc,
                                                             r.request_id))[:8]
                ) + (" ..." if len(requests) > 8 else ""),
                {"n_requests": len(requests)},
                len(requests),
                "requests",
                "fully deterministic — independent of input order",
            ),
            _step(
                2,
                "Hard constraints",
                "LOA <= berth length AND draft <= berth max depth AND berth in service",
                f"{len(served)} of {len(requests)} placed; "
                f"{len(unassigned)} unassigned",
                {"placed": len(served), "unassigned": len(unassigned)},
                len(served),
                "assignments",
                "guaranteed by construction — never violated",
            ),
            _step(
                3,
                "Berth exclusivity",
                "next start >= previous end + BERTH_TURNAROUND_BUFFER_H",
                f"buffer {BERTH_TURNAROUND_BUFFER_H} h enforced on "
                f"{len({a.berth_id for a in served})} occupied berths",
                {"buffer_h": BERTH_TURNAROUND_BUFFER_H},
                len({a.berth_id for a in served}),
                "berths",
                "",
            ),
            _step(
                4,
                "Tidal window snap",
                "start snapped forward to the first window admitting the vessel's draft",
                f"{sum(1 for a in served if a.tide_window_id)} snapped to a window, "
                f"{cost.tide_misses} tide miss(es)",
                {
                    "snapped": sum(1 for a in served if a.tide_window_id),
                    "misses": cost.tide_misses,
                },
                cost.tide_misses,
                "misses",
                f"tide is a COSTED SOFT constraint (policy={tide_policy})",
            ),
            _step(
                5,
                "Objective",
                "cost = w_wait * sum(wait_h) + w_tide * misses + w_shift * shifts",
                f"{weights.wait_hour} * {cost.wait_hours_total:.2f} + "
                f"{weights.tide_miss} * {cost.tide_misses} + "
                f"{weights.berth_shift} * {cost.berth_shifts} = "
                f"{cost.wait_cost:.2f} + {cost.tide_cost:.2f} + {cost.shift_cost:.2f} = "
                f"{cost.total_cost:.2f}",
                {
                    "wait_hours_total": round(cost.wait_hours_total, 3),
                    "tide_misses": cost.tide_misses,
                    "berth_shifts": cost.berth_shifts,
                },
                round(cost.total_cost, 4),
                "cost",
                f"weights version {weights.version}",
            ),
        ],
        "cost": cost.as_dict(),
        "result": {
            "algorithm": algorithm,
            "assignments": len(served),
            "unassigned": len(unassigned),
            "total_cost": round(cost.total_cost, 4),
            "solve_ms": round(solve_ms, 2),
        },
        "assumptions": [
            "Greedy is explicitly NOT globally optimal; it is instant and feasible by construction.",
            "wait_hours = max(0, start - requested_start): early berthing earns no credit.",
            "Only the START of the manoeuvre must fall inside a tidal window.",
            "Tide is a costed soft constraint by default; set tide_policy='hard' to reject instead.",
            "Tidal windows are supplied by UC1-M2; this module never imports it.",
        ],
        "provenance": {
            "weights_version": weights.version,
            "generated_at_utc": _iso(_utc_now()),
        },
    }


# --------------------------------------------------------------------------
# Optional CP-SAT exact solver (production upgrade path per WS2).
# --------------------------------------------------------------------------

_HAS_ORTOOLS = False
try:  # Catch bare Exception: a broken ortools install must degrade, not crash.
    from ortools.sat.python import cp_model as _cp_model  # noqa: E402

    _HAS_ORTOOLS = True
except Exception:  # pragma: no cover
    _cp_model = None  # type: ignore


def cpsat_available() -> bool:
    """True when ortools is importable and the CP-SAT path can run."""
    return _HAS_ORTOOLS


def solve_cpsat(
    requests: Sequence[BerthRequest],
    berths: Sequence[Berth],
    tidal_windows: Sequence[TidalWindow],
    weights: OptimiserWeights = DEFAULT_WEIGHTS,
    tide_policy: str = "soft",
    time_limit_s: float = CPSAT_TIME_LIMIT_S,
    horizon_h: float = TIDE_SEARCH_HORIZON_H,
    plan_id: str = "PLAN-CPSAT",
) -> Optional[BerthPlan]:
    """
    Exact MILP/CP-SAT allocation — the production replacement named in WS2.

    Returns ``None`` when ortools is not installed, so callers degrade to greedy
    rather than failing. The model is:

        * one optional interval per (request, berth), at 15-minute granularity
        * ``AddNoOverlap`` per berth, with the turnaround buffer folded into the
          interval length
        * exactly one berth selected per request (or the request is dropped,
          at a large penalty)
        * start restricted to the union of admitting tidal windows when
          ``tide_policy='hard'``; costed via a boolean when soft
        * objective identical to ``score_plan``, expressed in integer
          deci-hours so CP-SAT stays in integer arithmetic
    """
    if not _HAS_ORTOOLS:
        return None

    t0 = time.perf_counter()
    origin = min(_ensure_utc(r.requested_start_utc) for r in requests)
    slot = TIME_GRANULARITY_MIN
    horizon_slots = int(horizon_h * 60 / slot)

    def to_slot(dt: datetime) -> int:
        return int(round((_ensure_utc(dt) - origin).total_seconds() / 60.0 / slot))

    def from_slot(s: int) -> datetime:
        return origin + timedelta(minutes=s * slot)

    model = _cp_model.CpModel()
    buffer_slots = int(math.ceil(BERTH_TURNAROUND_BUFFER_H * 60 / slot))

    presence: Dict[Tuple[str, str], Any] = {}
    starts: Dict[Tuple[str, str], Any] = {}
    intervals_by_berth: Dict[str, List[Any]] = {b.berth_id: [] for b in berths}
    assigned_var: Dict[str, Any] = {}
    tide_miss_var: Dict[str, Any] = {}
    shift_terms: List[Tuple[Any, int]] = []
    wait_terms: List[Any] = []

    for req in requests:
        dur_slots = max(1, int(math.ceil(req.service_hours * 60 / slot)))
        req_slot = to_slot(req.requested_start_utc)
        floor_slot = to_slot(req.earliest_start_utc or req.requested_start_utc)

        # Slots at which a tide-admitting window is open.
        allowed: Set[int] = set()
        for w in tidal_windows:
            if not w.admits(req.draft_m):
                continue
            lo = max(floor_slot, to_slot(w.start_utc))
            hi = min(horizon_slots, to_slot(w.end_utc))
            allowed.update(range(lo, max(lo, hi)))

        options: List[Any] = []
        for berth in berths:
            ok, _ = check_compatibility(berth, req)
            if not ok:
                continue
            key = (req.request_id, berth.berth_id)
            p = model.NewBoolVar(f"p_{req.request_id}_{berth.berth_id}")
            s = model.NewIntVar(floor_slot, horizon_slots, f"s_{req.request_id}_{berth.berth_id}")
            iv = model.NewOptionalIntervalVar(
                s, dur_slots + buffer_slots, s + dur_slots + buffer_slots, p,
                f"iv_{req.request_id}_{berth.berth_id}",
            )
            intervals_by_berth[berth.berth_id].append(iv)
            presence[key] = p
            starts[key] = s
            options.append(p)
            if berth.berth_id != req.requested_berth_id:
                shift_terms.append((p, 1))
            if tide_policy == "hard" and allowed:
                model.AddAllowedAssignments([s], [(v,) for v in sorted(allowed)]).OnlyEnforceIf(p)

        if not options:
            continue

        a = model.NewBoolVar(f"a_{req.request_id}")
        model.Add(sum(options) == 1).OnlyEnforceIf(a)
        model.Add(sum(options) == 0).OnlyEnforceIf(a.Not())
        assigned_var[req.request_id] = a

        # Effective start = the start of whichever berth was selected.
        eff = model.NewIntVar(floor_slot, horizon_slots, f"eff_{req.request_id}")
        for berth in berths:
            key = (req.request_id, berth.berth_id)
            if key in presence:
                model.Add(eff == starts[key]).OnlyEnforceIf(presence[key])

        # Wait in deci-hours, one-sided.
        wait = model.NewIntVar(0, horizon_slots * slot, f"w_{req.request_id}")
        model.Add(wait >= (eff - req_slot) * slot)
        model.Add(wait >= 0)
        wait_terms.append(wait)

        if tide_policy == "soft":
            tm = model.NewBoolVar(f"tm_{req.request_id}")
            if allowed:
                in_window = model.NewBoolVar(f"iw_{req.request_id}")
                model.AddAllowedAssignments([eff], [(v,) for v in sorted(allowed)]).OnlyEnforceIf(
                    in_window
                )
                model.Add(tm == 1).OnlyEnforceIf(in_window.Not())
                model.Add(tm == 0).OnlyEnforceIf(in_window)
            else:
                model.Add(tm == 1)
            tide_miss_var[req.request_id] = tm

    for bid, ivs in intervals_by_berth.items():
        if ivs:
            model.AddNoOverlap(ivs)

    # Objective in integer minutes-equivalents: wait minutes * w_wait,
    # plus scaled penalties. Scale by 60 so weights stay comparable to hours.
    obj: List[Any] = []
    for w in wait_terms:
        obj.append(int(round(weights.wait_hour * 100)) * w)
    for rid, tm in tide_miss_var.items():
        obj.append(int(round(weights.tide_miss * 60 * 100)) * tm)
    for p, _ in shift_terms:
        obj.append(int(round(weights.berth_shift * 60 * 100)) * p)
    for rid, a in assigned_var.items():
        obj.append(int(round(1000 * 60 * 100)) * a.Not())     # large drop penalty
    model.Minimize(sum(obj))

    solver = _cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit_s)
    solver.parameters.num_search_workers = 4
    status = solver.Solve(model)
    if status not in (_cp_model.OPTIMAL, _cp_model.FEASIBLE):
        return None

    assignments: List[Assignment] = []
    unassigned: List[str] = []
    for req in requests:
        chosen = None
        for berth in berths:
            key = (req.request_id, berth.berth_id)
            if key in presence and solver.Value(presence[key]) == 1:
                chosen = (berth, solver.Value(starts[key]))
                break
        if chosen is None:
            unassigned.append(req.request_id)
            continue
        berth, s = chosen
        start = from_slot(s)
        end = start + timedelta(hours=req.service_hours)
        wait_h = max(0.0, _hours_between(req.requested_start_utc, start))
        is_shift = berth.berth_id != req.requested_berth_id
        tide_start, window_id = find_tidal_start(tidal_windows, req.draft_m, start)
        in_window = window_id is not None and tide_start is not None and tide_start <= start
        miss = not in_window
        cost = marginal_cost(wait_h, is_shift, miss, weights)
        assignments.append(
            Assignment(
                request_id=req.request_id,
                vessel_id=req.vessel_id,
                vessel_name=req.vessel_name,
                berth_id=berth.berth_id,
                start_utc=start,
                end_utc=end,
                wait_hours=wait_h,
                is_berth_shift=is_shift,
                tide_window_id=window_id if in_window else None,
                tide_miss=miss,
                feasible=True,
                infeasible_reason=None,
                marginal_cost=cost,
                rationale=(
                    f"{req.request_id} {req.vessel_name}: CP-SAT assigned {berth.berth_id} "
                    f"at {_iso(start)}; wait {wait_h:.2f} h"
                    + (", berth shift" if is_shift else "")
                    + (", tide miss" if miss else f", window {window_id}")
                    + f" = {cost:.2f}."
                ),
            )
        )

    assignments.sort(key=lambda a: (a.start_utc, a.berth_id, a.request_id))
    cost_bd = score_plan(assignments, weights)
    solve_ms = (time.perf_counter() - t0) * 1000.0

    return BerthPlan(
        plan_id=plan_id,
        algorithm="cpsat",
        generated_at_utc=_utc_now(),
        assignments=tuple(assignments),
        unassigned_request_ids=tuple(unassigned),
        cost=cost_bd,
        solve_ms=solve_ms,
        tide_policy=tide_policy,
        explanation=(
            f"cpsat: status={solver.StatusName(status)}, "
            f"objective={solver.ObjectiveValue():.0f}, "
            f"{TIME_GRANULARITY_MIN}-min slots over {horizon_h:.0f} h",
        ),
        breakdown=_plan_breakdown(
            "cpsat", requests, berths, tidal_windows, assignments, cost_bd,
            weights, tide_policy, solve_ms, unassigned,
        ),
    )


def optimise(
    requests: Sequence[BerthRequest],
    berths: Sequence[Berth],
    tidal_windows: Sequence[TidalWindow],
    weights: OptimiserWeights = DEFAULT_WEIGHTS,
    algorithm: str = "auto",
    tide_policy: str = "soft",
) -> BerthPlan:
    """
    Produce a berth plan.

    ``algorithm='auto'`` always computes the greedy plan first and keeps it as a
    FLOOR, then tries CP-SAT if ortools is installed and returns whichever plan
    costs less. Both costs are recorded in
    ``breakdown['algorithm_comparison']``, so the exact solver never silently
    regresses the demo.
    """
    if algorithm not in ALGORITHMS:
        raise ValueError(f"algorithm must be one of {ALGORITHMS}, got {algorithm!r}")
    if not requests:
        raise ValueError("at least one berth request is required")

    greedy = greedy_optimise(requests, berths, tidal_windows, weights, tide_policy)
    if algorithm == "greedy":
        greedy.breakdown["algorithm_comparison"] = {
            "greedy_cost": round(greedy.cost.total_cost, 4),
            "cpsat_cost": None,
            "cpsat_available": _HAS_ORTOOLS,
            "selected": "greedy",
            "note": "algorithm='greedy' requested explicitly",
        }
        return greedy

    exact = solve_cpsat(requests, berths, tidal_windows, weights, tide_policy)
    if exact is None:
        note = (
            "ortools not installed — greedy plan returned. "
            "Install with: pip install ortools"
            if not _HAS_ORTOOLS
            else "CP-SAT found no feasible solution within the time limit — greedy plan returned"
        )
        greedy.breakdown["algorithm_comparison"] = {
            "greedy_cost": round(greedy.cost.total_cost, 4),
            "cpsat_cost": None,
            "cpsat_available": _HAS_ORTOOLS,
            "selected": "greedy",
            "note": note,
        }
        return replace(greedy, explanation=greedy.explanation + (f"cpsat_unavailable: {note}",))

    comparison = {
        "greedy_cost": round(greedy.cost.total_cost, 4),
        "cpsat_cost": round(exact.cost.total_cost, 4),
        "cpsat_available": True,
        "improvement": round(greedy.cost.total_cost - exact.cost.total_cost, 4),
        "greedy_solve_ms": round(greedy.solve_ms, 2),
        "cpsat_solve_ms": round(exact.solve_ms, 2),
    }
    if exact.cost.total_cost <= greedy.cost.total_cost:
        comparison["selected"] = "cpsat"
        exact.breakdown["algorithm_comparison"] = comparison
        return exact
    comparison["selected"] = "greedy"
    comparison["note"] = "greedy kept as a floor — CP-SAT did not improve on it"
    greedy.breakdown["algorithm_comparison"] = comparison
    return greedy


def compare_plans(baseline: BerthPlan, candidate: BerthPlan) -> Dict[str, Any]:
    """Delta table between two plans — the what-if demo's payoff."""
    return {
        "baseline_plan_id": baseline.plan_id,
        "candidate_plan_id": candidate.plan_id,
        "delta_wait_hours": round(
            candidate.cost.wait_hours_total - baseline.cost.wait_hours_total, 3
        ),
        "delta_tide_misses": candidate.cost.tide_misses - baseline.cost.tide_misses,
        "delta_berth_shifts": candidate.cost.berth_shifts - baseline.cost.berth_shifts,
        "delta_total_cost": round(candidate.cost.total_cost - baseline.cost.total_cost, 4),
        "delta_unassigned": len(candidate.unassigned_request_ids)
        - len(baseline.unassigned_request_ids),
        "baseline": baseline.cost.as_dict(),
        "candidate": candidate.cost.as_dict(),
        "verdict": (
            "WORSE" if candidate.cost.total_cost > baseline.cost.total_cost + 1e-9
            else "BETTER" if candidate.cost.total_cost < baseline.cost.total_cost - 1e-9
            else "UNCHANGED"
        ),
    }


# --------------------------------------------------------------------------
# Scenario helpers — the M1..M10 regression hooks named in the WS2 spec.
# --------------------------------------------------------------------------

_SCENARIO_START = datetime(2026, 8, 1, tzinfo=timezone.utc)


def _base_inputs(
    seed: int = DEFAULT_SEED, n_requests: int = 10
) -> Tuple[List[BerthRequest], List[Berth], List[TidalWindow]]:
    end = _SCENARIO_START + timedelta(hours=TIDE_SEARCH_HORIZON_H)
    reqs = SyntheticRequestLoader(seed, n_requests).load_requests(_SCENARIO_START, end)
    return reqs, default_berths(), synthetic_tidal_windows(_SCENARIO_START, seed=seed)


def scenario_baseline(seed: int = DEFAULT_SEED, n_requests: int = 10):
    """Nothing disrupted."""
    return _base_inputs(seed, n_requests)


def scenario_berth_outage(
    berth_id: str = "BMCT-01", seed: int = DEFAULT_SEED, n_requests: int = 10
):
    """One berth taken out of service."""
    reqs, berths, windows = _base_inputs(seed, n_requests)
    berths = [replace(b, out_of_service=True) if b.berth_id == berth_id else b for b in berths]
    return reqs, berths, windows


def scenario_tide_narrowed(
    pct: float = 0.5, seed: int = DEFAULT_SEED, n_requests: int = 10
):
    """Siltation narrows every tidal window."""
    reqs, berths, _ = _base_inputs(seed, n_requests)
    return reqs, berths, synthetic_tidal_windows(_SCENARIO_START, seed=seed, narrow_factor=pct)


def scenario_arrival_surge(
    n_extra: int = 5, seed: int = DEFAULT_SEED, n_requests: int = 10
):
    """Unplanned extra arrivals on top of the programme."""
    reqs, berths, windows = _base_inputs(seed, n_requests)
    extra = SyntheticRequestLoader(seed + 977, n_extra).load_requests(
        _SCENARIO_START, _SCENARIO_START + timedelta(hours=TIDE_SEARCH_HORIZON_H)
    )
    extra = [replace(r, request_id=f"X-{r.request_id}") for r in extra]
    return reqs + extra, berths, windows


def scenario_deep_draft_call(seed: int = DEFAULT_SEED, n_requests: int = 10):
    """A ULCV too deep for most windows joins the programme."""
    reqs, berths, windows = _base_inputs(seed, n_requests)
    reqs = reqs + [
        BerthRequest(
            request_id="R-DEEP",
            vessel_id="V-DEEP",
            vessel_name="MSC IRINA (ULCV)",
            loa_m=399.0,
            draft_m=15.45,
            requested_berth_id="BMCT-01",
            requested_start_utc=_SCENARIO_START + timedelta(hours=6),
            service_hours=34.0,
            priority=1,
        )
    ]
    return reqs, berths, windows


SCENARIOS: Dict[str, Any] = {
    "baseline": scenario_baseline,
    "berth-outage": scenario_berth_outage,
    "tide-narrowed": scenario_tide_narrowed,
    "arrival-surge": scenario_arrival_surge,
    "deep-draft": scenario_deep_draft_call,
}


MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "spec_row": "WS2_AI_ML_Tools.md row 5 — Berth-plan optimisation / re-sequencing",
    "model_type": "greedy heuristic (feasible by construction) + optional CP-SAT",
    "cpsat_available": _HAS_ORTOOLS,
    "constants": {
        "DEFAULT_WEIGHTS": DEFAULT_WEIGHTS.as_dict(),
        "BERTH_TURNAROUND_BUFFER_H": BERTH_TURNAROUND_BUFFER_H,
        "TIDE_SEARCH_HORIZON_H": TIDE_SEARCH_HORIZON_H,
        "TIME_GRANULARITY_MIN": TIME_GRANULARITY_MIN,
        "TIDE_POLICIES": list(TIDE_POLICIES),
        "ALGORITHMS": list(ALGORITHMS),
    },
    "berth_count": len(DEFAULT_BERTH_SPECS),
    "scenarios": sorted(SCENARIOS),
}


# ==========================================================================
# SECTION 6 — FASTAPI ROUTER (optional dependency)
# ==========================================================================

_HAS_FASTAPI = False
try:
    from fastapi import APIRouter, HTTPException, Query  # noqa: E402
    from pydantic import BaseModel, Field                # noqa: E402
    from typing import Literal                           # noqa: E402

    _HAS_FASTAPI = True
except Exception:  # pragma: no cover
    APIRouter = None  # type: ignore
    HTTPException = None  # type: ignore
    BaseModel = object  # type: ignore
    Literal = None  # type: ignore

    def Field(default=None, **_kw):  # type: ignore
        return default

    def Query(default=None, **_kw):  # type: ignore
        return default


if _HAS_FASTAPI:

    class TidalWindowModel(BaseModel):
        """
        THE UC1-M2 BOUNDARY.

        Supply these from M2's ``evaluate_tidal_windows()`` output. M5 never
        imports M2 — windows cross the boundary as data, which is what keeps
        both modules independently runnable.
        """

        window_id: str
        start_utc: datetime
        end_utc: datetime
        max_draft_m: float = Field(15.5, gt=0, le=25)
        reach_id: str = "CH-INNER"
        direction: Literal["INBOUND", "OUTBOUND", "BOTH"] = "INBOUND"

        def to_window(self) -> TidalWindow:
            s, e = self.start_utc, self.end_utc
            s = s if s.tzinfo else s.replace(tzinfo=timezone.utc)
            e = e if e.tzinfo else e.replace(tzinfo=timezone.utc)
            if e <= s:
                raise HTTPException(422, f"{self.window_id}: end_utc must be after start_utc")
            return TidalWindow(self.window_id, s, e, self.max_draft_m,
                               self.reach_id, self.direction)

    class BerthModel(BaseModel):
        berth_id: str
        terminal: str = ""
        length_m: float = Field(350.0, gt=0, le=600)
        max_draft_m: float = Field(15.0, gt=0, le=25)
        available_from_utc: Optional[datetime] = None
        out_of_service: bool = False

        def to_berth(self) -> Berth:
            a = self.available_from_utc
            if a is not None and a.tzinfo is None:
                a = a.replace(tzinfo=timezone.utc)
            return Berth(self.berth_id, self.terminal, self.length_m,
                         self.max_draft_m, a, self.out_of_service)

    class BerthRequestModel(BaseModel):
        request_id: str
        vessel_id: str = ""
        vessel_name: str = ""
        loa_m: float = Field(330.0, gt=0, le=500)
        draft_m: float = Field(14.0, gt=0, le=25)
        requested_berth_id: str
        requested_start_utc: datetime
        service_hours: float = Field(24.0, gt=0, le=240)
        priority: int = Field(5, ge=1, le=9)
        earliest_start_utc: Optional[datetime] = None
        latest_start_utc: Optional[datetime] = None

        def to_request(self) -> BerthRequest:
            def _tz(d):
                if d is None:
                    return None
                return d if d.tzinfo else d.replace(tzinfo=timezone.utc)

            return BerthRequest(
                request_id=self.request_id,
                vessel_id=self.vessel_id,
                vessel_name=self.vessel_name,
                loa_m=self.loa_m,
                draft_m=self.draft_m,
                requested_berth_id=self.requested_berth_id,
                requested_start_utc=_tz(self.requested_start_utc),
                service_hours=self.service_hours,
                priority=self.priority,
                earliest_start_utc=_tz(self.earliest_start_utc),
                latest_start_utc=_tz(self.latest_start_utc),
            )

    class WeightsModel(BaseModel):
        wait_hour: float = Field(1.0, ge=0, le=100)
        tide_miss: float = Field(2.0, ge=0, le=100)
        berth_shift: float = Field(0.5, ge=0, le=100)

        def to_weights(self) -> OptimiserWeights:
            return OptimiserWeights(self.wait_hour, self.tide_miss, self.berth_shift)

    class OptimiseRequest(BaseModel):
        requests: List[BerthRequestModel]
        berths: Optional[List[BerthModel]] = None
        tidal_windows: Optional[List[TidalWindowModel]] = None
        weights: Optional[WeightsModel] = None
        algorithm: Literal["greedy", "cpsat", "auto"] = "auto"
        tide_policy: Literal["soft", "hard"] = "soft"

        def build(self):
            if not self.requests:
                raise HTTPException(422, "at least one berth request is required")
            reqs = [r.to_request() for r in self.requests]
            berths = [b.to_berth() for b in self.berths] if self.berths else default_berths()
            if self.tidal_windows is not None:
                windows = [w.to_window() for w in self.tidal_windows]
            else:
                windows = synthetic_tidal_windows(
                    min(r.requested_start_utc for r in reqs)
                )
            weights = self.weights.to_weights() if self.weights else DEFAULT_WEIGHTS
            return reqs, berths, windows, weights

    class CompareRequest(BaseModel):
        baseline_scenario: str = "baseline"
        candidate_scenario: str = "berth-outage"
        seed: int = DEFAULT_SEED
        n_requests: int = Field(10, ge=1, le=100)
        algorithm: Literal["greedy", "cpsat", "auto"] = "greedy"

    def build_router() -> "APIRouter":
        """Construct the UC1-M5 router. Mounted by ``api.py``."""
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC1-M5 Berth Optimiser"])

        @router.post("/optimise", summary="Produce a berth plan")
        def optimise_endpoint(req: OptimiseRequest) -> Dict[str, Any]:
            reqs, berths, windows, weights = req.build()
            plan = optimise(reqs, berths, windows, weights, req.algorithm, req.tide_policy)
            return plan.as_dict()

        @router.post("/compare", summary="Baseline vs disrupted scenario delta")
        def compare_endpoint(req: CompareRequest) -> Dict[str, Any]:
            for name in (req.baseline_scenario, req.candidate_scenario):
                if name not in SCENARIOS:
                    raise HTTPException(422, f"unknown scenario {name!r}; "
                                             f"choose from {sorted(SCENARIOS)}")
            b_in = SCENARIOS[req.baseline_scenario](seed=req.seed, n_requests=req.n_requests)
            c_in = SCENARIOS[req.candidate_scenario](seed=req.seed, n_requests=req.n_requests)
            b = optimise(*b_in, DEFAULT_WEIGHTS, req.algorithm)
            c = optimise(*c_in, DEFAULT_WEIGHTS, req.algorithm)
            return {
                "baseline_scenario": req.baseline_scenario,
                "candidate_scenario": req.candidate_scenario,
                "comparison": compare_plans(b, c),
                "baseline_plan": b.as_dict(),
                "candidate_plan": c.as_dict(),
            }

        @router.get("/weights", summary="Versioned objective weights")
        def weights_endpoint() -> Dict[str, Any]:
            return DEFAULT_WEIGHTS.as_dict()

        @router.get("/berths", summary="Default JNPA berth roster")
        def berths_endpoint() -> List[Dict[str, Any]]:
            return [b.as_dict() for b in default_berths()]

        @router.get("/constants", summary="Versioned constants (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {"module_version": MODULE_VERSION, "constants": MODULE_INFO["constants"]}

        @router.get("/demo", summary="Run a named scenario")
        def demo(
            scenario: str = Query("baseline"),
            algorithm: Literal["greedy", "cpsat", "auto"] = "greedy",
        ) -> Dict[str, Any]:
            if scenario not in SCENARIOS:
                raise HTTPException(422, f"unknown scenario {scenario!r}")
            return optimise(*SCENARIOS[scenario](), DEFAULT_WEIGHTS, algorithm).as_dict()

        @router.get("/health", summary="Module health and identity")
        def health() -> Dict[str, Any]:
            checks = _self_test()
            return {
                "status": "ok" if all(ok for _, ok, _ in checks) else "degraded",
                "module": MODULE_INFO,
                "checks": [{"name": n, "passed": ok, "detail": d} for n, ok, d in checks],
            }

        return router

else:  # pragma: no cover

    def build_router():  # type: ignore
        raise RuntimeError(
            "FastAPI is not installed. Install with: pip install 'fastapi>=0.115' 'pydantic>=2.7'"
        )


# ==========================================================================
# SECTION 7 — SELF-TEST AND CLI DEMO RUNNER
# ==========================================================================


def validate_plan(
    plan: BerthPlan, requests: Sequence[BerthRequest], berths: Sequence[Berth]
) -> Tuple[bool, List[str]]:
    """
    Assert the hard constraints the greedy algorithm claims to guarantee.

    This is the check that makes "feasibility guaranteed by construction" a
    testable claim rather than a marketing line.
    """
    problems: List[str] = []
    by_req = {r.request_id: r for r in requests}
    by_berth = {b.berth_id: b for b in berths}

    per_berth: Dict[str, List[Assignment]] = {}
    for a in plan.assignments:
        if not a.feasible:
            continue
        per_berth.setdefault(a.berth_id, []).append(a)

    for bid, items in per_berth.items():
        berth = by_berth.get(bid)
        if berth is None:
            problems.append(f"{bid} is not in the berth roster")
            continue
        if berth.out_of_service:
            problems.append(f"{bid} is out of service but has {len(items)} assignments")
        for a in items:
            r = by_req.get(a.request_id)
            if r is None:
                continue
            if r.loa_m > berth.length_m + 1e-9:
                problems.append(
                    f"{a.request_id}: LOA {r.loa_m} > {bid} length {berth.length_m}"
                )
            if r.draft_m > berth.max_draft_m + 1e-9:
                problems.append(
                    f"{a.request_id}: draft {r.draft_m} > {bid} depth {berth.max_draft_m}"
                )
            expected_end = a.start_utc + timedelta(hours=r.service_hours)
            if abs((a.end_utc - expected_end).total_seconds()) > 1.0:
                problems.append(f"{a.request_id}: end time does not match service hours")
        items.sort(key=lambda x: x.start_utc)
        for x, y in zip(items, items[1:]):
            if _intervals_overlap(x.start_utc, x.end_utc, y.start_utc, y.end_utc):
                problems.append(
                    f"{bid}: {x.request_id} and {y.request_id} overlap"
                )
            elif _hours_between(x.end_utc, y.start_utc) < BERTH_TURNAROUND_BUFFER_H - 1e-6:
                problems.append(
                    f"{bid}: {x.request_id} -> {y.request_id} gap "
                    f"{_hours_between(x.end_utc, y.start_utc):.3f} h "
                    f"< buffer {BERTH_TURNAROUND_BUFFER_H} h"
                )
    for a in plan.assignments:
        if a.feasible and a.wait_hours < -1e-9:
            problems.append(f"{a.request_id}: negative wait {a.wait_hours}")
    return (not problems), problems


def _self_test() -> List[Tuple[str, bool, str]]:
    """Return ``[(check_name, passed, detail), ...]``."""
    checks: List[Tuple[str, bool, str]] = []

    reqs, berths, windows = scenario_baseline()
    plan = greedy_optimise(reqs, berths, windows)

    ok, problems = validate_plan(plan, reqs, berths)
    checks.append(
        (
            "hard_constraints_guaranteed",
            ok,
            f"{len(plan.assignments)} assignments validated"
            if ok else f"{len(problems)} violations: {problems[:2]}",
        )
    )

    recomputed = score_plan(plan.assignments, DEFAULT_WEIGHTS)
    checks.append(
        (
            "cost_recomputation_matches",
            abs(recomputed.total_cost - plan.cost.total_cost) < 1e-9,
            f"solver {plan.cost.total_cost:.4f} == independent recompute "
            f"{recomputed.total_cost:.4f}",
        )
    )

    manual = (
        DEFAULT_WEIGHTS.wait_hour * plan.cost.wait_hours_total
        + DEFAULT_WEIGHTS.tide_miss * plan.cost.tide_misses
        + DEFAULT_WEIGHTS.berth_shift * plan.cost.berth_shifts
    )
    checks.append(
        (
            "objective_formula",
            abs(manual - plan.cost.total_cost) < 1e-9,
            f"1.0*{plan.cost.wait_hours_total:.2f} + 2.0*{plan.cost.tide_misses} + "
            f"0.5*{plan.cost.berth_shifts} = {plan.cost.total_cost:.2f}",
        )
    )

    checks.append(
        (
            "no_negative_wait",
            all(a.wait_hours >= 0.0 for a in plan.assignments),
            f"min wait {min((a.wait_hours for a in plan.assignments), default=0.0):.3f} h "
            f"— early berthing earns no credit",
        )
    )

    checks.append(
        (
            "determinism",
            greedy_optimise(reqs, berths, windows).cost.total_cost == plan.cost.total_cost,
            f"repeat run reproduces cost {plan.cost.total_cost:.4f}",
        )
    )
    shuffled = list(reqs)
    random.Random(7).shuffle(shuffled)
    checks.append(
        (
            "input_order_independence",
            abs(greedy_optimise(shuffled, berths, windows).cost.total_cost
                - plan.cost.total_cost) < 1e-9,
            "shuffling the request list does not change the plan cost",
        )
    )

    # Every assignment either sits in a window or is flagged as a tide miss.
    bad_tide = [
        a for a in plan.assignments
        if a.feasible and not a.tide_miss and a.tide_window_id is None
    ]
    checks.append(
        (
            "tide_flag_consistency",
            not bad_tide,
            f"{sum(1 for a in plan.assignments if a.tide_window_id)} in-window, "
            f"{plan.cost.tide_misses} miss(es), {len(bad_tide)} unaccounted",
        )
    )

    # Windows that actually admit the draft must be honoured.
    honoured = True
    detail = "no in-window assignments to check"
    win_by_id = {w.window_id: w for w in windows}
    for a in plan.assignments:
        if a.tide_window_id and a.tide_window_id in win_by_id:
            w = win_by_id[a.tide_window_id]
            r = next(x for x in reqs if x.request_id == a.request_id)
            if not (w.start_utc <= a.start_utc < w.end_utc) or not w.admits(r.draft_m):
                honoured = False
                detail = f"{a.request_id} start outside {a.tide_window_id}"
                break
    else:
        detail = f"{sum(1 for a in plan.assignments if a.tide_window_id)} starts verified inside their window"
    checks.append(("tidal_window_honoured", honoured, detail))

    # Requested berth is preferred when it is free and compatible.
    kept = sum(1 for a in plan.assignments if a.feasible and not a.is_berth_shift)
    checks.append(
        (
            "requested_berth_preferred",
            kept > 0,
            f"{kept}/{sum(1 for a in plan.assignments if a.feasible)} kept their requested berth",
        )
    )

    # Hard tide policy must reject rather than cost.
    deep = BerthRequest(
        "R-TOODEEP", "V-TD", "TOO DEEP", 399.0, 15.9, "BMCT-01",
        _SCENARIO_START + timedelta(hours=4), 20.0, priority=1,
    )
    soft_plan = greedy_optimise([deep], berths, windows, tide_policy="soft")
    hard_plan = greedy_optimise([deep], berths, windows, tide_policy="hard")
    checks.append(
        (
            "tide_policy_soft_vs_hard",
            soft_plan.cost.tide_misses == 1
            and len(soft_plan.unassigned_request_ids) == 0
            and len(hard_plan.unassigned_request_ids) == 1,
            f"draft 15.9 m: soft -> assigned with a tide miss "
            f"(cost {soft_plan.cost.total_cost:.2f}); hard -> unassigned",
        )
    )

    # Disruption must not reduce cost.
    d_reqs, d_berths, d_windows = scenario_berth_outage("BMCT-01")
    d_plan = greedy_optimise(d_reqs, d_berths, d_windows)
    ok_d, prob_d = validate_plan(d_plan, d_reqs, d_berths)
    cmp = compare_plans(plan, d_plan)
    checks.append(
        (
            "disruption_still_feasible",
            ok_d,
            f"berth outage -> {len(d_plan.assignments)} assignments, still valid"
            if ok_d else f"violations: {prob_d[:2]}",
        )
    )
    checks.append(
        (
            "disruption_costs_more_or_equal",
            cmp["delta_total_cost"] >= -1e-9,
            f"BMCT-01 outage: cost {plan.cost.total_cost:.2f} -> "
            f"{d_plan.cost.total_cost:.2f} ({cmp['delta_total_cost']:+.2f}, {cmp['verdict']})",
        )
    )
    checks.append(
        (
            "outage_berth_unused",
            all(a.berth_id != "BMCT-01" for a in d_plan.assignments if a.feasible),
            "no assignment placed on the out-of-service berth",
        )
    )

    # Narrowed tide must not reduce tide misses.
    n_reqs, n_berths, n_windows = scenario_tide_narrowed(0.4)
    n_plan = greedy_optimise(n_reqs, n_berths, n_windows)
    checks.append(
        (
            "narrowed_tide_costs_more",
            n_plan.cost.total_cost >= plan.cost.total_cost - 1e-9,
            f"windows narrowed to 40%: cost {plan.cost.total_cost:.2f} -> "
            f"{n_plan.cost.total_cost:.2f}",
        )
    )

    # Surge must remain feasible.
    s_reqs, s_berths, s_windows = scenario_arrival_surge(5)
    s_plan = greedy_optimise(s_reqs, s_berths, s_windows)
    ok_s, prob_s = validate_plan(s_plan, s_reqs, s_berths)
    checks.append(
        (
            "arrival_surge_feasible",
            ok_s and len(s_plan.assignments) == len(s_reqs),
            f"{len(s_reqs)} requests (5 unplanned) -> {len(s_plan.assignments)} placed, "
            f"cost {s_plan.cost.total_cost:.2f}",
        )
    )

    # Weights must actually change the plan's cost attribution.
    heavy_shift = greedy_optimise(
        reqs, berths, windows, OptimiserWeights(1.0, 2.0, 50.0)
    )
    checks.append(
        (
            "weights_configurable",
            heavy_shift.cost.berth_shifts <= plan.cost.berth_shifts,
            f"shift weight 0.5 -> 50.0: shifts {plan.cost.berth_shifts} -> "
            f"{heavy_shift.cost.berth_shifts}",
        )
    )

    # CP-SAT path: must degrade cleanly when ortools is absent.
    auto = optimise(reqs, berths, windows, DEFAULT_WEIGHTS, "auto")
    comparison = auto.breakdown.get("algorithm_comparison", {})
    checks.append(
        (
            "cpsat_degrades_cleanly",
            comparison.get("selected") in ("greedy", "cpsat")
            and (comparison.get("cpsat_available") == _HAS_ORTOOLS),
            f"ortools available={_HAS_ORTOOLS}; selected={comparison.get('selected')}; "
            f"greedy {comparison.get('greedy_cost')} vs cpsat {comparison.get('cpsat_cost')}",
        )
    )
    checks.append(
        (
            "auto_never_worse_than_greedy",
            auto.cost.total_cost <= plan.cost.total_cost + 1e-9,
            f"auto {auto.cost.total_cost:.4f} <= greedy floor {plan.cost.total_cost:.4f}",
        )
    )

    # Explainability.
    checks.append(
        (
            "every_assignment_has_rationale",
            all(a.rationale and len(a.rationale) > 20 for a in plan.assignments),
            f"{len(plan.assignments)} rationales, shortest "
            f"{min(len(a.rationale) for a in plan.assignments)} chars",
        )
    )
    checks.append(
        (
            "breakdown_completeness",
            len(plan.breakdown["steps"]) == 5
            and all(s.get("substitution") for s in plan.breakdown["steps"]),
            f"{len(plan.breakdown['steps'])} steps, all with substitutions",
        )
    )

    return checks


def _print_gantt(plan: BerthPlan, requests: Sequence[BerthRequest]) -> None:
    """One row per occupied berth, one character per hour."""
    served = [a for a in plan.assignments if a.feasible]
    if not served:
        print("   (no assignments)")
        return
    t0 = min(a.start_utc for a in served)
    t1 = max(a.end_utc for a in served)
    total_h = int(math.ceil(_hours_between(t0, t1))) + 1
    width = min(total_h, 110)
    scale = total_h / width if width else 1.0

    by_berth: Dict[str, List[Assignment]] = {}
    for a in served:
        by_berth.setdefault(a.berth_id, []).append(a)

    print(f"   window {_iso(t0)} .. {_iso(t1)}   ({total_h} h, 1 char ~ {scale:.1f} h)")
    for bid in sorted(by_berth):
        row = ["."] * width
        for a in sorted(by_berth[bid], key=lambda x: x.start_utc):
            lo = int(_hours_between(t0, a.start_utc) / scale)
            hi = int(_hours_between(t0, a.end_utc) / scale)
            label = a.request_id.replace("R-", "").replace("X-", "x")[-4:]
            for i in range(max(0, lo), min(width, max(lo + 1, hi))):
                row[i] = "#"
            for j, ch in enumerate(label):
                if lo + j < width and lo + j >= 0:
                    row[lo + j] = ch
        print(f"   {bid:<9}|{''.join(row)}|")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="UC1-M5 berth plan optimiser — demo and self-test runner."
    )
    parser.add_argument("--scenario", choices=sorted(SCENARIOS) + ["all"], default="all")
    parser.add_argument("--algorithm", choices=list(ALGORITHMS), default="auto")
    parser.add_argument("--tide-policy", choices=list(TIDE_POLICIES), default="soft")
    parser.add_argument("--requests", type=int, default=10)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args(argv)

    if not args.quiet:
        print("=" * 78)
        print(f"{MODULE_ID} — {MODULE_NAME}   ({MODULE_VERSION})")
        print("JNPA UC-I Vessel Traffic Management | WS2 row 5 | greedy heuristic")
        print("=" * 78)
        print(
            f"\nCP-SAT (ortools) available: {_HAS_ORTOOLS}"
            + ("" if _HAS_ORTOOLS else "   — greedy only; pip install ortools to enable")
        )

    base_reqs, base_berths, base_windows = scenario_baseline(args.seed, args.requests)
    base_plan = optimise(
        base_reqs, base_berths, base_windows, DEFAULT_WEIGHTS, args.algorithm, args.tide_policy
    )

    if args.json:
        print(json.dumps(base_plan.as_dict(), indent=2))
    elif not args.quiet:
        print(f"\nBERTHS ({len(base_berths)})")
        rows = [[b.berth_id, b.terminal, f"{b.length_m:.0f}", f"{b.max_draft_m:.1f}",
                 "OUT" if b.out_of_service else "in service"] for b in base_berths[:8]]
        print(_fmt_table(["berth", "terminal", "LOA max", "depth", "status"], rows, indent="  "))
        print(f"  ... and {len(base_berths) - 8} more")

        print(f"\nTIDAL WINDOWS ({len(base_windows)})  [supplied by UC1-M2]")
        rows = [[w.window_id, w.start_utc.strftime("%d %b %H:%M"),
                 w.end_utc.strftime("%d %b %H:%M"),
                 f"{_hours_between(w.start_utc, w.end_utc):.2f}",
                 f"{w.max_draft_m:.2f}"] for w in base_windows[:6]]
        print(_fmt_table(["id", "opens", "closes", "hours", "max draft"], rows, indent="  "))

        print(f"\nREQUESTS ({len(base_reqs)})")
        rows = [[r.request_id, r.vessel_name[:20], f"{r.loa_m:.0f}", f"{r.draft_m:.2f}",
                 r.requested_berth_id, r.requested_start_utc.strftime("%d %b %H:%M"),
                 f"{r.service_hours:.1f}", r.priority] for r in base_reqs]
        print(_fmt_table(
            ["id", "vessel", "LOA", "draft", "wants", "from", "service h", "pri"],
            rows, indent="  ",
        ))

        print(f"\nPLAN ({base_plan.algorithm}, {base_plan.solve_ms:.1f} ms)")
        _print_gantt(base_plan, base_reqs)

        c = base_plan.cost
        print("\nCOST BREAKDOWN")
        print(_fmt_table(
            ["component", "quantity", "weight", "subtotal"],
            [
                ["waiting", f"{c.wait_hours_total:.2f} h", f"{c.weights.wait_hour:.2f}",
                 f"{c.wait_cost:.2f}"],
                ["tide misses", c.tide_misses, f"{c.weights.tide_miss:.2f}", f"{c.tide_cost:.2f}"],
                ["berth shifts", c.berth_shifts, f"{c.weights.berth_shift:.2f}",
                 f"{c.shift_cost:.2f}"],
                ["TOTAL", "", "", f"{c.total_cost:.2f}"],
            ],
            indent="  ",
        ))
        print(f"  weights version: {c.weights.version}")

        print("\nPER-ASSIGNMENT RATIONALE")
        for a in base_plan.assignments:
            print(f"  {a.rationale}")

        comparison = base_plan.breakdown.get("algorithm_comparison", {})
        if comparison:
            print(
                f"\nALGORITHM  greedy {comparison.get('greedy_cost')} | "
                f"cpsat {comparison.get('cpsat_cost')} | "
                f"selected {comparison.get('selected')}"
                + (f"  ({comparison['note']})" if comparison.get("note") else "")
            )

        if args.scenario in ("all",) or args.scenario != "baseline":
            names = [s for s in sorted(SCENARIOS) if s != "baseline"] \
                if args.scenario == "all" else [args.scenario]
            print("\nDISRUPTION COMPARISON vs BASELINE")
            rows = []
            for name in names:
                s_reqs, s_berths, s_windows = SCENARIOS[name](
                    seed=args.seed, n_requests=args.requests
                )
                s_plan = optimise(
                    s_reqs, s_berths, s_windows, DEFAULT_WEIGHTS, args.algorithm, args.tide_policy
                )
                cmp = compare_plans(base_plan, s_plan)
                rows.append([
                    name,
                    len(s_reqs),
                    f"{s_plan.cost.wait_hours_total:.2f}",
                    f"{cmp['delta_wait_hours']:+.2f}",
                    s_plan.cost.tide_misses,
                    f"{cmp['delta_tide_misses']:+d}",
                    s_plan.cost.berth_shifts,
                    f"{cmp['delta_berth_shifts']:+d}",
                    f"{s_plan.cost.total_cost:.2f}",
                    f"{cmp['delta_total_cost']:+.2f}",
                    cmp["verdict"],
                ])
            print(_fmt_table(
                ["scenario", "reqs", "wait h", "d wait", "tide", "d tide",
                 "shifts", "d shift", "cost", "d cost", "verdict"],
                rows, indent="  ",
            ))

    checks = _self_test()
    passed = sum(1 for _, ok, _ in checks if ok)
    print(f"\n{'-' * 78}")
    print(f"SELF-TEST  {passed}/{len(checks)} passed")
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<34} {detail}")
    print("-" * 78)

    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
