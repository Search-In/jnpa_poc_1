"""
UC1-M7 — Port-Craft Assignment & Conflict Detection (Pilot / Tug / Mooring)
===========================================================================

Jawaharlal Nehru Port Authority (JNPA) — Workstream 2, UC-I Vessel Traffic
Management & Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"Do we have enough pilots, tugs and mooring launches to service the movements
scheduled in the next few hours — and if not, what single change fixes it?"

Craft shortage is briefing edge case EC-4. Recommendations must be explainable
to marine control, so every proposal changes exactly ONE thing and quotes the
response-gap minutes it closes.

ROSTER — A DOCUMENTED DISCREPANCY WITH THE SPEC
------------------------------------------------
``WS2_AI_ML_Tools.md`` row 7 states the roster is "9 craft: 3 pilots, 4 tugs,
2 mooring" and cites ``Details_of_Port_Crafts.pdf`` as its source. That PDF
actually lists **18 craft**:

    10 tugs           Ocean Divine / Freedom / Victor / Crest (50 T),
                      KNK Disha, Daisy Star, Lotus Star (60 T),
                      Ocean Swan 3, Konna Star, Mogra Star (70 T)
     4 pilot launches S.B.Sarala, PL.Pacific-7, SHM-XXV, SHM-XXVI
     1 utility launch SHM-XXIV (multipurpose)
     2 security launches S.B. Pacific-1, SHM XXVII
     1 VIP launch     M.L Chetak (the only JNPA-owned craft; the rest are hired)

This module therefore ships BOTH:

    JNPA_ROSTER_REAL  — 18 craft, transcribed verbatim from the PDF (default)
    JNPA_ROSTER_POC   — the spec's 9-craft figure, for regression against WS2

The real roster is the default because it is what the cited source document
says. The PoC roster is retained so the WS2 table remains reproducible, and
because a 10-tug fleet rarely triggers the shortage the demo needs to show.

ROLE MAPPING (stated as an assumption, not smuggled in)
-------------------------------------------------------
The PDF gives craft TYPE, not operational role. The mapping used here is:

    Tug                        -> {TUG}
    Pilot Launch               -> {PILOT}
    MultiPurpose Utility Launch-> {MOORING}
    Security Launch            -> {MOORING}   [ASSUMED dual-role: security
                                   launches assist line handling when the
                                   utility launch is committed]
    VIP Launch                 -> {}          [not available commercially]

Response times are NOT in the PDF. They are assumed and every craft carries
``response_time_source="ASSUMED"`` so the figure is never mistaken for source
data.

CORRECTNESS: INTERVAL-AWARE ALLOCATION
---------------------------------------
A craft serves ONE movement at a time. Allocation therefore tracks per-craft
busy intervals and will not hand the same pilot to two overlapping movements.
This is checked permanently by ``_self_test`` — a naive implementation that
slices an availability pool per movement produces physically impossible plans
that still look fine in the conflict report.

CONFLICT DETECTION
------------------
The window is stepped at 15 min. Consecutive deficit steps of the same role are
merged into ONE conflict block with a start, an end and a peak deficit, rather
than emitting one row per timestep.

USAGE
-----
    python uc1_m7_port_craft.py                      # full demo, exits 0
    python uc1_m7_port_craft.py --roster real
    python uc1_m7_port_craft.py --scenario two-pilots-down --json

SELF-CONTAINMENT POLICY
-----------------------
Standard library only above SECTION 6. FastAPI/pydantic optional.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

# ==========================================================================
# SECTION 1 — MODULE IDENTITY AND VERSIONED CONSTANTS
# ==========================================================================

MODULE_ID: str = "UC1-M7"
MODULE_NAME: str = "Port-Craft Assignment & Conflict Detection"
MODULE_VERSION: str = "m7-portcraft-v1.0.0"
ROUTER_PREFIX: str = "/uc1/m7"

DEFAULT_SEED: int = 20260807

ROLE_PILOT: str = "PILOT"
ROLE_TUG: str = "TUG"
ROLE_MOORING: str = "MOORING"
CRAFT_ROLES: Tuple[str, ...] = (ROLE_PILOT, ROLE_TUG, ROLE_MOORING)

STATUS_AVAILABLE: str = "AVAILABLE"
STATUS_DOWN: str = "DOWN"
STATUS_MAINTENANCE: str = "MAINTENANCE"

MOVEMENT_BERTHING: str = "BERTHING"
MOVEMENT_SAILING: str = "SAILING"
MOVEMENT_SHIFTING: str = "SHIFTING"

DEFAULT_STEP_MINUTES: int = 15
SWAP_DELAY_GRANULARITY_MIN: int = 5
MAX_DELAY_MINUTES: int = 360

# Cost of leaving one required slot unfilled, in "gap minutes". Set well above
# any realistic response time so filling a slot always beats shaving minutes off
# an already-covered one.
UNFILLED_SLOT_PENALTY_MIN: float = 120.0

NO_BOW_THRUSTER_EXTRA_TUGS: int = 1

SEVERITY_CRITICAL: str = "CRITICAL"
SEVERITY_HIGH: str = "HIGH"
SEVERITY_MEDIUM: str = "MEDIUM"

# Craft requirement per (movement type, vessel class). Duration is the period
# the craft are committed, not the vessel's total manoeuvre.
_REQ = "CraftRequirement"


@dataclass(frozen=True)
class CraftRequirement:
    """Craft committed to one movement, and for how long."""

    pilots: int
    tugs: int
    mooring: int
    duration_hours: float

    def get(self, role: str) -> int:
        return {
            ROLE_PILOT: self.pilots,
            ROLE_TUG: self.tugs,
            ROLE_MOORING: self.mooring,
        }[role]


REQUIREMENTS: Dict[Tuple[str, str], CraftRequirement] = {
    (MOVEMENT_BERTHING, "ULCV"): CraftRequirement(1, 3, 1, 2.5),
    (MOVEMENT_BERTHING, "POST_PANAMAX"): CraftRequirement(1, 2, 1, 2.0),
    (MOVEMENT_BERTHING, "PANAMAX"): CraftRequirement(1, 2, 1, 2.0),
    (MOVEMENT_BERTHING, "FEEDER"): CraftRequirement(1, 1, 1, 1.5),
    (MOVEMENT_SAILING, "ULCV"): CraftRequirement(1, 2, 1, 2.0),
    (MOVEMENT_SAILING, "POST_PANAMAX"): CraftRequirement(1, 2, 1, 1.5),
    (MOVEMENT_SAILING, "PANAMAX"): CraftRequirement(1, 1, 1, 1.5),
    (MOVEMENT_SAILING, "FEEDER"): CraftRequirement(1, 1, 0, 1.0),
    (MOVEMENT_SHIFTING, "ULCV"): CraftRequirement(1, 2, 1, 1.5),
    (MOVEMENT_SHIFTING, "POST_PANAMAX"): CraftRequirement(1, 2, 1, 1.5),
    (MOVEMENT_SHIFTING, "PANAMAX"): CraftRequirement(1, 1, 1, 1.0),
    (MOVEMENT_SHIFTING, "FEEDER"): CraftRequirement(1, 1, 0, 1.0),
}

VESSEL_CLASSES: Tuple[str, ...] = ("ULCV", "POST_PANAMAX", "PANAMAX", "FEEDER")

# Documented mapping from the PDF's craft TYPE column to operational roles.
ROLE_MAP: Dict[str, Tuple[str, ...]] = {
    "Tug": (ROLE_TUG,),
    "Pilot Launch": (ROLE_PILOT,),
    "MultiPurpose Utility Launch": (ROLE_MOORING,),
    "Security Launch": (ROLE_MOORING,),      # ASSUMED dual-role
    "VIP Launch": (),                        # not available commercially
    "Mooring Boat": (ROLE_MOORING,),         # used by the PoC roster only
}

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


def _minutes_between(a: datetime, b: datetime) -> float:
    """Signed minutes from ``a`` to ``b``. DUPLICATED BY DESIGN."""
    return (_ensure_utc(b) - _ensure_utc(a)).total_seconds() / 60.0


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
class PortCraft:
    """
    One port craft. Physical particulars are verbatim from
    ``Details_of_Port_Crafts.pdf``; response time and status are operational
    state and are flagged as assumed where they are not in the source.
    """

    craft_id: str
    name: str
    craft_type: str                     # PDF 'Type' column, verbatim
    roles: Tuple[str, ...]              # operational roles, via ROLE_MAP
    response_time_min: int
    status: str = STATUS_AVAILABLE
    owner: str = ""
    owned: bool = False                 # True = JNPA owned, False = hired
    year_built: str = ""
    loa_m: Optional[float] = None
    breadth_m: Optional[float] = None
    draft_m: Optional[float] = None
    bollard_pull_t: Optional[float] = None
    designed_speed_kn: Optional[float] = None
    base_location: str = "Pilot Jetty"
    response_time_source: str = "ASSUMED"

    @property
    def serviceable(self) -> bool:
        return self.status == STATUS_AVAILABLE

    def can_fill(self, role: str) -> bool:
        return role in self.roles

    def as_dict(self) -> Dict[str, Any]:
        return {
            "craft_id": self.craft_id,
            "name": self.name,
            "craft_type": self.craft_type,
            "roles": list(self.roles),
            "response_time_min": self.response_time_min,
            "response_time_source": self.response_time_source,
            "status": self.status,
            "serviceable": self.serviceable,
            "owner": self.owner,
            "owned": self.owned,
            "year_built": self.year_built,
            "loa_m": self.loa_m,
            "breadth_m": self.breadth_m,
            "draft_m": self.draft_m,
            "bollard_pull_t": self.bollard_pull_t,
            "designed_speed_kn": self.designed_speed_kn,
        }


@dataclass(frozen=True)
class VesselMovement:
    """One pilotage movement requiring craft."""

    movement_id: str
    vessel_id: str
    vessel_name: str
    movement_type: str                  # BERTHING | SAILING | SHIFTING
    vessel_class: str                   # ULCV | POST_PANAMAX | PANAMAX | FEEDER
    berth_id: str
    start_utc: datetime
    end_utc: datetime
    req_pilots: int
    req_tugs: int
    req_mooring: int
    priority: int = 5                   # lower number = higher priority
    has_bow_thruster: bool = True
    tide_locked: bool = False           # cannot be delayed without losing the tide

    def required(self, role: str) -> int:
        return {
            ROLE_PILOT: self.req_pilots,
            ROLE_TUG: self.req_tugs,
            ROLE_MOORING: self.req_mooring,
        }[role]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "movement_id": self.movement_id,
            "vessel_id": self.vessel_id,
            "vessel_name": self.vessel_name,
            "movement_type": self.movement_type,
            "vessel_class": self.vessel_class,
            "berth_id": self.berth_id,
            "start_utc": _iso(self.start_utc),
            "end_utc": _iso(self.end_utc),
            "req_pilots": self.req_pilots,
            "req_tugs": self.req_tugs,
            "req_mooring": self.req_mooring,
            "priority": self.priority,
            "has_bow_thruster": self.has_bow_thruster,
            "tide_locked": self.tide_locked,
        }


@dataclass(frozen=True)
class CraftAllocation:
    """Craft actually assigned to one movement, plus any shortfall."""

    movement_id: str
    pilot_ids: Tuple[str, ...]
    tug_ids: Tuple[str, ...]
    mooring_ids: Tuple[str, ...]
    expected_response_min: float
    shortfall: Dict[str, int]
    feasible: bool
    response_gap_min: float
    note: str = ""

    def ids_for(self, role: str) -> Tuple[str, ...]:
        return {
            ROLE_PILOT: self.pilot_ids,
            ROLE_TUG: self.tug_ids,
            ROLE_MOORING: self.mooring_ids,
        }[role]

    def all_ids(self) -> Tuple[str, ...]:
        return self.pilot_ids + self.tug_ids + self.mooring_ids

    def as_dict(self) -> Dict[str, Any]:
        return {
            "movement_id": self.movement_id,
            "pilot_ids": list(self.pilot_ids),
            "tug_ids": list(self.tug_ids),
            "mooring_ids": list(self.mooring_ids),
            "expected_response_min": round(self.expected_response_min, 2),
            "shortfall": dict(self.shortfall),
            "feasible": self.feasible,
            "response_gap_min": round(self.response_gap_min, 2),
            "note": self.note,
        }


@dataclass(frozen=True)
class DemandPoint:
    """Demand vs supply for one role at one timestep."""

    t: datetime
    role: str
    demand: int
    supply: int
    deficit: int
    movement_ids: Tuple[str, ...]


@dataclass(frozen=True)
class Conflict:
    """A merged, contiguous block where demand exceeds serviceable supply."""

    conflict_id: str
    role: str
    start_utc: datetime
    end_utc: datetime
    peak_demand: int
    supply: int
    peak_deficit: int
    movement_ids: Tuple[str, ...]
    severity: str
    detail: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "conflict_id": self.conflict_id,
            "role": self.role,
            "start_utc": _iso(self.start_utc),
            "end_utc": _iso(self.end_utc),
            "duration_min": round(_minutes_between(self.start_utc, self.end_utc), 1),
            "peak_demand": self.peak_demand,
            "supply": self.supply,
            "peak_deficit": self.peak_deficit,
            "movement_ids": list(self.movement_ids),
            "severity": self.severity,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class SwapProposal:
    """
    A single-unit change proposed to marine control.

    Exactly one thing changes: one craft moves, one craft is substituted, or one
    movement is delayed. Anything larger is not explainable on a radio call.
    """

    proposal_id: str
    conflict_id: str
    action: str                          # REASSIGN | SUBSTITUTE | DELAY
    craft_id_from: Optional[str]
    craft_id_to: Optional[str]
    movement_id: str
    donor_movement_id: Optional[str]
    delay_minutes: int
    response_gap_before_min: float
    response_gap_after_min: float
    gap_closed_minutes: float
    residual_deficit: int
    creates_new_conflict: bool
    rationale: str
    basis: str = "SIMULATED delta vs do-nothing"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "proposal_id": self.proposal_id,
            "conflict_id": self.conflict_id,
            "action": self.action,
            "craft_id_from": self.craft_id_from,
            "craft_id_to": self.craft_id_to,
            "movement_id": self.movement_id,
            "donor_movement_id": self.donor_movement_id,
            "delay_minutes": self.delay_minutes,
            "response_gap_before_min": round(self.response_gap_before_min, 2),
            "response_gap_after_min": round(self.response_gap_after_min, 2),
            "gap_closed_minutes": round(self.gap_closed_minutes, 2),
            "residual_deficit": self.residual_deficit,
            "creates_new_conflict": self.creates_new_conflict,
            "rationale": self.rationale,
            "basis": self.basis,
        }


@dataclass(frozen=True)
class PortCraftReport:
    """Complete M7 evaluation for one window."""

    scenario: str
    roster_preset: str
    window_start_utc: datetime
    window_end_utc: datetime
    roster_summary: Dict[str, Any]
    movements: Tuple[VesselMovement, ...]
    allocations: Tuple[CraftAllocation, ...]
    conflicts: Tuple[Conflict, ...]
    proposals: Tuple[SwapProposal, ...]
    utilisation_pct: Dict[str, float]
    total_response_gap_min: float
    status: str                          # FEASIBLE | CONFLICT_DETECTED
    recommendation: str
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "scenario": self.scenario,
            "roster_preset": self.roster_preset,
            "window_start_utc": _iso(self.window_start_utc),
            "window_end_utc": _iso(self.window_end_utc),
            "roster_summary": self.roster_summary,
            "movements": [m.as_dict() for m in self.movements],
            "allocations": [a.as_dict() for a in self.allocations],
            "conflicts": [c.as_dict() for c in self.conflicts],
            "proposals": [p.as_dict() for p in self.proposals],
            "utilisation_pct": {k: round(v, 2) for k, v in self.utilisation_pct.items()},
            "total_response_gap_min": round(self.total_response_gap_min, 2),
            "status": self.status,
            "recommendation": self.recommendation,
            "breakdown": self.breakdown,
        }


# ==========================================================================
# SECTION 4 — ROSTERS AND DATA PROVIDERS
# ==========================================================================

# --------------------------------------------------------------------------
# JNPA_ROSTER_REAL — transcribed verbatim from Details_of_Port_Crafts.pdf.
# Physical particulars (owner, year, LOA, breadth, draft, bollard pull, speed)
# are source data. Response times are ASSUMED, per the module docstring.
# --------------------------------------------------------------------------
_REAL_CRAFT: Tuple[Tuple[Any, ...], ...] = (
    # (id, name, type, owner, owned, year, loa, breadth, draft, bollard/-, speed, response_min)
    ("TG-01", "Ocean Divine", "Tug", "M/s Ocean Sparkle Ltd.", False, "Apr-18",
     30.31, 12.00, 4.30, 50.0, 12.00, 20),
    ("TG-02", "Ocean Freedom", "Tug", "M/s Ocean Sparkle Ltd.", False, "Mar-17",
     32.00, 11.50, 4.20, 50.0, 12.00, 20),
    ("TG-03", "Ocean Victor", "Tug", "M/s Ocean Sparkle Ltd.", False, "Dec-19",
     29.73, 10.60, 4.20, 50.0, 12.00, 25),
    ("TG-04", "Ocean Crest", "Tug", "M/s Ocean Sparkle Ltd.", False, "Sep-22",
     28.69, 12.00, 4.30, 50.0, 12.00, 20),
    ("TG-05", "Ocean Swan 3", "Tug", "M/s Ocean Sparkle Ltd", False, "Apr-20",
     32.00, 12.41, 5.28, 70.0, 12.00, 15),
    ("TG-06", "KNK Disha", "Tug", "M/s KNK Ship Management", False, "Dec-16",
     30.23, 12.00, 4.19, 60.0, 12.50, 20),
    ("TG-07", "Daisy Star", "Tug", "M/s Polestar Maritime Ltd", False, "Nov-16",
     30.28, 12.41, 4.40, 60.0, 12.00, 25),
    ("TG-08", "Lotus Star", "Tug", "M/s Polestar Maritime Ltd", False, "Jan-17",
     30.32, 12.41, 4.20, 60.0, 12.00, 25),
    ("TG-09", "Konna Star", "Tug", "M/s Polestar Maritime Ltd", False, "May-24",
     33.00, 12.20, 4.20, 70.0, 12.50, 15),
    ("TG-10", "Mogra Star", "Tug", "M/s Polestar Maritime Ltd", False, "Sep-24",
     31.03, 12.20, 4.20, 70.0, 12.50, 15),
    ("PL-01", "S.B.Sarala", "Pilot Launch", "M/s Sadhav Shipping Ltd", False, "2020",
     18.00, 4.50, 2.25, None, 20.00, 15),
    ("PL-02", "PL.Pacific-7", "Pilot Launch", "M/s Pacific Shipping Services", False, "2025",
     18.00, 4.50, 2.25, None, 20.00, 15),
    ("PL-03", "SHM-XXV", "Pilot Launch", "M/s SHM Ship Care Pvt Ltd", False, "Jan-19",
     19.40, 4.67, 0.75, None, 20.00, 20),
    ("PL-04", "SHM-XXVI", "Pilot Launch", "M/s SHM Ship Care Pvt Ltd", False, "Jan-19",
     19.40, 4.67, 0.75, None, 20.00, 20),
    ("ML-01", "SHM-XXIV", "MultiPurpose Utility Launch", "M/s SHM Ship Care Pvt Ltd", False,
     "2017", 12.43, 3.85, 0.60, None, 20.00, 10),
    ("SL-01", "S.B. Pacific-1", "Security Launch", "M/s Pacific Shipping Services", False,
     "2018", 14.50, 3.80, 0.65, None, 20.00, 15),
    ("SL-02", "SHM XXVII", "Security Launch", "M/s SHM Ship Care Pvt Ltd", False, "2023",
     15.02, 3.77, 0.60, None, 20.00, 15),
    ("VL-01", "M.L Chetak", "VIP Launch", "JNPA", True, "2018",
     15.00, 5.50, 1.20, None, 20.00, 20),
)


def _build_real_roster() -> Tuple[PortCraft, ...]:
    out: List[PortCraft] = []
    for (cid, name, ctype, owner, owned, year, loa, beam, draft,
         bollard, speed, resp) in _REAL_CRAFT:
        out.append(
            PortCraft(
                craft_id=cid,
                name=name,
                craft_type=ctype,
                roles=ROLE_MAP.get(ctype, ()),
                response_time_min=resp,
                status=STATUS_AVAILABLE,
                owner=owner,
                owned=owned,
                year_built=year,
                loa_m=loa,
                breadth_m=beam,
                draft_m=draft,
                bollard_pull_t=bollard,
                designed_speed_kn=speed,
                response_time_source="ASSUMED (not in Details_of_Port_Crafts.pdf)",
            )
        )
    return tuple(out)


JNPA_ROSTER_REAL: Tuple[PortCraft, ...] = _build_real_roster()


def _build_poc_roster() -> Tuple[PortCraft, ...]:
    """
    The spec's 9-craft PoC roster: 3 pilots, 4 tugs, 2 mooring.

    Retained so WS2_AI_ML_Tools.md row 7 stays reproducible, and because a
    10-tug fleet rarely produces the shortage the demo needs to illustrate.
    """
    spec: Tuple[Tuple[str, str, str, int, Optional[float]], ...] = (
        ("PL-01", "Pilot Launch 1", "Pilot Launch", 15, None),
        ("PL-02", "Pilot Launch 2", "Pilot Launch", 15, None),
        ("PL-03", "Pilot Launch 3", "Pilot Launch", 20, None),
        ("TG-01", "Tug 1", "Tug", 20, 60.0),
        ("TG-02", "Tug 2", "Tug", 20, 60.0),
        ("TG-03", "Tug 3", "Tug", 15, 80.0),
        ("TG-04", "Tug 4", "Tug", 25, 80.0),
        ("MB-01", "Mooring Boat 1", "Mooring Boat", 10, None),
        ("MB-02", "Mooring Boat 2", "Mooring Boat", 10, None),
    )
    return tuple(
        PortCraft(
            craft_id=cid,
            name=name,
            craft_type=ctype,
            roles=ROLE_MAP.get(ctype, ()),
            response_time_min=resp,
            bollard_pull_t=bollard,
            owner="per WS2_AI_ML_Tools.md row 7",
            response_time_source="ASSUMED (spec PoC roster)",
        )
        for cid, name, ctype, resp, bollard in spec
    )


JNPA_ROSTER_POC: Tuple[PortCraft, ...] = _build_poc_roster()

ROSTER_PRESETS: Dict[str, Tuple[PortCraft, ...]] = {
    "real": JNPA_ROSTER_REAL,
    "poc": JNPA_ROSTER_POC,
}


def build_default_roster(preset: str = "real") -> List[PortCraft]:
    """Return a mutable copy of a named roster preset."""
    key = (preset or "real").strip().lower()
    if key not in ROSTER_PRESETS:
        raise ValueError(f"roster preset must be one of {sorted(ROSTER_PRESETS)}, got {preset!r}")
    return list(ROSTER_PRESETS[key])


def apply_outage(roster: Sequence[PortCraft], down_ids: Iterable[str]) -> List[PortCraft]:
    """Mark named craft DOWN, leaving the rest untouched."""
    down = set(down_ids)
    unknown = down - {c.craft_id for c in roster}
    if unknown:
        raise ValueError(f"unknown craft ids: {sorted(unknown)}")
    return [replace(c, status=STATUS_DOWN) if c.craft_id in down else c for c in roster]


try:  # pragma: no cover
    from typing import Protocol, runtime_checkable
except ImportError:  # pragma: no cover
    Protocol = object  # type: ignore

    def runtime_checkable(c):  # type: ignore
        return c


@runtime_checkable
class CraftRosterLoader(Protocol):
    """Supplies the craft roster and its live status."""

    @property
    def source_id(self) -> str: ...

    def load_roster(self) -> List[PortCraft]: ...


class EmbeddedRosterLoader:
    """The transcribed PDF roster. Default; no I/O."""

    def __init__(self, preset: str = "real") -> None:
        self.preset = preset

    @property
    def source_id(self) -> str:
        return f"EMBEDDED_ROSTER/{self.preset}/Details_of_Port_Crafts.pdf"

    def load_roster(self) -> List[PortCraft]:
        return build_default_roster(self.preset)


class PortCraftLiveStatusLoader:
    """
    REAL-DATA STUB — live craft status and survey validity.

    The particulars in ``JNPA_ROSTER_REAL`` are already transcribed from
    ``Details_of_Port_Crafts.pdf``, so this stub covers only what the PDF does
    NOT contain: current availability.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Source (when a live feed exists): marine control craft board / VTS roster.
    Needed per craft:
        craft_id (join key on name -> our TG-/PL-/ML- ids),
        status AVAILABLE|DOWN|MAINTENANCE,
        current base location,
        survey / certificate validity date,
        measured response time in minutes (replacing the ASSUMED figures).

    Until that feed exists, response times stay ASSUMED and every PortCraft
    reports response_time_source accordingly — the figure must never be quoted
    as source data.
    """

    source_id = "JNPA_CRAFT_LIVE_STATUS/NOT_IMPLEMENTED"

    def load_roster(self) -> List[PortCraft]:
        raise NotImplementedError(PortCraftLiveStatusLoader.__doc__)


class PilotCardExcelLoader:
    """
    REAL-DATA STUB — vessel particulars driving the craft requirement.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Source:
        Model_Training_Data\\Model_Training_Data\\UC-I_Vessel_Traffic\\
        M7_Port_Craft_Assignment\\Pilot_card_data.xlsx

    Expected columns (confirm on first read): VESSEL NAME, VIA NO, LOA, BEAM,
    DRAFT, BOW THRUSTER (Y/N), CALL DATE.

    Contract: map each row to
        vessel_class    from LOA   (>=350 m ULCV, >=300 POST_PANAMAX,
                                    >=250 PANAMAX, else FEEDER)
        has_bow_thruster from the BOW THRUSTER column
    then look up REQUIREMENTS[(movement_type, vessel_class)] and add
    NO_BOW_THRUSTER_EXTRA_TUGS when the vessel has no thruster.

    Dependency to add when implementing: openpyxl.
    """

    source_id = "JNPA_PILOT_CARD_XLSX/NOT_IMPLEMENTED"

    def load_movements(self, start: datetime, end: datetime) -> List[VesselMovement]:
        raise NotImplementedError(PilotCardExcelLoader.__doc__)


class SyntheticMovementLoader:
    """
    Seeded synthetic movement schedule.

    Deliberately clusters movements around the tidal peaks so overlapping
    demand — and therefore conflict — is reachable. Uses ``random.Random(seed)``,
    never the global RNG.
    """

    source_id = "SYNTHETIC_MOVEMENTS_v1"

    def __init__(self, seed: int = DEFAULT_SEED, n_movements: int = 8) -> None:
        self.seed = seed
        self.n_movements = n_movements

    def load_movements(self, start: datetime, end: datetime) -> List[VesselMovement]:
        rng = random.Random(self.seed)
        start = _ensure_utc(start)
        span_h = max(1.0, _hours_between(start, end))
        names = [
            "MSC VALERIA", "MAERSK HANGZHOU", "CMA CGM MARCO POLO", "OOCL WASHINGTON",
            "HMM LEAF", "KMTC NHAVA SHEVA", "TS SHANGHAI", "AL SAADIYAT",
            "SPIL KARTIKA", "MYD FUZHOU", "ARAYA BHUM", "DP WORLD JEBEL ALI",
        ]
        berths = ["BMCT-01", "BMCT-02", "APMT-01", "APMT-02", "CB-06", "CB02", "CB05", "BMCT-03"]
        out: List[VesselMovement] = []
        for i in range(self.n_movements):
            # Cluster around two tidal peaks so overlaps are realistic.
            peak = 3.0 if i % 2 == 0 else 3.0 + span_h / 2.0
            offset = peak + rng.uniform(-1.5, 1.5)
            offset = max(0.5, min(span_h - 3.0, offset))
            mtype = rng.choice([MOVEMENT_BERTHING, MOVEMENT_BERTHING, MOVEMENT_SAILING])
            vclass = rng.choice(["ULCV", "ULCV", "POST_PANAMAX", "PANAMAX", "FEEDER"])
            req = REQUIREMENTS[(mtype, vclass)]
            thruster = rng.random() > 0.25
            tugs = req.tugs + (0 if thruster else NO_BOW_THRUSTER_EXTRA_TUGS)
            begin = start + timedelta(hours=offset)
            out.append(
                VesselMovement(
                    movement_id=f"MV-{1001 + i}",
                    vessel_id=f"V-{2001 + i}",
                    vessel_name=names[i % len(names)],
                    movement_type=mtype,
                    vessel_class=vclass,
                    berth_id=berths[i % len(berths)],
                    start_utc=begin,
                    end_utc=begin + timedelta(hours=req.duration_hours),
                    req_pilots=req.pilots,
                    req_tugs=tugs,
                    req_mooring=req.mooring,
                    priority=rng.choice([3, 5, 5, 7]),
                    has_bow_thruster=thruster,
                    tide_locked=(vclass == "ULCV" and rng.random() > 0.5),
                )
            )
        return sorted(out, key=lambda m: (m.start_utc, m.movement_id))


# ==========================================================================
# SECTION 5 — ENGINE
# ==========================================================================


def requirements_for(
    movement_type: str, vessel_class: str, has_bow_thruster: bool = True
) -> CraftRequirement:
    """
    Craft requirement for a movement, including the no-thruster tug uplift.

    A vessel without a bow thruster needs an extra tug to hold the head — this
    is the single most common reason a movement's demand exceeds the plan.
    """
    key = (movement_type, vessel_class)
    if key not in REQUIREMENTS:
        raise ValueError(f"no requirement defined for {key}")
    base = REQUIREMENTS[key]
    if has_bow_thruster:
        return base
    return CraftRequirement(
        base.pilots, base.tugs + NO_BOW_THRUSTER_EXTRA_TUGS, base.mooring, base.duration_hours
    )


def serviceable_supply(roster: Sequence[PortCraft]) -> Dict[str, List[str]]:
    """Serviceable craft ids per role. A craft may serve more than one role."""
    out: Dict[str, List[str]] = {r: [] for r in CRAFT_ROLES}
    for c in roster:
        if not c.serviceable:
            continue
        for role in c.roles:
            if role in out:
                out[role].append(c.craft_id)
    return {r: sorted(v) for r, v in out.items()}


def allocate_craft(
    movements: Sequence[VesselMovement],
    roster: Sequence[PortCraft],
    now_utc: Optional[datetime] = None,
    pinned: Optional[Mapping[str, Sequence[str]]] = None,
) -> List[CraftAllocation]:
    """
    Assign craft to movements, respecting exclusivity in time.

    A craft is allocatable to a movement only when
      (a) it has NO allocation overlapping that movement's window, and
      (b) it can physically get there: ``start - now >= response_time_min``.

    Movements are served in ``(priority, start_utc, movement_id)`` order and
    craft are chosen lowest-response-time first, tie-broken on ``craft_id``, so
    the result is fully deterministic.

    ``pinned`` optionally forces specific craft to a movement — used by the swap
    search to evaluate "what if this unit went there instead".

    Shortfalls are RECORDED, never papered over by handing out a craft that is
    already committed. That distinction is what makes the output a real plan
    rather than a wish list.
    """
    now = _ensure_utc(now_utc) if now_utc is not None else min(
        (_ensure_utc(m.start_utc) for m in movements), default=_utc_now()
    ) - timedelta(hours=1)
    pinned = {k: list(v) for k, v in (pinned or {}).items()}

    by_id = {c.craft_id: c for c in roster}
    busy: Dict[str, List[Tuple[datetime, datetime]]] = {c.craft_id: [] for c in roster}

    def _free(craft_id: str, start: datetime, end: datetime) -> bool:
        return not any(_intervals_overlap(start, end, a, b) for a, b in busy[craft_id])

    ordered = sorted(movements, key=lambda m: (m.priority, m.start_utc, m.movement_id))
    allocations: Dict[str, CraftAllocation] = {}

    for mv in ordered:
        start = _ensure_utc(mv.start_utc)
        end = _ensure_utc(mv.end_utc)
        lead_min = _minutes_between(now, start)

        assigned: Dict[str, List[str]] = {r: [] for r in CRAFT_ROLES}
        shortfall: Dict[str, int] = {}

        for role in CRAFT_ROLES:
            need = mv.required(role)
            if need <= 0:
                continue

            # Pinned units get first refusal, then the rest by response time.
            pin_ids = [
                cid for cid in pinned.get(mv.movement_id, [])
                if cid in by_id and by_id[cid].can_fill(role) and by_id[cid].serviceable
            ]
            others = sorted(
                (c for c in roster
                 if c.serviceable and c.can_fill(role) and c.craft_id not in pin_ids),
                key=lambda c: (c.response_time_min, c.craft_id),
            )
            candidates = [by_id[c] for c in pin_ids] + others

            for craft in candidates:
                if len(assigned[role]) >= need:
                    break
                if craft.craft_id in assigned[role]:
                    continue
                # A craft already committed to this movement in another role
                # cannot double up.
                if any(craft.craft_id in assigned[r] for r in CRAFT_ROLES):
                    continue
                if not _free(craft.craft_id, start, end):
                    continue
                if craft.response_time_min > lead_min:
                    continue          # physically cannot reach the vessel in time
                assigned[role].append(craft.craft_id)
                busy[craft.craft_id].append((start, end))

            if len(assigned[role]) < need:
                shortfall[role] = need - len(assigned[role])

        all_ids = [cid for r in CRAFT_ROLES for cid in assigned[r]]
        expected_response = max(
            (by_id[cid].response_time_min for cid in all_ids), default=0.0
        )
        unfilled = sum(shortfall.values())
        gap = float(unfilled) * UNFILLED_SLOT_PENALTY_MIN
        # Slack: how close the slowest committed unit is to the deadline.
        if all_ids:
            gap += max(0.0, expected_response - lead_min)

        note = ""
        if unfilled:
            note = "; ".join(f"{v} {k} short" for k, v in sorted(shortfall.items()))

        allocations[mv.movement_id] = CraftAllocation(
            movement_id=mv.movement_id,
            pilot_ids=tuple(assigned[ROLE_PILOT]),
            tug_ids=tuple(assigned[ROLE_TUG]),
            mooring_ids=tuple(assigned[ROLE_MOORING]),
            expected_response_min=float(expected_response),
            shortfall=shortfall,
            feasible=not shortfall,
            response_gap_min=gap,
            note=note,
        )

    # Return in schedule order, not service order, so the report reads naturally.
    return [allocations[m.movement_id] for m in sorted(movements, key=lambda m: (m.start_utc, m.movement_id))]


def total_response_gap(allocations: Sequence[CraftAllocation]) -> float:
    """Objective the swap search minimises: total gap minutes across all movements."""
    return sum(a.response_gap_min for a in allocations)


def demand_timeline(
    movements: Sequence[VesselMovement],
    roster: Sequence[PortCraft],
    window_start: datetime,
    window_end: datetime,
    step_minutes: int = DEFAULT_STEP_MINUTES,
) -> List[DemandPoint]:
    """Step the window and compare demand against serviceable supply per role."""
    supply = {r: len(v) for r, v in serviceable_supply(roster).items()}
    ws = _ensure_utc(window_start)
    we = _ensure_utc(window_end)
    out: List[DemandPoint] = []
    steps = int(math.ceil(_minutes_between(ws, we) / step_minutes))
    for i in range(steps + 1):
        t = ws + timedelta(minutes=i * step_minutes)
        active = [
            m for m in movements
            if _ensure_utc(m.start_utc) <= t < _ensure_utc(m.end_utc)
        ]
        for role in CRAFT_ROLES:
            demand = sum(m.required(role) for m in active)
            sup = supply.get(role, 0)
            out.append(
                DemandPoint(
                    t=t,
                    role=role,
                    demand=demand,
                    supply=sup,
                    deficit=max(0, demand - sup),
                    movement_ids=tuple(m.movement_id for m in active if m.required(role) > 0),
                )
            )
    return out


def detect_conflicts(
    movements: Sequence[VesselMovement],
    roster: Sequence[PortCraft],
    window_start: Optional[datetime] = None,
    window_end: Optional[datetime] = None,
    step_minutes: int = DEFAULT_STEP_MINUTES,
) -> List[Conflict]:
    """
    Find blocks where demand exceeds serviceable supply.

    Consecutive deficit steps for the same role are MERGED into one conflict
    with a start, an end and a peak deficit — emitting one row per timestep
    would bury the operator in near-duplicates.
    """
    if not movements:
        return []
    ws = _ensure_utc(window_start) if window_start else min(
        _ensure_utc(m.start_utc) for m in movements
    )
    we = _ensure_utc(window_end) if window_end else max(
        _ensure_utc(m.end_utc) for m in movements
    )
    timeline = demand_timeline(movements, roster, ws, we, step_minutes)
    by_movement = {m.movement_id: m for m in movements}

    conflicts: List[Conflict] = []
    counter = 0
    for role in CRAFT_ROLES:
        pts = [p for p in timeline if p.role == role]
        i = 0
        while i < len(pts):
            if pts[i].deficit <= 0:
                i += 1
                continue
            j = i
            while j + 1 < len(pts) and pts[j + 1].deficit > 0:
                j += 1
            block = pts[i : j + 1]
            peak = max(block, key=lambda p: p.deficit)
            mv_ids = sorted({mid for p in block for mid in p.movement_ids})
            tide_locked = any(by_movement[m].tide_locked for m in mv_ids if m in by_movement)
            if tide_locked:
                severity = SEVERITY_CRITICAL
            elif peak.deficit >= 2:
                severity = SEVERITY_HIGH
            else:
                severity = SEVERITY_MEDIUM
            counter += 1
            end_t = block[-1].t + timedelta(minutes=step_minutes)
            conflicts.append(
                Conflict(
                    conflict_id=f"CF-{counter:02d}",
                    role=role,
                    start_utc=block[0].t,
                    end_utc=min(end_t, we),
                    peak_demand=peak.demand,
                    supply=peak.supply,
                    peak_deficit=peak.deficit,
                    movement_ids=tuple(mv_ids),
                    severity=severity,
                    detail=(
                        f"{role} demand peaks at {peak.demand} against {peak.supply} "
                        f"serviceable ({peak.deficit} short) between "
                        f"{block[0].t.strftime('%H:%M')} and {end_t.strftime('%H:%M')} UTC, "
                        f"driven by {', '.join(mv_ids)}"
                        + (" — includes a tide-locked movement" if tide_locked else "")
                    ),
                )
            )
            i = j + 1
    return sorted(conflicts, key=lambda c: (c.start_utc, c.role))


def _shift_movement(mv: VesselMovement, minutes: int) -> VesselMovement:
    """Delay a movement by whole minutes, preserving its duration."""
    d = timedelta(minutes=minutes)
    return replace(mv, start_utc=mv.start_utc + d, end_utc=mv.end_utc + d)


def recommend_swaps(
    movements: Sequence[VesselMovement],
    roster: Sequence[PortCraft],
    conflicts: Sequence[Conflict],
    now_utc: Optional[datetime] = None,
    max_proposals: int = 3,
) -> List[SwapProposal]:
    """
    Propose single-unit changes that close the response gap.

    Three candidate families are searched, each altering exactly one thing:

      REASSIGN   take one unit of the deficit role from the LOWEST-priority
                 overlapping movement and pin it to the highest-priority one
      SUBSTITUTE pin an idle same-role unit with a lower response time
      DELAY      postpone the lowest-priority, NON-tide-locked conflicting
                 movement until the earliest same-role unit frees, rounded up
                 to the 5-minute granularity marine control actually works in

    Every candidate is scored by recomputing the FULL allocation and its total
    gap — not by a local estimate — and any candidate that creates a new
    conflict elsewhere is rejected outright. That rejection is the difference
    between a recommendation and a game of whack-a-mole.
    """
    if not conflicts:
        return []

    now = _ensure_utc(now_utc) if now_utc is not None else min(
        _ensure_utc(m.start_utc) for m in movements
    ) - timedelta(hours=1)

    base_alloc = allocate_craft(movements, roster, now)
    base_gap = total_response_gap(base_alloc)
    base_conflict_ids = {c.conflict_id for c in conflicts}
    by_id = {c.craft_id: c for c in roster}
    by_movement = {m.movement_id: m for m in movements}
    alloc_by_mv = {a.movement_id: a for a in base_alloc}

    candidates: List[Tuple[float, SwapProposal]] = []
    counter = 0

    def _evaluate(
        new_movements: Sequence[VesselMovement],
        pinned: Optional[Mapping[str, Sequence[str]]],
    ) -> Tuple[float, int, bool]:
        alloc = allocate_craft(new_movements, roster, now, pinned)
        gap = total_response_gap(alloc)
        residual = sum(sum(a.shortfall.values()) for a in alloc)
        new_conf = detect_conflicts(new_movements, roster)
        # "New conflict" means a role/time band that was not in conflict before.
        before_roles = {(c.role) for c in conflicts}
        creates_new = any(c.role not in before_roles for c in new_conf)
        return gap, residual, creates_new

    for conflict in conflicts:
        role = conflict.role
        involved = [by_movement[m] for m in conflict.movement_ids if m in by_movement]
        if not involved:
            continue
        short_movements = [
            m for m in involved
            if alloc_by_mv.get(m.movement_id) and alloc_by_mv[m.movement_id].shortfall.get(role, 0) > 0
        ]
        target = min(short_movements or involved, key=lambda m: (m.priority, m.start_utc, m.movement_id))
        donors = sorted(
            (m for m in involved if m.movement_id != target.movement_id),
            key=lambda m: (-m.priority, m.start_utc, m.movement_id),
        )

        # --- REASSIGN ---------------------------------------------------
        for donor in donors:
            donor_alloc = alloc_by_mv.get(donor.movement_id)
            if not donor_alloc:
                continue
            donor_units = donor_alloc.ids_for(role)
            if not donor_units:
                continue
            unit = donor_units[-1]     # give up the slowest-to-respond unit
            counter += 1
            gap, residual, creates_new = _evaluate(
                movements, {target.movement_id: [unit]}
            )
            candidates.append((
                gap,
                SwapProposal(
                    proposal_id=f"SW-{counter:02d}",
                    conflict_id=conflict.conflict_id,
                    action="REASSIGN",
                    craft_id_from=unit,
                    craft_id_to=None,
                    movement_id=target.movement_id,
                    donor_movement_id=donor.movement_id,
                    delay_minutes=0,
                    response_gap_before_min=base_gap,
                    response_gap_after_min=gap,
                    gap_closed_minutes=base_gap - gap,
                    residual_deficit=residual,
                    creates_new_conflict=creates_new,
                    rationale=(
                        f"Move {unit} ({by_id[unit].name}) from {donor.movement_id} "
                        f"[{donor.vessel_name}, priority {donor.priority}] to "
                        f"{target.movement_id} [{target.vessel_name}, priority "
                        f"{target.priority}], which is {conflict.peak_deficit} {role} short."
                    ),
                ),
            ))
            break   # one donor is enough; this is a SINGLE-unit proposal

        # --- SUBSTITUTE ---------------------------------------------------
        committed: Set[str] = {
            cid for a in base_alloc for cid in a.all_ids()
        }
        idle = sorted(
            (c for c in roster
             if c.serviceable and c.can_fill(role) and c.craft_id not in committed),
            key=lambda c: (c.response_time_min, c.craft_id),
        )
        if idle:
            unit = idle[0]
            counter += 1
            gap, residual, creates_new = _evaluate(
                movements, {target.movement_id: [unit.craft_id]}
            )
            candidates.append((
                gap,
                SwapProposal(
                    proposal_id=f"SW-{counter:02d}",
                    conflict_id=conflict.conflict_id,
                    action="SUBSTITUTE",
                    craft_id_from=None,
                    craft_id_to=unit.craft_id,
                    movement_id=target.movement_id,
                    donor_movement_id=None,
                    delay_minutes=0,
                    response_gap_before_min=base_gap,
                    response_gap_after_min=gap,
                    gap_closed_minutes=base_gap - gap,
                    residual_deficit=residual,
                    creates_new_conflict=creates_new,
                    rationale=(
                        f"Commit idle {unit.craft_id} ({unit.name}, "
                        f"{unit.response_time_min} min response) to "
                        f"{target.movement_id} [{target.vessel_name}]."
                    ),
                ),
            ))

        # --- DELAY --------------------------------------------------------
        delayable = [m for m in involved if not m.tide_locked]
        if delayable:
            victim = max(delayable, key=lambda m: (m.priority, m.start_utc, m.movement_id))
            for minutes in range(
                SWAP_DELAY_GRANULARITY_MIN, MAX_DELAY_MINUTES + 1, SWAP_DELAY_GRANULARITY_MIN * 6
            ):
                new_movements = [
                    _shift_movement(m, minutes) if m.movement_id == victim.movement_id else m
                    for m in movements
                ]
                gap, residual, creates_new = _evaluate(new_movements, None)
                if gap < base_gap - 1e-9:
                    counter += 1
                    candidates.append((
                        gap,
                        SwapProposal(
                            proposal_id=f"SW-{counter:02d}",
                            conflict_id=conflict.conflict_id,
                            action="DELAY",
                            craft_id_from=None,
                            craft_id_to=None,
                            movement_id=victim.movement_id,
                            donor_movement_id=None,
                            delay_minutes=minutes,
                            response_gap_before_min=base_gap,
                            response_gap_after_min=gap,
                            gap_closed_minutes=base_gap - gap,
                            residual_deficit=residual,
                            creates_new_conflict=creates_new,
                            rationale=(
                                f"Postpone {victim.movement_id} [{victim.vessel_name}, "
                                f"priority {victim.priority}, not tide-locked] by "
                                f"{minutes} min so a {role} frees up for the "
                                f"higher-priority movement."
                            ),
                        ),
                    ))
                    break   # smallest delay that helps

    # Reject anything that creates a new conflict, then rank by resulting gap.
    viable = [(g, p) for g, p in candidates if not p.creates_new_conflict]
    if not viable:
        viable = candidates      # nothing clean; surface the least-bad option
    viable.sort(key=lambda gp: (gp[0], -gp[1].gap_closed_minutes, gp[1].proposal_id))

    # The same physical action often surfaces from several conflict blocks —
    # delaying one movement can relieve PILOT, TUG and MOORING at once. Collapse
    # those to a single proposal so the alternatives offered are genuinely
    # different courses of action, not the same call restated three times.
    deduped: List[SwapProposal] = []
    seen: Set[Tuple[Any, ...]] = set()
    for _, p in viable:
        key = (p.action, p.movement_id, p.craft_id_from, p.craft_id_to, p.delay_minutes)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(p)
        if len(deduped) >= max_proposals:
            break
    return deduped


def utilisation_by_role(
    allocations: Sequence[CraftAllocation],
    movements: Sequence[VesselMovement],
    roster: Sequence[PortCraft],
    window_start: datetime,
    window_end: datetime,
) -> Dict[str, float]:
    """Committed craft-hours as a percentage of serviceable craft-hours."""
    window_h = max(1e-9, _hours_between(window_start, window_end))
    supply = serviceable_supply(roster)
    by_mv = {m.movement_id: m for m in movements}
    out: Dict[str, float] = {}
    for role in CRAFT_ROLES:
        capacity_h = len(supply.get(role, [])) * window_h
        used_h = 0.0
        for a in allocations:
            mv = by_mv.get(a.movement_id)
            if not mv:
                continue
            used_h += len(a.ids_for(role)) * _hours_between(mv.start_utc, mv.end_utc)
        out[role] = (used_h / capacity_h * 100.0) if capacity_h > 0 else 0.0
    return out


def evaluate(
    movements: Sequence[VesselMovement],
    roster: Sequence[PortCraft],
    window_start: Optional[datetime] = None,
    window_end: Optional[datetime] = None,
    scenario: str = "baseline",
    roster_preset: str = "real",
    now_utc: Optional[datetime] = None,
) -> PortCraftReport:
    """Run the full M7 evaluation: allocate, detect, recommend."""
    if not movements:
        raise ValueError("at least one movement is required")
    ws = _ensure_utc(window_start) if window_start else min(
        _ensure_utc(m.start_utc) for m in movements
    )
    we = _ensure_utc(window_end) if window_end else max(
        _ensure_utc(m.end_utc) for m in movements
    )
    now = _ensure_utc(now_utc) if now_utc is not None else ws - timedelta(hours=1)

    allocations = allocate_craft(movements, roster, now)
    conflicts = detect_conflicts(movements, roster, ws, we)
    proposals = recommend_swaps(movements, roster, conflicts, now)
    util = utilisation_by_role(allocations, movements, roster, ws, we)
    gap = total_response_gap(allocations)

    supply = serviceable_supply(roster)
    down = [c.craft_id for c in roster if not c.serviceable]
    roster_summary = {
        "preset": roster_preset,
        "total": len(roster),
        "serviceable": sum(1 for c in roster if c.serviceable),
        "down": down,
        "by_role": {r: len(v) for r, v in supply.items()},
        "by_type": {
            t: sum(1 for c in roster if c.craft_type == t)
            for t in sorted({c.craft_type for c in roster})
        },
    }

    status = "FEASIBLE" if not conflicts and all(a.feasible for a in allocations) \
        else "CONFLICT_DETECTED"

    if status == "FEASIBLE":
        rec = (
            f"All {len(movements)} movements can be serviced from the "
            f"{roster_summary['serviceable']}-craft serviceable roster. "
            f"Peak utilisation: "
            + ", ".join(f"{r} {util[r]:.0f}%" for r in CRAFT_ROLES)
            + "."
        )
    else:
        worst = max(conflicts, key=lambda c: (c.peak_deficit, c.severity == SEVERITY_CRITICAL)) \
            if conflicts else None
        rec = (
            f"{len(conflicts)} conflict block(s) detected. "
            + (
                f"Worst: {worst.role} short by {worst.peak_deficit} "
                f"({worst.severity}) from {worst.start_utc.strftime('%H:%M')} to "
                f"{worst.end_utc.strftime('%H:%M')} UTC. "
                if worst else ""
            )
        )
        if proposals:
            best = proposals[0]
            rec += (
                f"Recommended single change: {best.action} — {best.rationale} "
                f"Closes {best.gap_closed_minutes:.0f} gap-minutes "
                f"(residual deficit {best.residual_deficit}). [{best.basis}]"
            )
        else:
            rec += (
                "No single-unit change resolves this — escalate for a relief craft "
                "call-out or re-sequence the arrival programme."
            )

    peak_demand: Dict[str, Any] = {}
    timeline = demand_timeline(movements, roster, ws, we)
    for role in CRAFT_ROLES:
        pts = [p for p in timeline if p.role == role]
        if pts:
            pk = max(pts, key=lambda p: (p.demand, p.t))
            peak_demand[role] = {
                "at_utc": _iso(pk.t),
                "demand": pk.demand,
                "supply": pk.supply,
                "deficit": pk.deficit,
            }

    breakdown: Dict[str, Any] = {
        "model": "M7_PORT_CRAFT",
        "version": MODULE_VERSION,
        "scenario": scenario,
        "constants": {
            "DEFAULT_STEP_MINUTES": DEFAULT_STEP_MINUTES,
            "SWAP_DELAY_GRANULARITY_MIN": SWAP_DELAY_GRANULARITY_MIN,
            "UNFILLED_SLOT_PENALTY_MIN": UNFILLED_SLOT_PENALTY_MIN,
            "NO_BOW_THRUSTER_EXTRA_TUGS": NO_BOW_THRUSTER_EXTRA_TUGS,
        },
        "roster": roster_summary,
        "steps": [
            _step(
                1,
                "Serviceable supply",
                "supply[role] = count(craft where status == AVAILABLE and role in craft.roles)",
                "; ".join(f"{r}={len(supply[r])}" for r in CRAFT_ROLES)
                + (f"; DOWN: {', '.join(down)}" if down else ""),
                {r: len(supply[r]) for r in CRAFT_ROLES},
                {r: len(supply[r]) for r in CRAFT_ROLES},
                "craft",
                f"{len(roster)} on roster, {roster_summary['serviceable']} serviceable",
            ),
            _step(
                2,
                "Interval-aware allocation",
                "craft assignable iff no overlapping commitment AND response_time <= lead time",
                f"{sum(len(a.all_ids()) for a in allocations)} unit-assignments across "
                f"{len(movements)} movements; "
                f"{sum(sum(a.shortfall.values()) for a in allocations)} slots unfilled",
                {
                    "assignments": sum(len(a.all_ids()) for a in allocations),
                    "unfilled": sum(sum(a.shortfall.values()) for a in allocations),
                },
                sum(len(a.all_ids()) for a in allocations),
                "assignments",
                "no craft is committed to two overlapping movements",
            ),
            _step(
                3,
                "Conflict detection",
                "deficit(t, role) = demand - supply; contiguous deficits merged into one block",
                f"{len(conflicts)} merged conflict block(s) from "
                f"{sum(1 for p in timeline if p.deficit > 0)} deficit timesteps",
                {
                    "conflict_blocks": len(conflicts),
                    "deficit_timesteps": sum(1 for p in timeline if p.deficit > 0),
                    "step_minutes": DEFAULT_STEP_MINUTES,
                },
                len(conflicts),
                "blocks",
                "merging prevents one row per 15-minute step",
            ),
            _step(
                4,
                "Response gap",
                "gap = sum(unfilled * 120) + sum(max(0, response_time - lead_time))",
                f"total {gap:.1f} gap-minutes across {len(allocations)} movements",
                {"total_response_gap_min": round(gap, 2)},
                round(gap, 2),
                "min",
                "the objective the swap search minimises",
            ),
            _step(
                5,
                "Single-unit recommendation",
                "argmin over REASSIGN / SUBSTITUTE / DELAY of recomputed total gap",
                (
                    f"{proposals[0].action}: {gap:.1f} -> "
                    f"{proposals[0].response_gap_after_min:.1f} gap-min "
                    f"({proposals[0].gap_closed_minutes:+.1f} closed)"
                    if proposals else "no single-unit change improves the plan"
                ),
                {"proposals_evaluated": len(proposals)},
                proposals[0].action if proposals else None,
                "-",
                "candidates creating a new conflict elsewhere are rejected",
            ),
        ],
        "peak_demand": peak_demand,
        "conflicts": [c.as_dict() for c in conflicts],
        "recommendation": (proposals[0].as_dict() if proposals else None),
        "alternatives": [p.as_dict() for p in proposals[1:]],
        "utilisation_pct": {k: round(v, 2) for k, v in util.items()},
        "result": {
            "status": status,
            "conflict_count": len(conflicts),
            "total_response_gap_min": round(gap, 2),
            "recommendation": rec,
        },
        "assumptions": [
            "Craft requirement per movement from REQUIREMENTS[(type, class)].",
            f"No bow thruster adds {NO_BOW_THRUSTER_EXTRA_TUGS} tug.",
            "A craft serves one movement at a time (interval-aware allocation).",
            "Response times are ASSUMED — not present in Details_of_Port_Crafts.pdf.",
            "Security launches are treated as mooring-capable (ASSUMED dual role).",
            "Gap-closed minutes are a SIMULATED delta versus doing nothing.",
        ],
        "provenance": {
            "roster_source": f"Details_of_Port_Crafts.pdf (preset={roster_preset})",
            "movement_source": "SYNTHETIC_MOVEMENTS_v1",
            "commercial_figures": "SIMULATED",
            "generated_at_utc": _iso(_utc_now()),
        },
    }

    return PortCraftReport(
        scenario=scenario,
        roster_preset=roster_preset,
        window_start_utc=ws,
        window_end_utc=we,
        roster_summary=roster_summary,
        movements=tuple(sorted(movements, key=lambda m: (m.start_utc, m.movement_id))),
        allocations=tuple(allocations),
        conflicts=tuple(conflicts),
        proposals=tuple(proposals),
        utilisation_pct=util,
        total_response_gap_min=gap,
        status=status,
        recommendation=rec,
        breakdown=breakdown,
    )


def scenario_two_pilots_down(
    seed: int = DEFAULT_SEED,
    roster_preset: str = "poc",
    n_movements: int = 8,
) -> PortCraftReport:
    """
    Regression scenario M4 from the WS2 validation column: two pilots down.

    Defaults to the PoC roster because the real 4-pilot / 10-tug fleet absorbs a
    two-pilot outage without a shortage — which is itself a useful finding, and
    is shown side by side in the CLI demo.
    """
    start = datetime(2026, 8, 1, 6, tzinfo=timezone.utc)
    end = start + timedelta(hours=12)
    movements = SyntheticMovementLoader(seed, n_movements).load_movements(start, end)
    roster = build_default_roster(roster_preset)
    pilots = [c.craft_id for c in roster if c.can_fill(ROLE_PILOT)]
    roster = apply_outage(roster, pilots[1:3])
    return evaluate(movements, roster, start, end, "2_pilots_down", roster_preset)


def scenario_baseline(
    seed: int = DEFAULT_SEED,
    roster_preset: str = "real",
    n_movements: int = 8,
) -> PortCraftReport:
    """Full roster, nothing down."""
    start = datetime(2026, 8, 1, 6, tzinfo=timezone.utc)
    end = start + timedelta(hours=12)
    movements = SyntheticMovementLoader(seed, n_movements).load_movements(start, end)
    return evaluate(movements, build_default_roster(roster_preset), start, end,
                    "baseline", roster_preset)


MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "spec_row": "WS2_AI_ML_Tools.md row 7 — Port-craft assignment & conflict detection",
    "model_type": "deterministic utilisation + conflict heuristic",
    "constants": {
        "CRAFT_ROLES": list(CRAFT_ROLES),
        "DEFAULT_STEP_MINUTES": DEFAULT_STEP_MINUTES,
        "SWAP_DELAY_GRANULARITY_MIN": SWAP_DELAY_GRANULARITY_MIN,
        "UNFILLED_SLOT_PENALTY_MIN": UNFILLED_SLOT_PENALTY_MIN,
        "NO_BOW_THRUSTER_EXTRA_TUGS": NO_BOW_THRUSTER_EXTRA_TUGS,
        "ROLE_MAP": {k: list(v) for k, v in ROLE_MAP.items()},
        "REQUIREMENTS": {
            f"{k[0]}|{k[1]}": {
                "pilots": v.pilots, "tugs": v.tugs,
                "mooring": v.mooring, "duration_hours": v.duration_hours,
            }
            for k, v in REQUIREMENTS.items()
        },
    },
    "rosters": {
        "real": {
            "count": len(JNPA_ROSTER_REAL),
            "by_role": {r: len(v) for r, v in serviceable_supply(JNPA_ROSTER_REAL).items()},
            "source": "Details_of_Port_Crafts.pdf (18 craft)",
        },
        "poc": {
            "count": len(JNPA_ROSTER_POC),
            "by_role": {r: len(v) for r, v in serviceable_supply(JNPA_ROSTER_POC).items()},
            "source": "WS2_AI_ML_Tools.md row 7 (9 craft)",
        },
    },
    "spec_discrepancy": (
        "WS2_AI_ML_Tools.md row 7 states '9 craft: 3 pilots, 4 tugs, 2 mooring' and cites "
        "Details_of_Port_Crafts.pdf. That PDF lists 18 craft (10 tugs, 4 pilot launches, "
        "1 utility launch, 2 security launches, 1 VIP launch). The real roster is the "
        "default; the spec roster is retained as the 'poc' preset."
    ),
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

    class MovementModel(BaseModel):
        movement_id: str
        vessel_id: str = ""
        vessel_name: str = ""
        movement_type: Literal["BERTHING", "SAILING", "SHIFTING"] = "BERTHING"
        vessel_class: Literal["ULCV", "POST_PANAMAX", "PANAMAX", "FEEDER"] = "ULCV"
        berth_id: str = ""
        start_utc: datetime
        end_utc: Optional[datetime] = None
        priority: int = Field(5, ge=1, le=9)
        has_bow_thruster: bool = True
        tide_locked: bool = False
        req_pilots: Optional[int] = Field(None, ge=0, le=4)
        req_tugs: Optional[int] = Field(None, ge=0, le=8)
        req_mooring: Optional[int] = Field(None, ge=0, le=4)

        def to_movement(self) -> VesselMovement:
            start = self.start_utc
            start = start if start.tzinfo else start.replace(tzinfo=timezone.utc)
            req = requirements_for(self.movement_type, self.vessel_class, self.has_bow_thruster)
            end = self.end_utc
            if end is None:
                end = start + timedelta(hours=req.duration_hours)
            else:
                end = end if end.tzinfo else end.replace(tzinfo=timezone.utc)
            if end <= start:
                raise HTTPException(422, f"{self.movement_id}: end_utc must be after start_utc")
            return VesselMovement(
                movement_id=self.movement_id,
                vessel_id=self.vessel_id,
                vessel_name=self.vessel_name,
                movement_type=self.movement_type,
                vessel_class=self.vessel_class,
                berth_id=self.berth_id,
                start_utc=start,
                end_utc=end,
                req_pilots=self.req_pilots if self.req_pilots is not None else req.pilots,
                req_tugs=self.req_tugs if self.req_tugs is not None else req.tugs,
                req_mooring=self.req_mooring if self.req_mooring is not None else req.mooring,
                priority=self.priority,
                has_bow_thruster=self.has_bow_thruster,
                tide_locked=self.tide_locked,
            )

    class EvaluateRequest(BaseModel):
        movements: List[MovementModel]
        roster_preset: Literal["real", "poc"] = "real"
        down_craft_ids: List[str] = Field(default_factory=list)
        window_start_utc: Optional[datetime] = None
        window_end_utc: Optional[datetime] = None
        scenario: str = "adhoc"

        def build(self) -> Tuple[List[VesselMovement], List[PortCraft],
                                 Optional[datetime], Optional[datetime]]:
            if not self.movements:
                raise HTTPException(422, "at least one movement is required")
            movements = [m.to_movement() for m in self.movements]
            roster = build_default_roster(self.roster_preset)
            if self.down_craft_ids:
                try:
                    roster = apply_outage(roster, self.down_craft_ids)
                except ValueError as exc:
                    raise HTTPException(422, str(exc))
            ws = self.window_start_utc
            we = self.window_end_utc
            if ws is not None and ws.tzinfo is None:
                ws = ws.replace(tzinfo=timezone.utc)
            if we is not None and we.tzinfo is None:
                we = we.replace(tzinfo=timezone.utc)
            return movements, roster, ws, we

    def build_router() -> "APIRouter":
        """Construct the UC1-M7 router. Mounted by ``api.py``."""
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC1-M7 Port Craft"])

        @router.post("/evaluate", summary="Allocate craft, detect conflicts, recommend a swap")
        def evaluate_endpoint(req: EvaluateRequest) -> Dict[str, Any]:
            movements, roster, ws, we = req.build()
            return evaluate(movements, roster, ws, we, req.scenario, req.roster_preset).as_dict()

        @router.post("/conflicts", summary="Conflict blocks only")
        def conflicts_endpoint(req: EvaluateRequest) -> Dict[str, Any]:
            movements, roster, ws, we = req.build()
            conflicts = detect_conflicts(movements, roster, ws, we)
            return {
                "conflict_count": len(conflicts),
                "conflicts": [c.as_dict() for c in conflicts],
                "supply": {r: len(v) for r, v in serviceable_supply(roster).items()},
            }

        @router.post("/recommend", summary="Single-unit swap proposals only")
        def recommend_endpoint(req: EvaluateRequest) -> Dict[str, Any]:
            movements, roster, ws, we = req.build()
            conflicts = detect_conflicts(movements, roster, ws, we)
            proposals = recommend_swaps(movements, roster, conflicts)
            return {
                "conflict_count": len(conflicts),
                "proposals": [p.as_dict() for p in proposals],
                "basis": "SIMULATED delta vs do-nothing",
            }

        @router.get("/roster", summary="Craft roster (real = the PDF, poc = the spec)")
        def roster_endpoint(preset: Literal["real", "poc"] = "real") -> Dict[str, Any]:
            roster = build_default_roster(preset)
            return {
                "preset": preset,
                "count": len(roster),
                "by_role": {r: len(v) for r, v in serviceable_supply(roster).items()},
                "spec_discrepancy": MODULE_INFO["spec_discrepancy"],
                "craft": [c.as_dict() for c in roster],
            }

        @router.get("/scenario/two-pilots-down", summary="WS2 regression scenario M4")
        def two_pilots_down(
            roster_preset: Literal["real", "poc"] = "poc",
            seed: int = Query(DEFAULT_SEED),
        ) -> Dict[str, Any]:
            return scenario_two_pilots_down(seed, roster_preset).as_dict()

        @router.get("/constants", summary="Versioned constants (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {"module_version": MODULE_VERSION, "constants": MODULE_INFO["constants"]}

        @router.get("/demo", summary="Baseline evaluation on the real roster")
        def demo() -> Dict[str, Any]:
            return scenario_baseline().as_dict()

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


def _no_double_allocation(
    allocations: Sequence[CraftAllocation], movements: Sequence[VesselMovement]
) -> Tuple[bool, str]:
    """
    The permanent regression: no craft may serve two overlapping movements.

    A naive implementation slices an availability list per movement and hands
    the same pilot to concurrent jobs. The conflict report still looks fine, but
    the plan is physically impossible. This check makes that failure permanent.
    """
    by_mv = {m.movement_id: m for m in movements}
    commitments: Dict[str, List[Tuple[datetime, datetime, str]]] = {}
    for a in allocations:
        mv = by_mv.get(a.movement_id)
        if not mv:
            continue
        for cid in a.all_ids():
            commitments.setdefault(cid, []).append((mv.start_utc, mv.end_utc, mv.movement_id))
    for cid, spans in commitments.items():
        spans.sort()
        for (s1, e1, m1), (s2, e2, m2) in zip(spans, spans[1:]):
            if _intervals_overlap(s1, e1, s2, e2):
                return False, f"{cid} double-allocated to {m1} and {m2}"
    return True, f"{len(commitments)} craft, no overlapping commitments"


def _self_test() -> List[Tuple[str, bool, str]]:
    """Return ``[(check_name, passed, detail), ...]``."""
    checks: List[Tuple[str, bool, str]] = []

    # --- Roster fidelity --------------------------------------------------
    real_supply = serviceable_supply(JNPA_ROSTER_REAL)
    checks.append(
        (
            "real_roster_transcription",
            len(JNPA_ROSTER_REAL) == 18
            and len(real_supply[ROLE_TUG]) == 10
            and len(real_supply[ROLE_PILOT]) == 4,
            f"{len(JNPA_ROSTER_REAL)} craft: {len(real_supply[ROLE_TUG])} tugs, "
            f"{len(real_supply[ROLE_PILOT])} pilots, {len(real_supply[ROLE_MOORING])} mooring",
        )
    )
    checks.append(
        (
            "poc_roster_matches_spec",
            len(JNPA_ROSTER_POC) == 9
            and len(serviceable_supply(JNPA_ROSTER_POC)[ROLE_PILOT]) == 3
            and len(serviceable_supply(JNPA_ROSTER_POC)[ROLE_TUG]) == 4
            and len(serviceable_supply(JNPA_ROSTER_POC)[ROLE_MOORING]) == 2,
            "9 craft = 3 pilots + 4 tugs + 2 mooring, per WS2 row 7",
        )
    )
    checks.append(
        (
            "vip_launch_not_commercial",
            not any(c.roles for c in JNPA_ROSTER_REAL if c.craft_type == "VIP Launch"),
            "M.L Chetak (the only JNPA-owned craft) carries no commercial role",
        )
    )
    checks.append(
        (
            "response_times_flagged_assumed",
            all("ASSUMED" in c.response_time_source for c in JNPA_ROSTER_REAL),
            "every craft flags its response time as assumed, not source data",
        )
    )

    # --- Requirements -----------------------------------------------------
    r_with = requirements_for(MOVEMENT_BERTHING, "ULCV", True)
    r_without = requirements_for(MOVEMENT_BERTHING, "ULCV", False)
    checks.append(
        (
            "bow_thruster_uplift",
            r_without.tugs == r_with.tugs + NO_BOW_THRUSTER_EXTRA_TUGS,
            f"ULCV berthing: {r_with.tugs} tugs with thruster, {r_without.tugs} without",
        )
    )

    # --- THE regression: no double allocation ----------------------------
    start = datetime(2026, 8, 1, 6, tzinfo=timezone.utc)
    end = start + timedelta(hours=12)
    movements = SyntheticMovementLoader(DEFAULT_SEED, 8).load_movements(start, end)

    for preset in ("real", "poc"):
        roster = build_default_roster(preset)
        allocs = allocate_craft(movements, roster, start - timedelta(hours=1))
        ok, detail = _no_double_allocation(allocs, movements)
        checks.append((f"no_double_allocation_{preset}", ok, detail))

    # And under an outage, where the temptation to over-assign is greatest.
    poc = apply_outage(build_default_roster("poc"), ["PL-02", "PL-03"])
    allocs_down = allocate_craft(movements, poc, start - timedelta(hours=1))
    ok, detail = _no_double_allocation(allocs_down, movements)
    checks.append(("no_double_allocation_under_outage", ok, detail))

    # Overlapping movements needing the same single craft: exactly one is served.
    solo = [
        PortCraft("PL-X", "Solo Pilot", "Pilot Launch", (ROLE_PILOT,), 10),
        PortCraft("TG-X", "Solo Tug", "Tug", (ROLE_TUG,), 10),
        PortCraft("MB-X", "Solo Mooring", "Mooring Boat", (ROLE_MOORING,), 10),
    ]
    t0 = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
    twin = [
        VesselMovement("MV-A", "V-A", "ALPHA", MOVEMENT_BERTHING, "FEEDER", "B1",
                       t0, t0 + timedelta(hours=2), 1, 1, 1, priority=3),
        VesselMovement("MV-B", "V-B", "BRAVO", MOVEMENT_BERTHING, "FEEDER", "B2",
                       t0 + timedelta(minutes=30), t0 + timedelta(hours=2, minutes=30),
                       1, 1, 1, priority=7),
    ]
    twin_alloc = allocate_craft(twin, solo, t0 - timedelta(hours=1))
    served = [a for a in twin_alloc if a.feasible]
    ok, detail = _no_double_allocation(twin_alloc, twin)
    checks.append(
        (
            "overlapping_single_craft_contention",
            ok and len(served) == 1 and served[0].movement_id == "MV-A",
            f"one pilot, two overlapping movements -> {len(served)} served "
            f"({served[0].movement_id if served else 'none'}, higher priority wins)",
        )
    )

    # Response-time feasibility must be enforced.
    slow = [PortCraft("PL-S", "Slow Pilot", "Pilot Launch", (ROLE_PILOT,), 120)]
    urgent = [
        VesselMovement("MV-U", "V-U", "URGENT", MOVEMENT_SAILING, "FEEDER", "B1",
                       t0, t0 + timedelta(hours=1), 1, 0, 0)
    ]
    urgent_alloc = allocate_craft(urgent, slow, t0 - timedelta(minutes=30))
    checks.append(
        (
            "response_time_enforced",
            not urgent_alloc[0].feasible and urgent_alloc[0].shortfall.get(ROLE_PILOT) == 1,
            "a 120-min-response pilot cannot serve a movement 30 min away",
        )
    )

    # --- Conflict detection ----------------------------------------------
    conflicts_twin = detect_conflicts(twin, solo)
    checks.append(
        (
            "conflicts_merged_into_blocks",
            len(conflicts_twin) >= 1
            and all(c.end_utc > c.start_utc for c in conflicts_twin),
            f"{len(conflicts_twin)} merged block(s), each with a real duration "
            f"(not one row per 15-min step)",
        )
    )

    base_real = scenario_baseline(roster_preset="real")
    checks.append(
        (
            "real_roster_absorbs_load",
            base_real.status == "FEASIBLE",
            f"18-craft roster, 8 movements -> {base_real.status} "
            f"({len(base_real.conflicts)} conflicts)",
        )
    )

    down_poc = scenario_two_pilots_down(roster_preset="poc")
    pilot_conflicts = [c for c in down_poc.conflicts if c.role == ROLE_PILOT]
    checks.append(
        (
            "two_pilots_down_triggers_conflict",
            down_poc.status == "CONFLICT_DETECTED" and len(pilot_conflicts) >= 1,
            f"PoC roster minus 2 pilots -> {len(down_poc.conflicts)} conflict block(s), "
            f"{len(pilot_conflicts)} on PILOT",
        )
    )
    checks.append(
        (
            "outage_allocation_still_valid",
            _no_double_allocation(down_poc.allocations, down_poc.movements)[0],
            "the degraded plan is still physically valid",
        )
    )

    # --- Recommendations --------------------------------------------------
    if down_poc.proposals:
        best = down_poc.proposals[0]
        checks.append(
            (
                "proposal_improves_or_is_flagged",
                best.gap_closed_minutes > 0 or best.residual_deficit > 0,
                f"{best.action} closes {best.gap_closed_minutes:.0f} gap-min "
                f"(residual {best.residual_deficit})",
            )
        )
        checks.append(
            (
                "proposal_is_single_unit",
                sum([
                    1 if best.craft_id_from else 0,
                    1 if best.craft_id_to else 0,
                    1 if best.delay_minutes else 0,
                ]) <= 2,
                f"{best.action}: from={best.craft_id_from} to={best.craft_id_to} "
                f"delay={best.delay_minutes} min",
            )
        )
        checks.append(
            (
                "proposal_labelled_simulated",
                all(p.basis.startswith("SIMULATED") for p in down_poc.proposals),
                "gap-closed minutes are quoted as a simulated delta vs do-nothing",
            )
        )
        checks.append(
            (
                "delay_respects_tide_lock",
                all(
                    not any(
                        m.tide_locked and m.movement_id == p.movement_id
                        for m in down_poc.movements
                    )
                    for p in down_poc.proposals if p.action == "DELAY"
                ),
                "no DELAY proposal targets a tide-locked movement",
            )
        )
    else:
        checks.append(("proposal_generated", False, "no proposal produced for a conflict"))

    # --- Determinism and utilisation --------------------------------------
    checks.append(
        (
            "determinism",
            scenario_two_pilots_down(roster_preset="poc").total_response_gap_min
            == down_poc.total_response_gap_min,
            f"repeat run reproduces {down_poc.total_response_gap_min:.1f} gap-minutes",
        )
    )
    checks.append(
        (
            "utilisation_bounded",
            all(0.0 <= v <= 100.0 + 1e-9 for v in base_real.utilisation_pct.values()),
            ", ".join(f"{k} {v:.1f}%" for k, v in base_real.utilisation_pct.items()),
        )
    )
    checks.append(
        (
            "breakdown_completeness",
            len(base_real.breakdown["steps"]) == 5
            and all(s.get("substitution") for s in base_real.breakdown["steps"]),
            f"{len(base_real.breakdown['steps'])} steps, all with substitutions",
        )
    )

    return checks


def _print_report(report: PortCraftReport, title: str) -> None:
    print(f"\n{title}")
    rs = report.roster_summary
    print(
        f"  roster '{rs['preset']}': {rs['serviceable']}/{rs['total']} serviceable  "
        f"({', '.join(f'{r} {n}' for r, n in rs['by_role'].items())})"
        + (f"   DOWN: {', '.join(rs['down'])}" if rs["down"] else "")
    )

    rows = []
    alloc_by_mv = {a.movement_id: a for a in report.allocations}
    for m in report.movements:
        a = alloc_by_mv[m.movement_id]
        rows.append([
            m.movement_id,
            m.vessel_name[:18],
            m.movement_type[:4],
            m.vessel_class[:12],
            m.start_utc.strftime("%H:%M"),
            m.end_utc.strftime("%H:%M"),
            f"{m.req_pilots}/{m.req_tugs}/{m.req_mooring}",
            f"{len(a.pilot_ids)}/{len(a.tug_ids)}/{len(a.mooring_ids)}",
            m.priority,
            "TIDE" if m.tide_locked else "",
            "OK" if a.feasible else a.note,
        ])
    print(_fmt_table(
        ["id", "vessel", "type", "class", "start", "end", "req P/T/M",
         "got P/T/M", "pri", "lock", "status"],
        rows, indent="  ",
    ))

    if report.conflicts:
        print(f"\n  CONFLICT BLOCKS ({len(report.conflicts)})")
        rows = []
        for c in report.conflicts:
            rows.append([
                c.conflict_id, c.role,
                c.start_utc.strftime("%H:%M"), c.end_utc.strftime("%H:%M"),
                f"{_minutes_between(c.start_utc, c.end_utc):.0f}",
                c.peak_demand, c.supply, c.peak_deficit, c.severity,
                ", ".join(c.movement_ids),
            ])
        print(_fmt_table(
            ["id", "role", "from", "to", "min", "demand", "supply", "short",
             "severity", "movements"],
            rows, indent="    ",
        ))
    else:
        print("\n  CONFLICT BLOCKS: none — all movements serviceable")

    if report.proposals:
        print("\n  SINGLE-UNIT PROPOSALS  [SIMULATED delta vs do-nothing]")
        for i, p in enumerate(report.proposals):
            marker = "-->" if i == 0 else "   "
            print(
                f"  {marker} {p.proposal_id} {p.action:<10} gap "
                f"{p.response_gap_before_min:7.1f} -> {p.response_gap_after_min:7.1f} min "
                f"(closed {p.gap_closed_minutes:+7.1f}, residual deficit {p.residual_deficit})"
            )
            print(f"      {p.rationale}")

    print(
        "\n  UTILISATION  "
        + "  ".join(
            f"{r} {report.utilisation_pct[r]:5.1f}% "
            f"[{'#' * int(report.utilisation_pct[r] / 5)}]"
            for r in CRAFT_ROLES
        )
    )
    print(f"  TOTAL RESPONSE GAP  {report.total_response_gap_min:.1f} min")
    print(f"  STATUS {report.status}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="UC1-M7 port-craft assignment & conflict detection — demo and self-test."
    )
    parser.add_argument("--roster", choices=["real", "poc", "both"], default="both")
    parser.add_argument(
        "--scenario", choices=["baseline", "two-pilots-down", "all"], default="all"
    )
    parser.add_argument("--movements", type=int, default=8)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args(argv)

    if not args.quiet:
        print("=" * 78)
        print(f"{MODULE_ID} — {MODULE_NAME}   ({MODULE_VERSION})")
        print("JNPA UC-I Vessel Traffic Management | WS2 row 7 | deterministic heuristic")
        print("=" * 78)

    if args.json:
        print(json.dumps(scenario_two_pilots_down(args.seed, "poc", args.movements).as_dict(),
                         indent=2))
    elif not args.quiet:
        print("\nROSTER SOURCE DISCREPANCY")
        print(f"  {MODULE_INFO['spec_discrepancy']}")

        print("\nREAL ROSTER — Details_of_Port_Crafts.pdf (18 craft)")
        rows = []
        for c in JNPA_ROSTER_REAL:
            rows.append([
                c.craft_id, c.name[:18], c.craft_type[:28],
                "/".join(c.roles) or "-",
                c.response_time_min,
                f"{c.bollard_pull_t:.0f}" if c.bollard_pull_t else "-",
                f"{c.loa_m:.2f}" if c.loa_m else "-",
                "JNPA" if c.owned else "hired",
            ])
        print(_fmt_table(
            ["id", "name", "type (PDF)", "roles", "resp min", "bollard t", "LOA m", "owner"],
            rows, indent="  ",
        ))
        real_sup = serviceable_supply(JNPA_ROSTER_REAL)
        poc_sup = serviceable_supply(JNPA_ROSTER_POC)
        print(
            "  effective supply — real: "
            + ", ".join(f"{r} {len(real_sup[r])}" for r in CRAFT_ROLES)
            + "   |   poc: "
            + ", ".join(f"{r} {len(poc_sup[r])}" for r in CRAFT_ROLES)
        )

        presets = ["real", "poc"] if args.roster == "both" else [args.roster]
        for preset in presets:
            if args.scenario in ("all", "baseline"):
                _print_report(
                    scenario_baseline(args.seed, preset, args.movements),
                    f"BASELINE — full '{preset}' roster",
                )
            if args.scenario in ("all", "two-pilots-down"):
                _print_report(
                    scenario_two_pilots_down(args.seed, preset, args.movements),
                    f"SCENARIO M4 — two pilots down, '{preset}' roster",
                )

    checks = _self_test()
    passed = sum(1 for _, ok, _ in checks if ok)
    print(f"\n{'-' * 78}")
    print(f"SELF-TEST  {passed}/{len(checks)} passed")
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<36} {detail}")
    print("-" * 78)

    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
