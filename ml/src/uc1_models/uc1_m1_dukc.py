"""
UC1-M1 — DUKC / RTUKC Engine (Dynamic / Real-Time Under-Keel Clearance)
======================================================================

Jawaharlal Nehru Port Authority (JNPA) — Workstream 2, UC-I Vessel Traffic
Management & Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"Is there enough water under the keel for this vessel to transit this channel
reach, right now?"

WHY DETERMINISTIC (NOT ML)
--------------------------
Under-keel clearance is a safety-of-navigation computation. It must be auditable
and explainable to the Deputy Conservator, line by line, with every constant
traceable to a versioned configuration. A black-box regressor cannot be defended
in a post-incident inquiry. Accordingly this module is exact given its inputs,
and every result carries a step-by-step ``breakdown`` dict showing the formula,
the substituted numbers, and the intermediate value at each stage.

FORMULAE
--------
    squat_m        = min(2.5, Cb * V^2 / 100)            [Barrass-type, clamped]
    effective_m    = charted_depth + tide - siltation + dredging
    gross_ukc_m    = effective_m - (static_draft + squat)
    net_ukc_m      = gross_ukc_m - safety_margin          [margin default 1.0 m]

    status  = SAFE      if net_ukc >= 1.0 m
              MARGINAL  if 0.6 m <= net_ukc < 1.0 m
              NO GO     if net_ukc < 0.6 m

    Cb = 0.65 (container)  |  0.80 (bulk)

INVERSE SOLVES (closed form, no search loop)
--------------------------------------------
    min tide for target  : tide >= target + draft + squat - charted + silt - dredge
    max speed for target : V     = sqrt(100 * (effective - draft - target - margin) / Cb)

These turn M1 from a calculator into an advisor: instead of only saying "NO GO",
it says "reduce to 9.6 kn, or wait for 2.65 m of tide".

ASSUMPTIONS
-----------
* Barrass empirical squat, semi-restricted channel, even keel.
* Charted depths are chart datum; tide is height above chart datum.
* Siltation is depth LOST (positive = shallower); dredging is depth RESTORED.
* Static draft is the deepest of fore/aft; no heel or dynamic list allowance.
* Vessel-specific squat calibration (vendor DUKC) is the production upgrade path.

USAGE
-----
    python uc1_m1_dukc.py                 # full demo, exits 0 on success
    python uc1_m1_dukc.py --case nogo     # single scenario
    python uc1_m1_dukc.py --json          # machine-readable breakdown

    from uc1_m1_dukc import evaluate_dukc, VesselState, ChannelState, DEFAULT_REACHES
    r = evaluate_dukc(VesselState("V1", "MSC VALERIA", "CONTAINER", 15.0, 10.0),
                      ChannelState(DEFAULT_REACHES["CH-INNER"], tide_height_m=2.6))
    print(r.status, r.net_ukc_m)

SELF-CONTAINMENT POLICY
-----------------------
This file imports nothing outside the standard library above SECTION 6. FastAPI
and pydantic are optional and imported behind a guard, so the module runs on a
bare Python install. Shared helpers are duplicated into every UC-1 module by
design — see the DUPLICATED BY DESIGN banners.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

# ==========================================================================
# SECTION 1 — MODULE IDENTITY AND VERSIONED CONSTANTS
# ==========================================================================

MODULE_ID: str = "UC1-M1"
MODULE_NAME: str = "DUKC / RTUKC Engine"
MODULE_VERSION: str = "m1-dukc-v1.0.0"
ROUTER_PREFIX: str = "/uc1/m1"

DEFAULT_SEED: int = 20260807

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
    """
    One navigable segment of the JNPA approach channel.

    ``max_speed_kn`` is the operational speed cap for the reach. It matters:
    squat scales with V^2, so the turning basin's 6 kn cap produces roughly a
    quarter of the squat of the outer channel's 12 kn.
    """

    reach_id: str
    name: str
    charted_depth_m: float
    length_nm: float
    max_speed_kn: float
    is_turning_basin: bool = False


# Channel model per WS2_AI_ML_Tools.md row 2: "reaches CH-OUTER 17.5 m ...
# CH-INNER 15.0 m controlling". Depths are chart datum.
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
    vessel_class: str = "CONTAINER"       # CONTAINER | BULK
    static_draft_m: float = 15.0
    transit_speed_kn: float = 10.0
    loa_m: float = 366.0
    beam_m: float = 51.0
    block_coefficient_cb: Optional[float] = None   # None -> derived from class

    @property
    def cb(self) -> float:
        """Effective block coefficient — explicit override wins over class."""
        if self.block_coefficient_cb is not None:
            return float(self.block_coefficient_cb)
        return _cb_for_class(self.vessel_class)


@dataclass(frozen=True)
class ChannelState:
    """Environmental state of one reach at one instant."""

    reach: ChannelReach
    tide_height_m: float = 2.6
    siltation_delta_m: float = 0.0    # positive = depth LOST to siltation
    dredging_delta_m: float = 0.0     # positive = depth RESTORED by dredging

    @property
    def effective_depth_m(self) -> float:
        return _effective_depth_m(
            self.reach.charted_depth_m,
            self.tide_height_m,
            self.siltation_delta_m,
            self.dredging_delta_m,
        )


@dataclass(frozen=True)
class SensitivityPoint:
    """One corner of the draft x tide sensitivity grid."""

    draft_delta_m: float
    tide_delta_m: float
    evaluated_draft_m: float
    evaluated_tide_m: float
    squat_m: float
    gross_ukc_m: float
    net_ukc_m: float
    status: str
    is_baseline: bool
    status_flips: bool        # differs from the baseline status
    flips_worse: bool         # differs AND is worse than baseline

    def as_dict(self) -> Dict[str, Any]:
        return {
            "draft_delta_m": round(self.draft_delta_m, 3),
            "tide_delta_m": round(self.tide_delta_m, 3),
            "evaluated_draft_m": round(self.evaluated_draft_m, 3),
            "evaluated_tide_m": round(self.evaluated_tide_m, 3),
            "squat_m": round(self.squat_m, 4),
            "gross_ukc_m": round(self.gross_ukc_m, 4),
            "net_ukc_m": round(self.net_ukc_m, 4),
            "status": self.status,
            "is_baseline": self.is_baseline,
            "status_flips": self.status_flips,
            "flips_worse": self.flips_worse,
        }


@dataclass(frozen=True)
class DUKCResult:
    """Complete, auditable DUKC evaluation for one vessel on one reach."""

    vessel_id: str
    vessel_name: str
    reach_id: str
    reach_name: str

    charted_depth_m: float
    tide_height_m: float
    siltation_delta_m: float
    dredging_delta_m: float
    effective_depth_m: float

    static_draft_m: float
    transit_speed_kn: float
    block_coefficient_cb: float
    squat_m: float
    squat_clamped: bool

    gross_ukc_m: float
    net_ukc_m: float
    safety_margin_m: float
    status: str

    sensitivity: Tuple[SensitivityPoint, ...]
    sensitivity_worst_status: str
    sensitivity_robust: bool

    max_safe_speed_kn: Optional[float]
    min_tide_for_safe_m: float

    recommendation: str
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        """JSON-safe projection, for the API layer and for --json output."""
        return {
            "vessel_id": self.vessel_id,
            "vessel_name": self.vessel_name,
            "reach_id": self.reach_id,
            "reach_name": self.reach_name,
            "charted_depth_m": round(self.charted_depth_m, 3),
            "tide_height_m": round(self.tide_height_m, 3),
            "siltation_delta_m": round(self.siltation_delta_m, 3),
            "dredging_delta_m": round(self.dredging_delta_m, 3),
            "effective_depth_m": round(self.effective_depth_m, 4),
            "static_draft_m": round(self.static_draft_m, 3),
            "transit_speed_kn": round(self.transit_speed_kn, 2),
            "block_coefficient_cb": round(self.block_coefficient_cb, 4),
            "squat_m": round(self.squat_m, 4),
            "squat_clamped": self.squat_clamped,
            "gross_ukc_m": round(self.gross_ukc_m, 4),
            "net_ukc_m": round(self.net_ukc_m, 4),
            "safety_margin_m": round(self.safety_margin_m, 3),
            "status": self.status,
            "sensitivity": [p.as_dict() for p in self.sensitivity],
            "sensitivity_worst_status": self.sensitivity_worst_status,
            "sensitivity_robust": self.sensitivity_robust,
            "max_safe_speed_kn": (
                None if self.max_safe_speed_kn is None else round(self.max_safe_speed_kn, 2)
            ),
            "min_tide_for_safe_m": round(self.min_tide_for_safe_m, 3),
            "recommendation": self.recommendation,
            "breakdown": self.breakdown,
        }


@dataclass(frozen=True)
class AllReachesResult:
    """Transit-wide view: every reach evaluated, with the binding one named."""

    vessel_id: str
    vessel_name: str
    tide_height_m: float
    results: Tuple[DUKCResult, ...]
    binding_reach_id: str
    controlling_net_ukc_m: float
    transit_status: str
    recommendation: str
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "vessel_id": self.vessel_id,
            "vessel_name": self.vessel_name,
            "tide_height_m": round(self.tide_height_m, 3),
            "results": [r.as_dict() for r in self.results],
            "binding_reach_id": self.binding_reach_id,
            "controlling_net_ukc_m": round(self.controlling_net_ukc_m, 4),
            "transit_status": self.transit_status,
            "recommendation": self.recommendation,
            "breakdown": self.breakdown,
        }


# ==========================================================================
# SECTION 4 — DATA PROVIDERS (loader hooks)
# ==========================================================================
#
# M1 is a pure function of its inputs, so it needs no provider to run. These
# hooks exist so that a live deployment can source charted depths from the
# bathymetry corpus and tide from a gauge feed, without touching the engine.

try:  # pragma: no cover - typing convenience only
    from typing import Protocol, runtime_checkable
except ImportError:  # pragma: no cover
    Protocol = object  # type: ignore

    def runtime_checkable(c):  # type: ignore
        return c


@runtime_checkable
class ChannelDepthProvider(Protocol):
    """Supplies charted depth per reach."""

    @property
    def source_id(self) -> str: ...

    def reaches(self) -> Dict[str, ChannelReach]: ...


class DefaultChannelDepthProvider:
    """
    Design depths from WS2_AI_ML_Tools.md row 2 and the JNPA channel model.

    Deterministic, no I/O. This is the default so the module runs green with no
    data files present.
    """

    source_id = "DEFAULT_CHANNEL_MODEL_v1"

    def reaches(self) -> Dict[str, ChannelReach]:
        return dict(DEFAULT_REACHES)


class BathymetryPdfDepthProvider:
    """
    REAL-DATA STUB — charted depths from the shared hydrographic survey PDFs.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Source directory:
        Model_Training_Data\\Model_Training_Data\\UC-I_Vessel_Traffic\\
        M1-M2_DUKC_and_Tidal_Windows\\Bathymetry_Design_Depths\\*.pdf
        (12 files, e.g. 6148-24-SUR-PO-111-EF.pdf, MB-005-25-BMCT-Chart_2k-Model.pdf)

    Extract, per sheet, from the drawing TITLE BLOCK (not the soundings grid):
        - survey area code           -> maps to a reach_id
        - design / dredged depth (m) -> ChannelReach.charted_depth_m
        - chart datum reference      -> must be CD; reject if MSL without conversion
        - survey date                -> provenance, and to pick the latest sheet

    Also available for cross-check:
        Sea_Channel_Shapefile\\JNPA_Sea_Channels.shp  (+ .dbf/.prj)
        DBF fields: NAME, DESCRIPTIO, SHAPE_AREA, SHAPE_Leng, SHAPE_Ar_1
        CRS: WGS_1984_UTM_Zone_43N (projected metres) — reproject to WGS84
        for any map rendering. Gives reach geometry / length_nm.

    Return: Dict[str, ChannelReach] keyed by reach_id.
    Set source_id = "JNPA_BATHYMETRY_PDF/<latest survey date>".
    Dependencies to add when implementing: pdfplumber (title-block text),
    pyshp or geopandas (shapefile).
    """

    source_id = "JNPA_BATHYMETRY_PDF/NOT_IMPLEMENTED"

    def reaches(self) -> Dict[str, ChannelReach]:
        raise NotImplementedError(BathymetryPdfDepthProvider.__doc__)


# ==========================================================================
# SECTION 5 — ENGINE
# ==========================================================================


def block_coefficient(vessel_class: str) -> float:
    """Public wrapper over the duplicated core's Cb lookup."""
    return _cb_for_class(vessel_class)


def squat_m(cb: float, speed_kn: float) -> float:
    """Barrass-type squat in metres, clamped to [0.0, 2.5]."""
    return _squat_m(cb, speed_kn)


def ukc_status(net_ukc: float) -> str:
    """SAFE / MARGINAL / NO GO for a net UKC in metres."""
    return _ukc_status(net_ukc)


def status_is_at_least(status: str, target: str) -> bool:
    """True when ``status`` is as good as or better than ``target``."""
    return _STATUS_RANK.get(status, -1) >= _STATUS_RANK.get(target, 99)


def _threshold_for_status(target: str) -> float:
    """Net-UKC threshold that a status band requires."""
    key = (target or "").strip().upper()
    if key == STATUS_SAFE:
        return UKC_SAFETY_MARGIN_M
    if key == STATUS_MARGINAL:
        return UKC_MARGINAL_BAND_M
    raise ValueError(f"target status must be SAFE or MARGINAL, got {target!r}")


def min_tide_for_status(
    vessel: VesselState,
    channel: ChannelState,
    target: str = STATUS_SAFE,
    safety_margin_m: float = UKC_SAFETY_MARGIN_M,
) -> float:
    """
    Closed-form: the tide height needed to reach ``target`` at the current speed.

        net = charted + tide - silt + dredge - draft - squat - margin >= threshold
    =>  tide >= threshold + margin + draft + squat - charted + silt - dredge

    No search loop. Returns metres above chart datum; may be negative, meaning
    the reach already satisfies the target at any tide.
    """
    threshold = _threshold_for_status(target)
    sq = _squat_m(vessel.cb, vessel.transit_speed_kn)
    return (
        threshold
        + safety_margin_m
        + vessel.static_draft_m
        + sq
        - channel.reach.charted_depth_m
        + channel.siltation_delta_m
        - channel.dredging_delta_m
    )


def max_speed_for_status(
    vessel: VesselState,
    channel: ChannelState,
    target: str = STATUS_SAFE,
    safety_margin_m: float = UKC_SAFETY_MARGIN_M,
) -> Optional[float]:
    """
    Closed-form: the highest speed at which ``target`` still holds.

        allowance = effective_depth - draft - margin - threshold      (max squat)
        V         = sqrt(100 * allowance / Cb)

    Returns None when the target is unreachable even at rest (allowance < 0) —
    the vessel is too deep for this reach at this tide, and no speed reduction
    can fix it. Capped at the reach speed limit, since exceeding it is not a
    real option.
    """
    threshold = _threshold_for_status(target)
    allowance = (
        channel.effective_depth_m - vessel.static_draft_m - safety_margin_m - threshold
    )
    if allowance < 0.0:
        return None
    # Squat is clamped at MAX_SQUAT_CLAMP_M, so an allowance beyond the clamp
    # means every speed is acceptable on UKC grounds; cap at the reach limit.
    if allowance >= MAX_SQUAT_CLAMP_M:
        return float(channel.reach.max_speed_kn)
    v = math.sqrt(100.0 * allowance / vessel.cb)
    return float(min(v, channel.reach.max_speed_kn))


def ukc_sensitivity(
    vessel: VesselState,
    channel: ChannelState,
    draft_deltas: Sequence[float] = (-0.2, 0.0, 0.2),
    tide_deltas: Sequence[float] = (-0.1, 0.0, 0.1),
    safety_margin_m: float = UKC_SAFETY_MARGIN_M,
) -> Tuple[SensitivityPoint, ...]:
    """
    Corner-case sensitivity grid, per the spec's ``ukcSensitivity()``.

    Defaults to draft +/- 0.2 m x tide +/- 0.1 m = 9 points including the
    baseline. Each point reports whether the status flips relative to baseline,
    and whether it flips to something WORSE — the latter is the column a pilot
    actually acts on. Small measurement errors in draft or a tide gauge should
    not silently move a transit from SAFE to NO GO.
    """
    sq_base = _squat_m(vessel.cb, vessel.transit_speed_kn)
    _, net_base = _net_ukc_m(
        channel.reach.charted_depth_m,
        channel.tide_height_m,
        channel.siltation_delta_m,
        vessel.static_draft_m,
        sq_base,
        safety_margin_m,
        channel.dredging_delta_m,
    )
    base_status = _ukc_status(net_base)

    points: List[SensitivityPoint] = []
    for dd in draft_deltas:
        for td in tide_deltas:
            draft = vessel.static_draft_m + dd
            tide = channel.tide_height_m + td
            sq = _squat_m(vessel.cb, vessel.transit_speed_kn)  # speed unchanged
            gross, net = _net_ukc_m(
                channel.reach.charted_depth_m,
                tide,
                channel.siltation_delta_m,
                draft,
                sq,
                safety_margin_m,
                channel.dredging_delta_m,
            )
            st = _ukc_status(net)
            is_base = abs(dd) < 1e-12 and abs(td) < 1e-12
            flips = (st != base_status) and not is_base
            worse = flips and _STATUS_RANK[st] < _STATUS_RANK[base_status]
            points.append(
                SensitivityPoint(
                    draft_delta_m=dd,
                    tide_delta_m=td,
                    evaluated_draft_m=draft,
                    evaluated_tide_m=tide,
                    squat_m=sq,
                    gross_ukc_m=gross,
                    net_ukc_m=net,
                    status=st,
                    is_baseline=is_base,
                    status_flips=flips,
                    flips_worse=worse,
                )
            )
    return tuple(points)


def _recommendation(
    status: str,
    net_ukc: float,
    max_safe_speed: Optional[float],
    min_tide_safe: float,
    tide_now: float,
    speed_now: float,
    robust: bool,
) -> str:
    """Plain-language advice for marine control, derived from the numbers."""
    if status == STATUS_SAFE:
        base = f"GO: net UKC {net_ukc:.2f} m is at or above the {UKC_SAFETY_MARGIN_M:.2f} m safety margin."
        if not robust:
            base += (
                " Note: a corner of the draft +/-0.2 m / tide +/-0.1 m grid falls to a"
                " lower band — confirm the declared draft and the gauge reading."
            )
        return base

    tide_gap = min_tide_safe - tide_now
    parts: List[str] = []
    if status == STATUS_MARGINAL:
        parts.append(
            f"CAUTION: net UKC {net_ukc:.2f} m is inside the marginal band "
            f"({UKC_MARGINAL_BAND_M:.2f}-{UKC_SAFETY_MARGIN_M:.2f} m)."
        )
    else:
        parts.append(
            f"NO GO: net UKC {net_ukc:.2f} m is below the {UKC_MARGINAL_BAND_M:.2f} m minimum."
        )

    if max_safe_speed is not None and max_safe_speed < speed_now - 0.05:
        parts.append(f"Reduce speed to {max_safe_speed:.1f} kn")
    if tide_gap > 0.005:
        parts.append(
            f"{'or await' if len(parts) > 1 else 'Await'} tide {min_tide_safe:.2f} m "
            f"(+{tide_gap:.2f} m on the current {tide_now:.2f} m)"
        )
    if len(parts) == 1:
        parts.append("Speed reduction alone cannot restore SAFE — reduce draft or defer the transit")
    return " ".join(parts).rstrip(".") + "."


def evaluate_dukc(
    vessel: VesselState,
    channel: ChannelState,
    safety_margin_m: float = UKC_SAFETY_MARGIN_M,
    with_sensitivity: bool = True,
    depth_source: str = "DEFAULT_CHANNEL_MODEL_v1",
    tide_source: str = "CALLER_SUPPLIED",
) -> DUKCResult:
    """
    Evaluate under-keel clearance for one vessel on one reach.

    Returns a fully-populated :class:`DUKCResult` whose ``breakdown`` contains
    six numbered steps, a sensitivity block, and an inverse-solve block. Every
    step carries a ``substitution`` string with the real numbers plugged in.
    """
    cb = vessel.cb
    raw_squat = cb * (abs(vessel.transit_speed_kn) ** 2) / 100.0
    sq = _squat_m(cb, vessel.transit_speed_kn)
    clamped = raw_squat > MAX_SQUAT_CLAMP_M

    effective = _effective_depth_m(
        channel.reach.charted_depth_m,
        channel.tide_height_m,
        channel.siltation_delta_m,
        channel.dredging_delta_m,
    )
    gross, net = _net_ukc_m(
        channel.reach.charted_depth_m,
        channel.tide_height_m,
        channel.siltation_delta_m,
        vessel.static_draft_m,
        sq,
        safety_margin_m,
        channel.dredging_delta_m,
    )
    status = _ukc_status(net)

    sens: Tuple[SensitivityPoint, ...] = ()
    worst = status
    robust = True
    if with_sensitivity:
        sens = ukc_sensitivity(vessel, channel, safety_margin_m=safety_margin_m)
        worst = min((p.status for p in sens), key=lambda s: _STATUS_RANK[s])
        robust = not any(p.flips_worse for p in sens)

    max_v = max_speed_for_status(vessel, channel, STATUS_SAFE, safety_margin_m)
    min_tide = min_tide_for_status(vessel, channel, STATUS_SAFE, safety_margin_m)

    rec = _recommendation(
        status, net, max_v, min_tide, channel.tide_height_m, vessel.transit_speed_kn, robust
    )

    steps = [
        _step(
            1,
            "Block coefficient",
            "Cb = CB_CONTAINER if class == CONTAINER else CB_BULK",
            f"Cb({vessel.vessel_class}) = {cb:.3f}",
            {"vessel_class": vessel.vessel_class, "CB_CONTAINER": CB_CONTAINER, "CB_BULK": CB_BULK},
            round(cb, 4),
            "-",
            "explicit override" if vessel.block_coefficient_cb is not None else "derived from class",
        ),
        _step(
            2,
            "Barrass squat",
            "squat_m = min(MAX_SQUAT_CLAMP_M, Cb * V^2 / 100)",
            f"min({MAX_SQUAT_CLAMP_M}, {cb:.3f} * {vessel.transit_speed_kn:.1f}^2 / 100) = {sq:.3f}",
            {
                "Cb": round(cb, 4),
                "V_kn": vessel.transit_speed_kn,
                "raw_squat_m": round(raw_squat, 4),
                "MAX_SQUAT_CLAMP_M": MAX_SQUAT_CLAMP_M,
            },
            round(sq, 4),
            "m",
            f"clamp_active={clamped}",
        ),
        _step(
            3,
            "Effective water depth",
            "effective_m = charted_depth + tide - siltation + dredging",
            f"{channel.reach.charted_depth_m:.2f} + {channel.tide_height_m:.2f} "
            f"- {channel.siltation_delta_m:.2f} + {channel.dredging_delta_m:.2f} = {effective:.3f}",
            {
                "charted_depth_m": channel.reach.charted_depth_m,
                "tide_height_m": channel.tide_height_m,
                "siltation_delta_m": channel.siltation_delta_m,
                "dredging_delta_m": channel.dredging_delta_m,
            },
            round(effective, 4),
            "m",
            f"reach {channel.reach.reach_id}",
        ),
        _step(
            4,
            "Gross UKC",
            "gross_ukc_m = effective_m - (static_draft + squat)",
            f"{effective:.3f} - ({vessel.static_draft_m:.2f} + {sq:.3f}) = {gross:.3f}",
            {
                "effective_m": round(effective, 4),
                "static_draft_m": vessel.static_draft_m,
                "squat_m": round(sq, 4),
            },
            round(gross, 4),
            "m",
            "",
        ),
        _step(
            5,
            "Net UKC",
            "net_ukc_m = gross_ukc_m - UKC_SAFETY_MARGIN_M",
            f"{gross:.3f} - {safety_margin_m:.3f} = {net:.3f}",
            {"gross_ukc_m": round(gross, 4), "UKC_SAFETY_MARGIN_M": safety_margin_m},
            round(net, 4),
            "m",
            "",
        ),
        _step(
            6,
            "Status classification",
            "SAFE if net >= 1.0; MARGINAL if net >= 0.6; else NO GO",
            f"net {net:.3f} -> {status}",
            {
                "net_ukc_m": round(net, 4),
                "UKC_SAFETY_MARGIN_M": UKC_SAFETY_MARGIN_M,
                "UKC_MARGINAL_BAND_M": UKC_MARGINAL_BAND_M,
            },
            status,
            "-",
            "",
        ),
    ]

    breakdown: Dict[str, Any] = {
        "model": "M1_DUKC",
        "version": MODULE_VERSION,
        "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
        "constants": {
            "UKC_SAFETY_MARGIN_M": UKC_SAFETY_MARGIN_M,
            "UKC_MARGINAL_BAND_M": UKC_MARGINAL_BAND_M,
            "MAX_SQUAT_CLAMP_M": MAX_SQUAT_CLAMP_M,
            "CB_CONTAINER": CB_CONTAINER,
            "CB_BULK": CB_BULK,
        },
        "inputs": {
            "vessel_id": vessel.vessel_id,
            "vessel_name": vessel.vessel_name,
            "vessel_class": vessel.vessel_class,
            "static_draft_m": vessel.static_draft_m,
            "transit_speed_kn": vessel.transit_speed_kn,
            "loa_m": vessel.loa_m,
            "reach_id": channel.reach.reach_id,
            "charted_depth_m": channel.reach.charted_depth_m,
            "tide_height_m": channel.tide_height_m,
            "siltation_delta_m": channel.siltation_delta_m,
            "dredging_delta_m": channel.dredging_delta_m,
            "safety_margin_m": safety_margin_m,
        },
        "steps": steps,
        "sensitivity": {
            "grid": "draft +/-0.2 m x tide +/-0.1 m",
            "evaluated": with_sensitivity,
            "points": [p.as_dict() for p in sens],
            "worst_status": worst,
            "robust": robust,
            "flips_worse_count": sum(1 for p in sens if p.flips_worse),
        },
        "inverse_solve": {
            "min_tide_for_safe_m": round(min_tide, 4),
            "min_tide_formula": (
                "tide >= threshold + margin + draft + squat - charted + siltation - dredging"
            ),
            "min_tide_substitution": (
                f"{UKC_SAFETY_MARGIN_M:.2f} + {safety_margin_m:.2f} + {vessel.static_draft_m:.2f} "
                f"+ {sq:.3f} - {channel.reach.charted_depth_m:.2f} "
                f"+ {channel.siltation_delta_m:.2f} - {channel.dredging_delta_m:.2f} = {min_tide:.3f}"
            ),
            "max_safe_speed_kn": None if max_v is None else round(max_v, 3),
            "max_speed_formula": "V = sqrt(100 * (effective - draft - margin - threshold) / Cb)",
            "max_speed_substitution": (
                "unreachable at any speed"
                if max_v is None
                else (
                    f"sqrt(100 * ({effective:.3f} - {vessel.static_draft_m:.2f} "
                    f"- {safety_margin_m:.2f} - {UKC_SAFETY_MARGIN_M:.2f}) / {cb:.3f}) "
                    f"= {max_v:.3f} (capped at reach limit {channel.reach.max_speed_kn:.1f} kn)"
                )
            ),
        },
        "result": {
            "squat_m": round(sq, 4),
            "gross_ukc_m": round(gross, 4),
            "net_ukc_m": round(net, 4),
            "status": status,
            "recommendation": rec,
        },
        "assumptions": [
            "Barrass empirical squat for a semi-restricted channel, even keel.",
            "Charted depth is referenced to chart datum; tide is height above chart datum.",
            "Siltation is depth lost (positive); dredging is depth restored (positive).",
            "Static draft is the deepest of fore/aft; no heel or dynamic list allowance.",
            f"Safety margin {safety_margin_m:.2f} m applied on top of gross UKC.",
        ],
        "provenance": {
            "depth_source": depth_source,
            "tide_source": tide_source,
            "generated_at_utc": _iso(_utc_now()),
        },
    }

    return DUKCResult(
        vessel_id=vessel.vessel_id,
        vessel_name=vessel.vessel_name,
        reach_id=channel.reach.reach_id,
        reach_name=channel.reach.name,
        charted_depth_m=channel.reach.charted_depth_m,
        tide_height_m=channel.tide_height_m,
        siltation_delta_m=channel.siltation_delta_m,
        dredging_delta_m=channel.dredging_delta_m,
        effective_depth_m=effective,
        static_draft_m=vessel.static_draft_m,
        transit_speed_kn=vessel.transit_speed_kn,
        block_coefficient_cb=cb,
        squat_m=sq,
        squat_clamped=clamped,
        gross_ukc_m=gross,
        net_ukc_m=net,
        safety_margin_m=safety_margin_m,
        status=status,
        sensitivity=sens,
        sensitivity_worst_status=worst,
        sensitivity_robust=robust,
        max_safe_speed_kn=max_v,
        min_tide_for_safe_m=min_tide,
        recommendation=rec,
        breakdown=breakdown,
    )


def evaluate_all_reaches(
    vessel: VesselState,
    tide_m: float,
    siltation_m: float = 0.0,
    dredging_m: float = 0.0,
    reaches: Optional[Mapping[str, ChannelReach]] = None,
    use_reach_speed_limit: bool = True,
    safety_margin_m: float = UKC_SAFETY_MARGIN_M,
    with_sensitivity: bool = False,
) -> AllReachesResult:
    """
    Evaluate every reach of the transit and identify the binding one.

    When ``use_reach_speed_limit`` is True (the default and the physically
    correct reading), each reach is evaluated at its own speed cap rather than
    at a single transit speed. This matters: the turning basin is as shallow as
    CH-INNER but its 6 kn limit produces roughly a quarter of the squat, so
    naively applying one speed everywhere flags the wrong reach as binding.

    The binding reach is ``argmin(net_ukc)`` — the true controlling constraint,
    which is not always the shallowest reach.
    """
    reach_map = dict(reaches) if reaches is not None else dict(DEFAULT_REACHES)
    results: List[DUKCResult] = []
    for rid, reach in reach_map.items():
        speed = min(vessel.transit_speed_kn, reach.max_speed_kn) if use_reach_speed_limit \
            else vessel.transit_speed_kn
        v = VesselState(
            vessel_id=vessel.vessel_id,
            vessel_name=vessel.vessel_name,
            vessel_class=vessel.vessel_class,
            static_draft_m=vessel.static_draft_m,
            transit_speed_kn=speed,
            loa_m=vessel.loa_m,
            beam_m=vessel.beam_m,
            block_coefficient_cb=vessel.block_coefficient_cb,
        )
        c = ChannelState(reach, tide_m, siltation_m, dredging_m)
        results.append(
            evaluate_dukc(v, c, safety_margin_m, with_sensitivity=with_sensitivity)
        )

    binding = min(results, key=lambda r: (r.net_ukc_m, r.reach_id))
    transit_status = min((r.status for r in results), key=lambda s: _STATUS_RANK[s])

    shallowest = min(reach_map.values(), key=lambda r: (r.charted_depth_m, r.reach_id))
    note = ""
    if shallowest.reach_id != binding.reach_id:
        note = (
            f" Note: the shallowest reach is {shallowest.reach_id} "
            f"({shallowest.charted_depth_m:.1f} m) but the binding constraint is "
            f"{binding.reach_id} because of its higher speed limit and hence greater squat."
        )

    rec = (
        f"Transit status {transit_status}; controlling net UKC {binding.net_ukc_m:.2f} m "
        f"at {binding.reach_id}. {binding.recommendation}{note}"
    )

    breakdown: Dict[str, Any] = {
        "model": "M1_DUKC_ALL_REACHES",
        "version": MODULE_VERSION,
        "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
        "constants": {
            "UKC_SAFETY_MARGIN_M": UKC_SAFETY_MARGIN_M,
            "UKC_MARGINAL_BAND_M": UKC_MARGINAL_BAND_M,
        },
        "inputs": {
            "vessel_id": vessel.vessel_id,
            "static_draft_m": vessel.static_draft_m,
            "requested_speed_kn": vessel.transit_speed_kn,
            "tide_height_m": tide_m,
            "siltation_delta_m": siltation_m,
            "dredging_delta_m": dredging_m,
            "use_reach_speed_limit": use_reach_speed_limit,
        },
        "steps": [
            _step(
                1,
                "Per-reach evaluation",
                "for each reach: net_ukc = effective - (draft + squat(V_reach)) - margin",
                "; ".join(
                    f"{r.reach_id}@{r.transit_speed_kn:.0f}kn net={r.net_ukc_m:.3f}"
                    for r in results
                ),
                {"reaches": [r.reach_id for r in results]},
                [round(r.net_ukc_m, 4) for r in results],
                "m",
                "each reach uses its own speed cap" if use_reach_speed_limit else "single speed",
            ),
            _step(
                2,
                "Binding reach",
                "binding = argmin(net_ukc over reaches)",
                f"argmin -> {binding.reach_id} at {binding.net_ukc_m:.3f} m",
                {rid: round(r.net_ukc_m, 4) for rid, r in zip(reach_map.keys(), results)},
                binding.reach_id,
                "-",
                note.strip(),
            ),
            _step(
                3,
                "Transit status",
                "transit_status = worst status across all reaches",
                f"worst({', '.join(r.status for r in results)}) = {transit_status}",
                {r.reach_id: r.status for r in results},
                transit_status,
                "-",
                "",
            ),
        ],
        "controlling_depth_m": round(shallowest.charted_depth_m, 3),
        "shallowest_reach_id": shallowest.reach_id,
        "binding_reach_id": binding.reach_id,
        "per_reach": {r.reach_id: r.breakdown["result"] for r in results},
        "result": {
            "binding_reach_id": binding.reach_id,
            "controlling_net_ukc_m": round(binding.net_ukc_m, 4),
            "transit_status": transit_status,
        },
        "assumptions": [
            "Binding reach is argmin(net UKC), not simply the shallowest charted depth.",
            "Each reach evaluated at min(requested speed, reach speed limit).",
        ],
        "provenance": {
            "depth_source": "DEFAULT_CHANNEL_MODEL_v1",
            "tide_source": "CALLER_SUPPLIED",
            "generated_at_utc": _iso(_utc_now()),
        },
    }

    return AllReachesResult(
        vessel_id=vessel.vessel_id,
        vessel_name=vessel.vessel_name,
        tide_height_m=tide_m,
        results=tuple(results),
        binding_reach_id=binding.reach_id,
        controlling_net_ukc_m=binding.net_ukc_m,
        transit_status=transit_status,
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
    "spec_row": "WS2_AI_ML_Tools.md row 1 — DUKC / RTUKC",
    "model_type": "deterministic physics (no training)",
    "constants": {
        "UKC_SAFETY_MARGIN_M": UKC_SAFETY_MARGIN_M,
        "UKC_MARGINAL_BAND_M": UKC_MARGINAL_BAND_M,
        "MAX_SQUAT_CLAMP_M": MAX_SQUAT_CLAMP_M,
        "CB_CONTAINER": CB_CONTAINER,
        "CB_BULK": CB_BULK,
    },
    "reaches": {
        rid: {
            "name": r.name,
            "charted_depth_m": r.charted_depth_m,
            "length_nm": r.length_nm,
            "max_speed_kn": r.max_speed_kn,
            "is_turning_basin": r.is_turning_basin,
        }
        for rid, r in DEFAULT_REACHES.items()
    },
}


# ==========================================================================
# SECTION 6 — FASTAPI ROUTER (optional dependency)
# ==========================================================================

_HAS_FASTAPI = False
try:  # Catch bare Exception, not ImportError: a broken/ABI-mismatched install
    from fastapi import APIRouter, HTTPException  # noqa: E402
    from pydantic import BaseModel, Field         # noqa: E402
    from typing import Literal                    # noqa: E402

    _HAS_FASTAPI = True
except Exception:  # pragma: no cover - exercised only on bare installs
    APIRouter = None  # type: ignore
    HTTPException = None  # type: ignore
    BaseModel = object  # type: ignore
    Literal = None  # type: ignore

    def Field(default=None, **_kw):  # type: ignore
        return default


if _HAS_FASTAPI:

    class DUKCRequest(BaseModel):
        """Single-reach DUKC evaluation request."""

        vessel_id: str = Field("V-1001", max_length=32)
        vessel_name: str = Field("MSC VALERIA", max_length=120)
        vessel_class: Literal["CONTAINER", "BULK"] = "CONTAINER"
        static_draft_m: float = Field(15.0, gt=0, le=25)
        transit_speed_kn: float = Field(10.0, ge=0, le=30)
        loa_m: float = Field(366.0, gt=0, le=500)
        reach_id: Literal["CH-OUTER", "CH-MID", "CH-INNER", "TURNING-CIRCLE"] = "CH-INNER"
        tide_height_m: float = Field(2.6, ge=-2, le=8)
        siltation_delta_m: float = Field(0.0, ge=0, le=3)
        dredging_delta_m: float = Field(0.0, ge=0, le=3)
        block_coefficient_cb: Optional[float] = Field(None, gt=0.3, lt=1.0)
        safety_margin_m: float = Field(1.0, ge=0, le=3)
        with_sensitivity: bool = True

        def to_states(self) -> Tuple[VesselState, ChannelState]:
            vessel = VesselState(
                vessel_id=self.vessel_id,
                vessel_name=self.vessel_name,
                vessel_class=self.vessel_class,
                static_draft_m=self.static_draft_m,
                transit_speed_kn=self.transit_speed_kn,
                loa_m=self.loa_m,
                block_coefficient_cb=self.block_coefficient_cb,
            )
            channel = ChannelState(
                reach=DEFAULT_REACHES[self.reach_id],
                tide_height_m=self.tide_height_m,
                siltation_delta_m=self.siltation_delta_m,
                dredging_delta_m=self.dredging_delta_m,
            )
            return vessel, channel

    class AllReachesRequest(BaseModel):
        """Whole-transit evaluation across every reach."""

        vessel_id: str = Field("V-1001", max_length=32)
        vessel_name: str = Field("MSC VALERIA", max_length=120)
        vessel_class: Literal["CONTAINER", "BULK"] = "CONTAINER"
        static_draft_m: float = Field(15.0, gt=0, le=25)
        transit_speed_kn: float = Field(10.0, ge=0, le=30)
        tide_height_m: float = Field(2.6, ge=-2, le=8)
        siltation_delta_m: float = Field(0.0, ge=0, le=3)
        dredging_delta_m: float = Field(0.0, ge=0, le=3)
        use_reach_speed_limit: bool = True
        safety_margin_m: float = Field(1.0, ge=0, le=3)

    def build_router() -> "APIRouter":
        """Construct the UC1-M1 router. Mounted by ``api.py``."""
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC1-M1 DUKC / RTUKC"])

        @router.post("/evaluate", summary="Evaluate under-keel clearance on one reach")
        def evaluate(req: DUKCRequest) -> Dict[str, Any]:
            vessel, channel = req.to_states()
            result = evaluate_dukc(
                vessel, channel, req.safety_margin_m, with_sensitivity=req.with_sensitivity
            )
            return result.as_dict()

        @router.post("/evaluate-all-reaches", summary="Evaluate every channel reach")
        def evaluate_all(req: AllReachesRequest) -> Dict[str, Any]:
            vessel = VesselState(
                vessel_id=req.vessel_id,
                vessel_name=req.vessel_name,
                vessel_class=req.vessel_class,
                static_draft_m=req.static_draft_m,
                transit_speed_kn=req.transit_speed_kn,
            )
            return evaluate_all_reaches(
                vessel,
                req.tide_height_m,
                req.siltation_delta_m,
                req.dredging_delta_m,
                use_reach_speed_limit=req.use_reach_speed_limit,
                safety_margin_m=req.safety_margin_m,
            ).as_dict()

        @router.post("/sensitivity", summary="Draft/tide corner-case sensitivity grid")
        def sensitivity(req: DUKCRequest) -> Dict[str, Any]:
            vessel, channel = req.to_states()
            pts = ukc_sensitivity(vessel, channel, safety_margin_m=req.safety_margin_m)
            worst = min((p.status for p in pts), key=lambda s: _STATUS_RANK[s])
            return {
                "vessel_id": req.vessel_id,
                "reach_id": req.reach_id,
                "grid": "draft +/-0.2 m x tide +/-0.1 m",
                "points": [p.as_dict() for p in pts],
                "worst_status": worst,
                "robust": not any(p.flips_worse for p in pts),
            }

        @router.get("/reaches", summary="Channel reach model")
        def reaches() -> Dict[str, Any]:
            return MODULE_INFO["reaches"]

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
            vessel = VesselState("V-1001", "MSC VALERIA", "CONTAINER", 15.0, 10.0)
            channel = ChannelState(DEFAULT_REACHES["CH-INNER"], 2.6)
            return evaluate_dukc(vessel, channel).as_dict()

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
    """
    Return ``[(check_name, passed, detail), ...]``.

    Used by the CLI (exit code) and by ``GET /health``. Every check is a claim
    this module makes about itself somewhere in its documentation.
    """
    checks: List[Tuple[str, bool, str]] = []

    try:
        _dukc_core_selftest()
        checks.append(("dukc_core_golden_values", True, DUKC_CORE_FINGERPRINT))
    except AssertionError as exc:
        checks.append(("dukc_core_golden_values", False, str(exc)))

    # Canonical MARGINAL case from the module docstring.
    v = VesselState("V-1001", "MSC VALERIA", "CONTAINER", 15.0, 10.0)
    c = ChannelState(DEFAULT_REACHES["CH-INNER"], 2.6)
    r = evaluate_dukc(v, c)
    checks.append(
        (
            "canonical_marginal_case",
            abs(r.squat_m - 0.650) < 1e-9
            and abs(r.gross_ukc_m - 1.950) < 1e-9
            and abs(r.net_ukc_m - 0.950) < 1e-9
            and r.status == STATUS_MARGINAL,
            f"squat={r.squat_m:.3f} gross={r.gross_ukc_m:.3f} net={r.net_ukc_m:.3f} {r.status}",
        )
    )

    # Inverse solves must agree with the forward computation.
    checks.append(
        (
            "inverse_min_tide",
            abs(r.min_tide_for_safe_m - 2.650) < 1e-9,
            f"min tide for SAFE = {r.min_tide_for_safe_m:.3f} m (expected 2.650)",
        )
    )
    checks.append(
        (
            "inverse_max_speed",
            r.max_safe_speed_kn is not None and abs(r.max_safe_speed_kn - 9.6077) < 1e-3,
            f"max SAFE speed = {r.max_safe_speed_kn:.4f} kn (expected 9.6077)",
        )
    )

    # Round-trip: at exactly max_safe_speed the status must be SAFE.
    if r.max_safe_speed_kn is not None:
        v2 = VesselState("V-1001", "MSC VALERIA", "CONTAINER", 15.0, r.max_safe_speed_kn - 1e-6)
        r2 = evaluate_dukc(v2, c, with_sensitivity=False)
        checks.append(
            (
                "inverse_speed_roundtrip",
                r2.status == STATUS_SAFE,
                f"at {v2.transit_speed_kn:.4f} kn -> {r2.status} (net {r2.net_ukc_m:.4f} m)",
            )
        )

    # Round-trip: at exactly min_tide_for_safe the status must be SAFE.
    c2 = ChannelState(DEFAULT_REACHES["CH-INNER"], r.min_tide_for_safe_m + 1e-9)
    r3 = evaluate_dukc(v, c2, with_sensitivity=False)
    checks.append(
        (
            "inverse_tide_roundtrip",
            r3.status == STATUS_SAFE,
            f"at tide {c2.tide_height_m:.3f} m -> {r3.status} (net {r3.net_ukc_m:.4f} m)",
        )
    )

    # NO GO case: same vessel at 14 kn.
    v4 = VesselState("V-1001", "MSC VALERIA", "CONTAINER", 15.0, 14.0)
    r4 = evaluate_dukc(v4, c, with_sensitivity=False)
    checks.append(
        (
            "high_speed_no_go",
            r4.status == STATUS_NO_GO and abs(r4.squat_m - 1.274) < 1e-9,
            f"14 kn -> squat {r4.squat_m:.3f} net {r4.net_ukc_m:.3f} {r4.status}",
        )
    )

    # Sensitivity grid must have exactly 9 points, one of them the baseline.
    checks.append(
        (
            "sensitivity_grid_shape",
            len(r.sensitivity) == 9 and sum(1 for p in r.sensitivity if p.is_baseline) == 1,
            f"{len(r.sensitivity)} points, {sum(1 for p in r.sensitivity if p.is_baseline)} baseline",
        )
    )

    # Squat clamp must bind for a fast bulk carrier.
    checks.append(
        (
            "squat_clamp_binds",
            abs(_squat_m(CB_BULK, 20.0) - MAX_SQUAT_CLAMP_M) < 1e-12,
            f"squat(0.80, 20 kn) = {_squat_m(CB_BULK, 20.0):.3f} m (clamped at {MAX_SQUAT_CLAMP_M})",
        )
    )

    # Binding reach on a silted channel must be CH-INNER, not the turning basin.
    ar = evaluate_all_reaches(v, tide_m=2.6, siltation_m=0.30)
    checks.append(
        (
            "binding_reach_identified",
            ar.binding_reach_id == "CH-INNER",
            f"binding={ar.binding_reach_id} net={ar.controlling_net_ukc_m:.3f} m "
            f"status={ar.transit_status}",
        )
    )

    # Dredging must never make UKC worse; siltation must never make it better.
    r_dredge = evaluate_dukc(
        v, ChannelState(DEFAULT_REACHES["CH-INNER"], 2.6, 0.0, 0.5), with_sensitivity=False
    )
    r_silt = evaluate_dukc(
        v, ChannelState(DEFAULT_REACHES["CH-INNER"], 2.6, 0.5, 0.0), with_sensitivity=False
    )
    checks.append(
        (
            "lever_monotonicity",
            r_dredge.net_ukc_m > r.net_ukc_m > r_silt.net_ukc_m,
            f"dredged {r_dredge.net_ukc_m:.3f} > base {r.net_ukc_m:.3f} > silted {r_silt.net_ukc_m:.3f}",
        )
    )

    # Every result must carry a complete, auditable breakdown.
    checks.append(
        (
            "breakdown_completeness",
            len(r.breakdown["steps"]) == 6
            and all(s.get("substitution") for s in r.breakdown["steps"]),
            f"{len(r.breakdown['steps'])} steps, all with substitutions",
        )
    )

    return checks


def _print_result(r: DUKCResult, title: str) -> None:
    print(f"\n{title}")
    print(
        f"  {r.vessel_name} | draft {r.static_draft_m:.2f} m | {r.transit_speed_kn:.1f} kn | "
        f"{r.reach_id} charted {r.charted_depth_m:.1f} m | tide {r.tide_height_m:.2f} m"
    )
    for s in r.breakdown["steps"]:
        print(f"  [{s['step']}] {s['label']:<22} {s['substitution']}"
              + (f"   ({s['note']})" if s["note"] else ""))
    print(f"  -> STATUS {r.status}")


def _print_sensitivity(r: DUKCResult) -> None:
    print("\n  SENSITIVITY  draft +/-0.2 m x tide +/-0.1 m")
    rows = []
    for p in r.sensitivity:
        rows.append(
            [
                f"{p.draft_delta_m:+.2f}",
                f"{p.tide_delta_m:+.2f}",
                f"{p.evaluated_draft_m:.2f}",
                f"{p.evaluated_tide_m:.2f}",
                f"{p.net_ukc_m:.3f}",
                p.status,
                "BASE" if p.is_baseline else ("WORSE" if p.flips_worse else ("better" if p.status_flips else "-")),
            ]
        )
    print(_fmt_table(
        ["dDraft", "dTide", "draft", "tide", "net", "status", "flip"], rows, indent="    "
    ))
    print(
        f"    worst = {r.sensitivity_worst_status}   robust = {r.sensitivity_robust}"
        f"   ({r.breakdown['sensitivity']['flips_worse_count']} of 8 corners degrade)"
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="UC1-M1 DUKC / RTUKC engine — demo and self-test runner."
    )
    parser.add_argument(
        "--case",
        choices=["marginal", "nogo", "all-reaches", "sensitivity", "lever", "all"],
        default="all",
        help="Which demo scenario to run (default: all).",
    )
    parser.add_argument("--json", action="store_true", help="Dump the raw breakdown as JSON.")
    parser.add_argument("--quiet", action="store_true", help="Print only the self-test summary.")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="Unused; kept for CLI parity.")
    args = parser.parse_args(argv)

    if not args.quiet:
        print("=" * 78)
        print(f"{MODULE_ID} — {MODULE_NAME}   ({MODULE_VERSION})")
        print("JNPA UC-I Vessel Traffic Management | WS2 row 1 | deterministic physics")
        print("=" * 78)

    try:
        _dukc_core_selftest()
        core_ok = True
    except AssertionError as exc:
        core_ok = False
        print(f"DUKC CORE SELFTEST ... FAIL: {exc}")

    if not args.quiet and core_ok:
        print(f"\nDUKC CORE SELFTEST ... PASS   ({DUKC_CORE_FINGERPRINT})")

    vessel = VesselState("V-1001", "MSC VALERIA", "CONTAINER", 15.0, 10.0)
    channel = ChannelState(DEFAULT_REACHES["CH-INNER"], 2.6)
    r1 = evaluate_dukc(vessel, channel)

    if args.json:
        payload: Dict[str, Any] = {"case_marginal": r1.as_dict()}
        if args.case in ("all", "all-reaches"):
            payload["case_all_reaches"] = evaluate_all_reaches(
                vessel, 2.6, siltation_m=0.30
            ).as_dict()
        print(json.dumps(payload, indent=2))
    elif not args.quiet:
        if args.case in ("all", "marginal", "sensitivity"):
            _print_result(r1, "CASE 1 — CH-INNER at the safety boundary")
            _print_sensitivity(r1)
            print(
                f"\n  INVERSE   min tide for SAFE = {r1.min_tide_for_safe_m:.3f} m"
                f"   |   max SAFE speed = {r1.max_safe_speed_kn:.2f} kn"
            )
            print(f"  RECOMMEND {r1.recommendation}")

        if args.case in ("all", "nogo"):
            v2 = VesselState("V-1001", "MSC VALERIA", "CONTAINER", 15.0, 14.0)
            r2 = evaluate_dukc(v2, channel, with_sensitivity=False)
            _print_result(r2, "CASE 2 — same vessel, speed raised to 14.0 kn")
            print(
                f"  LEVER     reducing 14.0 -> 10.0 kn recovers "
                f"{r2.squat_m - r1.squat_m:.3f} m of UKC and converts "
                f"{r2.status} -> {r1.status}."
            )
            print(f"  RECOMMEND {r2.recommendation}")

        if args.case in ("all", "all-reaches"):
            ar = evaluate_all_reaches(vessel, tide_m=2.6, siltation_m=0.30)
            print("\nCASE 3 — all reaches, tide 2.60 m, siltation 0.30 m")
            rows = []
            for r in ar.results:
                rows.append([
                    r.reach_id,
                    f"{r.charted_depth_m:.1f}",
                    f"{r.transit_speed_kn:.0f}",
                    f"{r.squat_m:.3f}",
                    f"{r.effective_depth_m:.2f}",
                    f"{r.net_ukc_m:.3f}",
                    r.status,
                    "<-- BINDING" if r.reach_id == ar.binding_reach_id else "",
                ])
            print(_fmt_table(
                ["reach", "charted", "kn", "squat", "effective", "net UKC", "status", ""],
                rows, indent="    ",
            ))
            print(f"\n  {ar.recommendation}")

        if args.case in ("all", "lever"):
            print("\nCASE 4 — dredging / siltation lever on CH-INNER at 2.60 m tide")
            rows = []
            for label, silt, dredge in (
                ("SILTED  -0.3 m", 0.30, 0.0),
                ("BASELINE", 0.0, 0.0),
                ("DREDGED +0.5 m", 0.0, 0.50),
            ):
                rr = evaluate_dukc(
                    vessel, ChannelState(DEFAULT_REACHES["CH-INNER"], 2.6, silt, dredge),
                    with_sensitivity=False,
                )
                rows.append([
                    label,
                    f"{rr.effective_depth_m:.2f}",
                    f"{rr.net_ukc_m:.3f}",
                    rr.status,
                    f"{rr.min_tide_for_safe_m:.3f}",
                ])
            print(_fmt_table(
                ["scenario", "effective", "net UKC", "status", "tide for SAFE"],
                rows, indent="    ",
            ))

    checks = _self_test()
    passed = sum(1 for _, ok, _ in checks if ok)
    print(f"\n{'-' * 78}")
    print(f"SELF-TEST  {passed}/{len(checks)} passed")
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<28} {detail}")
    print("-" * 78)

    return 0 if passed == len(checks) and core_ok else 1


if __name__ == "__main__":
    sys.exit(main())
