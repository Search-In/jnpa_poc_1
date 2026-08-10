"""
UC1-M4 — ETA Uncertainty & Berth Utilisation Analytics
======================================================

Jawaharlal Nehru Port Authority (JNPA) — Workstream 2, UC-I Vessel Traffic
Management & Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"How confident is this ETA, how full are the berths, and how long do vessels
actually wait?"

WHY DETERMINISTIC
-----------------
Utilisation is a MEASUREMENT question, not a prediction question. Occupancy and
waiting time are aggregations over observed berthing intervals; the only
modelled quantity is the ETA confidence band, and that is a two-term linear
formula fixed by the spec. Everything here is exactly reproducible from the
input records, and every figure ships with its own breakdown.

FORMULAE
--------
    sigma_h      = 0.06 * horizon_hours + 0.05 * ais_staleness_minutes
    eta_p10/p90  = eta_p50 -/+ 1.28 * sigma_h
    occupancy_%  = sum(occupied berth-hours) / (n_berths * window_hours) * 100
    waiting_h    = actual_atb - actual_ata          (p50 and p90 reported)

DISTRIBUTIONS, NOT MEANS
------------------------
Per the spec, every figure is reported as p50/p90 rather than a bare mean. A
mean waiting time hides the tail that actually drives agent complaints; p90 is
the number a berth planner is held to.

THE FOUR INTERVAL CASES (where naive implementations break)
-----------------------------------------------------------
1. WINDOW CLIPPING. A stay that starts before or ends after the reporting
   window contributes only its overlap:
   ``overlap = max(0, min(end, w_end) - max(start, w_start))``.

2. LOCAL-DAY BUCKETING. JNPA reports in IST (UTC+05:30, no DST). A 40 h stay
   spans three local day-cells. Day boundaries are computed in local time and
   converted back to UTC. Critically, each cell's ``available_hours`` is the
   CLIPPED day length inside the window — a window starting at 06:00 gives its
   first day 18 available hours, not 24. Without that, partial days report
   spurious >100% occupancy.

3. DOUBLE-BOOKED BERTHS. Real berthing logs contain overlapping records for the
   same berth (double banking, data-entry errors, or a shift recorded twice).
   Default ``mode="union"`` merges overlapping intervals per berth before
   summing, so occupancy is bounded by 100%. ``mode="sum"`` keeps the raw total.
   The difference is SURFACED as ``breakdown.occupied_hours.double_booked``
   rather than hidden — it is a data-quality signal worth seeing.

4. OPEN-ENDED STAYS. A vessel still alongside has no ATD. Its interval is
   clipped to the window end and counted in ``open_ended_clipped``, never
   dropped and never treated as zero.

USAGE
-----
    python uc1_m4_berth_utilisation.py            # full demo, exits 0 on success
    python uc1_m4_berth_utilisation.py --days 14
    python uc1_m4_berth_utilisation.py --json

    from uc1_m4_berth_utilisation import compute_eta_band, EtaObservation
    band = compute_eta_band(EtaObservation("C1", "V1", now, eta, 45.0))
    print(band.sigma_hours, band.confidence_label)

SELF-CONTAINMENT POLICY
-----------------------
Standard library only above SECTION 6. FastAPI/pydantic optional. Shared helpers
are duplicated into every UC-1 module by design.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import random
import statistics
import sys
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

# ==========================================================================
# SECTION 1 — MODULE IDENTITY AND VERSIONED CONSTANTS
# ==========================================================================

MODULE_ID: str = "UC1-M4"
MODULE_NAME: str = "ETA Uncertainty & Berth Utilisation Analytics"
MODULE_VERSION: str = "m4-analytics-v1.0.0"
ROUTER_PREFIX: str = "/uc1/m4"

DEFAULT_SEED: int = 20260807

# ETA band coefficients — WS2_AI_ML_Tools.md row 4:
# "ETA band widens with horizon (0.06 h/h) + AIS staleness (0.05 h/min)".
ETA_SIGMA_PER_HORIZON_HOUR: float = 0.06     # hours of sigma per hour of horizon
ETA_SIGMA_PER_STALENESS_MINUTE: float = 0.05  # hours of sigma per minute of staleness
Z_P80: float = 1.28                           # +/- 1.28 sigma spans the P10..P90 band

# Confidence labelling thresholds on sigma, in hours. The final band is open
# ended, expressed as +inf so the lookup is a simple ordered scan.
CONFIDENCE_BANDS: Tuple[Tuple[float, str], ...] = (
    (1.5, "HIGH"),
    (4.0, "MEDIUM"),
    (float("inf"), "LOW"),
)


def _bands_json() -> List[List[Any]]:
    """
    JSON-safe rendering of CONFIDENCE_BANDS.

    ``json.dumps`` emits bare ``Infinity`` for float('inf'), which is invalid
    JSON and makes strict parsers (including Starlette's response encoder)
    reject the payload. The open-ended band is therefore emitted as ``null``.
    """
    return [[None if math.isinf(t) else t, label] for t, label in CONFIDENCE_BANDS]

# JNPA operates on Indian Standard Time. India has no daylight saving, so a
# fixed offset is exact rather than an approximation.
PORT_TZ_OFFSET_HOURS: float = 5.5
PORT_TZ_LABEL: str = "IST (UTC+05:30)"

OCCUPANCY_MODES: Tuple[str, ...] = ("union", "sum")

# Optional real-data hand-off from dsr_extract.py.
#
# Resolved from this file's location (src/uc1_models/ -> src/ -> project root)
# rather than the working directory. A bare relative path fails silently: the
# loader's available() returns False and the module drops to synthetic
# occupancy, so running the model from the wrong folder would quietly change
# the numbers instead of raising. The module stays self-contained -- this is a
# path expression, not an import of the pipeline.
DSR_CSV_DEFAULT: str = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "reference", "dsr_berth_stays.csv",
)

# The real JNPA berth roster: 21 berths across 7 terminals, derived from section
# (H) "Vessels Under Operation" of the 54 Daily Status Reports.
#
# Berth ids are the CANONICAL form emitted by dsr_extract.normalise_berth_id().
# That matters: the source reports spell the same berth both ways ("BMCT-01" and
# "BMCT01"), and NSFT/NSICT berths appear as "CB01" in some reports. Keying on
# the raw string would split one physical berth into two and halve its
# occupancy. Run `python dsr_extract.py --emit-berths berths.json` to regenerate.
#
# Lengths and depths are NOT in the reports — they are operational planning
# figures carried here so the compatibility checks have something to test.
DEFAULT_BERTHS: Tuple[Tuple[str, str, float, float], ...] = (
    # (berth_id, terminal, length_m, max_draft_m)
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
# --------------------------------------------------------------------------
# M4 carries no DUKC core (it is pure analytics), but it does carry the same
# time/format/statistics helpers as every other UC-1 module so it can be copied
# out and run in isolation.
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


def _overlap_hours(
    a_start: datetime, a_end: datetime, b_start: datetime, b_end: datetime
) -> float:
    """
    Overlap of two closed intervals, in hours; 0.0 when disjoint.
    DUPLICATED BY DESIGN.

        overlap = max(0, min(a_end, b_end) - max(a_start, b_start))
    """
    lo = max(_ensure_utc(a_start), _ensure_utc(b_start))
    hi = min(_ensure_utc(a_end), _ensure_utc(b_end))
    if hi <= lo:
        return 0.0
    return (hi - lo).total_seconds() / 3600.0


def _percentile(values: Sequence[float], q: float) -> float:
    """
    Linear-interpolation percentile, ``q`` in [0, 1]. DUPLICATED BY DESIGN.

    Method: sort ascending, take the rank ``q * (n - 1)``, and interpolate
    linearly between the two neighbouring order statistics. This is numpy's
    default ('linear') and R's type 7, stated explicitly so a reviewer can
    reproduce the figure by hand.
    """
    if not values:
        return float("nan")
    xs = sorted(float(v) for v in values)
    if len(xs) == 1:
        return xs[0]
    q = min(1.0, max(0.0, q))
    pos = q * (len(xs) - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return xs[lo]
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


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


def _to_local(dt: datetime, offset_h: float = PORT_TZ_OFFSET_HOURS) -> datetime:
    """UTC -> port local wall clock (as a naive-in-UTC shifted value)."""
    return _ensure_utc(dt) + timedelta(hours=offset_h)


def _from_local(dt: datetime, offset_h: float = PORT_TZ_OFFSET_HOURS) -> datetime:
    """Port local wall clock -> UTC."""
    return dt - timedelta(hours=offset_h)


def _merge_intervals(
    intervals: Sequence[Tuple[datetime, datetime]]
) -> List[Tuple[datetime, datetime]]:
    """
    Merge overlapping / touching intervals. DUPLICATED BY DESIGN.

    Used to bound berth occupancy at 100% when a log double-books a berth.
    """
    if not intervals:
        return []
    ordered = sorted(
        ((_ensure_utc(a), _ensure_utc(b)) for a, b in intervals if b > a),
        key=lambda p: (p[0], p[1]),
    )
    if not ordered:
        return []
    merged: List[Tuple[datetime, datetime]] = [ordered[0]]
    for start, end in ordered[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            if end > last_end:
                merged[-1] = (last_start, end)
        else:
            merged.append((start, end))
    return merged


# Public alias — part of the documented API surface.
merge_intervals = _merge_intervals
overlap_hours = _overlap_hours
percentile = _percentile


# ==========================================================================
# SECTION 3 — DATACLASSES
# ==========================================================================


@dataclass(frozen=True)
class EtaObservation:
    """One ETA report for a vessel, with the age of the position fix behind it."""

    call_id: str
    vessel_id: str
    now_utc: datetime
    forecast_eta_utc: datetime
    ais_staleness_minutes: float = 0.0
    source: str = "AIS"          # AIS | AGENT | PCS
    vessel_name: str = ""


@dataclass(frozen=True)
class EtaBand:
    """ETA with an uncertainty band derived from horizon and fix staleness."""

    call_id: str
    vessel_id: str
    horizon_hours: float
    ais_staleness_minutes: float
    sigma_hours: float
    eta_p10_utc: datetime
    eta_p50_utc: datetime
    eta_p90_utc: datetime
    band_width_hours: float
    confidence_label: str
    source: str
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "call_id": self.call_id,
            "vessel_id": self.vessel_id,
            "horizon_hours": round(self.horizon_hours, 3),
            "ais_staleness_minutes": round(self.ais_staleness_minutes, 2),
            "sigma_hours": round(self.sigma_hours, 4),
            "eta_p10_utc": _iso(self.eta_p10_utc),
            "eta_p50_utc": _iso(self.eta_p50_utc),
            "eta_p90_utc": _iso(self.eta_p90_utc),
            "band_width_hours": round(self.band_width_hours, 3),
            "confidence_label": self.confidence_label,
            "source": self.source,
            "breakdown": self.breakdown,
        }


@dataclass(frozen=True)
class BerthSpec:
    """A berth and its physical limits."""

    berth_id: str
    terminal: str
    length_m: float
    max_draft_m: float


@dataclass(frozen=True)
class BerthingRecord:
    """
    One vessel call against one berth, planned and actual.

    ``actual_atd_utc is None`` means the vessel is still alongside — a real and
    common state in a live berthing log, handled explicitly rather than dropped.
    """

    call_id: str
    vessel_id: str
    berth_id: str
    terminal: str = ""
    vessel_name: str = ""
    planned_ata_utc: Optional[datetime] = None
    planned_atb_utc: Optional[datetime] = None
    planned_atd_utc: Optional[datetime] = None
    actual_ata_utc: Optional[datetime] = None
    actual_atb_utc: Optional[datetime] = None
    actual_atd_utc: Optional[datetime] = None


@dataclass(frozen=True)
class OccupancyCell:
    """Occupancy of one berth on one local (IST) day."""

    berth_id: str
    local_date: date
    occupied_hours: float
    available_hours: float
    occupancy_pct: float
    call_ids: Tuple[str, ...]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "berth_id": self.berth_id,
            "local_date": self.local_date.isoformat(),
            "occupied_hours": round(self.occupied_hours, 3),
            "available_hours": round(self.available_hours, 3),
            "occupancy_pct": round(self.occupancy_pct, 2),
            "call_ids": list(self.call_ids),
        }


@dataclass(frozen=True)
class OccupancyCalendar:
    """Berth x local-day occupancy grid plus the roll-ups."""

    window_start_utc: datetime
    window_end_utc: datetime
    window_hours: float
    berth_ids: Tuple[str, ...]
    local_dates: Tuple[date, ...]
    cells: Tuple[OccupancyCell, ...]
    per_berth_pct: Dict[str, float]
    per_day_pct: Dict[str, float]
    total_occupied_hours: float
    total_berth_hours: float
    overall_occupancy_pct: float
    mode: str
    breakdown: Dict[str, Any]

    def cell(self, berth_id: str, d: date) -> Optional[OccupancyCell]:
        for c in self.cells:
            if c.berth_id == berth_id and c.local_date == d:
                return c
        return None

    def as_dict(self, include_cells: bool = True) -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "window_start_utc": _iso(self.window_start_utc),
            "window_end_utc": _iso(self.window_end_utc),
            "window_hours": round(self.window_hours, 3),
            "berth_ids": list(self.berth_ids),
            "local_dates": [d.isoformat() for d in self.local_dates],
            "per_berth_pct": {k: round(v, 2) for k, v in self.per_berth_pct.items()},
            "per_day_pct": {k: round(v, 2) for k, v in self.per_day_pct.items()},
            "total_occupied_hours": round(self.total_occupied_hours, 3),
            "total_berth_hours": round(self.total_berth_hours, 3),
            "overall_occupancy_pct": round(self.overall_occupancy_pct, 2),
            "mode": self.mode,
            "breakdown": self.breakdown,
        }
        if include_cells:
            out["cells"] = [c.as_dict() for c in self.cells]
        return out


@dataclass(frozen=True)
class WaitingTimeStats:
    """Waiting-time distribution, reported as p50/p90 rather than a mean."""

    definition: str
    n: int
    p50_hours: float
    p90_hours: float
    p10_hours: float
    mean_hours: float
    max_hours: float
    by_terminal: Dict[str, Dict[str, float]]
    n_dropped: int
    drop_reasons: Tuple[Dict[str, str], ...]
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "definition": self.definition,
            "n": self.n,
            "p10_hours": round(self.p10_hours, 3),
            "p50_hours": round(self.p50_hours, 3),
            "p90_hours": round(self.p90_hours, 3),
            "mean_hours": round(self.mean_hours, 3),
            "max_hours": round(self.max_hours, 3),
            "by_terminal": {
                k: {kk: round(vv, 3) for kk, vv in v.items()}
                for k, v in self.by_terminal.items()
            },
            "n_dropped": self.n_dropped,
            "drop_reasons": [dict(d) for d in self.drop_reasons],
            "breakdown": self.breakdown,
        }


@dataclass(frozen=True)
class PlanAdherenceStats:
    """Planned vs actual, for arrival and for berthing."""

    n: int
    arrival_delay_p50_h: float
    arrival_delay_p90_h: float
    berth_delay_p50_h: float
    berth_delay_p90_h: float
    departure_delay_p50_h: float
    departure_delay_p90_h: float
    n_arrival: int
    n_berth: int
    n_departure: int
    breakdown: Dict[str, Any]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "n": self.n,
            "arrival_delay_p50_h": round(self.arrival_delay_p50_h, 3),
            "arrival_delay_p90_h": round(self.arrival_delay_p90_h, 3),
            "berth_delay_p50_h": round(self.berth_delay_p50_h, 3),
            "berth_delay_p90_h": round(self.berth_delay_p90_h, 3),
            "departure_delay_p50_h": round(self.departure_delay_p50_h, 3),
            "departure_delay_p90_h": round(self.departure_delay_p90_h, 3),
            "n_arrival": self.n_arrival,
            "n_berth": self.n_berth,
            "n_departure": self.n_departure,
            "breakdown": self.breakdown,
        }


@dataclass(frozen=True)
class UtilisationReport:
    """Everything M4 produces for one reporting window."""

    window_start_utc: datetime
    window_end_utc: datetime
    calendar: OccupancyCalendar
    waiting: WaitingTimeStats
    adherence: PlanAdherenceStats
    eta_bands: Tuple[EtaBand, ...]
    record_count: int
    berth_count: int
    data_source: str
    recommendation: str
    breakdown: Dict[str, Any]

    def as_dict(self, include_cells: bool = True) -> Dict[str, Any]:
        return {
            "window_start_utc": _iso(self.window_start_utc),
            "window_end_utc": _iso(self.window_end_utc),
            "calendar": self.calendar.as_dict(include_cells=include_cells),
            "waiting": self.waiting.as_dict(),
            "adherence": self.adherence.as_dict(),
            "eta_bands": [b.as_dict() for b in self.eta_bands],
            "record_count": self.record_count,
            "berth_count": self.berth_count,
            "data_source": self.data_source,
            "recommendation": self.recommendation,
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
class BerthingLogLoader(Protocol):
    """Supplies berthing records for a time window."""

    @property
    def source_id(self) -> str: ...

    def load_records(self, start: datetime, end: datetime) -> List[BerthingRecord]: ...

    def load_berths(self) -> List[BerthSpec]: ...


def default_berths() -> List[BerthSpec]:
    """The real 20-berth JNPA roster."""
    return [BerthSpec(b, t, l, d) for (b, t, l, d) in DEFAULT_BERTHS]


class SyntheticBerthingLogLoader:
    """
    Seeded synthetic berthing log, calibrated to JNPA public reference figures.

    Anchors (assumptions register): ~10-12 calls/day port-wide, berth stay
    ~0.97 d (23.3 h), waiting p50 around 14 h with a long right tail so p90
    lands near 38 h. The generator deliberately injects the three dirty-data
    conditions the engine must survive:

      * one double-booked berth interval  -> exercises union vs sum
      * one open-ended stay (no ATD)      -> exercises window clipping
      * one record with ATD before ATB    -> exercises the drop path

    Deterministic: uses ``random.Random(seed)``, never the global RNG.
    """

    source_id = "SYNTHETIC_BERTHING_LOG_v1"

    def __init__(
        self,
        seed: int = DEFAULT_SEED,
        calls_per_day: Tuple[int, int] = (10, 12),
        berths: Optional[Sequence[BerthSpec]] = None,
        inject_dirty_data: bool = True,
    ) -> None:
        self.seed = seed
        self.calls_per_day = calls_per_day
        self._berths = list(berths) if berths is not None else default_berths()
        self.inject_dirty_data = inject_dirty_data

    def load_berths(self) -> List[BerthSpec]:
        return list(self._berths)

    def load_records(self, start: datetime, end: datetime) -> List[BerthingRecord]:
        rng = random.Random(self.seed)
        start = _ensure_utc(start)
        end = _ensure_utc(end)
        days = max(1, int(math.ceil(_hours_between(start, end) / 24.0)))
        container_berths = [b for b in self._berths if b.terminal in
                            ("NSFT", "NSICT", "NSIGT", "APMT", "BMCT")]
        records: List[BerthingRecord] = []
        seq = 0

        # A berth serves one vessel at a time. Tracking when each berth next
        # falls vacant keeps the generated log physically valid, so the only
        # overlap in the output is the one deliberately injected below — which
        # is what makes the double-booking figure meaningful rather than noise.
        free_at: Dict[str, datetime] = {b.berth_id: start for b in container_berths}
        turnaround_gap_h = 0.5

        for d in range(days):
            day0 = start + timedelta(days=d)
            n_calls = rng.randint(*self.calls_per_day)
            for _ in range(n_calls):
                seq += 1

                ata = day0 + timedelta(hours=rng.uniform(0.0, 24.0))
                # Base wait is the tide/pilotage component only. The rest of
                # the observed waiting time EMERGES from berth queueing below,
                # which is the physically honest way to reach the ~14 h p50
                # anchor — drawing the full wait directly would double-count.
                base_wait_h = min(48.0, math.exp(rng.gauss(math.log(8.0), 0.55)))
                requested_atb = ata + timedelta(hours=base_wait_h)

                # Earliest-available berth, ties broken by id for determinism.
                berth = min(
                    container_berths,
                    key=lambda b: (free_at[b.berth_id], b.berth_id),
                )
                atb = max(requested_atb, free_at[berth.berth_id])

                # Berth stay: mean ~23.3 h (0.97 d) per the JNPA reference.
                stay_h = max(4.0, rng.gauss(23.3, 7.0))
                atd = atb + timedelta(hours=stay_h)
                free_at[berth.berth_id] = atd + timedelta(hours=turnaround_gap_h)

                # Plan is the actual, perturbed — so adherence stats are non-trivial.
                p_ata = ata - timedelta(hours=rng.gauss(0.0, 3.0))
                p_atb = atb - timedelta(hours=rng.gauss(2.0, 4.0))
                p_atd = atd - timedelta(hours=rng.gauss(1.0, 5.0))

                records.append(
                    BerthingRecord(
                        call_id=f"C-{seq:04d}",
                        vessel_id=f"V-{seq:04d}",
                        vessel_name=f"SYNTH VESSEL {seq:03d}",
                        berth_id=berth.berth_id,
                        terminal=berth.terminal,
                        planned_ata_utc=p_ata,
                        planned_atb_utc=p_atb,
                        planned_atd_utc=p_atd,
                        actual_ata_utc=ata,
                        actual_atb_utc=atb,
                        actual_atd_utc=atd,
                    )
                )

        if self.inject_dirty_data and records:
            base = records[0]
            # (a) Double-booked berth: an overlapping record on the same berth.
            records.append(
                BerthingRecord(
                    call_id="C-DBL1",
                    vessel_id="V-DBL1",
                    vessel_name="DOUBLE BANKED",
                    berth_id=base.berth_id,
                    terminal=base.terminal,
                    actual_ata_utc=base.actual_ata_utc,
                    actual_atb_utc=base.actual_atb_utc + timedelta(hours=1.0),
                    actual_atd_utc=base.actual_atd_utc + timedelta(hours=1.0),
                )
            )
            # (b) Open-ended stay: berthed inside the window, still alongside.
            records.append(
                BerthingRecord(
                    call_id="C-OPEN",
                    vessel_id="V-OPEN",
                    vessel_name="STILL ALONGSIDE",
                    berth_id=self._berths[-1].berth_id,
                    terminal=self._berths[-1].terminal,
                    actual_ata_utc=end - timedelta(hours=30.0),
                    actual_atb_utc=end - timedelta(hours=24.0),
                    actual_atd_utc=None,
                )
            )
            # (c) Corrupt record: departure before berthing.
            records.append(
                BerthingRecord(
                    call_id="C-BAD1",
                    vessel_id="V-BAD1",
                    vessel_name="BAD TIMESTAMPS",
                    berth_id=self._berths[0].berth_id,
                    terminal=self._berths[0].terminal,
                    actual_ata_utc=start + timedelta(hours=10.0),
                    actual_atb_utc=start + timedelta(hours=20.0),
                    actual_atd_utc=start + timedelta(hours=15.0),
                )
            )

        return sorted(records, key=lambda r: (r.actual_ata_utc or start, r.call_id))


class DsrBerthStayLoader:
    """
    REAL DATA — reads ``dsr_berth_stays.csv`` produced by ``dsr_extract.py``.

    That CSV is extracted from section (H) "Vessels Under Operation" on page 3
    of every JNPA Daily Status Report (53 PDFs, Feb and May 2026), which prints:

        Terminal | Berth No | Via No | Vessel Name | Cargo | Berthed on |
        Expected Completion

    Those two timestamps give a real berth-stay interval per vessel per report.
    ``dsr_extract.py`` already converts IST -> UTC and drops corrupt rows, so
    this loader is a thin CSV reader.

    Falls back cleanly: ``available()`` is False when the CSV is absent, and the
    caller uses the synthetic loader instead. Real data is never a hard
    requirement for the module to run.

    LIMITATION worth stating: the DSR prints "Berthed on" and "Expected
    Completion" but not ATA, so waiting time (ATB - ATA) is NOT derivable from
    this source. Occupancy and berth stay are. Waiting time needs the VESARR /
    VESDEP logs or the terminal berthing reports — see the stubs below.
    """

    def __init__(self, csv_path: str = DSR_CSV_DEFAULT) -> None:
        self.csv_path = csv_path

    @property
    def source_id(self) -> str:
        return f"JNPA_DSR_SECTION_H/{os.path.basename(self.csv_path)}"

    def available(self) -> bool:
        return os.path.isfile(self.csv_path)

    def load_berths(self) -> List[BerthSpec]:
        return default_berths()

    def load_records(self, start: datetime, end: datetime) -> List[BerthingRecord]:
        if not self.available():
            raise FileNotFoundError(
                f"{self.csv_path} not found. Run: python dsr_extract.py --out {self.csv_path}"
            )
        out: List[BerthingRecord] = []
        with open(self.csv_path, "r", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                try:
                    berthed = datetime.fromisoformat(
                        row["berthed_on_utc"].replace("Z", "+00:00")
                    )
                    completion_raw = (row.get("expected_completion_utc") or "").strip()
                    completion = (
                        datetime.fromisoformat(completion_raw.replace("Z", "+00:00"))
                        if completion_raw
                        else None
                    )
                except (KeyError, ValueError):
                    continue
                out.append(
                    BerthingRecord(
                        call_id=f"{row.get('report_date', '')}-{row.get('via_no', '')}",
                        vessel_id=row.get("via_no", ""),
                        vessel_name=row.get("vessel_name", ""),
                        berth_id=row.get("berth_id", ""),
                        terminal=row.get("terminal", ""),
                        actual_atb_utc=berthed,
                        actual_atd_utc=completion,
                    )
                )
        return [
            r for r in out
            if r.actual_atb_utc is not None and _ensure_utc(start) <= r.actual_atb_utc <= _ensure_utc(end)
        ]


class TerminalBerthingReportPdfLoader:
    """
    REAL-DATA STUB — planned vs actual from the terminal berthing reports.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Source directory:
        Model_Training_Data\\Model_Training_Data\\UC-I_Vessel_Traffic\\
        M4-M5_ETA_BerthUtilisation_Optimiser\\Berthing_Reports_Planned_vs_Actual\\

    IMPORTANT: this is NOT one layout. Five terminals publish five different
    report formats, so this loader needs FIVE PARSE PROFILES, each with its own
    table locator and column map:

        APM Terminals\\      APMT_Berthing_Report_-_DD-Mon-2026.pdf
        BMCT_PSA\\           Berthing_Sheet__DD_MON_2026*.pdf
        NSFT\\               Daily_Berthing_Report_D_M_2026.pdf
        NSICT_DP World\\     BERTHING-CT*.pdf
        NSIGT_DP World\\     BERTHING-GT*.pdf

    Extract per vessel row, mapping each terminal's column names onto:
        call_id / VIA no, vessel name, berth,
        planned ETA / ETB / ETD, actual ATA / ATB / ATD

    Timestamps are IST -> convert to UTC here. Watch for two date formats in the
    same corpus: 'DD/MM/YYYY HH:MM' and 'DD-MM-YYYY HH:MM'.

    Reject rows where ATD <= ATB, or where the berth id is not in the roster.
    Retain rows with a missing ATD — the vessel is still alongside and the
    engine handles that case explicitly.

    Set source_id = "JNPA_TERMINAL_BERTHING_PDF/<terminal>/<date>".
    Dependency to add when implementing: pdfplumber.
    """

    source_id = "JNPA_TERMINAL_BERTHING_PDF/NOT_IMPLEMENTED"

    def load_berths(self) -> List[BerthSpec]:
        raise NotImplementedError(TerminalBerthingReportPdfLoader.__doc__)

    def load_records(self, start: datetime, end: datetime) -> List[BerthingRecord]:
        raise NotImplementedError(TerminalBerthingReportPdfLoader.__doc__)


class VesarrVesdepLogLoader:
    """
    REAL-DATA STUB — actual arrival/departure from the PCS message logs.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Sources:
        ...\\PCS_NLP_Marine_Messages\\VESARR\\NlpPcsVesselArr*.log
        ...\\PCS_NLP_Marine_Messages\\VESDEP\\NlpPcsVesselDep*.log

    Format: one line per event,
        'M/D/YYYY h:mm:ss AM/PM: <message>'
    wrapping a JSON envelope
        {"ReqHeader": {Channel_ID, Service_ID, Request_ID, Request_Date},
         "ReqBody": {"XML": "<VesselArrival>...</VesselArrival>"}}

    The inner XML carries: RecordType, BerthNumber (e.g. 'CB02'), VCN
    (e.g. 'INNSA1NF0S0776'), IMONumber, CallSign, VoyageNumber, TOOrDOckCode,
    TerminalAR, VesselName, CountryOfVessel, SACode, SLCode, RotationNumber.
    VESDEP uses root <VesselMovement> with DocumentType VESDEP.

    Contract: emit actual_ata_utc from VESARR Request_Date and actual_atd_utc
    from the matching VESDEP, joined on VCN. Timestamps are IST -> UTC.

    This is the ONLY source in the corpus that gives a true ATA, and therefore
    the only one from which waiting time (ATB - ATA) can be computed for real.

    Dependencies: stdlib json + xml.etree only.
    """

    source_id = "JNPA_PCS_VESARR_VESDEP/NOT_IMPLEMENTED"

    def load_berths(self) -> List[BerthSpec]:
        raise NotImplementedError(VesarrVesdepLogLoader.__doc__)

    def load_records(self, start: datetime, end: datetime) -> List[BerthingRecord]:
        raise NotImplementedError(VesarrVesdepLogLoader.__doc__)


class BermanPlannedLoader:
    """
    REAL-DATA STUB — planned ETB/ETD from PCS BERMAN messages.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Source: ...\\PCS_NLP_Marine_Messages\\BERMAN\\BERMAN_<commonRef>.xml (14 files)

    Verified tag path:
        BerthManagement/DocumentDetails/BERMANHeader/{VCN, CallSign, IMONumber,
        VoyageNumber, VesselType, RotationNumber, Anchorage, EDTA, EDTD,
        DraftFwd, DraftAft, SpecificBerthDetails/BerthDetails}

    EDTA / EDTD literal format: 'DDMMYYYY:HH:MM'  (e.g. '11022026:17:00'), IST.
    Parse with datetime.strptime(value, '%d%m%Y:%H:%M') then attach IST and
    convert to UTC.

    Contract: emit planned_ata_utc = EDTA, planned_atd_utc = EDTD. These are
    PLANNED times and belong only in the plan-adherence comparison — never
    substitute them for actuals.

    Dependency: stdlib xml.etree only.
    """

    source_id = "JNPA_PCS_BERMAN/NOT_IMPLEMENTED"

    def load_berths(self) -> List[BerthSpec]:
        raise NotImplementedError(BermanPlannedLoader.__doc__)

    def load_records(self, start: datetime, end: datetime) -> List[BerthingRecord]:
        raise NotImplementedError(BermanPlannedLoader.__doc__)


# ==========================================================================
# SECTION 5 — ENGINE
# ==========================================================================


def eta_sigma_hours(horizon_hours: float, ais_staleness_minutes: float) -> float:
    """
    ETA uncertainty in hours.

        sigma = 0.06 * horizon_hours + 0.05 * ais_staleness_minutes

    Both terms matter and both are visible in the demo grid: a 24 h horizon on a
    fresh fix gives 1.44 h, while a 2 h horizon on a 3-hour-old fix gives 9.12 h.
    Staleness dominates at short range, which is the operationally interesting
    result — a stale fix on a vessel two hours out is worse than a fresh fix a
    day out.

    Negative inputs are clamped to zero; sigma is never negative.
    """
    h = max(0.0, float(horizon_hours))
    s = max(0.0, float(ais_staleness_minutes))
    return ETA_SIGMA_PER_HORIZON_HOUR * h + ETA_SIGMA_PER_STALENESS_MINUTE * s


def confidence_label(sigma_hours: float) -> str:
    """HIGH / MEDIUM / LOW from sigma, using the versioned band thresholds."""
    for threshold, label in CONFIDENCE_BANDS:
        if sigma_hours < threshold:
            return label
    return CONFIDENCE_BANDS[-1][1]


def compute_eta_band(obs: EtaObservation) -> EtaBand:
    """Turn one ETA observation into a P10/P50/P90 band with a breakdown."""
    now = _ensure_utc(obs.now_utc)
    eta = _ensure_utc(obs.forecast_eta_utc)
    horizon = max(0.0, _hours_between(now, eta))
    sigma = eta_sigma_hours(horizon, obs.ais_staleness_minutes)
    delta = timedelta(hours=Z_P80 * sigma)
    label = confidence_label(sigma)

    horizon_term = ETA_SIGMA_PER_HORIZON_HOUR * horizon
    stale_term = ETA_SIGMA_PER_STALENESS_MINUTE * max(0.0, obs.ais_staleness_minutes)

    breakdown = {
        "model": "M4_ETA_BAND",
        "version": MODULE_VERSION,
        "constants": {
            "ETA_SIGMA_PER_HORIZON_HOUR": ETA_SIGMA_PER_HORIZON_HOUR,
            "ETA_SIGMA_PER_STALENESS_MINUTE": ETA_SIGMA_PER_STALENESS_MINUTE,
            "Z_P80": Z_P80,
            "CONFIDENCE_BANDS": _bands_json(),
        },
        "inputs": {
            "call_id": obs.call_id,
            "vessel_id": obs.vessel_id,
            "now_utc": _iso(now),
            "forecast_eta_utc": _iso(eta),
            "ais_staleness_minutes": obs.ais_staleness_minutes,
            "source": obs.source,
        },
        "steps": [
            _step(
                1,
                "Horizon",
                "horizon_hours = forecast_eta - now",
                f"{_iso(eta)} - {_iso(now)} = {horizon:.3f} h",
                {"now_utc": _iso(now), "eta_utc": _iso(eta)},
                round(horizon, 4),
                "h",
                "clamped at 0 for an ETA already in the past",
            ),
            _step(
                2,
                "Sigma",
                "sigma = 0.06 * horizon_hours + 0.05 * staleness_minutes",
                f"0.06 * {horizon:.3f} + 0.05 * {obs.ais_staleness_minutes:.1f} "
                f"= {horizon_term:.4f} + {stale_term:.4f} = {sigma:.4f}",
                {
                    "horizon_term_h": round(horizon_term, 4),
                    "staleness_term_h": round(stale_term, 4),
                },
                round(sigma, 4),
                "h",
                f"horizon contributes {(horizon_term / sigma * 100.0) if sigma else 0.0:.1f}%",
            ),
            _step(
                3,
                "Band",
                "p10/p90 = p50 -/+ Z_P80 * sigma",
                f"{_iso(eta)} -/+ {Z_P80} * {sigma:.4f} h = "
                f"{_iso(eta - delta)} .. {_iso(eta + delta)}",
                {"z": Z_P80, "sigma_h": round(sigma, 4)},
                round(2.0 * Z_P80 * sigma, 4),
                "h",
                "80% central interval",
            ),
            _step(
                4,
                "Confidence label",
                "HIGH if sigma < 1.5 h; MEDIUM if < 4.0 h; else LOW",
                f"sigma {sigma:.3f} h -> {label}",
                {"sigma_h": round(sigma, 4)},
                label,
                "-",
                "",
            ),
        ],
        "result": {
            "sigma_hours": round(sigma, 4),
            "band_width_hours": round(2.0 * Z_P80 * sigma, 4),
            "confidence_label": label,
        },
        "assumptions": [
            "Uncertainty is symmetric about the reported ETA.",
            "Band is the 80% central interval (+/- 1.28 sigma), not a 95% interval.",
            "Staleness is the age of the last position fix, in minutes.",
        ],
        "provenance": {
            "eta_source": obs.source,
            "generated_at_utc": _iso(_utc_now()),
        },
    }

    return EtaBand(
        call_id=obs.call_id,
        vessel_id=obs.vessel_id,
        horizon_hours=horizon,
        ais_staleness_minutes=obs.ais_staleness_minutes,
        sigma_hours=sigma,
        eta_p10_utc=eta - delta,
        eta_p50_utc=eta,
        eta_p90_utc=eta + delta,
        band_width_hours=2.0 * Z_P80 * sigma,
        confidence_label=label,
        source=obs.source,
        breakdown=breakdown,
    )


def _local_day_bounds_utc(
    window_start: datetime, window_end: datetime, offset_h: float
) -> List[Tuple[date, datetime, datetime]]:
    """
    Enumerate local (IST) days spanning the window, returning for each day the
    UTC interval CLIPPED to the window.

    The clipping is the important part: a window starting at 06:00 local gives
    its first day 18 available hours, not 24. Using a flat 24 h denominator for
    partial days is what produces spurious >100% occupancy cells.
    """
    ws = _ensure_utc(window_start)
    we = _ensure_utc(window_end)
    local_start = _to_local(ws, offset_h)
    local_end = _to_local(we, offset_h)

    out: List[Tuple[date, datetime, datetime]] = []
    d = local_start.date()
    while d <= local_end.date():
        day_lo_local = datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc)
        day_hi_local = day_lo_local + timedelta(days=1)
        lo = max(ws, _from_local(day_lo_local, offset_h))
        hi = min(we, _from_local(day_hi_local, offset_h))
        if hi > lo:
            out.append((d, lo, hi))
        d = d + timedelta(days=1)
    return out


def _record_interval(
    rec: BerthingRecord, window_end: datetime
) -> Tuple[Optional[datetime], Optional[datetime], bool, Optional[str]]:
    """
    Berth-occupancy interval for a record.

    Returns ``(start, end, was_open_ended, drop_reason)``. A missing ATD means
    the vessel is still alongside: the interval is clipped to the window end and
    flagged, never dropped.
    """
    start = rec.actual_atb_utc or rec.planned_atb_utc
    if start is None:
        return None, None, False, "no_berthing_time"
    end = rec.actual_atd_utc or rec.planned_atd_utc
    open_ended = False
    if end is None:
        end = _ensure_utc(window_end)
        open_ended = True
    if _ensure_utc(end) <= _ensure_utc(start):
        return None, None, False, "atd_before_atb"
    return _ensure_utc(start), _ensure_utc(end), open_ended, None


def occupancy_calendar(
    records: Sequence[BerthingRecord],
    berths: Sequence[BerthSpec],
    window_start_utc: datetime,
    window_end_utc: datetime,
    mode: str = "union",
    tz_offset_hours: float = PORT_TZ_OFFSET_HOURS,
) -> OccupancyCalendar:
    """
    Berth x local-day occupancy grid.

        occupancy_pct = sum(occupied berth-hours) / (n_berths * window_hours) * 100

    ``mode="union"`` (default) merges overlapping intervals per berth before
    summing, so no berth can exceed 100%. ``mode="sum"`` keeps the raw total.
    The difference is reported as ``double_booked`` — it is a data-quality
    signal, not something to hide.
    """
    if mode not in OCCUPANCY_MODES:
        raise ValueError(f"mode must be one of {OCCUPANCY_MODES}, got {mode!r}")

    ws = _ensure_utc(window_start_utc)
    we = _ensure_utc(window_end_utc)
    if we <= ws:
        raise ValueError("window_end_utc must be after window_start_utc")
    window_hours = _hours_between(ws, we)

    berth_ids = tuple(b.berth_id for b in berths)
    berth_set = set(berth_ids)

    # Bucket intervals by berth, clipped to the window.
    per_berth_intervals: Dict[str, List[Tuple[datetime, datetime, str]]] = {
        b: [] for b in berth_ids
    }
    dropped: List[Dict[str, str]] = []
    open_ended_clipped = 0
    unknown_berth = 0

    for rec in records:
        start, end, open_ended, reason = _record_interval(rec, we)
        if reason is not None:
            dropped.append({"call_id": rec.call_id, "berth_id": rec.berth_id, "reason": reason})
            continue
        if rec.berth_id not in berth_set:
            unknown_berth += 1
            dropped.append(
                {"call_id": rec.call_id, "berth_id": rec.berth_id, "reason": "unknown_berth"}
            )
            continue
        lo = max(start, ws)
        hi = min(end, we)
        if hi <= lo:
            continue          # entirely outside the window — not an error
        if open_ended:
            open_ended_clipped += 1
        per_berth_intervals[rec.berth_id].append((lo, hi, rec.call_id))

    days = _local_day_bounds_utc(ws, we, tz_offset_hours)

    cells: List[OccupancyCell] = []
    per_berth_hours: Dict[str, float] = {}
    raw_sum_hours = 0.0
    union_hours = 0.0

    for bid in berth_ids:
        raw = per_berth_intervals[bid]
        raw_total = sum(_hours_between(a, b) for a, b, _ in raw)
        merged = _merge_intervals([(a, b) for a, b, _ in raw])
        union_total = sum(_hours_between(a, b) for a, b in merged)
        raw_sum_hours += raw_total
        union_hours += union_total

        effective = merged if mode == "union" else [(a, b) for a, b, _ in raw]
        per_berth_hours[bid] = union_total if mode == "union" else raw_total

        for d, day_lo, day_hi in days:
            avail = _hours_between(day_lo, day_hi)
            occ = sum(_overlap_hours(a, b, day_lo, day_hi) for a, b in effective)
            occ = min(occ, avail) if mode == "union" else occ
            call_ids = tuple(
                sorted(
                    {
                        cid
                        for a, b, cid in raw
                        if _overlap_hours(a, b, day_lo, day_hi) > 0.0
                    }
                )
            )
            cells.append(
                OccupancyCell(
                    berth_id=bid,
                    local_date=d,
                    occupied_hours=occ,
                    available_hours=avail,
                    occupancy_pct=(occ / avail * 100.0) if avail > 0 else 0.0,
                    call_ids=call_ids,
                )
            )

    total_occupied = sum(per_berth_hours.values())
    total_berth_hours = len(berth_ids) * window_hours
    overall_pct = (total_occupied / total_berth_hours * 100.0) if total_berth_hours else 0.0

    per_berth_pct = {
        bid: (per_berth_hours[bid] / window_hours * 100.0) if window_hours else 0.0
        for bid in berth_ids
    }
    per_day_pct: Dict[str, float] = {}
    for d, day_lo, day_hi in days:
        day_cells = [c for c in cells if c.local_date == d]
        occ = sum(c.occupied_hours for c in day_cells)
        avail = sum(c.available_hours for c in day_cells)
        per_day_pct[d.isoformat()] = (occ / avail * 100.0) if avail else 0.0

    breakdown: Dict[str, Any] = {
        "model": "M4_OCCUPANCY_CALENDAR",
        "version": MODULE_VERSION,
        "formula": "occupancy_pct = sum(occupied berth-hours) / (n_berths * window_hours) * 100",
        "window": {
            "start_utc": _iso(ws),
            "end_utc": _iso(we),
            "hours": round(window_hours, 3),
            "tz_for_day_buckets": PORT_TZ_LABEL,
            "local_days": len(days),
        },
        "berths": {"count": len(berth_ids), "ids": list(berth_ids)},
        "steps": [
            _step(
                1,
                "Clip intervals to window",
                "overlap = max(0, min(end, w_end) - max(start, w_start))",
                f"{len(records)} records in, "
                f"{sum(len(v) for v in per_berth_intervals.values())} intervals retained",
                {"records_in": len(records), "dropped": len(dropped)},
                sum(len(v) for v in per_berth_intervals.values()),
                "intervals",
                f"{open_ended_clipped} open-ended stays clipped to window end",
            ),
            _step(
                2,
                "Merge per berth",
                "union = merge_intervals(per-berth intervals)",
                f"raw sum {raw_sum_hours:.2f} h -> union {union_hours:.2f} h "
                f"(double-booked {raw_sum_hours - union_hours:.2f} h)",
                {
                    "raw_sum_hours": round(raw_sum_hours, 3),
                    "union_hours": round(union_hours, 3),
                },
                round(union_hours, 3),
                "h",
                f"mode={mode}",
            ),
            _step(
                3,
                "Local-day bucketing",
                "day cell available_hours = clipped local day length inside the window",
                f"{len(days)} local days; available hours per day: "
                + ", ".join(f"{_hours_between(a, b):.2f}" for _, a, b in days[:5])
                + (" ..." if len(days) > 5 else ""),
                {"local_days": len(days), "tz_offset_hours": tz_offset_hours},
                len(days),
                "days",
                "partial days get a partial denominator, preventing >100% cells",
            ),
            _step(
                4,
                "Occupancy",
                "occupancy_pct = total_occupied / (n_berths * window_hours) * 100",
                f"{total_occupied:.2f} / ({len(berth_ids)} * {window_hours:.2f}) * 100 "
                f"= {overall_pct:.2f}%",
                {
                    "total_occupied_hours": round(total_occupied, 3),
                    "n_berths": len(berth_ids),
                    "window_hours": round(window_hours, 3),
                },
                round(overall_pct, 3),
                "%",
                "",
            ),
        ],
        "occupied_hours": {
            "union": round(union_hours, 3),
            "raw_sum": round(raw_sum_hours, 3),
            "double_booked": round(raw_sum_hours - union_hours, 3),
            "open_ended_clipped": open_ended_clipped,
        },
        "denominator_hours": round(total_berth_hours, 3),
        "occupancy_pct": round(overall_pct, 3),
        "mode": mode,
        "data_quality": {
            "records_in": len(records),
            "records_used": len(records) - len(dropped),
            "dropped_count": len(dropped),
            "unknown_berth_count": unknown_berth,
            "dropped": dropped[:25],
            "max_cell_pct": round(max((c.occupancy_pct for c in cells), default=0.0), 3),
        },
        "assumptions": [
            "Occupancy is measured from berthing (ATB) to departure (ATD).",
            "Day cells are bucketed in IST; the denominator is the clipped day length.",
            "mode='union' bounds a berth at 100%; mode='sum' exposes double booking.",
            "Open-ended stays (no ATD) are clipped to the window end, never dropped.",
        ],
        "provenance": {"generated_at_utc": _iso(_utc_now())},
    }

    return OccupancyCalendar(
        window_start_utc=ws,
        window_end_utc=we,
        window_hours=window_hours,
        berth_ids=berth_ids,
        local_dates=tuple(d for d, _, _ in days),
        cells=tuple(cells),
        per_berth_pct=per_berth_pct,
        per_day_pct=per_day_pct,
        total_occupied_hours=total_occupied,
        total_berth_hours=total_berth_hours,
        overall_occupancy_pct=overall_pct,
        mode=mode,
        breakdown=breakdown,
    )


def waiting_time_distribution(
    records: Sequence[BerthingRecord],
    berths: Optional[Sequence[BerthSpec]] = None,
    use_actuals: bool = True,
    max_plausible_hours: float = 240.0,
) -> WaitingTimeStats:
    """
    Waiting time from arrival to berthing, reported as p50 and p90.

        waiting_h = ATB - ATA        (actuals by default)

    Rows are dropped, with a reason, when either timestamp is missing, when ATB
    precedes ATA, or when the wait exceeds ``max_plausible_hours`` (a data-entry
    guard). Dropped counts are reported rather than silently reducing n.
    """
    terminal_by_berth = (
        {b.berth_id: b.terminal for b in berths} if berths else {}
    )
    definition = "actual_atb - actual_ata" if use_actuals else "planned_atb - planned_ata"

    waits: List[float] = []
    by_terminal_raw: Dict[str, List[float]] = {}
    dropped: List[Dict[str, str]] = []

    for rec in records:
        ata = rec.actual_ata_utc if use_actuals else rec.planned_ata_utc
        atb = rec.actual_atb_utc if use_actuals else rec.planned_atb_utc
        if ata is None or atb is None:
            dropped.append({"call_id": rec.call_id, "reason": "missing_ata_or_atb"})
            continue
        w = _hours_between(ata, atb)
        if w < 0.0:
            dropped.append({"call_id": rec.call_id, "reason": "atb_before_ata"})
            continue
        if w > max_plausible_hours:
            dropped.append({"call_id": rec.call_id, "reason": "wait_exceeds_plausible_limit"})
            continue
        waits.append(w)
        term = rec.terminal or terminal_by_berth.get(rec.berth_id, "UNKNOWN")
        by_terminal_raw.setdefault(term, []).append(w)

    by_terminal = {
        t: {
            "n": float(len(v)),
            "p50_hours": _percentile(v, 0.50),
            "p90_hours": _percentile(v, 0.90),
            "mean_hours": statistics.fmean(v) if v else float("nan"),
        }
        for t, v in sorted(by_terminal_raw.items())
    }

    p50 = _percentile(waits, 0.50)
    p90 = _percentile(waits, 0.90)
    p10 = _percentile(waits, 0.10)

    breakdown: Dict[str, Any] = {
        "model": "M4_WAITING_TIME",
        "version": MODULE_VERSION,
        "definition": definition,
        "percentile_method": "linear interpolation on the sorted sample (numpy 'linear' / R type 7)",
        "steps": [
            _step(
                1,
                "Compute waits",
                "waiting_h = ATB - ATA",
                f"{len(waits)} valid of {len(records)} records "
                f"({len(dropped)} dropped)",
                {"n_valid": len(waits), "n_dropped": len(dropped)},
                len(waits),
                "records",
                "",
            ),
            _step(
                2,
                "Percentiles",
                "p_q = interpolate(sorted(waits), q * (n - 1))",
                f"p10 {p10:.2f} h | p50 {p50:.2f} h | p90 {p90:.2f} h",
                {"p10": round(p10, 3), "p50": round(p50, 3), "p90": round(p90, 3)},
                round(p50, 3),
                "h",
                "distributions reported rather than a bare mean, per spec",
            ),
        ],
        "data_quality": {
            "records_in": len(records),
            "records_used": len(waits),
            "dropped_count": len(dropped),
            "dropped": dropped[:25],
        },
        "assumptions": [
            "Waiting is anchorage/roads time between arrival and going alongside.",
            f"Waits over {max_plausible_hours:.0f} h are treated as data-entry errors.",
        ],
        "provenance": {"generated_at_utc": _iso(_utc_now())},
    }

    return WaitingTimeStats(
        definition=definition,
        n=len(waits),
        p50_hours=p50,
        p90_hours=p90,
        p10_hours=p10,
        mean_hours=statistics.fmean(waits) if waits else float("nan"),
        max_hours=max(waits) if waits else float("nan"),
        by_terminal=by_terminal,
        n_dropped=len(dropped),
        drop_reasons=tuple(dropped[:25]),
        breakdown=breakdown,
    )


def plan_adherence(records: Sequence[BerthingRecord]) -> PlanAdherenceStats:
    """
    Planned vs actual delays, as p50/p90. Positive means later than planned.
    """
    arr: List[float] = []
    ber: List[float] = []
    dep: List[float] = []
    for rec in records:
        if rec.planned_ata_utc and rec.actual_ata_utc:
            arr.append(_hours_between(rec.planned_ata_utc, rec.actual_ata_utc))
        if rec.planned_atb_utc and rec.actual_atb_utc:
            ber.append(_hours_between(rec.planned_atb_utc, rec.actual_atb_utc))
        if rec.planned_atd_utc and rec.actual_atd_utc:
            dep.append(_hours_between(rec.planned_atd_utc, rec.actual_atd_utc))

    breakdown = {
        "model": "M4_PLAN_ADHERENCE",
        "version": MODULE_VERSION,
        "definition": "delay_h = actual - planned (positive = later than planned)",
        "steps": [
            _step(
                1,
                "Delay percentiles",
                "p50/p90 of (actual - planned) per milestone",
                f"arrival n={len(arr)} p50={_percentile(arr, 0.5):.2f} h; "
                f"berthing n={len(ber)} p50={_percentile(ber, 0.5):.2f} h; "
                f"departure n={len(dep)} p50={_percentile(dep, 0.5):.2f} h",
                {"n_arrival": len(arr), "n_berth": len(ber), "n_departure": len(dep)},
                round(_percentile(ber, 0.5), 3),
                "h",
                "berthing delay is the operationally actionable one",
            )
        ],
        "provenance": {"generated_at_utc": _iso(_utc_now())},
    }

    return PlanAdherenceStats(
        n=len(records),
        arrival_delay_p50_h=_percentile(arr, 0.50),
        arrival_delay_p90_h=_percentile(arr, 0.90),
        berth_delay_p50_h=_percentile(ber, 0.50),
        berth_delay_p90_h=_percentile(ber, 0.90),
        departure_delay_p50_h=_percentile(dep, 0.50),
        departure_delay_p90_h=_percentile(dep, 0.90),
        n_arrival=len(arr),
        n_berth=len(ber),
        n_departure=len(dep),
        breakdown=breakdown,
    )


def berth_utilisation_report(
    records: Sequence[BerthingRecord],
    berths: Sequence[BerthSpec],
    window_start_utc: datetime,
    window_end_utc: datetime,
    eta_observations: Sequence[EtaObservation] = (),
    mode: str = "union",
    data_source: str = "SYNTHETIC_BERTHING_LOG_v1",
) -> UtilisationReport:
    """Assemble the full M4 report for one reporting window."""
    cal = occupancy_calendar(records, berths, window_start_utc, window_end_utc, mode)
    wait = waiting_time_distribution(records, berths)
    adh = plan_adherence(records)
    bands = tuple(compute_eta_band(o) for o in eta_observations)

    busiest = max(cal.per_berth_pct.items(), key=lambda kv: kv[1]) if cal.per_berth_pct else ("-", 0.0)
    quietest = min(cal.per_berth_pct.items(), key=lambda kv: kv[1]) if cal.per_berth_pct else ("-", 0.0)

    rec = (
        f"Overall berth occupancy {cal.overall_occupancy_pct:.1f}% across "
        f"{len(cal.berth_ids)} berths over {cal.window_hours:.0f} h. "
        f"Busiest {busiest[0]} at {busiest[1]:.1f}%, quietest {quietest[0]} at "
        f"{quietest[1]:.1f}%. Waiting time p50 {wait.p50_hours:.1f} h / p90 "
        f"{wait.p90_hours:.1f} h over {wait.n} calls."
    )
    dbl = cal.breakdown["occupied_hours"]["double_booked"]
    if dbl > 0.01:
        rec += (
            f" DATA QUALITY: {dbl:.2f} berth-hours are double-booked in the source log "
            f"(reported in union mode; switch to mode='sum' to see the raw total)."
        )

    breakdown = {
        "model": "M4_UTILISATION_REPORT",
        "version": MODULE_VERSION,
        "window": {
            "start_utc": _iso(window_start_utc),
            "end_utc": _iso(window_end_utc),
            "hours": round(cal.window_hours, 3),
        },
        "components": {
            "occupancy": cal.breakdown,
            "waiting": wait.breakdown,
            "adherence": adh.breakdown,
        },
        "result": {
            "overall_occupancy_pct": round(cal.overall_occupancy_pct, 2),
            "waiting_p50_hours": round(wait.p50_hours, 3),
            "waiting_p90_hours": round(wait.p90_hours, 3),
            "berth_delay_p50_hours": round(adh.berth_delay_p50_h, 3),
            "recommendation": rec,
        },
        "provenance": {
            "data_source": data_source,
            "generated_at_utc": _iso(_utc_now()),
        },
    }

    return UtilisationReport(
        window_start_utc=_ensure_utc(window_start_utc),
        window_end_utc=_ensure_utc(window_end_utc),
        calendar=cal,
        waiting=wait,
        adherence=adh,
        eta_bands=bands,
        record_count=len(records),
        berth_count=len(berths),
        data_source=data_source,
        recommendation=rec,
        breakdown=breakdown,
    )


def load_records_with_fallback(
    start: datetime, end: datetime, csv_path: str = DSR_CSV_DEFAULT, seed: int = DEFAULT_SEED
) -> Tuple[List[BerthingRecord], List[BerthSpec], str]:
    """
    Prefer real extracted data; fall back to the synthetic generator.

    Real data is never a hard requirement — the module always runs.
    """
    dsr = DsrBerthStayLoader(csv_path)
    if dsr.available():
        try:
            recs = dsr.load_records(start, end)
            if recs:
                return recs, dsr.load_berths(), dsr.source_id
        except Exception:  # pragma: no cover - defensive, falls through
            pass
    synth = SyntheticBerthingLogLoader(seed=seed)
    return synth.load_records(start, end), synth.load_berths(), synth.source_id


MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "spec_row": "WS2_AI_ML_Tools.md row 4 — ETA/ETD -> berth utilisation",
    "model_type": "deterministic analytics (measurement, not prediction)",
    "constants": {
        "ETA_SIGMA_PER_HORIZON_HOUR": ETA_SIGMA_PER_HORIZON_HOUR,
        "ETA_SIGMA_PER_STALENESS_MINUTE": ETA_SIGMA_PER_STALENESS_MINUTE,
        "Z_P80": Z_P80,
        "CONFIDENCE_BANDS": _bands_json(),
        "PORT_TZ_OFFSET_HOURS": PORT_TZ_OFFSET_HOURS,
        "OCCUPANCY_MODES": list(OCCUPANCY_MODES),
    },
    "berth_count": len(DEFAULT_BERTHS),
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

    class EtaBandRequest(BaseModel):
        """One ETA observation to band."""

        call_id: str = Field("C-0001", max_length=40)
        vessel_id: str = Field("V-0001", max_length=40)
        now_utc: Optional[datetime] = None
        forecast_eta_utc: datetime
        ais_staleness_minutes: float = Field(0.0, ge=0, le=2880)
        source: Literal["AIS", "AGENT", "PCS"] = "AIS"

        def to_obs(self) -> EtaObservation:
            now = self.now_utc or _utc_now()
            if now.tzinfo is None:
                now = now.replace(tzinfo=timezone.utc)
            eta = self.forecast_eta_utc
            if eta.tzinfo is None:
                eta = eta.replace(tzinfo=timezone.utc)
            return EtaObservation(
                call_id=self.call_id,
                vessel_id=self.vessel_id,
                now_utc=now,
                forecast_eta_utc=eta,
                ais_staleness_minutes=self.ais_staleness_minutes,
                source=self.source,
            )

    class BerthModel(BaseModel):
        berth_id: str
        terminal: str = ""
        length_m: float = Field(350.0, gt=0, le=600)
        max_draft_m: float = Field(15.0, gt=0, le=25)

    class BerthingRecordModel(BaseModel):
        call_id: str
        vessel_id: str = ""
        vessel_name: str = ""
        berth_id: str
        terminal: str = ""
        planned_ata_utc: Optional[datetime] = None
        planned_atb_utc: Optional[datetime] = None
        planned_atd_utc: Optional[datetime] = None
        actual_ata_utc: Optional[datetime] = None
        actual_atb_utc: Optional[datetime] = None
        actual_atd_utc: Optional[datetime] = None

        def to_record(self) -> BerthingRecord:
            def _tz(d: Optional[datetime]) -> Optional[datetime]:
                if d is None:
                    return None
                return d if d.tzinfo else d.replace(tzinfo=timezone.utc)

            return BerthingRecord(
                call_id=self.call_id,
                vessel_id=self.vessel_id,
                vessel_name=self.vessel_name,
                berth_id=self.berth_id,
                terminal=self.terminal,
                planned_ata_utc=_tz(self.planned_ata_utc),
                planned_atb_utc=_tz(self.planned_atb_utc),
                planned_atd_utc=_tz(self.planned_atd_utc),
                actual_ata_utc=_tz(self.actual_ata_utc),
                actual_atb_utc=_tz(self.actual_atb_utc),
                actual_atd_utc=_tz(self.actual_atd_utc),
            )

    class OccupancyRequest(BaseModel):
        records: List[BerthingRecordModel]
        berths: Optional[List[BerthModel]] = None
        window_start_utc: datetime
        window_end_utc: datetime
        mode: Literal["union", "sum"] = "union"
        include_cells: bool = True

    class WaitingRequest(BaseModel):
        records: List[BerthingRecordModel]
        use_actuals: bool = True

    def build_router() -> "APIRouter":
        """Construct the UC1-M4 router. Mounted by ``api.py``."""
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC1-M4 ETA & Berth Utilisation"])

        @router.post("/eta-band", summary="ETA P10/P50/P90 band from horizon and AIS staleness")
        def eta_band(req: EtaBandRequest) -> Dict[str, Any]:
            return compute_eta_band(req.to_obs()).as_dict()

        @router.post("/eta-band/batch", summary="Band many ETAs at once")
        def eta_band_batch(reqs: List[EtaBandRequest]) -> List[Dict[str, Any]]:
            if len(reqs) > 500:
                raise HTTPException(413, "batch limited to 500 observations")
            return [compute_eta_band(r.to_obs()).as_dict() for r in reqs]

        @router.post("/occupancy", summary="Berth x day occupancy calendar")
        def occupancy(req: OccupancyRequest) -> Dict[str, Any]:
            berths = (
                [BerthSpec(b.berth_id, b.terminal, b.length_m, b.max_draft_m) for b in req.berths]
                if req.berths
                else default_berths()
            )
            ws = req.window_start_utc
            we = req.window_end_utc
            ws = ws if ws.tzinfo else ws.replace(tzinfo=timezone.utc)
            we = we if we.tzinfo else we.replace(tzinfo=timezone.utc)
            if we <= ws:
                raise HTTPException(422, "window_end_utc must be after window_start_utc")
            cal = occupancy_calendar(
                [r.to_record() for r in req.records], berths, ws, we, req.mode
            )
            return cal.as_dict(include_cells=req.include_cells)

        @router.post("/waiting-distribution", summary="Waiting-time p50/p90 by terminal")
        def waiting(req: WaitingRequest) -> Dict[str, Any]:
            return waiting_time_distribution(
                [r.to_record() for r in req.records], default_berths(), req.use_actuals
            ).as_dict()

        @router.get("/demo-report", summary="Full utilisation report on demo data")
        def demo_report(
            days: int = Query(7, ge=1, le=60),
            mode: Literal["union", "sum"] = "union",
            include_cells: bool = False,
        ) -> Dict[str, Any]:
            start = datetime(2026, 8, 1, tzinfo=timezone.utc)
            end = start + timedelta(days=days)
            records, berths, src = load_records_with_fallback(start, end)
            obs = _demo_eta_observations(start)
            return berth_utilisation_report(
                records, berths, start, end, obs, mode, src
            ).as_dict(include_cells=include_cells)

        @router.get("/constants", summary="Versioned constants (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {"module_version": MODULE_VERSION, "constants": MODULE_INFO["constants"]}

        @router.get("/demo", summary="Canonical ETA sigma sensitivity grid")
        def demo() -> Dict[str, Any]:
            grid = []
            for horizon in (2.0, 6.0, 12.0, 24.0):
                for stale in (0.0, 15.0, 60.0, 180.0):
                    s = eta_sigma_hours(horizon, stale)
                    grid.append({
                        "horizon_hours": horizon,
                        "staleness_minutes": stale,
                        "sigma_hours": round(s, 4),
                        "band_width_hours": round(2 * Z_P80 * s, 4),
                        "confidence": confidence_label(s),
                    })
            return {"formula": "sigma = 0.06*horizon_h + 0.05*staleness_min", "grid": grid}

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


def _demo_eta_observations(start: datetime) -> List[EtaObservation]:
    """A small spread of ETA observations for the demo report."""
    now = start
    return [
        EtaObservation("C-E01", "V-E01", now, now + timedelta(hours=2), 0.0, "AIS", "FRESH FIX"),
        EtaObservation("C-E02", "V-E02", now, now + timedelta(hours=2), 180.0, "AIS", "STALE FIX"),
        EtaObservation("C-E03", "V-E03", now, now + timedelta(hours=24), 0.0, "AIS", "LONG RANGE"),
        EtaObservation("C-E04", "V-E04", now, now + timedelta(hours=48), 60.0, "AGENT", "AGENT ETA"),
    ]


def _self_test() -> List[Tuple[str, bool, str]]:
    """Return ``[(check_name, passed, detail), ...]``."""
    checks: List[Tuple[str, bool, str]] = []

    # --- ETA band ---------------------------------------------------------
    s = eta_sigma_hours(24.0, 0.0)
    checks.append(
        ("eta_sigma_horizon_term", abs(s - 1.44) < 1e-12, f"24 h horizon, fresh fix -> {s:.4f} h")
    )
    s2 = eta_sigma_hours(0.0, 60.0)
    checks.append(
        ("eta_sigma_staleness_term", abs(s2 - 3.0) < 1e-12, f"0 h horizon, 60 min stale -> {s2:.4f} h")
    )
    s3 = eta_sigma_hours(2.0, 180.0)
    checks.append(
        (
            "eta_staleness_dominates_short_range",
            s3 > eta_sigma_hours(24.0, 0.0),
            f"2 h horizon + 180 min stale = {s3:.2f} h > 24 h horizon fresh = 1.44 h",
        )
    )
    now = datetime(2026, 8, 1, tzinfo=timezone.utc)
    band = compute_eta_band(EtaObservation("C1", "V1", now, now + timedelta(hours=12), 30.0))
    expected_sigma = 0.06 * 12.0 + 0.05 * 30.0
    checks.append(
        (
            "eta_band_symmetry",
            abs(band.sigma_hours - expected_sigma) < 1e-12
            and abs(
                _hours_between(band.eta_p10_utc, band.eta_p50_utc)
                - _hours_between(band.eta_p50_utc, band.eta_p90_utc)
            ) < 1e-9,
            f"sigma {band.sigma_hours:.3f} h, band {band.band_width_hours:.3f} h, "
            f"{band.confidence_label}",
        )
    )
    # ETA already in the past must clamp the horizon, not go negative.
    past = compute_eta_band(EtaObservation("C2", "V2", now, now - timedelta(hours=5), 0.0))
    checks.append(
        ("eta_past_horizon_clamped", past.horizon_hours == 0.0 and past.sigma_hours == 0.0,
         f"ETA 5 h in the past -> horizon {past.horizon_hours:.1f} h, sigma {past.sigma_hours:.1f} h")
    )

    # --- Interval mathematics --------------------------------------------
    a0 = datetime(2026, 8, 1, 0, tzinfo=timezone.utc)
    checks.append(
        (
            "overlap_disjoint_is_zero",
            _overlap_hours(a0, a0 + timedelta(hours=1), a0 + timedelta(hours=2),
                           a0 + timedelta(hours=3)) == 0.0,
            "disjoint intervals -> 0.0 h",
        )
    )
    checks.append(
        (
            "overlap_partial",
            abs(_overlap_hours(a0, a0 + timedelta(hours=3), a0 + timedelta(hours=2),
                               a0 + timedelta(hours=5)) - 1.0) < 1e-12,
            "[0,3) vs [2,5) -> 1.0 h",
        )
    )
    merged = _merge_intervals([
        (a0, a0 + timedelta(hours=2)),
        (a0 + timedelta(hours=1), a0 + timedelta(hours=3)),
        (a0 + timedelta(hours=5), a0 + timedelta(hours=6)),
    ])
    checks.append(
        (
            "merge_intervals",
            len(merged) == 2 and _hours_between(merged[0][0], merged[0][1]) == 3.0,
            f"3 intervals -> {len(merged)} merged, first spans "
            f"{_hours_between(merged[0][0], merged[0][1]):.1f} h",
        )
    )

    # --- Occupancy: the three dirty-data cases ---------------------------
    berths = [BerthSpec("B1", "T1", 350.0, 15.0), BerthSpec("B2", "T1", 350.0, 15.0)]
    w0 = datetime(2026, 8, 1, 6, tzinfo=timezone.utc)      # 06:00 UTC = 11:30 IST
    w1 = w0 + timedelta(days=3)

    # A 40 h stay crossing local midnight, plus a deliberate double-booking.
    stay_start = datetime(2026, 8, 1, 8, tzinfo=timezone.utc)
    hand_records = [
        BerthingRecord("H1", "V1", "B1", "T1", actual_ata_utc=stay_start - timedelta(hours=6),
                       actual_atb_utc=stay_start,
                       actual_atd_utc=stay_start + timedelta(hours=40)),
        BerthingRecord("H2", "V2", "B1", "T1", actual_ata_utc=stay_start,
                       actual_atb_utc=stay_start + timedelta(hours=10),
                       actual_atd_utc=stay_start + timedelta(hours=20)),   # fully inside H1
        BerthingRecord("H3", "V3", "B2", "T1", actual_ata_utc=w1 - timedelta(hours=30),
                       actual_atb_utc=w1 - timedelta(hours=24),
                       actual_atd_utc=None),                                # open ended
        BerthingRecord("H4", "V4", "B2", "T1", actual_ata_utc=w0,
                       actual_atb_utc=w0 + timedelta(hours=5),
                       actual_atd_utc=w0 + timedelta(hours=2)),             # corrupt
    ]

    cal_union = occupancy_calendar(hand_records, berths, w0, w1, mode="union")
    cal_sum = occupancy_calendar(hand_records, berths, w0, w1, mode="sum")

    checks.append(
        (
            "union_less_than_raw_sum",
            cal_union.total_occupied_hours < cal_sum.total_occupied_hours,
            f"union {cal_union.total_occupied_hours:.2f} h < sum "
            f"{cal_sum.total_occupied_hours:.2f} h "
            f"(double-booked {cal_union.breakdown['occupied_hours']['double_booked']:.2f} h)",
        )
    )
    checks.append(
        (
            "double_booking_surfaced",
            abs(cal_union.breakdown["occupied_hours"]["double_booked"] - 10.0) < 1e-9,
            f"H2 sits entirely inside H1 -> {cal_union.breakdown['occupied_hours']['double_booked']:.2f} h",
        )
    )
    b1_cells = [c for c in cal_union.cells if c.berth_id == "B1" and c.occupied_hours > 0]
    checks.append(
        (
            "cross_midnight_writes_three_cells",
            len(b1_cells) == 3,
            f"40 h stay from 08:00Z (13:30 IST) writes {len(b1_cells)} local day cells",
        )
    )
    checks.append(
        (
            "no_cell_exceeds_100pct",
            all(c.occupancy_pct <= 100.0 + 1e-9 for c in cal_union.cells),
            f"max cell {max(c.occupancy_pct for c in cal_union.cells):.2f}% "
            f"(union mode bounds at 100%)",
        )
    )
    checks.append(
        (
            "partial_day_denominator_clipped",
            any(abs(c.available_hours - 24.0) > 1e-9 for c in cal_union.cells)
            and all(c.available_hours <= 24.0 + 1e-9 for c in cal_union.cells),
            "first/last local days get a partial denominator, not a flat 24 h",
        )
    )
    checks.append(
        (
            "open_ended_clipped_counted",
            cal_union.breakdown["occupied_hours"]["open_ended_clipped"] == 1,
            f"{cal_union.breakdown['occupied_hours']['open_ended_clipped']} open-ended stay clipped",
        )
    )
    checks.append(
        (
            "corrupt_record_dropped_with_reason",
            any(d["reason"] == "atd_before_atb" for d in cal_union.breakdown["data_quality"]["dropped"]),
            f"{cal_union.breakdown['data_quality']['dropped_count']} dropped, reasons recorded",
        )
    )
    # Per-berth available hours must sum to exactly the window length.
    per_berth_avail = sum(
        c.available_hours for c in cal_union.cells if c.berth_id == "B1"
    )
    checks.append(
        (
            "day_cells_tile_the_window",
            abs(per_berth_avail - cal_union.window_hours) < 1e-9,
            f"B1 day cells total {per_berth_avail:.2f} h == window {cal_union.window_hours:.2f} h",
        )
    )

    # --- Percentiles ------------------------------------------------------
    checks.append(
        (
            "percentile_interpolation",
            abs(_percentile([1.0, 2.0, 3.0, 4.0], 0.5) - 2.5) < 1e-12
            and abs(_percentile([1.0, 2.0, 3.0, 4.0], 0.9) - 3.7) < 1e-12,
            "p50([1,2,3,4]) = 2.5, p90 = 3.7 (linear interpolation)",
        )
    )

    # --- End-to-end on synthetic data ------------------------------------
    start = datetime(2026, 8, 1, tzinfo=timezone.utc)
    end = start + timedelta(days=7)
    loader = SyntheticBerthingLogLoader(seed=DEFAULT_SEED)
    recs = loader.load_records(start, end)
    rep = berth_utilisation_report(
        recs, loader.load_berths(), start, end, _demo_eta_observations(start)
    )
    checks.append(
        (
            "report_occupancy_in_range",
            0.0 <= rep.calendar.overall_occupancy_pct <= 100.0,
            f"{rep.calendar.overall_occupancy_pct:.2f}% over {len(rep.calendar.berth_ids)} berths",
        )
    )
    checks.append(
        (
            "waiting_p90_ge_p50",
            rep.waiting.p90_hours >= rep.waiting.p50_hours >= rep.waiting.p10_hours,
            f"p10 {rep.waiting.p10_hours:.2f} <= p50 {rep.waiting.p50_hours:.2f} "
            f"<= p90 {rep.waiting.p90_hours:.2f} h (n={rep.waiting.n})",
        )
    )
    checks.append(
        (
            "synthetic_calibration_waiting",
            8.0 <= rep.waiting.p50_hours <= 22.0,
            f"synthetic waiting p50 {rep.waiting.p50_hours:.2f} h "
            f"(anchor: JNPA reference implies ~14 h)",
        )
    )
    checks.append(
        (
            "determinism",
            SyntheticBerthingLogLoader(seed=DEFAULT_SEED).load_records(start, end)[5].call_id
            == recs[5].call_id,
            "seeded generator reproduces the same log",
        )
    )

    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="UC1-M4 ETA uncertainty & berth utilisation — demo and self-test."
    )
    parser.add_argument("--days", type=int, default=7, help="Reporting window in days.")
    parser.add_argument("--mode", choices=list(OCCUPANCY_MODES), default="union")
    parser.add_argument("--csv", default=DSR_CSV_DEFAULT, help="Real DSR CSV, if extracted.")
    parser.add_argument("--json", action="store_true", help="Dump the report as JSON.")
    parser.add_argument("--quiet", action="store_true", help="Print only the self-test summary.")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args(argv)

    if not args.quiet:
        print("=" * 78)
        print(f"{MODULE_ID} — {MODULE_NAME}   ({MODULE_VERSION})")
        print("JNPA UC-I Vessel Traffic Management | WS2 row 4 | deterministic analytics")
        print("=" * 78)

    start = datetime(2026, 8, 1, tzinfo=timezone.utc)
    end = start + timedelta(days=args.days)
    records, berths, src = load_records_with_fallback(start, end, args.csv, args.seed)
    report = berth_utilisation_report(
        records, berths, start, end, _demo_eta_observations(start), args.mode, src
    )

    if args.json:
        print(json.dumps(report.as_dict(include_cells=False), indent=2))
    elif not args.quiet:
        print(f"\nDATA SOURCE  {src}   ({len(records)} records, {len(berths)} berths)")
        if src.startswith("SYNTHETIC"):
            print(
                f"             real data hand-off: run 'python dsr_extract.py' to produce "
                f"{args.csv}, then re-run this module."
            )

        print("\n1. ETA SIGMA SENSITIVITY  sigma = 0.06*horizon_h + 0.05*staleness_min")
        rows = []
        for horizon in (2.0, 6.0, 12.0, 24.0):
            row = [f"{horizon:.0f} h"]
            for stale in (0.0, 15.0, 60.0, 180.0):
                sg = eta_sigma_hours(horizon, stale)
                row.append(f"{sg:.2f} ({confidence_label(sg)[0]})")
            rows.append(row)
        print(_fmt_table(
            ["horizon", "fresh", "15 min", "60 min", "180 min"], rows, indent="   "
        ))
        print(
            "   Note: a 2 h horizon on a 180 min stale fix (9.12 h) is far more uncertain\n"
            "   than a 24 h horizon on a fresh fix (1.44 h) — staleness dominates at short range."
        )

        cal = report.calendar
        print(
            f"\n2. OCCUPANCY CALENDAR  {_iso(cal.window_start_utc)} .. {_iso(cal.window_end_utc)}"
            f"  ({cal.window_hours:.0f} h, {len(cal.local_dates)} local days, mode={cal.mode})"
        )
        hdr = ["berth"] + [d.strftime("%d%b") for d in cal.local_dates] + ["berth %"]
        rows = []
        for bid in cal.berth_ids:
            row: List[Any] = [bid]
            for d in cal.local_dates:
                c = cal.cell(bid, d)
                row.append(f"{c.occupancy_pct:5.1f}" if c else "    -")
            row.append(f"{cal.per_berth_pct[bid]:6.1f}")
            rows.append(row)
        day_row: List[Any] = ["ALL"]
        for d in cal.local_dates:
            day_row.append(f"{cal.per_day_pct[d.isoformat()]:5.1f}")
        day_row.append(f"{cal.overall_occupancy_pct:6.1f}")
        rows.append(day_row)
        print(_fmt_table(hdr, rows, indent="   "))

        oh = cal.breakdown["occupied_hours"]
        print(
            f"   occupied union {oh['union']:.2f} h | raw sum {oh['raw_sum']:.2f} h | "
            f"double-booked {oh['double_booked']:.2f} h | open-ended clipped "
            f"{oh['open_ended_clipped']}"
        )
        dq = cal.breakdown["data_quality"]
        print(
            f"   data quality: {dq['records_used']}/{dq['records_in']} used, "
            f"{dq['dropped_count']} dropped, max cell {dq['max_cell_pct']:.1f}%"
        )

        w = report.waiting
        print(f"\n3. WAITING TIME DISTRIBUTION  ({w.definition})")
        rows = [["ALL", w.n, f"{w.p10_hours:.2f}", f"{w.p50_hours:.2f}",
                 f"{w.p90_hours:.2f}", f"{w.mean_hours:.2f}", f"{w.max_hours:.2f}"]]
        for t, v in w.by_terminal.items():
            rows.append([t, int(v["n"]), "-", f"{v['p50_hours']:.2f}",
                         f"{v['p90_hours']:.2f}", f"{v['mean_hours']:.2f}", "-"])
        print(_fmt_table(
            ["terminal", "n", "p10", "p50", "p90", "mean", "max"], rows, indent="   "
        ))
        print(f"   {w.n_dropped} records dropped: "
              + ", ".join(sorted({d['reason'] for d in w.drop_reasons})) if w.n_dropped
              else "   no records dropped")

        a = report.adherence
        print("\n4. PLAN ADHERENCE  (actual - planned; positive = later than planned)")
        print(_fmt_table(
            ["milestone", "n", "p50 h", "p90 h"],
            [
                ["arrival", a.n_arrival, f"{a.arrival_delay_p50_h:+.2f}", f"{a.arrival_delay_p90_h:+.2f}"],
                ["berthing", a.n_berth, f"{a.berth_delay_p50_h:+.2f}", f"{a.berth_delay_p90_h:+.2f}"],
                ["departure", a.n_departure, f"{a.departure_delay_p50_h:+.2f}", f"{a.departure_delay_p90_h:+.2f}"],
            ],
            indent="   ",
        ))

        print("\n5. ETA BANDS")
        rows = []
        for b in report.eta_bands:
            rows.append([
                b.call_id,
                f"{b.horizon_hours:.1f}",
                f"{b.ais_staleness_minutes:.0f}",
                f"{b.sigma_hours:.2f}",
                b.eta_p10_utc.strftime("%d %b %H:%M"),
                b.eta_p50_utc.strftime("%d %b %H:%M"),
                b.eta_p90_utc.strftime("%d %b %H:%M"),
                f"{b.band_width_hours:.2f}",
                b.confidence_label,
            ])
        print(_fmt_table(
            ["call", "horiz h", "stale m", "sigma", "P10", "P50", "P90", "width", "confidence"],
            rows, indent="   ",
        ))

        print(f"\nRECOMMEND  {report.recommendation}")

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
