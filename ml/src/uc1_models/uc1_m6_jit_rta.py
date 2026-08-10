"""
UC1-M6 — Just-In-Time Arrival / RTA Advisory with Bunker & CO2 Delta
====================================================================

Jawaharlal Nehru Port Authority (JNPA) — Workstream 2, UC-I Vessel Traffic
Management & Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"This ship is 240 NM out and her berth is not ready for 20 hours. Should she
keep steaming at 16 knots and then sit at anchor, or slow down and arrive just
in time?"

EQUATIONS
---------
    RTA            = max(berth_ready, tidal_window_start [, pilot_available])
    available_h    = RTA - now
    required_speed = distance_nm / available_h
    fuel_tons      = 3.2 * (speed / 16)^3 * transit_hours
    CO2_tons       = fuel_tons * 3.114                      [IMO factor]
    bunker_usd     = fuel_tons * 600                        [SIMULATED]

Fuel scales with the CUBE of speed, which is why slow-steaming pays: dropping
from 16 to 12 knots cuts the hourly burn to (12/16)^3 = 42% even though the
passage takes a third longer.

THE HEADLINE FIGURE IS THE CONSERVATIVE ONE
--------------------------------------------
Two savings can be quoted, and this module computes both:

  * STEAMING-ONLY  — compares steaming fuel at service speed against steaming
    fuel at the JIT speed. This is the HEADLINE, because it rests on nothing
    but the cube law and the vessel's own consumption curve.

  * ANCHORAGE-INCLUSIVE — additionally charges the arrive-and-wait baseline for
    hotel/auxiliary load while at anchor, at ANCHORAGE_IDLE_FUEL_T_PER_H. It is
    the larger and physically more complete number, but that rate is itself a
    SIMULATED assumption an evaluator can challenge, so it is reported as a
    clearly-labelled secondary line and never as the claim.

Every commercial figure carries the literal label SIMULATED together with the
constant it depends on. Bunker price is an assumption, not a quotation.

EDGE CASES THE MODULE HANDLES EXPLICITLY
-----------------------------------------
  (a) Berth ready BEFORE the vessel could arrive even at full speed: no
      slow-steaming is possible, driver becomes MAX_SPEED_LIMIT, savings are
      zero and the advice says the vessel is already on the optimal trajectory.
  (b) Required speed below minimum steerage: the recommendation becomes
      "steam at 8 kn and take the residual wait at anchor" rather than
      pretending a ship can hold station at 3 knots.
  (c) RTA landing after the tidal window closes: ``misses_tidal_window`` is set
      and the advice says so, rather than silently recommending an arrival the
      vessel cannot use.

USAGE
-----
    python uc1_m6_jit_rta.py                       # full demo, exits 0
    python uc1_m6_jit_rta.py --distance 400 --berth-ready-h 30
    python uc1_m6_jit_rta.py --json

SELF-CONTAINMENT POLICY
-----------------------
Standard library only above SECTION 6. FastAPI/pydantic optional. The DUKC core
in SECTION 2 is byte-identical to the copy in uc1_m1_dukc.py by design; M6 uses
it to check the arrival draft against the tidal window it is being sent to.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

# ==========================================================================
# SECTION 1 — MODULE IDENTITY AND VERSIONED CONSTANTS
# ==========================================================================

MODULE_ID: str = "UC1-M6"
MODULE_NAME: str = "Just-In-Time Arrival / RTA Advisory"
MODULE_VERSION: str = "m6-jit-v1.0.0"
ROUTER_PREFIX: str = "/uc1/m6"

DEFAULT_SEED: int = 20260807

# Propulsion and emissions constants — WS2_AI_ML_Tools.md row 6.
SERVICE_SPEED_REF_KN: float = 16.0        # reference speed for the fuel curve
FUEL_BASE_T_PER_H: float = 3.2            # tonnes/hour at SERVICE_SPEED_REF_KN
FUEL_SPEED_EXPONENT: float = 3.0          # fuel ∝ speed^3
IMO_CO2_FACTOR_T_PER_T: float = 3.114     # tonnes CO2 per tonne of fuel (IMO)
MIN_STEERAGE_SPEED_KN: float = 8.0        # below this a ship cannot hold course

# Commercial assumptions — every figure derived from these is SIMULATED.
BUNKER_PRICE_USD_PER_T: float = 600.0
ANCHORAGE_IDLE_FUEL_T_PER_H: float = 0.35  # hotel/auxiliary load at anchor
COMMERCIAL_FIGURES_LABEL: str = "SIMULATED"

# RTA drivers
DRIVER_BERTH_READY: str = "BERTH_READY"
DRIVER_TIDAL_WINDOW: str = "TIDAL_WINDOW"
DRIVER_PILOT: str = "PILOT"
DRIVER_MAX_SPEED: str = "MAX_SPEED_LIMIT"

LEG_BASELINE: str = "BASELINE_FULL_SPEED"
LEG_JIT: str = "JIT_SLOW_STEAM"

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


def _hours_between(a: datetime, b: datetime) -> float:
    """Signed hours from ``a`` to ``b``. DUPLICATED BY DESIGN."""
    return (_ensure_utc(b) - _ensure_utc(a)).total_seconds() / 3600.0


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
class VesselAtSea:
    """A vessel on passage to JNPA."""

    vessel_id: str
    vessel_name: str
    vessel_class: str = "CONTAINER"
    now: datetime = None                       # type: ignore[assignment]
    distance_to_go_nm: float = 240.0
    service_speed_kn: float = SERVICE_SPEED_REF_KN
    fuel_at_service_t_per_h: float = FUEL_BASE_T_PER_H
    min_steerage_kn: float = MIN_STEERAGE_SPEED_KN
    arrival_draft_m: float = 14.5

    @property
    def cb(self) -> float:
        return _cb_for_class(self.vessel_class)


@dataclass(frozen=True)
class PortReadiness:
    """When the port can actually take the vessel."""

    berth_id: str
    berth_ready_time: datetime
    tidal_window_start: Optional[datetime] = None
    tidal_window_end: Optional[datetime] = None
    tidal_window_max_draft_m: Optional[float] = None
    pilot_available_from: Optional[datetime] = None


@dataclass(frozen=True)
class VoyageLeg:
    """One costed way of making the passage."""

    label: str
    speed_kn: float
    transit_hours: float
    arrival_time: datetime
    steaming_fuel_t: float
    anchorage_wait_hours: float
    anchorage_fuel_t: float
    total_fuel_t: float
    steaming_co2_t: float
    total_co2_t: float
    steaming_bunker_usd: float
    total_bunker_usd: float

    def as_dict(self) -> Dict[str, Any]:
        return {
            "label": self.label,
            "speed_kn": round(self.speed_kn, 3),
            "transit_hours": round(self.transit_hours, 3),
            "arrival_time": _iso(self.arrival_time),
            "steaming_fuel_t": round(self.steaming_fuel_t, 4),
            "anchorage_wait_hours": round(self.anchorage_wait_hours, 3),
            "anchorage_fuel_t": round(self.anchorage_fuel_t, 4),
            "total_fuel_t": round(self.total_fuel_t, 4),
            "steaming_co2_t": round(self.steaming_co2_t, 4),
            "total_co2_t": round(self.total_co2_t, 4),
            "steaming_bunker_usd": round(self.steaming_bunker_usd, 2),
            "total_bunker_usd": round(self.total_bunker_usd, 2),
        }


@dataclass(frozen=True)
class Savings:
    """A saving figure and the basis it rests on."""

    basis: str                       # STEAMING_ONLY | ANCHORAGE_INCLUSIVE
    fuel_saved_t: float
    co2_saved_t: float
    bunker_saved_usd: float
    is_headline: bool
    label: str = COMMERCIAL_FIGURES_LABEL
    note: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "basis": self.basis,
            "fuel_saved_t": round(self.fuel_saved_t, 4),
            "co2_saved_t": round(self.co2_saved_t, 4),
            "bunker_saved_usd": round(self.bunker_saved_usd, 2),
            "is_headline": self.is_headline,
            "label": self.label,
            "note": self.note,
        }


@dataclass(frozen=True)
class JITResult:
    """Complete JIT advisory for one vessel."""

    vessel_id: str
    vessel_name: str
    berth_id: str
    now: datetime
    distance_to_go_nm: float

    rta: datetime
    rta_driver: str
    available_hours: float
    required_speed_kn: float
    recommended_speed_kn: float
    speed_clamped: bool
    clamp_reason: Optional[str]
    feasible: bool
    misses_tidal_window: bool
    draft_admitted_by_window: Optional[bool]

    baseline: VoyageLeg
    jit: VoyageLeg

    headline: Savings
    secondary: Savings
    anchorage_hours_eliminated: float

    recommendation: str
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "vessel_id": self.vessel_id,
            "vessel_name": self.vessel_name,
            "berth_id": self.berth_id,
            "now": _iso(self.now),
            "distance_to_go_nm": round(self.distance_to_go_nm, 2),
            "rta": _iso(self.rta),
            "rta_driver": self.rta_driver,
            "available_hours": round(self.available_hours, 3),
            "required_speed_kn": round(self.required_speed_kn, 3),
            "recommended_speed_kn": round(self.recommended_speed_kn, 3),
            "speed_clamped": self.speed_clamped,
            "clamp_reason": self.clamp_reason,
            "feasible": self.feasible,
            "misses_tidal_window": self.misses_tidal_window,
            "draft_admitted_by_window": self.draft_admitted_by_window,
            "baseline": self.baseline.as_dict(),
            "jit": self.jit.as_dict(),
            "headline_saving": self.headline.as_dict(),
            "secondary_saving": self.secondary.as_dict(),
            "anchorage_hours_eliminated": round(self.anchorage_hours_eliminated, 3),
            "savings_label": COMMERCIAL_FIGURES_LABEL,
            "recommendation": self.recommendation,
            "breakdown": self.breakdown,
        }


@dataclass(frozen=True)
class FleetJITResult:
    """Roll-up over several vessels."""

    generated_at: datetime
    results: Tuple[JITResult, ...]
    fleet_fuel_saved_t: float
    fleet_co2_saved_t: float
    fleet_bunker_saved_usd: float
    fleet_anchorage_hours_eliminated: float
    basis: str
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "generated_at": _iso(self.generated_at),
            "results": [r.as_dict() for r in self.results],
            "fleet_fuel_saved_t": round(self.fleet_fuel_saved_t, 3),
            "fleet_co2_saved_t": round(self.fleet_co2_saved_t, 3),
            "fleet_bunker_saved_usd": round(self.fleet_bunker_saved_usd, 2),
            "fleet_anchorage_hours_eliminated": round(self.fleet_anchorage_hours_eliminated, 2),
            "basis": self.basis,
            "savings_label": COMMERCIAL_FIGURES_LABEL,
            "breakdown": self.breakdown,
        }


# ==========================================================================
# SECTION 4 — DATA PROVIDERS (loader hooks)
# ==========================================================================

try:  # pragma: no cover
    from typing import Protocol, runtime_checkable
except ImportError:  # pragma: no cover
    Protocol = object  # type: ignore

    def runtime_checkable(c):  # type: ignore
        return c


@runtime_checkable
class FleetProvider(Protocol):
    """Supplies vessels on passage and the port readiness they are steaming to."""

    @property
    def source_id(self) -> str: ...

    def load_fleet(self, now: datetime) -> List[Tuple[VesselAtSea, PortReadiness]]: ...


class SyntheticFleetProvider:
    """Seeded synthetic inbound fleet. Deterministic via ``random.Random``."""

    source_id = "SYNTHETIC_FLEET_v1"

    def __init__(self, seed: int = DEFAULT_SEED, n_vessels: int = 5) -> None:
        self.seed = seed
        self.n_vessels = n_vessels

    def load_fleet(self, now: datetime) -> List[Tuple[VesselAtSea, PortReadiness]]:
        rng = random.Random(self.seed)
        now = _ensure_utc(now)
        names = [
            "CMA CGM ANTOINE DE SAINT EXUPERY", "MSC VALERIA", "MAERSK HANGZHOU",
            "OOCL WASHINGTON", "HMM LEAF", "AL SAADIYAT", "TS SHANGHAI",
        ]
        berths = ["APMT-01", "BMCT-01", "BMCT-02", "CB-06", "CB02", "APMT-02", "BMCT-03"]
        out: List[Tuple[VesselAtSea, PortReadiness]] = []
        for i in range(self.n_vessels):
            distance = round(rng.uniform(120.0, 480.0), 1)
            service = rng.choice([15.0, 16.0, 17.0, 18.0])
            full_speed_h = distance / service
            # Berth ready somewhere between "already" and "well after" arrival,
            # so the fleet exercises both the JIT and the no-slack branches.
            ready_h = full_speed_h * rng.uniform(0.85, 1.9)
            vessel = VesselAtSea(
                vessel_id=f"V-{4001 + i}",
                vessel_name=names[i % len(names)],
                vessel_class="CONTAINER",
                now=now,
                distance_to_go_nm=distance,
                service_speed_kn=service,
                fuel_at_service_t_per_h=round(rng.uniform(2.6, 4.0), 2),
                arrival_draft_m=round(rng.uniform(12.0, 15.2), 2),
            )
            window_start = now + timedelta(hours=ready_h - rng.uniform(0.0, 3.0))
            readiness = PortReadiness(
                berth_id=berths[i % len(berths)],
                berth_ready_time=now + timedelta(hours=ready_h),
                tidal_window_start=window_start,
                tidal_window_end=window_start + timedelta(hours=4.75),
                tidal_window_max_draft_m=15.5 if i % 2 == 0 else 15.2,
            )
            out.append((vessel, readiness))
        return out


class AisFleetProvider:
    """
    REAL-DATA STUB — inbound fleet from AIS plus PCS call information.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Distance-to-go and speed come from an AIS feed (not in the shared corpus).
    Vessel particulars and the declared arrival draft ARE available:

        ...\\M4-M5_ETA_BerthUtilisation_Optimiser\\PCS_NLP_Marine_Messages\\CALINF\\*.xml
        Root <VoyageRegistration>/<VoyageDetails>:
            RecordType, VoyageNumber, IMONumber, TypeOfVessel, CallSign, SACode,
            LineCode, DockORTOCode, Portcode, EDTA, EDTD, OriginalPortOfDep,
            LastPortOfCall, ExpectedDraftInMeter, PurposeOfvisit, Status,
            BallastWithCargo, CargoSummary/CargoDetails{RecordType,TypeOfCargo}
        <DocumentSummary><IssuedDateTime> format YYYYMMDDHHMMSS

    Mapping:
        vessel_id           <- IMONumber
        arrival_draft_m     <- ExpectedDraftInMeter
        vessel_class        <- TypeOfVessel
        distance_to_go_nm   <- great-circle from the AIS position to the
                               pilot boarding ground (18.9333 N, 72.8667 E)
        service_speed_kn    <- vessel register, or the AIS 30-day median SOG

    berth_ready_time comes from UC1-M5's plan; tidal_window_* from UC1-M2.
    Neither is imported here — both cross the boundary as data.

    Dependency: stdlib xml.etree only (plus whatever the AIS feed needs).
    """

    source_id = "AIS_PLUS_PCS_CALINF/NOT_IMPLEMENTED"

    def load_fleet(self, now: datetime) -> List[Tuple[VesselAtSea, PortReadiness]]:
        raise NotImplementedError(AisFleetProvider.__doc__)


# ==========================================================================
# SECTION 5 — ENGINE
# ==========================================================================


def compute_rta(readiness: PortReadiness) -> Tuple[datetime, str]:
    """
    Required Time of Arrival and the constraint that sets it.

        RTA = max(berth_ready, tidal_window_start [, pilot_available])

    Returning the DRIVER matters operationally: "you are waiting on the tide" and
    "you are waiting on the berth" call for different conversations with the
    terminal.
    """
    candidates: List[Tuple[datetime, str]] = [
        (_ensure_utc(readiness.berth_ready_time), DRIVER_BERTH_READY)
    ]
    if readiness.tidal_window_start is not None:
        candidates.append((_ensure_utc(readiness.tidal_window_start), DRIVER_TIDAL_WINDOW))
    if readiness.pilot_available_from is not None:
        candidates.append((_ensure_utc(readiness.pilot_available_from), DRIVER_PILOT))
    # Ties resolve to the earliest-listed driver, which is the berth — the
    # constraint the port actually controls.
    best = max(candidates, key=lambda c: c[0])
    latest = best[0]
    for dt, name in candidates:
        if dt == latest:
            return latest, name
    return best


def required_speed_kn(distance_nm: float, available_h: float) -> float:
    """Speed needed to cover the distance in the time available."""
    if available_h <= 0:
        return float("inf")
    return float(distance_nm) / float(available_h)


def fuel_tons(
    speed_kn: float,
    transit_hours: float,
    base_t_per_h: float = FUEL_BASE_T_PER_H,
    ref_speed_kn: float = SERVICE_SPEED_REF_KN,
    exponent: float = FUEL_SPEED_EXPONENT,
) -> float:
    """
    Bunker consumption over a passage.

        fuel = base_t_per_h * (speed / ref_speed)^exponent * transit_hours

    The cube law is the whole basis of slow-steaming economics.
    """
    if speed_kn <= 0 or transit_hours <= 0:
        return 0.0
    return base_t_per_h * ((speed_kn / ref_speed_kn) ** exponent) * transit_hours


def co2_tons(fuel_t: float) -> float:
    """CO2 from bunker burn, using the IMO conversion factor."""
    return float(fuel_t) * IMO_CO2_FACTOR_T_PER_T


def bunker_usd(fuel_t: float, price_per_t: float = BUNKER_PRICE_USD_PER_T) -> float:
    """Bunker cost. SIMULATED — the price is an assumption, not a quotation."""
    return float(fuel_t) * float(price_per_t)


def build_leg(
    label: str,
    speed_kn: float,
    vessel: VesselAtSea,
    arrive_not_before: datetime,
) -> VoyageLeg:
    """
    Cost one way of making the passage.

    If the vessel arrives before ``arrive_not_before`` it waits at anchor, and
    that wait is charged hotel load — the anchorage-inclusive figure. The
    steaming-only figures are kept separately so the conservative headline can
    be computed without double counting.
    """
    now = _ensure_utc(vessel.now)
    transit_h = vessel.distance_to_go_nm / speed_kn if speed_kn > 0 else float("inf")
    arrival = now + timedelta(hours=transit_h)
    steaming = fuel_tons(
        speed_kn, transit_h, vessel.fuel_at_service_t_per_h, vessel.service_speed_kn
    )
    wait_h = max(0.0, _hours_between(arrival, _ensure_utc(arrive_not_before)))
    anchor_fuel = wait_h * ANCHORAGE_IDLE_FUEL_T_PER_H
    total = steaming + anchor_fuel
    return VoyageLeg(
        label=label,
        speed_kn=speed_kn,
        transit_hours=transit_h,
        arrival_time=arrival,
        steaming_fuel_t=steaming,
        anchorage_wait_hours=wait_h,
        anchorage_fuel_t=anchor_fuel,
        total_fuel_t=total,
        steaming_co2_t=co2_tons(steaming),
        total_co2_t=co2_tons(total),
        steaming_bunker_usd=bunker_usd(steaming),
        total_bunker_usd=bunker_usd(total),
    )


def evaluate_jit(vessel: VesselAtSea, readiness: PortReadiness) -> JITResult:
    """
    Produce the JIT advisory for one vessel, with a full audit trail.

    The headline saving is STEAMING-ONLY by deliberate choice; the
    anchorage-inclusive figure is computed and returned as ``secondary``.
    """
    now = _ensure_utc(vessel.now)
    rta, driver = compute_rta(readiness)
    available_h = _hours_between(now, rta)

    full_speed_h = vessel.distance_to_go_nm / vessel.service_speed_kn
    earliest_arrival = now + timedelta(hours=full_speed_h)

    required = required_speed_kn(vessel.distance_to_go_nm, available_h)

    # Clamp the advisory speed into what the ship can actually do.
    clamped = False
    clamp_reason: Optional[str] = None
    recommended = required
    if available_h <= 0 or required > vessel.service_speed_kn:
        # Cannot make the RTA even at service speed — no slow-steaming available.
        recommended = vessel.service_speed_kn
        clamped = True
        clamp_reason = (
            f"required {required:.2f} kn exceeds service speed "
            f"{vessel.service_speed_kn:.1f} kn — the vessel is already on the "
            f"fastest trajectory"
        )
        driver = DRIVER_MAX_SPEED
    elif required < vessel.min_steerage_kn:
        recommended = vessel.min_steerage_kn
        clamped = True
        clamp_reason = (
            f"required {required:.2f} kn is below minimum steerage "
            f"{vessel.min_steerage_kn:.1f} kn — steam at {vessel.min_steerage_kn:.1f} kn "
            f"and take the residual wait at anchor"
        )

    baseline = build_leg(LEG_BASELINE, vessel.service_speed_kn, vessel, rta)
    jit = build_leg(LEG_JIT, recommended, vessel, rta)

    feasible = not (clamped and driver == DRIVER_MAX_SPEED)

    # Tidal-window checks: does the RTA land inside the window, and does the
    # window admit the vessel's arrival draft?
    misses_window = False
    draft_admitted: Optional[bool] = None
    if readiness.tidal_window_end is not None:
        misses_window = jit.arrival_time > _ensure_utc(readiness.tidal_window_end)
    if readiness.tidal_window_max_draft_m is not None:
        draft_admitted = vessel.arrival_draft_m <= readiness.tidal_window_max_draft_m + 1e-9

    steaming_saved = baseline.steaming_fuel_t - jit.steaming_fuel_t
    total_saved = baseline.total_fuel_t - jit.total_fuel_t
    anchorage_eliminated = baseline.anchorage_wait_hours - jit.anchorage_wait_hours

    headline = Savings(
        basis="STEAMING_ONLY",
        fuel_saved_t=steaming_saved,
        co2_saved_t=co2_tons(steaming_saved),
        bunker_saved_usd=bunker_usd(steaming_saved),
        is_headline=True,
        note=(
            "Compares steaming fuel at service speed against steaming fuel at the "
            "JIT speed. Rests only on the cube law and the vessel's own consumption "
            "curve — the most conservative and most defensible claim."
        ),
    )
    secondary = Savings(
        basis="ANCHORAGE_INCLUSIVE",
        fuel_saved_t=total_saved,
        co2_saved_t=co2_tons(total_saved),
        bunker_saved_usd=bunker_usd(total_saved),
        is_headline=False,
        note=(
            f"Additionally charges the arrive-and-wait baseline hotel load at "
            f"ANCHORAGE_IDLE_FUEL_T_PER_H={ANCHORAGE_IDLE_FUEL_T_PER_H} t/h. Larger and "
            f"physically more complete, but that rate is itself a SIMULATED assumption, "
            f"so it is reported as a secondary figure and not claimed."
        ),
    )

    # Recommendation
    if driver == DRIVER_MAX_SPEED:
        rec = (
            f"NO ACTION: the berth is ready at {_iso(rta)} but the vessel cannot arrive "
            f"before {_iso(earliest_arrival)} even at {vessel.service_speed_kn:.1f} kn. "
            f"She is already on the optimal trajectory; no slow-steaming saving is "
            f"available."
        )
    elif clamped:
        rec = (
            f"Slow-steam to {recommended:.1f} kn (minimum steerage). "
            f"{clamp_reason}. Arrives {_iso(jit.arrival_time)}, "
            f"{jit.anchorage_wait_hours:.2f} h residual anchorage. "
            f"Saves {headline.fuel_saved_t:.2f} t bunker "
            f"(USD {headline.bunker_saved_usd:,.0f} {COMMERCIAL_FIGURES_LABEL}) and "
            f"{headline.co2_saved_t:.2f} t CO2."
        )
    else:
        rec = (
            f"Slow-steam {vessel.service_speed_kn:.1f} -> {recommended:.1f} kn. "
            f"RTA {_iso(rta)} (driver {driver}). Eliminates "
            f"{anchorage_eliminated:.2f} h of anchorage wait, saves "
            f"{headline.fuel_saved_t:.2f} t bunker "
            f"(USD {headline.bunker_saved_usd:,.0f} {COMMERCIAL_FIGURES_LABEL}) and "
            f"{headline.co2_saved_t:.2f} t CO2."
        )
    if misses_window:
        rec += (
            f" WARNING: the recommended arrival falls after the tidal window closes at "
            f"{_iso(readiness.tidal_window_end)} — request a later window or accept the wait."
        )
    if draft_admitted is False:
        rec += (
            f" WARNING: arrival draft {vessel.arrival_draft_m:.2f} m exceeds the window's "
            f"{readiness.tidal_window_max_draft_m:.2f} m limit — the transit is not "
            f"permissible as planned."
        )

    sim = f"{COMMERCIAL_FIGURES_LABEL} — assumption: BUNKER_PRICE_USD_PER_T={BUNKER_PRICE_USD_PER_T}"

    steps = [
        _step(
            1,
            "RTA",
            "RTA = max(berth_ready, tidal_window_start, pilot_available)",
            f"max({_iso(readiness.berth_ready_time)}, "
            f"{_iso(readiness.tidal_window_start) or 'n/a'}, "
            f"{_iso(readiness.pilot_available_from) or 'n/a'}) = {_iso(rta)}",
            {
                "berth_ready": _iso(readiness.berth_ready_time),
                "tidal_window_start": _iso(readiness.tidal_window_start),
                "pilot_available_from": _iso(readiness.pilot_available_from),
            },
            _iso(rta),
            "utc",
            f"driver: {driver}",
        ),
        _step(
            2,
            "Available time",
            "available_h = RTA - now",
            f"{_iso(rta)} - {_iso(now)} = {available_h:.3f} h",
            {"now": _iso(now), "rta": _iso(rta)},
            round(available_h, 4),
            "h",
            "",
        ),
        _step(
            3,
            "Required speed",
            "required_speed = distance_nm / available_h",
            f"{vessel.distance_to_go_nm:.1f} / {available_h:.3f} = {required:.3f} kn"
            if math.isfinite(required) else "available_h <= 0 -> infinite",
            {"distance_nm": vessel.distance_to_go_nm, "available_h": round(available_h, 4)},
            round(required, 4) if math.isfinite(required) else None,
            "kn",
            "",
        ),
        _step(
            4,
            "Speed clamp",
            "recommended = clamp(required, min_steerage, service_speed)",
            f"clamp({required:.3f}, {vessel.min_steerage_kn:.1f}, "
            f"{vessel.service_speed_kn:.1f}) = {recommended:.3f} kn"
            if math.isfinite(required)
            else f"-> {recommended:.3f} kn",
            {
                "min_steerage_kn": vessel.min_steerage_kn,
                "service_speed_kn": vessel.service_speed_kn,
            },
            round(recommended, 4),
            "kn",
            clamp_reason or "not clamped",
        ),
        _step(
            5,
            "Baseline transit",
            "transit_h = distance_nm / service_speed",
            f"{vessel.distance_to_go_nm:.1f} / {vessel.service_speed_kn:.1f} = "
            f"{baseline.transit_hours:.3f} h, arriving {_iso(baseline.arrival_time)}",
            {"service_speed_kn": vessel.service_speed_kn},
            round(baseline.transit_hours, 4),
            "h",
            f"{baseline.anchorage_wait_hours:.2f} h of anchorage wait would follow",
        ),
        _step(
            6,
            "Baseline fuel",
            "fuel = base_t_per_h * (speed / ref)^3 * transit_h  [+ anchorage burn]",
            f"{vessel.fuel_at_service_t_per_h:.2f} * "
            f"({vessel.service_speed_kn:.1f}/{vessel.service_speed_kn:.1f})^3 * "
            f"{baseline.transit_hours:.3f} = {baseline.steaming_fuel_t:.3f} t steaming; "
            f"+ {ANCHORAGE_IDLE_FUEL_T_PER_H} * {baseline.anchorage_wait_hours:.2f} = "
            f"{baseline.anchorage_fuel_t:.3f} t at anchor",
            {
                "steaming_fuel_t": round(baseline.steaming_fuel_t, 4),
                "anchorage_fuel_t": round(baseline.anchorage_fuel_t, 4),
                "ANCHORAGE_IDLE_FUEL_T_PER_H": ANCHORAGE_IDLE_FUEL_T_PER_H,
            },
            round(baseline.total_fuel_t, 4),
            "t",
            f"{sim}; anchorage rate is also SIMULATED",
        ),
        _step(
            7,
            "JIT fuel",
            "fuel = base_t_per_h * (jit_speed / ref)^3 * transit_h",
            f"{vessel.fuel_at_service_t_per_h:.2f} * "
            f"({recommended:.3f}/{vessel.service_speed_kn:.1f})^3 * "
            f"{jit.transit_hours:.3f} = {jit.steaming_fuel_t:.3f} t",
            {
                "jit_speed_kn": round(recommended, 4),
                "transit_hours": round(jit.transit_hours, 4),
            },
            round(jit.steaming_fuel_t, 4),
            "t",
            f"cube law: ({recommended:.2f}/{vessel.service_speed_kn:.1f})^3 = "
            f"{(recommended / vessel.service_speed_kn) ** 3:.4f}",
        ),
        _step(
            8,
            "Savings — HEADLINE (steaming only)",
            "saved = baseline_steaming - jit_steaming ; CO2 = saved * 3.114 ; USD = saved * 600",
            f"{baseline.steaming_fuel_t:.3f} - {jit.steaming_fuel_t:.3f} = "
            f"{steaming_saved:.3f} t -> {headline.co2_saved_t:.3f} t CO2, "
            f"USD {headline.bunker_saved_usd:,.0f}",
            {
                "fuel_saved_t": round(steaming_saved, 4),
                "IMO_CO2_FACTOR_T_PER_T": IMO_CO2_FACTOR_T_PER_T,
                "BUNKER_PRICE_USD_PER_T": BUNKER_PRICE_USD_PER_T,
            },
            round(steaming_saved, 4),
            "t",
            sim,
        ),
        _step(
            9,
            "Savings — secondary (anchorage inclusive)",
            "saved = baseline_total - jit_total",
            f"{baseline.total_fuel_t:.3f} - {jit.total_fuel_t:.3f} = {total_saved:.3f} t "
            f"-> {secondary.co2_saved_t:.3f} t CO2, USD {secondary.bunker_saved_usd:,.0f}",
            {"fuel_saved_t": round(total_saved, 4)},
            round(total_saved, 4),
            "t",
            "NOT the headline — the anchorage burn rate is an added assumption",
        ),
    ]

    breakdown: Dict[str, Any] = {
        "model": "M6_JIT_RTA",
        "version": MODULE_VERSION,
        "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
        "constants": {
            "SERVICE_SPEED_REF_KN": SERVICE_SPEED_REF_KN,
            "FUEL_BASE_T_PER_H": FUEL_BASE_T_PER_H,
            "FUEL_SPEED_EXPONENT": FUEL_SPEED_EXPONENT,
            "IMO_CO2_FACTOR_T_PER_T": IMO_CO2_FACTOR_T_PER_T,
            "BUNKER_PRICE_USD_PER_T": BUNKER_PRICE_USD_PER_T,
            "ANCHORAGE_IDLE_FUEL_T_PER_H": ANCHORAGE_IDLE_FUEL_T_PER_H,
            "MIN_STEERAGE_SPEED_KN": MIN_STEERAGE_SPEED_KN,
        },
        "inputs": {
            "vessel_id": vessel.vessel_id,
            "vessel_name": vessel.vessel_name,
            "now": _iso(now),
            "distance_to_go_nm": vessel.distance_to_go_nm,
            "service_speed_kn": vessel.service_speed_kn,
            "fuel_at_service_t_per_h": vessel.fuel_at_service_t_per_h,
            "min_steerage_kn": vessel.min_steerage_kn,
            "arrival_draft_m": vessel.arrival_draft_m,
            "berth_id": readiness.berth_id,
            "berth_ready_time": _iso(readiness.berth_ready_time),
            "tidal_window_start": _iso(readiness.tidal_window_start),
            "tidal_window_end": _iso(readiness.tidal_window_end),
            "tidal_window_max_draft_m": readiness.tidal_window_max_draft_m,
        },
        "steps": steps,
        "legs": {"baseline": baseline.as_dict(), "jit": jit.as_dict()},
        "savings": {
            "headline": headline.as_dict(),
            "secondary": secondary.as_dict(),
            "anchorage_hours_eliminated": round(anchorage_eliminated, 3),
        },
        "tidal_check": {
            "misses_tidal_window": misses_window,
            "draft_admitted_by_window": draft_admitted,
            "arrival_draft_m": vessel.arrival_draft_m,
            "window_max_draft_m": readiness.tidal_window_max_draft_m,
        },
        "result": {
            "rta": _iso(rta),
            "rta_driver": driver,
            "recommended_speed_kn": round(recommended, 3),
            "feasible": feasible,
            "headline_fuel_saved_t": round(headline.fuel_saved_t, 3),
            "headline_co2_saved_t": round(headline.co2_saved_t, 3),
            "headline_bunker_saved_usd": round(headline.bunker_saved_usd, 2),
            "recommendation": rec,
        },
        "assumptions": [
            f"Fuel scales as speed^{FUEL_SPEED_EXPONENT:.0f} against a "
            f"{SERVICE_SPEED_REF_KN:.0f} kn reference.",
            f"IMO CO2 factor {IMO_CO2_FACTOR_T_PER_T} t CO2 per t of fuel.",
            f"Bunker price USD {BUNKER_PRICE_USD_PER_T:.0f}/t — SIMULATED assumption.",
            f"Anchorage hotel load {ANCHORAGE_IDLE_FUEL_T_PER_H} t/h — SIMULATED assumption.",
            f"Minimum steerage {MIN_STEERAGE_SPEED_KN:.0f} kn.",
            "HEADLINE saving is steaming-only; anchorage-inclusive is secondary.",
            "Weather, current and hull fouling are not modelled.",
        ],
        "provenance": {
            "commercial_figures": COMMERCIAL_FIGURES_LABEL,
            "berth_ready_source": "UC1-M5 berth plan (supplied as data)",
            "tidal_window_source": "UC1-M2 window scan (supplied as data)",
            "generated_at_utc": _iso(_utc_now()),
        },
    }

    return JITResult(
        vessel_id=vessel.vessel_id,
        vessel_name=vessel.vessel_name,
        berth_id=readiness.berth_id,
        now=now,
        distance_to_go_nm=vessel.distance_to_go_nm,
        rta=rta,
        rta_driver=driver,
        available_hours=available_h,
        required_speed_kn=required,
        recommended_speed_kn=recommended,
        speed_clamped=clamped,
        clamp_reason=clamp_reason,
        feasible=feasible,
        misses_tidal_window=misses_window,
        draft_admitted_by_window=draft_admitted,
        baseline=baseline,
        jit=jit,
        headline=headline,
        secondary=secondary,
        anchorage_hours_eliminated=anchorage_eliminated,
        recommendation=rec,
        breakdown=breakdown,
    )


def evaluate_fleet(
    pairs: Sequence[Tuple[VesselAtSea, PortReadiness]],
    basis: str = "STEAMING_ONLY",
) -> FleetJITResult:
    """Roll the advisory up over an inbound fleet, on the chosen savings basis."""
    results = [evaluate_jit(v, r) for v, r in pairs]

    def pick(res: JITResult) -> Savings:
        return res.headline if basis == "STEAMING_ONLY" else res.secondary

    fuel = sum(max(0.0, pick(r).fuel_saved_t) for r in results)
    co2 = sum(max(0.0, pick(r).co2_saved_t) for r in results)
    usd = sum(max(0.0, pick(r).bunker_saved_usd) for r in results)
    anchor = sum(max(0.0, r.anchorage_hours_eliminated) for r in results)

    return FleetJITResult(
        generated_at=_utc_now(),
        results=tuple(results),
        fleet_fuel_saved_t=fuel,
        fleet_co2_saved_t=co2,
        fleet_bunker_saved_usd=usd,
        fleet_anchorage_hours_eliminated=anchor,
        basis=basis,
        breakdown={
            "model": "M6_JIT_FLEET",
            "version": MODULE_VERSION,
            "basis": basis,
            "vessels": len(results),
            "vessels_with_saving": sum(1 for r in results if pick(r).fuel_saved_t > 1e-9),
            "vessels_already_optimal": sum(
                1 for r in results if r.rta_driver == DRIVER_MAX_SPEED
            ),
            "formula": "fleet_saving = sum(max(0, per-vessel saving))",
            "note": (
                "Negative per-vessel savings are floored at zero: a vessel that cannot "
                "slow down contributes nothing, it does not subtract from the fleet total."
            ),
            "result": {
                "fleet_fuel_saved_t": round(fuel, 3),
                "fleet_co2_saved_t": round(co2, 3),
                "fleet_bunker_saved_usd": round(usd, 2),
                "fleet_anchorage_hours_eliminated": round(anchor, 2),
            },
            "provenance": {
                "commercial_figures": COMMERCIAL_FIGURES_LABEL,
                "generated_at_utc": _iso(_utc_now()),
            },
        },
    )


def speed_sweep(
    vessel: VesselAtSea,
    readiness: PortReadiness,
    speeds: Optional[Sequence[float]] = None,
) -> List[Dict[str, Any]]:
    """
    Fuel-versus-speed curve for the dashboard.

    Defaults to 8.0 .. service speed in 0.5 kn steps, which is the range a master
    can actually order.
    """
    if speeds is None:
        lo = vessel.min_steerage_kn
        hi = vessel.service_speed_kn
        n = int(round((hi - lo) / 0.5)) + 1
        speeds = [round(lo + i * 0.5, 2) for i in range(max(1, n))]
    rta, _ = compute_rta(readiness)
    out: List[Dict[str, Any]] = []
    for s in speeds:
        leg = build_leg(f"SWEEP_{s:.1f}", s, vessel, rta)
        out.append({
            "speed_kn": round(s, 2),
            "transit_hours": round(leg.transit_hours, 3),
            "arrival_time": _iso(leg.arrival_time),
            "steaming_fuel_t": round(leg.steaming_fuel_t, 4),
            "anchorage_wait_hours": round(leg.anchorage_wait_hours, 3),
            "total_fuel_t": round(leg.total_fuel_t, 4),
            "steaming_co2_t": round(leg.steaming_co2_t, 4),
            "arrives_late": leg.arrival_time > rta,
        })
    return out


MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "dukc_core_version": DUKC_CORE_VERSION,
    "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
    "spec_row": "WS2_AI_ML_Tools.md row 6 — JIT arrival / RTA advice",
    "model_type": "deterministic physics / heuristic",
    "commercial_figures": COMMERCIAL_FIGURES_LABEL,
    "headline_basis": "STEAMING_ONLY",
    "constants": {
        "SERVICE_SPEED_REF_KN": SERVICE_SPEED_REF_KN,
        "FUEL_BASE_T_PER_H": FUEL_BASE_T_PER_H,
        "FUEL_SPEED_EXPONENT": FUEL_SPEED_EXPONENT,
        "IMO_CO2_FACTOR_T_PER_T": IMO_CO2_FACTOR_T_PER_T,
        "BUNKER_PRICE_USD_PER_T": BUNKER_PRICE_USD_PER_T,
        "ANCHORAGE_IDLE_FUEL_T_PER_H": ANCHORAGE_IDLE_FUEL_T_PER_H,
        "MIN_STEERAGE_SPEED_KN": MIN_STEERAGE_SPEED_KN,
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

    class JITRequest(BaseModel):
        """One vessel on passage, and the port readiness she is steaming to."""

        vessel_id: str = Field("V-1003", max_length=32)
        vessel_name: str = Field("CMA CGM ANTOINE DE SAINT EXUPERY", max_length=120)
        vessel_class: Literal["CONTAINER", "BULK"] = "CONTAINER"
        now: Optional[datetime] = None
        distance_to_go_nm: float = Field(240.0, gt=0, le=5000)
        service_speed_kn: float = Field(16.0, gt=0, le=30)
        fuel_at_service_t_per_h: float = Field(3.2, gt=0, le=20)
        min_steerage_kn: float = Field(8.0, ge=0, le=15)
        arrival_draft_m: float = Field(14.5, gt=0, le=25)
        berth_id: str = Field("APMT-01", max_length=32)
        berth_ready_time: datetime
        tidal_window_start: Optional[datetime] = None
        tidal_window_end: Optional[datetime] = None
        tidal_window_max_draft_m: Optional[float] = Field(None, gt=0, le=25)
        pilot_available_from: Optional[datetime] = None

        def build(self) -> Tuple[VesselAtSea, PortReadiness]:
            def _tz(d):
                if d is None:
                    return None
                return d if d.tzinfo else d.replace(tzinfo=timezone.utc)

            now = _tz(self.now) or _utc_now()
            vessel = VesselAtSea(
                vessel_id=self.vessel_id,
                vessel_name=self.vessel_name,
                vessel_class=self.vessel_class,
                now=now,
                distance_to_go_nm=self.distance_to_go_nm,
                service_speed_kn=self.service_speed_kn,
                fuel_at_service_t_per_h=self.fuel_at_service_t_per_h,
                min_steerage_kn=self.min_steerage_kn,
                arrival_draft_m=self.arrival_draft_m,
            )
            readiness = PortReadiness(
                berth_id=self.berth_id,
                berth_ready_time=_tz(self.berth_ready_time),
                tidal_window_start=_tz(self.tidal_window_start),
                tidal_window_end=_tz(self.tidal_window_end),
                tidal_window_max_draft_m=self.tidal_window_max_draft_m,
                pilot_available_from=_tz(self.pilot_available_from),
            )
            return vessel, readiness

    def build_router() -> "APIRouter":
        """Construct the UC1-M6 router. Mounted by ``api.py``."""
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC1-M6 JIT Arrival / RTA"])

        @router.post("/advise", summary="JIT speed advice with bunker and CO2 delta")
        def advise(req: JITRequest) -> Dict[str, Any]:
            vessel, readiness = req.build()
            return evaluate_jit(vessel, readiness).as_dict()

        @router.post("/advise-fleet", summary="Fleet roll-up")
        def advise_fleet(
            reqs: List[JITRequest],
            basis: Literal["STEAMING_ONLY", "ANCHORAGE_INCLUSIVE"] = "STEAMING_ONLY",
        ) -> Dict[str, Any]:
            if not reqs:
                raise HTTPException(422, "at least one vessel is required")
            if len(reqs) > 200:
                raise HTTPException(413, "fleet limited to 200 vessels")
            return evaluate_fleet([r.build() for r in reqs], basis).as_dict()

        @router.post("/speed-sweep", summary="Fuel-vs-speed curve for charting")
        def sweep(req: JITRequest) -> Dict[str, Any]:
            vessel, readiness = req.build()
            rta, driver = compute_rta(readiness)
            return {
                "vessel_id": req.vessel_id,
                "rta": _iso(rta),
                "rta_driver": driver,
                "curve": speed_sweep(vessel, readiness),
                "note": "fuel ∝ speed^3; the knee of this curve is the JIT argument",
            }

        @router.get("/constants", summary="Versioned constants (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {
                "module_version": MODULE_VERSION,
                "dukc_core_fingerprint": DUKC_CORE_FINGERPRINT,
                "commercial_figures": COMMERCIAL_FIGURES_LABEL,
                "constants": MODULE_INFO["constants"],
            }

        @router.get("/demo", summary="Canonical 240 NM demo scenario")
        def demo() -> Dict[str, Any]:
            vessel, readiness = _canonical_case()
            return evaluate_jit(vessel, readiness).as_dict()

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

_DEMO_NOW = datetime(2026, 8, 1, tzinfo=timezone.utc)


def _canonical_case(
    distance_nm: float = 240.0,
    berth_ready_h: float = 20.0,
    window_start_h: float = 19.0,
) -> Tuple[VesselAtSea, PortReadiness]:
    """The worked example from the module docstring."""
    vessel = VesselAtSea(
        vessel_id="V-1003",
        vessel_name="CMA CGM ANTOINE DE SAINT EXUPERY",
        vessel_class="CONTAINER",
        now=_DEMO_NOW,
        distance_to_go_nm=distance_nm,
        service_speed_kn=16.0,
        fuel_at_service_t_per_h=3.2,
        min_steerage_kn=8.0,
        arrival_draft_m=14.5,
    )
    readiness = PortReadiness(
        berth_id="APMT-01",
        berth_ready_time=_DEMO_NOW + timedelta(hours=berth_ready_h),
        tidal_window_start=_DEMO_NOW + timedelta(hours=window_start_h),
        tidal_window_end=_DEMO_NOW + timedelta(hours=window_start_h + 4.75),
        tidal_window_max_draft_m=15.5,
    )
    return vessel, readiness


def _self_test() -> List[Tuple[str, bool, str]]:
    """Return ``[(check_name, passed, detail), ...]``."""
    checks: List[Tuple[str, bool, str]] = []

    try:
        _dukc_core_selftest()
        checks.append(("dukc_core_golden_values", True, DUKC_CORE_FINGERPRINT))
    except AssertionError as exc:
        checks.append(("dukc_core_golden_values", False, str(exc)))

    vessel, readiness = _canonical_case()
    r = evaluate_jit(vessel, readiness)

    checks.append(
        (
            "rta_is_max_of_constraints",
            r.rta == _DEMO_NOW + timedelta(hours=20) and r.rta_driver == DRIVER_BERTH_READY,
            f"max(berth 20 h, tide 19 h) -> {r.available_hours:.1f} h, driver {r.rta_driver}",
        )
    )
    checks.append(
        (
            "required_speed",
            abs(r.required_speed_kn - 12.0) < 1e-9 and not r.speed_clamped,
            f"240 NM / 20.0 h = {r.required_speed_kn:.2f} kn (not clamped)",
        )
    )
    checks.append(
        (
            "baseline_fuel",
            abs(r.baseline.steaming_fuel_t - 48.0) < 1e-9
            and abs(r.baseline.transit_hours - 15.0) < 1e-9,
            f"16 kn: {r.baseline.transit_hours:.2f} h, "
            f"{r.baseline.steaming_fuel_t:.3f} t steaming",
        )
    )
    checks.append(
        (
            "jit_fuel_cube_law",
            abs(r.jit.steaming_fuel_t - 27.0) < 1e-9,
            f"3.2 * (12/16)^3 * 20 = {r.jit.steaming_fuel_t:.3f} t "
            f"(cube factor {(12 / 16) ** 3:.4f})",
        )
    )
    checks.append(
        (
            "headline_is_steaming_only",
            r.headline.basis == "STEAMING_ONLY"
            and r.headline.is_headline
            and abs(r.headline.fuel_saved_t - 21.0) < 1e-9,
            f"headline {r.headline.fuel_saved_t:.2f} t / "
            f"{r.headline.co2_saved_t:.2f} t CO2 / USD {r.headline.bunker_saved_usd:,.0f}",
        )
    )
    checks.append(
        (
            "secondary_is_larger",
            r.secondary.fuel_saved_t > r.headline.fuel_saved_t
            and not r.secondary.is_headline
            and abs(r.secondary.fuel_saved_t - 22.75) < 1e-9,
            f"anchorage-inclusive {r.secondary.fuel_saved_t:.2f} t > headline "
            f"{r.headline.fuel_saved_t:.2f} t, correctly flagged non-headline",
        )
    )
    checks.append(
        (
            "co2_factor",
            abs(r.headline.co2_saved_t - 21.0 * IMO_CO2_FACTOR_T_PER_T) < 1e-9,
            f"21.0 t * {IMO_CO2_FACTOR_T_PER_T} = {r.headline.co2_saved_t:.3f} t CO2",
        )
    )
    checks.append(
        (
            "bunker_price",
            abs(r.headline.bunker_saved_usd - 21.0 * BUNKER_PRICE_USD_PER_T) < 1e-9,
            f"21.0 t * USD {BUNKER_PRICE_USD_PER_T:.0f} = "
            f"USD {r.headline.bunker_saved_usd:,.0f} [{COMMERCIAL_FIGURES_LABEL}]",
        )
    )
    checks.append(
        (
            "anchorage_eliminated",
            abs(r.anchorage_hours_eliminated - 5.0) < 1e-9 and r.jit.anchorage_wait_hours == 0.0,
            f"baseline waits {r.baseline.anchorage_wait_hours:.2f} h, JIT waits "
            f"{r.jit.anchorage_wait_hours:.2f} h",
        )
    )
    checks.append(
        (
            "jit_arrives_exactly_at_rta",
            abs(_hours_between(r.jit.arrival_time, r.rta)) < 1e-6,
            f"JIT arrival {_iso(r.jit.arrival_time)} == RTA {_iso(r.rta)}",
        )
    )
    checks.append(
        (
            "commercial_figures_labelled",
            r.headline.label == COMMERCIAL_FIGURES_LABEL
            and r.breakdown["provenance"]["commercial_figures"] == COMMERCIAL_FIGURES_LABEL
            and COMMERCIAL_FIGURES_LABEL in r.breakdown["steps"][7]["note"],
            "every commercial figure carries the SIMULATED label with its assumption",
        )
    )

    # --- Edge case (a): berth ready before full-speed arrival --------------
    v_a, rd_a = _canonical_case(distance_nm=400.0, berth_ready_h=10.0, window_start_h=9.0)
    r_a = evaluate_jit(v_a, rd_a)
    checks.append(
        (
            "edge_no_slack_max_speed",
            r_a.rta_driver == DRIVER_MAX_SPEED
            and not r_a.feasible
            and abs(r_a.headline.fuel_saved_t) < 1e-9
            and "already on the optimal trajectory" in r_a.recommendation,
            f"400 NM, berth ready in 10 h -> driver {r_a.rta_driver}, "
            f"saving {r_a.headline.fuel_saved_t:.2f} t",
        )
    )

    # --- Edge case (b): required speed below minimum steerage -------------
    v_b, rd_b = _canonical_case(distance_nm=100.0, berth_ready_h=40.0, window_start_h=39.0)
    r_b = evaluate_jit(v_b, rd_b)
    checks.append(
        (
            "edge_below_steerage_clamped",
            r_b.speed_clamped
            and abs(r_b.recommended_speed_kn - MIN_STEERAGE_SPEED_KN) < 1e-9
            and r_b.jit.anchorage_wait_hours > 0.0
            and "residual" in r_b.recommendation,
            f"100 NM in 40 h needs {r_b.required_speed_kn:.2f} kn -> clamped to "
            f"{r_b.recommended_speed_kn:.1f} kn, {r_b.jit.anchorage_wait_hours:.2f} h residual",
        )
    )
    checks.append(
        (
            "clamped_case_still_saves",
            r_b.headline.fuel_saved_t > 0.0,
            f"even clamped, saves {r_b.headline.fuel_saved_t:.2f} t "
            f"(USD {r_b.headline.bunker_saved_usd:,.0f} {COMMERCIAL_FIGURES_LABEL})",
        )
    )

    # --- Edge case (c): RTA past the window close -------------------------
    v_c = replace(_canonical_case()[0], distance_to_go_nm=240.0)
    rd_c = PortReadiness(
        berth_id="APMT-01",
        berth_ready_time=_DEMO_NOW + timedelta(hours=20),
        tidal_window_start=_DEMO_NOW + timedelta(hours=10),
        tidal_window_end=_DEMO_NOW + timedelta(hours=14),
        tidal_window_max_draft_m=15.5,
    )
    r_c = evaluate_jit(v_c, rd_c)
    checks.append(
        (
            "edge_misses_tidal_window",
            r_c.misses_tidal_window and "WARNING" in r_c.recommendation,
            f"RTA {_iso(r_c.rta)} lands after the window closes "
            f"{_iso(rd_c.tidal_window_end)} -> flagged",
        )
    )

    # --- Draft not admitted by the window ---------------------------------
    v_d = replace(_canonical_case()[0], arrival_draft_m=15.8)
    rd_d = _canonical_case()[1]
    r_d = evaluate_jit(v_d, rd_d)
    checks.append(
        (
            "draft_vs_window_limit",
            r_d.draft_admitted_by_window is False and "not permissible" in r_d.recommendation,
            f"arrival draft 15.80 m vs window limit "
            f"{rd_d.tidal_window_max_draft_m:.2f} m -> flagged",
        )
    )

    # --- Tide driving the RTA ---------------------------------------------
    v_e, _ = _canonical_case()
    rd_e = PortReadiness(
        berth_id="APMT-01",
        berth_ready_time=_DEMO_NOW + timedelta(hours=16),
        tidal_window_start=_DEMO_NOW + timedelta(hours=22),
        tidal_window_end=_DEMO_NOW + timedelta(hours=26),
    )
    r_e = evaluate_jit(v_e, rd_e)
    checks.append(
        (
            "tide_can_drive_rta",
            r_e.rta_driver == DRIVER_TIDAL_WINDOW
            and abs(r_e.available_hours - 22.0) < 1e-9,
            f"berth ready at 16 h but tide opens at 22 h -> driver {r_e.rta_driver}",
        )
    )

    # --- Monotonicity: slower is always cheaper on steaming fuel ----------
    curve = speed_sweep(*_canonical_case())
    mono = all(
        curve[i]["steaming_fuel_t"] <= curve[i + 1]["steaming_fuel_t"] + 1e-9
        for i in range(len(curve) - 1)
    )
    checks.append(
        (
            "speed_sweep_monotonic",
            mono and len(curve) == 17,
            f"{len(curve)} points from {curve[0]['speed_kn']:.1f} to "
            f"{curve[-1]['speed_kn']:.1f} kn; steaming fuel non-decreasing in speed",
        )
    )

    # --- Fleet roll-up -----------------------------------------------------
    fleet = evaluate_fleet(SyntheticFleetProvider(DEFAULT_SEED, 5).load_fleet(_DEMO_NOW))
    checks.append(
        (
            "fleet_rollup_non_negative",
            fleet.fleet_fuel_saved_t >= 0.0 and fleet.fleet_co2_saved_t >= 0.0,
            f"5 vessels: {fleet.fleet_fuel_saved_t:.2f} t fuel, "
            f"{fleet.fleet_co2_saved_t:.2f} t CO2, "
            f"USD {fleet.fleet_bunker_saved_usd:,.0f} [{COMMERCIAL_FIGURES_LABEL}]",
        )
    )
    checks.append(
        (
            "fleet_basis_ordering",
            evaluate_fleet(
                SyntheticFleetProvider(DEFAULT_SEED, 5).load_fleet(_DEMO_NOW),
                "ANCHORAGE_INCLUSIVE",
            ).fleet_fuel_saved_t >= fleet.fleet_fuel_saved_t,
            "anchorage-inclusive fleet total >= steaming-only fleet total",
        )
    )
    checks.append(
        (
            "determinism",
            evaluate_fleet(
                SyntheticFleetProvider(DEFAULT_SEED, 5).load_fleet(_DEMO_NOW)
            ).fleet_fuel_saved_t == fleet.fleet_fuel_saved_t,
            f"repeat run reproduces {fleet.fleet_fuel_saved_t:.4f} t",
        )
    )

    checks.append(
        (
            "breakdown_completeness",
            len(r.breakdown["steps"]) == 9
            and all(s.get("substitution") for s in r.breakdown["steps"]),
            f"{len(r.breakdown['steps'])} steps, all with substitutions",
        )
    )

    return checks


def _print_case(r: JITResult, title: str) -> None:
    print(f"\n{title}")
    print(
        f"  {r.vessel_name}  {r.distance_to_go_nm:.1f} NM to go   "
        f"service {r.baseline.speed_kn:.1f} kn   berth {r.berth_id}"
    )
    for s in r.breakdown["steps"][:4]:
        print(f"  [{s['step']}] {s['label']:<28} {s['substitution']}"
              + (f"   ({s['note']})" if s["note"] and s["step"] == 4 else ""))

    print()
    print(_fmt_table(
        ["leg", "speed", "transit", "arrive", "steam t", "wait h", "anch t", "total t"],
        [
            [
                leg.label, f"{leg.speed_kn:.2f}", f"{leg.transit_hours:.2f} h",
                leg.arrival_time.strftime("%d %b %H:%M"),
                f"{leg.steaming_fuel_t:.2f}", f"{leg.anchorage_wait_hours:.2f}",
                f"{leg.anchorage_fuel_t:.2f}", f"{leg.total_fuel_t:.2f}",
            ]
            for leg in (r.baseline, r.jit)
        ],
        indent="  ",
    ))

    h, s2 = r.headline, r.secondary
    print(
        f"\n  HEADLINE  (steaming only)      {h.fuel_saved_t:7.2f} t bunker | "
        f"{h.co2_saved_t:7.2f} t CO2 | USD {h.bunker_saved_usd:9,.0f}   [{h.label}]"
    )
    print(
        f"  secondary (anchorage incl.)    {s2.fuel_saved_t:7.2f} t bunker | "
        f"{s2.co2_saved_t:7.2f} t CO2 | USD {s2.bunker_saved_usd:9,.0f}   [{s2.label}, not claimed]"
    )
    print(f"  anchorage eliminated           {r.anchorage_hours_eliminated:7.2f} h")
    print(f"\n  RECOMMEND  {r.recommendation}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="UC1-M6 JIT arrival / RTA advisory — demo and self-test runner."
    )
    parser.add_argument("--distance", type=float, default=240.0, help="Distance to go, NM.")
    parser.add_argument("--berth-ready-h", type=float, default=20.0,
                        help="Hours from now until the berth is ready.")
    parser.add_argument("--window-start-h", type=float, default=19.0,
                        help="Hours from now until the tidal window opens.")
    parser.add_argument("--fleet", type=int, default=5, help="Fleet size for the roll-up.")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args(argv)

    if not args.quiet:
        print("=" * 78)
        print(f"{MODULE_ID} — {MODULE_NAME}   ({MODULE_VERSION})")
        print("JNPA UC-I Vessel Traffic Management | WS2 row 6 | deterministic physics")
        print("=" * 78)

    try:
        _dukc_core_selftest()
        core_ok = True
        if not args.quiet:
            print(f"\nDUKC CORE SELFTEST ... PASS   ({DUKC_CORE_FINGERPRINT})")
    except AssertionError as exc:
        core_ok = False
        print(f"DUKC CORE SELFTEST ... FAIL: {exc}")

    vessel, readiness = _canonical_case(args.distance, args.berth_ready_h, args.window_start_h)
    result = evaluate_jit(vessel, readiness)

    if args.json:
        print(json.dumps(result.as_dict(), indent=2))
    elif not args.quiet:
        print(
            f"\nASSUMPTIONS  bunker USD {BUNKER_PRICE_USD_PER_T:.0f}/t | "
            f"IMO CO2 {IMO_CO2_FACTOR_T_PER_T} t/t | anchorage "
            f"{ANCHORAGE_IDLE_FUEL_T_PER_H} t/h | min steerage "
            f"{MIN_STEERAGE_SPEED_KN:.0f} kn   — all commercial figures {COMMERCIAL_FIGURES_LABEL}"
        )

        _print_case(result, "CASE 1 — canonical JIT opportunity")

        v_a, rd_a = _canonical_case(400.0, 10.0, 9.0)
        _print_case(evaluate_jit(v_a, rd_a), "CASE 2 — no slack: berth ready before she can arrive")

        v_b, rd_b = _canonical_case(100.0, 40.0, 39.0)
        _print_case(evaluate_jit(v_b, rd_b), "CASE 3 — required speed below minimum steerage")

        print("\nSPEED SWEEP  (fuel is cubic in speed — this curve is the JIT argument)")
        rows = []
        for pt in speed_sweep(vessel, readiness):
            bar = "#" * int(pt["steaming_fuel_t"] / 2)
            rows.append([
                f"{pt['speed_kn']:.1f}", f"{pt['transit_hours']:.2f}",
                f"{pt['steaming_fuel_t']:.2f}", f"{pt['anchorage_wait_hours']:.2f}",
                f"{pt['total_fuel_t']:.2f}", "LATE" if pt["arrives_late"] else "", bar,
            ])
        print(_fmt_table(
            ["kn", "transit h", "steam t", "wait h", "total t", "", ""], rows, indent="  "
        ))

        fleet = evaluate_fleet(
            SyntheticFleetProvider(args.seed, args.fleet).load_fleet(_DEMO_NOW)
        )
        print(f"\nFLEET ROLL-UP  ({len(fleet.results)} inbound vessels, basis {fleet.basis})")
        rows = []
        for fr in fleet.results:
            rows.append([
                fr.vessel_id, fr.vessel_name[:26], f"{fr.distance_to_go_nm:.0f}",
                f"{fr.baseline.speed_kn:.1f}", f"{fr.recommended_speed_kn:.1f}",
                fr.rta_driver,
                f"{fr.headline.fuel_saved_t:.2f}", f"{fr.headline.co2_saved_t:.2f}",
                f"{fr.headline.bunker_saved_usd:,.0f}",
                f"{fr.anchorage_hours_eliminated:.1f}",
            ])
        print(_fmt_table(
            ["id", "vessel", "NM", "svc kn", "JIT kn", "driver",
             "fuel t", "CO2 t", "USD", "anch h"],
            rows, indent="  ",
        ))
        print(
            f"  TOTAL  {fleet.fleet_fuel_saved_t:.2f} t bunker | "
            f"{fleet.fleet_co2_saved_t:.2f} t CO2 | "
            f"USD {fleet.fleet_bunker_saved_usd:,.0f} | "
            f"{fleet.fleet_anchorage_hours_eliminated:.1f} h anchorage eliminated   "
            f"[{COMMERCIAL_FIGURES_LABEL}]"
        )
        print(
            f"  {fleet.breakdown['vessels_already_optimal']} of {len(fleet.results)} vessels "
            f"are already on their optimal trajectory and contribute nothing."
        )

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
