"""
UC1-M2 — Tidal Window Computation & Extension Scanner
=====================================================

Jawaharlal Nehru Port Authority (JNPA) — Workstream 2, UC-I Vessel Traffic
Management & Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"Over the next five days, when exactly can this deep-draft vessel transit the
channel — and how much does dredging widen those windows?"

This is the module that answers the briefing item "extend tidal window": the
effect of dredging (+m restored) or siltation (-m lost) on window width is
computed live, in hours, rather than asserted.

METHOD
------
Walk the tide curve at 0.25 h steps across a 120 h horizon (481 samples), and
at every step evaluate under-keel clearance on EVERY channel reach using the
duplicated DUKC core. A step is feasible when the worst reach still meets the
required status. Contiguous feasible steps are assembled into windows.

    tide(t)      = 2.6 + 1.7*cos(w*t) + 0.3*sin(0.5*w*t),  w = 2*pi/12.4206 h
    squat_reach  = min(2.5, Cb * V_reach^2 / 100)
    net_ukc      = charted + tide - silt + dredge - draft - squat - margin
    feasible(t)  = min over reaches of status(net_ukc) >= min_status

    required_tide = threshold + margin + draft + squat - charted + silt - dredge

WHY PER-REACH, NOT JUST "CONTROLLING DEPTH"
-------------------------------------------
The spec defines controlling depth as the minimum charted depth of the inner
and turning reaches. That figure is still reported, but go/no-go uses the true
per-reach minimum NET UKC, because each reach carries its own speed limit and
squat scales with V^2. CH-INNER (15.0 m, 10 kn) and the turning basin (15.0 m,
6 kn) share a charted depth, yet the basin has roughly a quarter of the squat
and is therefore not the binding constraint. Using charted depth alone would
name the wrong reach.

THRESHOLD POLICY
----------------
``min_status`` defaults to SAFE (net UKC >= 1.0 m). MARGINAL periods (0.6-1.0 m)
are scanned and reported SEPARATELY as "conditional windows" and are never
counted in headline usable hours. Allowing MARGINAL would roughly double the
reported availability; claiming those hours as routinely usable is not
defensible to the Deputy Conservator.

WINDOW BOUNDARY CONVENTION
--------------------------
A window covering sample indices i..j inclusive has
``duration_h = (j - i) * step_hours``. Two adjacent feasible samples therefore
form a 0.25 h window, not 0.5 h. This is asserted in the self-test because an
off-by-one here is the classic silent bug in window scanners.

USAGE
-----
    python uc1_m2_tidal_window.py                 # full demo, exits 0 on success
    python uc1_m2_tidal_window.py --draft 16.0    # a deeper call
    python uc1_m2_tidal_window.py --json

    from uc1_m2_tidal_window import evaluate_tidal_windows, VesselState
    res = evaluate_tidal_windows(VesselState("V1", "MAERSK", "CONTAINER", 15.5, 10.0))
    print(res.baseline.total_usable_hours, res.comparisons[0].verdict)

SELF-CONTAINMENT POLICY
-----------------------
Standard library only above SECTION 6. FastAPI/pydantic are optional. The DUKC
core in SECTION 2 is byte-identical to the copy in uc1_m1_dukc.py by design.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

# ==========================================================================
# SECTION 1 — MODULE IDENTITY AND VERSIONED CONSTANTS
# ==========================================================================

MODULE_ID: str = "UC1-M2"
MODULE_NAME: str = "Tidal Window Computation & Extension Scanner"
MODULE_VERSION: str = "m2-tidal-v1.0.0"
ROUTER_PREFIX: str = "/uc1/m2"

DEFAULT_SEED: int = 20260807

# Scan geometry — per WS2_AI_ML_Tools.md row 2: "tide curve walked at 0.25 h
# steps over 120 h".
FORECAST_HOURS: float = 120.0
STEP_HOURS: float = 0.25
EXPECTED_SAMPLES: int = 481          # int(120 / 0.25) + 1, inclusive of both ends
MIN_WINDOW_HOURS: float = 0.5        # shorter openings are not operationally usable

# Analytic tide model (production upgrade path: INCOIS / tide-gauge assimilation).
TIDE_MEAN_M: float = 2.6             # per spec: "mean 2.6 m"
TIDE_AMP_M: float = 1.7              # per spec: "amplitude 1.7 m"
TIDE_K1_AMP_M: float = 0.3           # diurnal inequality -> "mixed semi-diurnal"
TIDE_M2_PERIOD_H: float = 12.4206    # principal lunar semi-diurnal constituent

DEFAULT_DREDGING_DELTA_M: float = 0.5
DEFAULT_SILTATION_DELTA_M: float = 0.3

# ==========================================================================
# SECTION 2 — DUKC CORE  (DUPLICATED BY DESIGN into M1, M2, M6, M8)
# --------------------------------------------------------------------------
# This block is byte-identical across uc1_m1_dukc.py, uc1_m2_tidal_window.py,
# uc1_m6_jit_rta.py and uc1_m8_causal_chain.py. Do NOT factor it into a shared
# package — the flat-file architecture is a deliberate requirement so each
# module can be copied out and run in isolation.
#
# Drift between copies is the one real risk of that choice, so it is made
# DETECTABLE rather than merely discouraged:
#   1. DUKC_CORE_FINGERPRINT changes whenever any constant or formula changes.
#   2. _dukc_core_selftest() asserts golden values and runs from every __main__.
#   3. api.py asserts all four modules report the same fingerprint at mount time
#      and refuses to start otherwise.
# ==========================================================================

DUKC_CORE_VERSION: str = "1.0.0"
DUKC_CORE_FINGERPRINT: str = "dukc-core/1.0.0/barrass-cb-v2-clamp2.5/margin1.0/band0.6"

UKC_SAFETY_MARGIN_M: float = 1.0     # net UKC at or above this is SAFE
UKC_MARGINAL_BAND_M: float = 0.6     # net UKC at or above this is MARGINAL
MAX_SQUAT_CLAMP_M: float = 2.5       # Barrass squat clamp, upper bound
MIN_SQUAT_CLAMP_M: float = 0.0       # squat cannot be negative

CB_CONTAINER: float = 0.65           # block coefficient, container vessels
CB_BULK: float = 0.80                # block coefficient, bulk carriers

STATUS_SAFE: str = "SAFE"
STATUS_MARGINAL: str = "MARGINAL"
STATUS_NO_GO: str = "NO GO"

# Ordered worst -> best, used to compare / rank statuses.
_STATUS_RANK: Dict[str, int] = {STATUS_NO_GO: 0, STATUS_MARGINAL: 1, STATUS_SAFE: 2}


def _cb_for_class(vessel_class: str) -> float:
    """Block coefficient for a vessel class. DUPLICATED BY DESIGN."""
    key = (vessel_class or "").strip().upper()
    if key in ("BULK", "BULKER", "BULK CARRIER", "DRY BULK", "TANKER"):
        return CB_BULK
    return CB_CONTAINER


def _squat_m(cb: float, speed_kn: float) -> float:
    """
    Barrass-type squat, clamped to [0.0, 2.5] m. DUPLICATED BY DESIGN.

        squat = min(2.5, Cb * V^2 / 100)

    Speed is through-water in knots. Negative speed is treated as astern and
    uses |V| — squat is a function of speed magnitude.
    """
    raw = cb * (abs(float(speed_kn)) ** 2) / 100.0
    return max(MIN_SQUAT_CLAMP_M, min(MAX_SQUAT_CLAMP_M, raw))


def _effective_depth_m(
    charted_depth_m: float,
    tide_m: float,
    siltation_m: float = 0.0,
    dredging_m: float = 0.0,
) -> float:
    """Water column available over the bed. DUPLICATED BY DESIGN."""
    return float(charted_depth_m) + float(tide_m) - float(siltation_m) + float(dredging_m)


def _net_ukc_m(
    charted_depth_m: float,
    tide_m: float,
    siltation_m: float,
    draft_m: float,
    squat_m_value: float,
    margin_m: float = UKC_SAFETY_MARGIN_M,
    dredging_m: float = 0.0,
) -> Tuple[float, float]:
    """
    Return ``(gross_ukc_m, net_ukc_m)``. DUPLICATED BY DESIGN.

        gross = (charted + tide - siltation + dredging) - (draft + squat)
        net   = gross - margin
    """
    effective = _effective_depth_m(charted_depth_m, tide_m, siltation_m, dredging_m)
    gross = effective - (float(draft_m) + float(squat_m_value))
    return gross, gross - float(margin_m)


def _ukc_status(net_ukc: float) -> str:
    """Traffic-light classification of net UKC. DUPLICATED BY DESIGN."""
    if net_ukc >= UKC_SAFETY_MARGIN_M:
        return STATUS_SAFE
    if net_ukc >= UKC_MARGINAL_BAND_M:
        return STATUS_MARGINAL
    return STATUS_NO_GO


def _dukc_core_selftest() -> None:
    """
    Golden-value asserts for the duplicated core. DUPLICATED BY DESIGN.

    Any accidental edit to a constant or formula trips one of these immediately,
    in every module that carries the block.
    """
    assert abs(_squat_m(CB_CONTAINER, 10.0) - 0.650) < 1e-9, "squat(0.65,10) != 0.650"
    assert abs(_squat_m(CB_CONTAINER, 14.0) - 1.274) < 1e-9, "squat(0.65,14) != 1.274"
    assert abs(_squat_m(CB_BULK, 20.0) - 2.500) < 1e-9, "squat clamp at 2.5 m failed"
    assert abs(_squat_m(CB_CONTAINER, 0.0) - 0.0) < 1e-9, "squat at rest != 0"
    assert _ukc_status(1.00) == STATUS_SAFE
    assert _ukc_status(0.95) == STATUS_MARGINAL
    assert _ukc_status(0.60) == STATUS_MARGINAL
    assert _ukc_status(0.59) == STATUS_NO_GO
    gross, net = _net_ukc_m(15.0, 2.6, 0.0, 15.0, 0.65, UKC_SAFETY_MARGIN_M)
    assert abs(gross - 1.95) < 1e-9, "gross UKC golden value failed"
    assert abs(net - 0.95) < 1e-9, "net UKC golden value failed"
    assert _cb_for_class("CONTAINER") == CB_CONTAINER
    assert _cb_for_class("BULK") == CB_BULK


# --------------------------------------------------------------------------
# Shared formatting / time helpers. DUPLICATED BY DESIGN — do not factor out.
# --------------------------------------------------------------------------

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
    """
    One auditable line of a ``breakdown`` dict. DUPLICATED BY DESIGN.

    ``substitution`` carries the formula with the real numbers already plugged
    in AND the result. That field is what makes the output audit-grade — a
    reviewer can verify the arithmetic without running the code.
    """
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
class ChannelReach:
    """One navigable segment of the JNPA approach channel."""

    reach_id: str
    name: str
    charted_depth_m: float
    length_nm: float
    max_speed_kn: float
    is_turning_basin: bool = False


DEFAULT_REACHES: Dict[str, ChannelReach] = {
    "CH-OUTER": ChannelReach("CH-OUTER", "Outer Approach Channel", 17.5, 12.0, 12.0),
    "CH-MID": ChannelReach("CH-MID", "Mid Approach Channel", 16.2, 5.0, 11.0),
    "CH-INNER": ChannelReach("CH-INNER", "Inner Approach Channel", 15.0, 6.5, 10.0),
    "TURNING-CIRCLE": ChannelReach("TURNING-CIRCLE", "Main Turning Basin", 15.0, 1.2, 6.0, True),
}

REACH_IDS: Tuple[str, ...] = tuple(DEFAULT_REACHES.keys())


@dataclass(frozen=True)
class VesselState:
    """Vessel particulars relevant to under-keel clearance."""

    vessel_id: str
    vessel_name: str
    vessel_class: str = "CONTAINER"
    static_draft_m: float = 15.5
    transit_speed_kn: float = 10.0
    loa_m: float = 366.0
    beam_m: float = 51.0
    block_coefficient_cb: Optional[float] = None

    @property
    def cb(self) -> float:
        if self.block_coefficient_cb is not None:
            return float(self.block_coefficient_cb)
        return _cb_for_class(self.vessel_class)


@dataclass(frozen=True)
class TideSample:
    """One point on the tide curve."""

    t: datetime
    height_m: float
    kind: str = "MID"      # HIGH | LOW | MID


@dataclass(frozen=True)
class ReachFeasibility:
    """Per-reach snapshot at one time step."""

    reach_id: str
    charted_depth_m: float
    speed_kn: float
    effective_depth_m: float
    squat_m: float
    net_ukc_m: float
    status: str


@dataclass(frozen=True)
class ScanSample:
    """One of the 481 rows of the curve walk."""

    index: int
    t: datetime
    tide_m: float
    binding_reach_id: str
    controlling_net_ukc_m: float
    status: str
    feasible: bool

    def as_dict(self) -> Dict[str, Any]:
        return {
            "index": self.index,
            "t": _iso(self.t),
            "tide_m": round(self.tide_m, 3),
            "binding_reach_id": self.binding_reach_id,
            "controlling_net_ukc_m": round(self.controlling_net_ukc_m, 4),
            "status": self.status,
            "feasible": self.feasible,
        }


@dataclass(frozen=True)
class TidalWindow:
    """A contiguous run of feasible steps — one usable transit opening."""

    window_id: int
    start: datetime
    end: datetime
    duration_h: float
    peak_tide_m: float
    peak_tide_at: datetime
    min_tide_m: float
    min_net_ukc_m: float
    max_net_ukc_m: float
    binding_reach_id: str
    worst_status: str
    opens_at_tide_m: float
    sample_start_index: int
    sample_end_index: int

    def as_dict(self) -> Dict[str, Any]:
        return {
            "window_id": self.window_id,
            "start": _iso(self.start),
            "end": _iso(self.end),
            "duration_h": round(self.duration_h, 3),
            "peak_tide_m": round(self.peak_tide_m, 3),
            "peak_tide_at": _iso(self.peak_tide_at),
            "min_tide_m": round(self.min_tide_m, 3),
            "min_net_ukc_m": round(self.min_net_ukc_m, 4),
            "max_net_ukc_m": round(self.max_net_ukc_m, 4),
            "binding_reach_id": self.binding_reach_id,
            "worst_status": self.worst_status,
            "opens_at_tide_m": round(self.opens_at_tide_m, 3),
            "sample_start_index": self.sample_start_index,
            "sample_end_index": self.sample_end_index,
        }


@dataclass(frozen=True)
class ScenarioWindows:
    """All windows found under one siltation/dredging scenario."""

    scenario_id: str
    label: str
    siltation_delta_m: float
    dredging_delta_m: float
    min_status: str
    windows: Tuple[TidalWindow, ...]
    window_count: int
    total_usable_hours: float
    mean_window_hours: float
    longest_window_h: float
    shortest_window_h: float
    max_gap_hours: float                 # the KPI a berth planner acts on
    first_window_start: Optional[datetime]
    availability_pct: float
    discarded_short_windows: int
    required_tide_m: float
    binding_reach_id: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "scenario_id": self.scenario_id,
            "label": self.label,
            "siltation_delta_m": round(self.siltation_delta_m, 3),
            "dredging_delta_m": round(self.dredging_delta_m, 3),
            "min_status": self.min_status,
            "windows": [w.as_dict() for w in self.windows],
            "window_count": self.window_count,
            "total_usable_hours": round(self.total_usable_hours, 3),
            "mean_window_hours": round(self.mean_window_hours, 3),
            "longest_window_h": round(self.longest_window_h, 3),
            "shortest_window_h": round(self.shortest_window_h, 3),
            "max_gap_hours": round(self.max_gap_hours, 3),
            "first_window_start": _iso(self.first_window_start),
            "availability_pct": round(self.availability_pct, 2),
            "discarded_short_windows": self.discarded_short_windows,
            "required_tide_m": round(self.required_tide_m, 3),
            "binding_reach_id": self.binding_reach_id,
        }


@dataclass(frozen=True)
class WindowComparison:
    """Scenario vs baseline — the 'extend tidal window' deliverable."""

    scenario_id: str
    label: str
    baseline_hours: float
    scenario_hours: float
    delta_hours: float
    delta_pct: float
    delta_window_count: int
    baseline_max_gap_h: float
    scenario_max_gap_h: float
    delta_max_gap_h: float
    verdict: str          # WIDENED | SHRANK | UNCHANGED

    def as_dict(self) -> Dict[str, Any]:
        return {
            "scenario_id": self.scenario_id,
            "label": self.label,
            "baseline_hours": round(self.baseline_hours, 3),
            "scenario_hours": round(self.scenario_hours, 3),
            "delta_hours": round(self.delta_hours, 3),
            "delta_pct": round(self.delta_pct, 2),
            "delta_window_count": self.delta_window_count,
            "baseline_max_gap_h": round(self.baseline_max_gap_h, 3),
            "scenario_max_gap_h": round(self.scenario_max_gap_h, 3),
            "delta_max_gap_h": round(self.delta_max_gap_h, 3),
            "verdict": self.verdict,
        }


@dataclass(frozen=True)
class ScenarioSpec:
    """A named siltation/dredging scenario to scan alongside the baseline."""

    scenario_id: str
    label: str
    siltation_delta_m: float = 0.0
    dredging_delta_m: float = 0.0


@dataclass(frozen=True)
class TidalWindowResult:
    """Full M2 output for one vessel call."""

    vessel_id: str
    vessel_name: str
    static_draft_m: float
    transit_speed_kn: float

    horizon_start: datetime
    horizon_hours: float
    step_hours: float
    samples: int

    reaches_scanned: Tuple[str, ...]
    controlling_depth_m: float
    controlling_reach_id: str
    binding_reach_id: str
    required_tide_for_feasible_m: float

    baseline: ScenarioWindows
    scenarios: Tuple[ScenarioWindows, ...]
    comparisons: Tuple[WindowComparison, ...]
    conditional: ScenarioWindows          # MARGINAL-tolerant scan, reported separately

    tide_source: str
    recommendation: str
    breakdown: Dict[str, Any]

    def as_dict(self, include_samples: bool = False) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "vessel_id": self.vessel_id,
            "vessel_name": self.vessel_name,
            "static_draft_m": round(self.static_draft_m, 3),
            "transit_speed_kn": round(self.transit_speed_kn, 2),
            "horizon_start": _iso(self.horizon_start),
            "horizon_hours": self.horizon_hours,
            "step_hours": self.step_hours,
            "samples": self.samples,
            "reaches_scanned": list(self.reaches_scanned),
            "controlling_depth_m": round(self.controlling_depth_m, 3),
            "controlling_reach_id": self.controlling_reach_id,
            "binding_reach_id": self.binding_reach_id,
            "required_tide_for_feasible_m": round(self.required_tide_for_feasible_m, 3),
            "baseline": self.baseline.as_dict(),
            "scenarios": [s.as_dict() for s in self.scenarios],
            "comparisons": [c.as_dict() for c in self.comparisons],
            "conditional_marginal": self.conditional.as_dict(),
            "tide_source": self.tide_source,
            "recommendation": self.recommendation,
            "breakdown": self.breakdown,
        }
        if not include_samples:
            out["breakdown"] = {
                k: v for k, v in self.breakdown.items() if k != "full_curve"
            }
        return out


# ==========================================================================
# SECTION 4 — DATA PROVIDERS (loader hooks)
# ==========================================================================

try:  # pragma: no cover - typing convenience only
    from typing import Protocol, runtime_checkable
except ImportError:  # pragma: no cover
    Protocol = object  # type: ignore

    def runtime_checkable(c):  # type: ignore
        return c


@runtime_checkable
class TideProvider(Protocol):
    """Supplies tide height above chart datum as a function of time."""

    @property
    def source_id(self) -> str: ...

    def height_m(self, t: datetime) -> float: ...

    def series(self, start: datetime, hours: float, step_h: float) -> List[TideSample]: ...


class SyntheticTideProvider:
    """
    Analytic mixed semi-diurnal tide, per WS2_AI_ML_Tools.md row 1:
    "mixed semi-diurnal tide model (mean 2.6 m, amplitude 1.7 m)".

        h(t) = MEAN + AMP*cos(w*t) + K1*sin(0.5*w*t),   w = 2*pi / 12.4206 h

    The K1 term produces the diurnal inequality that makes successive high
    waters unequal — which is what makes the window widths unequal too, and
    therefore what makes the dredging comparison interesting.

    Fully deterministic: no RNG, so two runs with the same epoch agree exactly.
    Production upgrade path: INCOIS / tide-gauge assimilated surface.
    """

    source_id = "SYNTHETIC_HARMONIC_v1"

    def __init__(self, epoch: Optional[datetime] = None) -> None:
        self.epoch = _ensure_utc(epoch) if epoch is not None else datetime(
            2026, 1, 1, tzinfo=timezone.utc
        )

    def height_m(self, t: datetime) -> float:
        hours = (_ensure_utc(t) - self.epoch).total_seconds() / 3600.0
        w = 2.0 * math.pi / TIDE_M2_PERIOD_H
        return (
            TIDE_MEAN_M
            + TIDE_AMP_M * math.cos(w * hours)
            + TIDE_K1_AMP_M * math.sin(0.5 * w * hours)
        )

    def series(self, start: datetime, hours: float, step_h: float) -> List[TideSample]:
        start = _ensure_utc(start)
        n = int(round(hours / step_h)) + 1
        out: List[TideSample] = []
        for i in range(n):
            t = start + timedelta(hours=i * step_h)
            out.append(TideSample(t=t, height_m=self.height_m(t), kind="MID"))
        # Label local extrema so the curve is readable in the UI.
        labelled: List[TideSample] = []
        for i, s in enumerate(out):
            kind = "MID"
            if 0 < i < len(out) - 1:
                if out[i - 1].height_m < s.height_m >= out[i + 1].height_m:
                    kind = "HIGH"
                elif out[i - 1].height_m > s.height_m <= out[i + 1].height_m:
                    kind = "LOW"
            labelled.append(TideSample(t=s.t, height_m=s.height_m, kind=kind))
        return labelled


class BerthingReportTideProvider:
    """
    REAL-DATA STUB — tide predictions printed on the daily berthing reports.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Source directory:
        Model_Training_Data\\Model_Training_Data\\UC-I_Vessel_Traffic\\
        M1-M2_DUKC_and_Tidal_Windows\\Tide_Tables_from_Berthing_Reports\\
    Five terminal sub-folders, five PDFs each (25 total):
        APM Terminals\\APMT_Berthing_Report_-_DD-Mon-2026.pdf
        BMCT_PSA\\Berthing_Sheet__DD_MON_2026*.pdf
        NSFT\\Daily_Berthing_Report_D_M_2026.pdf
        NSICT_DP World\\BERTHING-CT*.pdf
        NSIGT_DP World\\BERTHING-GT*.pdf

    Extract from the report HEADER (not the vessel table): the HW/LW extrema for
    the day, as (clock time, height in metres). Terminals print these in
    different header layouts, so each folder needs its own parse profile.

    Contract:
        return List[TideSample(t=<tz-aware UTC>, height_m=float,
                               kind='HIGH'|'LOW')], sorted ascending.
        Source timestamps are IST (UTC+05:30, no DST) -> convert to UTC here,
        not in the caller.

    Interpolation between the printed extrema is this class's responsibility,
    NOT the caller's. Use cosine interpolation between consecutive HW/LW pairs:
        h(t) = (h1+h2)/2 + (h1-h2)/2 * cos(pi * (t-t1)/(t2-t1))
    which is the standard "rule of twelfths" continuous analogue and matches
    admiralty practice closely enough for window scanning.

    Reject: any day where fewer than 2 extrema parse, or where consecutive
    extrema are not alternating HIGH/LOW.

    Set source_id = "JNPA_BERTHING_REPORT_PDF/<terminal>/<date>".
    Dependency to add when implementing: pdfplumber.
    """

    source_id = "JNPA_BERTHING_REPORT_PDF/NOT_IMPLEMENTED"

    def height_m(self, t: datetime) -> float:
        raise NotImplementedError(BerthingReportTideProvider.__doc__)

    def series(self, start: datetime, hours: float, step_h: float) -> List[TideSample]:
        raise NotImplementedError(BerthingReportTideProvider.__doc__)


# ==========================================================================
# SECTION 5 — ENGINE
# ==========================================================================


def _threshold_for_status(target: str) -> float:
    """Net-UKC threshold that a status band requires."""
    key = (target or "").strip().upper()
    if key == STATUS_SAFE:
        return UKC_SAFETY_MARGIN_M
    if key == STATUS_MARGINAL:
        return UKC_MARGINAL_BAND_M
    raise ValueError(f"min_status must be SAFE or MARGINAL, got {target!r}")


def controlling_depth(
    reaches: Mapping[str, ChannelReach],
    siltation_m: float = 0.0,
    dredging_m: float = 0.0,
) -> Tuple[float, str]:
    """
    Controlling depth as the spec defines it: minimum charted depth across the
    reaches, adjusted for siltation/dredging.

    Reported for continuity with the tender document. Note that go/no-go uses
    the per-reach minimum NET UKC instead — see the module docstring.
    """
    best_id = min(reaches.values(), key=lambda r: (r.charted_depth_m, r.reach_id)).reach_id
    depth = reaches[best_id].charted_depth_m - siltation_m + dredging_m
    return depth, best_id


def required_tide_m(
    draft_m: float,
    reaches: Mapping[str, ChannelReach],
    transit_speed_kn: float,
    cb: float,
    siltation_m: float = 0.0,
    dredging_m: float = 0.0,
    margin_m: float = UKC_SAFETY_MARGIN_M,
    min_status: str = STATUS_SAFE,
) -> Tuple[float, str]:
    """
    Closed-form: the tide height at which the whole transit first becomes
    feasible, and the reach that sets it.

        tide_req(reach) = threshold + margin + draft + squat(V_reach)
                          - charted + siltation - dredging

    The binding reach is the one with the LARGEST required tide — that is the
    constraint that opens last and closes first.
    """
    threshold = _threshold_for_status(min_status)
    worst_tide = -math.inf
    worst_id = ""
    for rid, reach in reaches.items():
        v = min(transit_speed_kn, reach.max_speed_kn)
        sq = _squat_m(cb, v)
        need = (
            threshold + margin_m + draft_m + sq - reach.charted_depth_m
            + siltation_m - dredging_m
        )
        if need > worst_tide:
            worst_tide = need
            worst_id = rid
    return worst_tide, worst_id


def evaluate_reaches_at(
    vessel: VesselState,
    tide_m: float,
    reaches: Mapping[str, ChannelReach],
    siltation_m: float,
    dredging_m: float,
    margin_m: float = UKC_SAFETY_MARGIN_M,
) -> List[ReachFeasibility]:
    """
    Evaluate every reach at one tide height, each at its own speed cap.

    This is the step where per-reach speed limits matter: squat scales with V^2,
    so a shallow reach with a low speed limit can be less binding than a deeper
    reach transited faster.
    """
    out: List[ReachFeasibility] = []
    for rid, reach in reaches.items():
        v = min(vessel.transit_speed_kn, reach.max_speed_kn)
        sq = _squat_m(vessel.cb, v)
        eff = _effective_depth_m(reach.charted_depth_m, tide_m, siltation_m, dredging_m)
        _, net = _net_ukc_m(
            reach.charted_depth_m, tide_m, siltation_m,
            vessel.static_draft_m, sq, margin_m, dredging_m,
        )
        out.append(
            ReachFeasibility(
                reach_id=rid,
                charted_depth_m=reach.charted_depth_m,
                speed_kn=v,
                effective_depth_m=eff,
                squat_m=sq,
                net_ukc_m=net,
                status=_ukc_status(net),
            )
        )
    return out


def scan_samples(
    vessel: VesselState,
    tide: TideProvider,
    start: datetime,
    reaches: Mapping[str, ChannelReach],
    siltation_m: float = 0.0,
    dredging_m: float = 0.0,
    hours: float = FORECAST_HOURS,
    step_h: float = STEP_HOURS,
    margin_m: float = UKC_SAFETY_MARGIN_M,
    min_status: str = STATUS_SAFE,
) -> List[ScanSample]:
    """
    Walk the tide curve and evaluate transit feasibility at every step.

    Returns ``int(hours/step_h) + 1`` samples, inclusive of both endpoints.
    """
    start = _ensure_utc(start)
    curve = tide.series(start, hours, step_h)
    out: List[ScanSample] = []
    for i, s in enumerate(curve):
        per_reach = evaluate_reaches_at(
            vessel, s.height_m, reaches, siltation_m, dredging_m, margin_m
        )
        binding = min(per_reach, key=lambda r: (r.net_ukc_m, r.reach_id))
        status = _ukc_status(binding.net_ukc_m)
        out.append(
            ScanSample(
                index=i,
                t=s.t,
                tide_m=s.height_m,
                binding_reach_id=binding.reach_id,
                controlling_net_ukc_m=binding.net_ukc_m,
                status=status,
                feasible=_STATUS_RANK[status] >= _STATUS_RANK[min_status],
            )
        )
    return out


def windows_from_samples(
    samples: Sequence[ScanSample],
    step_h: float = STEP_HOURS,
    min_window_h: float = MIN_WINDOW_HOURS,
) -> Tuple[List[TidalWindow], int]:
    """
    Assemble contiguous feasible runs into windows.

    BOUNDARY CONVENTION: a run covering sample indices i..j inclusive has
    ``duration_h = (j - i) * step_h``. Two adjacent feasible samples give
    0.25 h, not 0.5 h. Runs shorter than ``min_window_h`` are discarded as
    operationally unusable; the discard count is returned so the caller can
    report it rather than silently losing openings.
    """
    windows: List[TidalWindow] = []
    discarded = 0
    wid = 0
    i = 0
    n = len(samples)
    while i < n:
        if not samples[i].feasible:
            i += 1
            continue
        j = i
        while j + 1 < n and samples[j + 1].feasible:
            j += 1
        run = samples[i : j + 1]
        duration = (j - i) * step_h
        if duration + 1e-12 < min_window_h:
            discarded += 1
            i = j + 1
            continue
        peak = max(run, key=lambda s: s.tide_m)
        wid += 1
        windows.append(
            TidalWindow(
                window_id=wid,
                start=run[0].t,
                end=run[-1].t,
                duration_h=duration,
                peak_tide_m=peak.tide_m,
                peak_tide_at=peak.t,
                min_tide_m=min(s.tide_m for s in run),
                min_net_ukc_m=min(s.controlling_net_ukc_m for s in run),
                max_net_ukc_m=max(s.controlling_net_ukc_m for s in run),
                binding_reach_id=min(
                    run, key=lambda s: s.controlling_net_ukc_m
                ).binding_reach_id,
                worst_status=min(
                    (s.status for s in run), key=lambda s: _STATUS_RANK[s]
                ),
                opens_at_tide_m=run[0].tide_m,
                sample_start_index=i,
                sample_end_index=j,
            )
        )
        i = j + 1
    return windows, discarded


def scan_windows(
    vessel: VesselState,
    tide: TideProvider,
    start: datetime,
    reaches: Mapping[str, ChannelReach],
    scenario_id: str = "BASELINE",
    label: str = "Baseline",
    siltation_m: float = 0.0,
    dredging_m: float = 0.0,
    hours: float = FORECAST_HOURS,
    step_h: float = STEP_HOURS,
    margin_m: float = UKC_SAFETY_MARGIN_M,
    min_status: str = STATUS_SAFE,
    min_window_h: float = MIN_WINDOW_HOURS,
) -> Tuple[ScenarioWindows, List[ScanSample]]:
    """Scan one scenario end to end. Returns the summary and the raw samples."""
    samples = scan_samples(
        vessel, tide, start, reaches, siltation_m, dredging_m,
        hours, step_h, margin_m, min_status,
    )
    windows, discarded = windows_from_samples(samples, step_h, min_window_h)

    total = sum(w.duration_h for w in windows)
    count = len(windows)
    req_tide, binding = required_tide_m(
        vessel.static_draft_m, reaches, vessel.transit_speed_kn, vessel.cb,
        siltation_m, dredging_m, margin_m, min_status,
    )

    # Max gap: the longest stretch with no usable window, measured between the
    # END of one window and the START of the next, plus the leading and trailing
    # stretches of the horizon. This is the number a berth planner acts on.
    horizon_start = samples[0].t
    horizon_end = samples[-1].t
    gaps: List[float] = []
    if not windows:
        gaps.append((horizon_end - horizon_start).total_seconds() / 3600.0)
    else:
        gaps.append((windows[0].start - horizon_start).total_seconds() / 3600.0)
        for a, b in zip(windows, windows[1:]):
            gaps.append((b.start - a.end).total_seconds() / 3600.0)
        gaps.append((horizon_end - windows[-1].end).total_seconds() / 3600.0)

    summary = ScenarioWindows(
        scenario_id=scenario_id,
        label=label,
        siltation_delta_m=siltation_m,
        dredging_delta_m=dredging_m,
        min_status=min_status,
        windows=tuple(windows),
        window_count=count,
        total_usable_hours=total,
        mean_window_hours=(total / count) if count else 0.0,
        longest_window_h=max((w.duration_h for w in windows), default=0.0),
        shortest_window_h=min((w.duration_h for w in windows), default=0.0),
        max_gap_hours=max(gaps) if gaps else 0.0,
        first_window_start=windows[0].start if windows else None,
        availability_pct=(total / hours * 100.0) if hours else 0.0,
        discarded_short_windows=discarded,
        required_tide_m=req_tide,
        binding_reach_id=binding,
    )
    return summary, samples


def compare_scenarios(baseline: ScenarioWindows, other: ScenarioWindows) -> WindowComparison:
    """Quantify a scenario against the baseline in hours, percent and max gap."""
    delta = other.total_usable_hours - baseline.total_usable_hours
    pct = (delta / baseline.total_usable_hours * 100.0) if baseline.total_usable_hours else 0.0
    if abs(delta) < 1e-9:
        verdict = "UNCHANGED"
    elif delta > 0:
        verdict = "WIDENED"
    else:
        verdict = "SHRANK"
    return WindowComparison(
        scenario_id=other.scenario_id,
        label=other.label,
        baseline_hours=baseline.total_usable_hours,
        scenario_hours=other.total_usable_hours,
        delta_hours=delta,
        delta_pct=pct,
        delta_window_count=other.window_count - baseline.window_count,
        baseline_max_gap_h=baseline.max_gap_hours,
        scenario_max_gap_h=other.max_gap_hours,
        delta_max_gap_h=other.max_gap_hours - baseline.max_gap_hours,
        verdict=verdict,
    )


DEFAULT_SCENARIOS: Tuple[ScenarioSpec, ...] = (
    ScenarioSpec("DREDGED", f"Dredged +{DEFAULT_DREDGING_DELTA_M:.1f} m",
                 0.0, DEFAULT_DREDGING_DELTA_M),
    ScenarioSpec("SILTED", f"Silted -{DEFAULT_SILTATION_DELTA_M:.1f} m",
                 DEFAULT_SILTATION_DELTA_M, 0.0),
)


def evaluate_tidal_windows(
    vessel: VesselState,
    tide: Optional[TideProvider] = None,
    start: Optional[datetime] = None,
    reaches: Optional[Mapping[str, ChannelReach]] = None,
    scenarios: Sequence[ScenarioSpec] = DEFAULT_SCENARIOS,
    hours: float = FORECAST_HOURS,
    step_h: float = STEP_HOURS,
    margin_m: float = UKC_SAFETY_MARGIN_M,
    min_status: str = STATUS_SAFE,
    min_window_h: float = MIN_WINDOW_HOURS,
) -> TidalWindowResult:
    """
    Full M2 evaluation: baseline scan, scenario scans, and the comparison table.

    Also runs a MARGINAL-tolerant scan and reports it separately as
    ``conditional`` — those hours are visible but never counted as usable.
    """
    tide = tide or SyntheticTideProvider()
    start = _ensure_utc(start) if start is not None else datetime(2026, 8, 1, tzinfo=timezone.utc)
    reach_map = dict(reaches) if reaches is not None else dict(DEFAULT_REACHES)

    baseline, base_samples = scan_windows(
        vessel, tide, start, reach_map, "BASELINE", "Baseline",
        0.0, 0.0, hours, step_h, margin_m, min_status, min_window_h,
    )

    scen_results: List[ScenarioWindows] = []
    for spec in scenarios:
        s, _ = scan_windows(
            vessel, tide, start, reach_map, spec.scenario_id, spec.label,
            spec.siltation_delta_m, spec.dredging_delta_m,
            hours, step_h, margin_m, min_status, min_window_h,
        )
        scen_results.append(s)

    comparisons = tuple(compare_scenarios(baseline, s) for s in scen_results)

    # Conditional (MARGINAL-tolerant) scan — reported, never counted as usable.
    conditional, _ = scan_windows(
        vessel, tide, start, reach_map, "CONDITIONAL", "Conditional (MARGINAL tolerated)",
        0.0, 0.0, hours, step_h, margin_m, STATUS_MARGINAL, min_window_h,
    )

    ctrl_depth, ctrl_reach = controlling_depth(reach_map)
    req_tide, binding = required_tide_m(
        vessel.static_draft_m, reach_map, vessel.transit_speed_kn, vessel.cb,
        0.0, 0.0, margin_m, min_status,
    )

    # Recommendation
    if baseline.window_count == 0:
        rec = (
            f"NO transit window in the next {hours:.0f} h at draft "
            f"{vessel.static_draft_m:.2f} m and {vessel.transit_speed_kn:.1f} kn. "
            f"{binding} needs {req_tide:.2f} m of tide; the curve peaks below that. "
            f"Options: lighten to reduce draft, reduce speed, or dredge."
        )
    else:
        widened = [c for c in comparisons if c.verdict == "WIDENED"]
        rec = (
            f"{baseline.window_count} usable windows totalling "
            f"{baseline.total_usable_hours:.2f} h "
            f"({baseline.availability_pct:.1f}% of the horizon); longest "
            f"{baseline.longest_window_h:.2f} h, worst wait "
            f"{baseline.max_gap_hours:.2f} h. Binding reach {binding} at "
            f"{req_tide:.2f} m required tide."
        )
        if widened:
            best = max(widened, key=lambda c: c.delta_hours)
            rec += (
                f" {best.label} would add {best.delta_hours:+.2f} h "
                f"({best.delta_pct:+.1f}%) and cut the worst wait by "
                f"{-best.delta_max_gap_h:.2f} h."
            )

    # Decimated curve trace: every 20th sample, so the walk is inspectable
    # without shipping a 481-row payload in every response.
    trace = [s.as_dict() for s in base_samples[::20]]

    steps = [
        _step(
            1,
            "Horizon construction",
            "samples = int(horizon_hours / step_hours) + 1",
            f"int({hours:.0f} / {step_h}) + 1 = {len(base_samples)}",
            {"horizon_hours": hours, "step_hours": step_h},
            len(base_samples),
            "samples",
            f"expected {EXPECTED_SAMPLES} at the default 120 h / 0.25 h",
        ),
        _step(
            2,
            "Controlling depth",
            "controlling_depth = min(charted depth over reaches)",
            f"min({', '.join(f'{r.charted_depth_m:.1f}' for r in reach_map.values())}) "
            f"= {ctrl_depth:.2f} ({ctrl_reach})",
            {rid: r.charted_depth_m for rid, r in reach_map.items()},
            round(ctrl_depth, 3),
            "m",
            "reported per spec; go/no-go uses per-reach net UKC instead",
        ),
        _step(
            3,
            "Squat per reach",
            "squat_reach = min(2.5, Cb * min(V_transit, V_reach)^2 / 100)",
            "; ".join(
                f"{rid}@{min(vessel.transit_speed_kn, r.max_speed_kn):.0f}kn="
                f"{_squat_m(vessel.cb, min(vessel.transit_speed_kn, r.max_speed_kn)):.3f}"
                for rid, r in reach_map.items()
            ),
            {"Cb": round(vessel.cb, 4), "V_transit_kn": vessel.transit_speed_kn},
            {
                rid: round(_squat_m(vessel.cb, min(vessel.transit_speed_kn, r.max_speed_kn)), 4)
                for rid, r in reach_map.items()
            },
            "m",
            "each reach uses its own speed cap",
        ),
        _step(
            4,
            "Required tide threshold",
            "tide_req = threshold + margin + draft + squat - charted + silt - dredge",
            f"{_threshold_for_status(min_status):.2f} + {margin_m:.2f} + "
            f"{vessel.static_draft_m:.2f} + "
            f"{_squat_m(vessel.cb, min(vessel.transit_speed_kn, reach_map[binding].max_speed_kn)):.3f}"
            f" - {reach_map[binding].charted_depth_m:.2f} = {req_tide:.3f}",
            {
                "threshold_m": _threshold_for_status(min_status),
                "margin_m": margin_m,
                "draft_m": vessel.static_draft_m,
                "binding_reach": binding,
            },
            round(req_tide, 3),
            "m",
            f"binding reach {binding} (largest required tide)",
        ),
        _step(
            5,
            "Curve walk",
            "feasible(t) = status(min net UKC over reaches) >= min_status",
            f"{sum(1 for s in base_samples if s.feasible)} of {len(base_samples)} "
            f"samples feasible at min_status={min_status}",
            {
                "feasible_samples": sum(1 for s in base_samples if s.feasible),
                "total_samples": len(base_samples),
                "min_status": min_status,
            },
            sum(1 for s in base_samples if s.feasible),
            "samples",
            "",
        ),
        _step(
            6,
            "Window assembly",
            "window i..j inclusive -> duration_h = (j - i) * step_hours",
            f"{baseline.window_count} windows, {baseline.total_usable_hours:.2f} h total, "
            f"{baseline.discarded_short_windows} discarded below {min_window_h} h",
            {
                "window_count": baseline.window_count,
                "min_window_h": min_window_h,
                "discarded": baseline.discarded_short_windows,
            },
            round(baseline.total_usable_hours, 3),
            "h",
            "boundary convention pinned in the self-test",
        ),
        _step(
            7,
            "Scenario comparison",
            "delta_h = scenario.total - baseline.total ; delta_pct = delta / baseline * 100",
            "; ".join(
                f"{c.label}: {c.delta_hours:+.2f} h ({c.delta_pct:+.1f}%) {c.verdict}"
                for c in comparisons
            ),
            {c.scenario_id: round(c.delta_hours, 3) for c in comparisons},
            [round(c.delta_hours, 3) for c in comparisons],
            "h",
            "this is the 'extend tidal window' deliverable",
        ),
    ]

    breakdown: Dict[str, Any] = {
        "model": "M2_TIDAL_WINDOW",
        "version": MODULE_VERSION,
        "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
        "constants": {
            "FORECAST_HOURS": hours,
            "STEP_HOURS": step_h,
            "EXPECTED_SAMPLES": EXPECTED_SAMPLES,
            "MIN_WINDOW_HOURS": min_window_h,
            "UKC_SAFETY_MARGIN_M": UKC_SAFETY_MARGIN_M,
            "UKC_MARGINAL_BAND_M": UKC_MARGINAL_BAND_M,
            "TIDE_MEAN_M": TIDE_MEAN_M,
            "TIDE_AMP_M": TIDE_AMP_M,
            "TIDE_K1_AMP_M": TIDE_K1_AMP_M,
            "TIDE_M2_PERIOD_H": TIDE_M2_PERIOD_H,
        },
        "inputs": {
            "vessel_id": vessel.vessel_id,
            "vessel_name": vessel.vessel_name,
            "vessel_class": vessel.vessel_class,
            "static_draft_m": vessel.static_draft_m,
            "transit_speed_kn": vessel.transit_speed_kn,
            "horizon_start": _iso(start),
            "horizon_hours": hours,
            "step_hours": step_h,
            "min_status": min_status,
            "reaches": list(reach_map.keys()),
        },
        "steps": steps,
        "scenarios": {
            s.scenario_id: {
                "label": s.label,
                "siltation_delta_m": s.siltation_delta_m,
                "dredging_delta_m": s.dredging_delta_m,
                "required_tide_m": round(s.required_tide_m, 3),
                "window_count": s.window_count,
                "total_usable_hours": round(s.total_usable_hours, 3),
                "mean_window_hours": round(s.mean_window_hours, 3),
                "max_gap_hours": round(s.max_gap_hours, 3),
                "availability_pct": round(s.availability_pct, 2),
            }
            for s in [baseline] + scen_results
        },
        "comparisons": [c.as_dict() for c in comparisons],
        "conditional_marginal": {
            "note": (
                "MARGINAL-tolerant scan. Reported for visibility only; these hours "
                "are NOT counted in headline usable hours because a 0.6 m net UKC "
                "transit is not routinely claimable."
            ),
            "total_usable_hours": round(conditional.total_usable_hours, 3),
            "window_count": conditional.window_count,
            "extra_hours_vs_safe": round(
                conditional.total_usable_hours - baseline.total_usable_hours, 3
            ),
        },
        "curve_sample": {
            "note": f"every 20th sample of {len(base_samples)} (baseline scenario)",
            "rows": trace,
        },
        "full_curve": [s.as_dict() for s in base_samples],
        "result": {
            "window_count": baseline.window_count,
            "total_usable_hours": round(baseline.total_usable_hours, 3),
            "availability_pct": round(baseline.availability_pct, 2),
            "max_gap_hours": round(baseline.max_gap_hours, 3),
            "binding_reach_id": binding,
            "required_tide_m": round(req_tide, 3),
            "recommendation": rec,
        },
        "assumptions": [
            "Analytic mixed semi-diurnal tide (mean 2.6 m, amplitude 1.7 m, K1 0.3 m).",
            "Feasibility evaluated on every reach, each at its own speed cap.",
            "Window i..j inclusive has duration (j-i)*step_h.",
            f"Windows shorter than {min_window_h} h are discarded as unusable.",
            f"min_status={min_status}: MARGINAL periods reported separately, not counted.",
        ],
        "provenance": {
            "tide_source": getattr(tide, "source_id", "UNKNOWN"),
            "depth_source": "DEFAULT_CHANNEL_MODEL_v1",
            "generated_at_utc": _iso(_utc_now()),
        },
    }

    return TidalWindowResult(
        vessel_id=vessel.vessel_id,
        vessel_name=vessel.vessel_name,
        static_draft_m=vessel.static_draft_m,
        transit_speed_kn=vessel.transit_speed_kn,
        horizon_start=start,
        horizon_hours=hours,
        step_hours=step_h,
        samples=len(base_samples),
        reaches_scanned=tuple(reach_map.keys()),
        controlling_depth_m=ctrl_depth,
        controlling_reach_id=ctrl_reach,
        binding_reach_id=binding,
        required_tide_for_feasible_m=req_tide,
        baseline=baseline,
        scenarios=tuple(scen_results),
        comparisons=comparisons,
        conditional=conditional,
        tide_source=getattr(tide, "source_id", "UNKNOWN"),
        recommendation=rec,
        breakdown=breakdown,
    )


MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "dukc_core_version": DUKC_CORE_VERSION,
    "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
    "spec_row": "WS2_AI_ML_Tools.md row 2 — Tidal-window computation & extension",
    "model_type": "deterministic window-scan over the DUKC physics model",
    "constants": {
        "FORECAST_HOURS": FORECAST_HOURS,
        "STEP_HOURS": STEP_HOURS,
        "EXPECTED_SAMPLES": EXPECTED_SAMPLES,
        "MIN_WINDOW_HOURS": MIN_WINDOW_HOURS,
        "TIDE_MEAN_M": TIDE_MEAN_M,
        "TIDE_AMP_M": TIDE_AMP_M,
        "TIDE_K1_AMP_M": TIDE_K1_AMP_M,
        "TIDE_M2_PERIOD_H": TIDE_M2_PERIOD_H,
        "UKC_SAFETY_MARGIN_M": UKC_SAFETY_MARGIN_M,
        "UKC_MARGINAL_BAND_M": UKC_MARGINAL_BAND_M,
        "DEFAULT_MIN_STATUS": STATUS_SAFE,
    },
    "reaches": {
        rid: {
            "name": r.name,
            "charted_depth_m": r.charted_depth_m,
            "max_speed_kn": r.max_speed_kn,
        }
        for rid, r in DEFAULT_REACHES.items()
    },
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

    class TidalWindowRequest(BaseModel):
        """Five-day tidal window scan for one vessel call."""

        vessel_id: str = Field("V-1002", max_length=32)
        vessel_name: str = Field("MAERSK Mc-KINNEY MOLLER", max_length=120)
        vessel_class: Literal["CONTAINER", "BULK"] = "CONTAINER"
        static_draft_m: float = Field(15.5, gt=0, le=25)
        transit_speed_kn: float = Field(10.0, ge=0, le=30)
        horizon_start: Optional[datetime] = None
        horizon_hours: float = Field(120.0, gt=0, le=336)
        step_hours: float = Field(0.25, gt=0, le=1)
        reach_ids: List[str] = Field(default_factory=lambda: list(REACH_IDS))
        dredging_delta_m: float = Field(0.5, ge=0, le=3)
        siltation_delta_m: float = Field(0.3, ge=0, le=3)
        safety_margin_m: float = Field(1.0, ge=0, le=3)
        min_status: Literal["SAFE", "MARGINAL"] = "SAFE"
        min_window_hours: float = Field(0.5, ge=0, le=12)
        include_samples: bool = False       # guards the 481-row payload

        def to_call(self) -> Tuple[VesselState, Dict[str, ChannelReach], datetime,
                                   Tuple[ScenarioSpec, ...]]:
            unknown = [r for r in self.reach_ids if r not in DEFAULT_REACHES]
            if unknown:
                raise HTTPException(422, f"unknown reach_ids: {unknown}")
            vessel = VesselState(
                vessel_id=self.vessel_id,
                vessel_name=self.vessel_name,
                vessel_class=self.vessel_class,
                static_draft_m=self.static_draft_m,
                transit_speed_kn=self.transit_speed_kn,
            )
            reaches = {r: DEFAULT_REACHES[r] for r in self.reach_ids}
            start = self.horizon_start or datetime(2026, 8, 1, tzinfo=timezone.utc)
            if start.tzinfo is None:
                start = start.replace(tzinfo=timezone.utc)
            scenarios = (
                ScenarioSpec("DREDGED", f"Dredged +{self.dredging_delta_m:.1f} m",
                             0.0, self.dredging_delta_m),
                ScenarioSpec("SILTED", f"Silted -{self.siltation_delta_m:.1f} m",
                             self.siltation_delta_m, 0.0),
            )
            return vessel, reaches, start, scenarios

    def build_router() -> "APIRouter":
        """Construct the UC1-M2 router. Mounted by ``api.py``."""
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC1-M2 Tidal Windows"])

        @router.post("/windows", summary="Scan 120 h of tide for usable transit windows")
        def windows(req: TidalWindowRequest) -> Dict[str, Any]:
            vessel, reaches, start, scenarios = req.to_call()
            res = evaluate_tidal_windows(
                vessel, SyntheticTideProvider(), start, reaches, scenarios,
                req.horizon_hours, req.step_hours, req.safety_margin_m,
                req.min_status, req.min_window_hours,
            )
            return res.as_dict(include_samples=req.include_samples)

        @router.post("/extension", summary="Dredging vs siltation window-width delta")
        def extension(req: TidalWindowRequest) -> Dict[str, Any]:
            vessel, reaches, start, scenarios = req.to_call()
            res = evaluate_tidal_windows(
                vessel, SyntheticTideProvider(), start, reaches, scenarios,
                req.horizon_hours, req.step_hours, req.safety_margin_m,
                req.min_status, req.min_window_hours,
            )
            return {
                "vessel_id": res.vessel_id,
                "static_draft_m": res.static_draft_m,
                "binding_reach_id": res.binding_reach_id,
                "required_tide_for_feasible_m": round(res.required_tide_for_feasible_m, 3),
                "baseline": res.baseline.as_dict(),
                "scenarios": [s.as_dict() for s in res.scenarios],
                "comparisons": [c.as_dict() for c in res.comparisons],
                "recommendation": res.recommendation,
            }

        @router.get("/tide-curve", summary="Raw tide curve for charting")
        def tide_curve(
            hours: float = Query(120.0, gt=0, le=336),
            step_h: float = Query(0.25, gt=0, le=1),
            start: Optional[datetime] = None,
        ) -> Dict[str, Any]:
            provider = SyntheticTideProvider()
            s = start or datetime(2026, 8, 1, tzinfo=timezone.utc)
            if s.tzinfo is None:
                s = s.replace(tzinfo=timezone.utc)
            series = provider.series(s, hours, step_h)
            return {
                "source_id": provider.source_id,
                "start": _iso(s),
                "hours": hours,
                "step_h": step_h,
                "count": len(series),
                "samples": [
                    {"t": _iso(x.t), "height_m": round(x.height_m, 4), "kind": x.kind}
                    for x in series
                ],
            }

        @router.get("/constants", summary="Versioned constants (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {
                "module_version": MODULE_VERSION,
                "dukc_core_version": DUKC_CORE_VERSION,
                "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
                "constants": MODULE_INFO["constants"],
            }

        @router.get("/demo", summary="Run the canonical demo scenario")
        def demo() -> Dict[str, Any]:
            vessel = VesselState("V-1002", "MAERSK Mc-KINNEY MOLLER", "CONTAINER", 15.5, 10.0)
            return evaluate_tidal_windows(vessel).as_dict(include_samples=False)

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


def _self_test() -> List[Tuple[str, bool, str]]:
    """Return ``[(check_name, passed, detail), ...]``."""
    checks: List[Tuple[str, bool, str]] = []

    try:
        _dukc_core_selftest()
        checks.append(("dukc_core_golden_values", True, DUKC_CORE_FINGERPRINT))
    except AssertionError as exc:
        checks.append(("dukc_core_golden_values", False, str(exc)))

    vessel = VesselState("V-1002", "MAERSK Mc-KINNEY MOLLER", "CONTAINER", 15.5, 10.0)
    res = evaluate_tidal_windows(vessel)

    checks.append(
        (
            "sample_count_481",
            res.samples == EXPECTED_SAMPLES,
            f"{res.samples} samples over {res.horizon_hours:.0f} h at {res.step_hours} h",
        )
    )

    # Window boundary convention: i..j inclusive -> (j-i)*step_h.
    conv_ok = True
    conv_detail = "no windows to check"
    if res.baseline.windows:
        w = res.baseline.windows[0]
        expected = (w.sample_end_index - w.sample_start_index) * res.step_hours
        wall = (w.end - w.start).total_seconds() / 3600.0
        conv_ok = abs(w.duration_h - expected) < 1e-9 and abs(wall - expected) < 1e-6
        conv_detail = (
            f"window {w.window_id}: indices {w.sample_start_index}..{w.sample_end_index} "
            f"-> {w.duration_h:.2f} h (wall clock {wall:.2f} h)"
        )
    checks.append(("window_duration_convention", conv_ok, conv_detail))

    # A hand-built two-sample run must give exactly one step of duration.
    now = datetime(2026, 8, 1, tzinfo=timezone.utc)
    synthetic = [
        ScanSample(0, now, 3.0, "CH-INNER", 0.1, STATUS_NO_GO, False),
        ScanSample(1, now + timedelta(hours=0.25), 3.5, "CH-INNER", 1.1, STATUS_SAFE, True),
        ScanSample(2, now + timedelta(hours=0.50), 3.6, "CH-INNER", 1.2, STATUS_SAFE, True),
        ScanSample(3, now + timedelta(hours=0.75), 3.0, "CH-INNER", 0.1, STATUS_NO_GO, False),
    ]
    hand_w, hand_discard = windows_from_samples(synthetic, 0.25, min_window_h=0.0)
    checks.append(
        (
            "hand_built_window_offbyone",
            len(hand_w) == 1 and abs(hand_w[0].duration_h - 0.25) < 1e-12,
            f"{len(hand_w)} window(s), duration "
            f"{hand_w[0].duration_h if hand_w else float('nan'):.4f} h (expected 0.2500)",
        )
    )

    # Short-window discard must be counted, not silently dropped.
    _, disc = windows_from_samples(synthetic, 0.25, min_window_h=0.5)
    checks.append(
        ("short_window_discard_counted", disc == 1, f"discarded={disc} (expected 1)")
    )

    # The headline lever test: dredged > baseline > silted, in usable hours.
    dredged = next(s for s in res.scenarios if s.scenario_id == "DREDGED")
    silted = next(s for s in res.scenarios if s.scenario_id == "SILTED")
    checks.append(
        (
            "lever_monotonicity",
            dredged.total_usable_hours > res.baseline.total_usable_hours > silted.total_usable_hours,
            f"dredged {dredged.total_usable_hours:.2f} h > baseline "
            f"{res.baseline.total_usable_hours:.2f} h > silted {silted.total_usable_hours:.2f} h",
        )
    )

    # Verdicts must match the direction of the deltas.
    verdicts = {c.scenario_id: c.verdict for c in res.comparisons}
    checks.append(
        (
            "comparison_verdicts",
            verdicts.get("DREDGED") == "WIDENED" and verdicts.get("SILTED") == "SHRANK",
            f"DREDGED={verdicts.get('DREDGED')} SILTED={verdicts.get('SILTED')}",
        )
    )

    # Dredging must not make the worst wait longer.
    dredge_cmp = next(c for c in res.comparisons if c.scenario_id == "DREDGED")
    checks.append(
        (
            "dredging_reduces_max_gap",
            dredge_cmp.delta_max_gap_h <= 1e-9,
            f"max gap {dredge_cmp.baseline_max_gap_h:.2f} -> "
            f"{dredge_cmp.scenario_max_gap_h:.2f} h ({dredge_cmp.delta_max_gap_h:+.2f})",
        )
    )

    # Required tide must agree with the forward scan: every window's opening
    # tide must be at or above the threshold.
    if res.baseline.windows:
        min_open = min(w.min_tide_m for w in res.baseline.windows)
        checks.append(
            (
                "required_tide_consistency",
                min_open >= res.required_tide_for_feasible_m - 1e-6,
                f"lowest in-window tide {min_open:.3f} m >= required "
                f"{res.required_tide_for_feasible_m:.3f} m",
            )
        )

    # Every feasible sample must actually satisfy min_status.
    full = res.breakdown["full_curve"]
    bad = [r for r in full if r["feasible"] and r["status"] not in (STATUS_SAFE,)]
    checks.append(
        (
            "feasibility_matches_status",
            not bad,
            f"{len(full)} samples scanned, {len(bad)} mislabelled",
        )
    )

    # The MARGINAL-tolerant scan must be a superset in hours.
    checks.append(
        (
            "conditional_superset",
            res.conditional.total_usable_hours >= res.baseline.total_usable_hours,
            f"conditional {res.conditional.total_usable_hours:.2f} h >= "
            f"safe {res.baseline.total_usable_hours:.2f} h "
            f"(+{res.conditional.total_usable_hours - res.baseline.total_usable_hours:.2f} h "
            f"not counted as usable)",
        )
    )

    # A vessel too deep to ever transit must yield zero windows, not a crash.
    deep = VesselState("V-DEEP", "TOO DEEP", "CONTAINER", 20.0, 10.0)
    deep_res = evaluate_tidal_windows(deep)
    checks.append(
        (
            "infeasible_vessel_zero_windows",
            deep_res.baseline.window_count == 0 and "NO transit window" in deep_res.recommendation,
            f"draft 20.0 m -> {deep_res.baseline.window_count} windows, "
            f"required tide {deep_res.required_tide_for_feasible_m:.2f} m",
        )
    )

    # Breakdown completeness.
    checks.append(
        (
            "breakdown_completeness",
            len(res.breakdown["steps"]) == 7
            and all(s.get("substitution") for s in res.breakdown["steps"]),
            f"{len(res.breakdown['steps'])} steps, all with substitutions",
        )
    )

    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="UC1-M2 tidal window scanner — demo and self-test runner."
    )
    parser.add_argument("--draft", type=float, default=15.5, help="Static draft in metres.")
    parser.add_argument("--speed", type=float, default=10.0, help="Transit speed in knots.")
    parser.add_argument(
        "--vessel-class", choices=["CONTAINER", "BULK"], default="CONTAINER"
    )
    parser.add_argument(
        "--min-status", choices=["SAFE", "MARGINAL"], default="SAFE",
        help="Feasibility threshold (default SAFE).",
    )
    parser.add_argument("--json", action="store_true", help="Dump the result as JSON.")
    parser.add_argument("--quiet", action="store_true", help="Print only the self-test summary.")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="Unused; CLI parity.")
    args = parser.parse_args(argv)

    if not args.quiet:
        print("=" * 78)
        print(f"{MODULE_ID} — {MODULE_NAME}   ({MODULE_VERSION})")
        print("JNPA UC-I Vessel Traffic Management | WS2 row 2 | deterministic window scan")
        print("=" * 78)

    try:
        _dukc_core_selftest()
        core_ok = True
        if not args.quiet:
            print(f"\nDUKC CORE SELFTEST ... PASS   ({DUKC_CORE_FINGERPRINT})")
    except AssertionError as exc:
        core_ok = False
        print(f"DUKC CORE SELFTEST ... FAIL: {exc}")

    vessel = VesselState(
        "V-1002", "MAERSK Mc-KINNEY MOLLER", args.vessel_class, args.draft, args.speed
    )
    res = evaluate_tidal_windows(vessel, min_status=args.min_status)

    if args.json:
        print(json.dumps(res.as_dict(include_samples=False), indent=2))
    elif not args.quiet:
        print(
            f"\nVESSEL   {res.vessel_name}  draft {res.static_draft_m:.2f} m  "
            f"{res.transit_speed_kn:.1f} kn  ({vessel.vessel_class}, Cb {vessel.cb:.2f})"
        )
        print(
            f"HORIZON  {_iso(res.horizon_start)}  +{res.horizon_hours:.0f} h @ "
            f"{res.step_hours} h  ->  {res.samples} samples   "
            f"[tide {res.tide_source}]"
        )
        print(
            f"CHANNEL  controlling depth {res.controlling_depth_m:.2f} m "
            f"({res.controlling_reach_id});  binding reach {res.binding_reach_id};  "
            f"required tide {res.required_tide_for_feasible_m:.3f} m  "
            f"[min_status={args.min_status}]"
        )

        print("\nSQUAT BY REACH (each reach at its own speed cap)")
        rows = []
        for rid, r in DEFAULT_REACHES.items():
            v = min(vessel.transit_speed_kn, r.max_speed_kn)
            sq = _squat_m(vessel.cb, v)
            need, _ = required_tide_m(
                vessel.static_draft_m, {rid: r}, vessel.transit_speed_kn, vessel.cb,
                min_status=args.min_status,
            )
            rows.append([
                rid, f"{r.charted_depth_m:.1f}", f"{v:.0f}", f"{sq:.3f}", f"{need:.3f}",
                "<-- BINDING" if rid == res.binding_reach_id else "",
            ])
        print(_fmt_table(
            ["reach", "charted", "kn", "squat", "tide needed", ""], rows, indent="  "
        ))

        print("\nSCENARIO SCAN")
        rows = []
        for s in [res.baseline] + list(res.scenarios):
            rows.append([
                s.label,
                f"{s.siltation_delta_m:.2f}",
                f"{s.dredging_delta_m:.2f}",
                f"{s.required_tide_m:.3f}",
                s.window_count,
                f"{s.total_usable_hours:.2f}",
                f"{s.mean_window_hours:.2f}",
                f"{s.longest_window_h:.2f}",
                f"{s.max_gap_hours:.2f}",
                f"{s.availability_pct:.1f}%",
            ])
        print(_fmt_table(
            ["scenario", "silt", "dredge", "tide req", "wins", "total h",
             "mean h", "longest", "max gap", "avail"],
            rows, indent="  ",
        ))

        print("\nEXTENSION vs BASELINE  (the 'extend tidal window' deliverable)")
        rows = []
        for c in res.comparisons:
            rows.append([
                c.label,
                f"{c.delta_hours:+.2f} h",
                f"{c.delta_pct:+.1f}%",
                f"{c.baseline_max_gap_h:.2f} -> {c.scenario_max_gap_h:.2f}",
                f"{c.delta_max_gap_h:+.2f} h",
                c.verdict,
            ])
        print(_fmt_table(
            ["scenario", "delta hours", "delta %", "max gap", "gap delta", "verdict"],
            rows, indent="  ",
        ))

        print(f"\nBASELINE WINDOW LIST  ({res.baseline.window_count} windows)")
        rows = []
        for w in res.baseline.windows:
            rows.append([
                f"#{w.window_id}",
                w.start.strftime("%d %b %H:%M"),
                w.end.strftime("%d %b %H:%M"),
                f"{w.duration_h:.2f}",
                f"{w.peak_tide_m:.2f}",
                f"{w.min_net_ukc_m:.3f}",
                w.binding_reach_id,
            ])
        if rows:
            print(_fmt_table(
                ["id", "opens", "closes", "hours", "peak tide", "min net UKC", "binding"],
                rows, indent="  ",
            ))
        else:
            print("  (none)")

        cond = res.breakdown["conditional_marginal"]
        print(
            f"\nCONDITIONAL (MARGINAL tolerated): {cond['window_count']} windows, "
            f"{cond['total_usable_hours']:.2f} h "
            f"(+{cond['extra_hours_vs_safe']:.2f} h NOT counted as usable)"
        )
        print(f"\nRECOMMEND  {res.recommendation}")

    checks = _self_test()
    passed = sum(1 for _, ok, _ in checks if ok)
    print(f"\n{'-' * 78}")
    print(f"SELF-TEST  {passed}/{len(checks)} passed")
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<32} {detail}")
    print("-" * 78)

    return 0 if passed == len(checks) and core_ok else 1


if __name__ == "__main__":
    sys.exit(main())
