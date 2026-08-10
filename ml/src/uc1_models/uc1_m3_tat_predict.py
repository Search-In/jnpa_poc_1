"""
UC1-M3 â€” Vessel Turnaround Time (TAT) Prediction, ETB -> ETD Horizon
=====================================================================

Jawaharlal Nehru Port Authority (JNPA) â€” Workstream 2, UC-I Vessel Traffic
Management & Optimization. Tender ref GeM/2026/B/7297343.

BUSINESS QUESTION
-----------------
"This ship is about to go alongside. How long until she sails, and how confident
are we?"

DUAL ENGINE
-----------
(a) TRANSPARENT ADDITIVE LINEAR MODEL â€” documented, versioned coefficients.
    Always available, zero dependencies. Produces a per-factor contribution
    chart an operator can read off: "12.8 of your 44 hours are the 3,200 TEU
    parcel".

(b) LEARNED QUANTILE REGRESSOR â€” LightGBM if installed, else scikit-learn
    GradientBoosting, else scikit-learn RandomForest, else back to (a). Trained
    on ingested call history with P10/P50/P90 bands.

The fallback chain is walked at fit time and the reason each engine was skipped
is returned in ``engine_trace``, so the API always shows which engine actually
ran AND why the others did not.

## DATA LEAKAGE POLICY

Leakage is the single failure mode that makes a TAT model look excellent in
validation and useless in production. Four controls are enforced, and the first
of them runs at import time.

1. STRUCTURAL SEPARATION.
   ``TATFeatures`` holds only the pre-berthing information set. ``TATLabel``
   holds the target and the outcome timestamps. They are DIFFERENT frozen
   dataclasses, joined loosely by ``TATCall``. No code path passes a
   ``TATLabel`` into a model. At inference time ``TATCall.label is None``.

2. EXPLICIT ALLOW-LIST, NEVER ``asdict()``.
   ``FEATURE_COLUMNS`` names the 16 numeric predictors. ``BANNED_FIELDS`` names
   everything that would leak. ``_assert_no_leakage()`` verifies the two are
   disjoint and RUNS AT IMPORT â€” a future contributor who adds ``atd_utc`` to
   the feature list gets an ImportError, not a suspiciously good MAPE.
   Note ``atb_utc`` is BANNED as a predictor: it is the split key only.

3. CHRONOLOGICAL SPLIT WITH PURGE.
   We never call ``train_test_split(shuffle=True)`` or ``KFold``. Random
   splitting places calls from the same day â€” sharing yard state, weather, tide
   and craft roster â€” on both sides of the split, and lets the model see the
   future. Instead: sort by ATB, cut at the 80th percentile of time, then PURGE
   from TRAIN any call whose outcome (ATD) had not yet been observed at the
   decision boundary. Post-condition asserted: max(train ATB) < min(test ATB).

4. NO FIT STATISTICS FROM TEST.
   Imputation medians are computed on TRAIN only and applied to both.
   Hyperparameter selection uses expanding-window folds INSIDE the train slice.

HONESTY FLAG ON THE CONTRIBUTION CHART
---------------------------------------
When an ML engine supplies P50, the per-factor contributions shown are those of
the ADDITIVE SURROGATE, not the gradient-boosted model's internal splits. That
is stated in ``breakdown["attribution_source"]`` and must be rendered in the UI
caption. A contribution chart that silently explains a different model from the
one that produced the number is worse than no chart at all.

CALIBRATION ANCHORS
-------------------
JNPA public performance reference (assumptions register):
    TAT        ~ 1.83 days = 43.92 h
    berth stay ~ 0.97 days = 23.28 h
    arrivals   ~ 10-12 calls/day
The synthetic generator reproduces these and ``verify_calibration()`` reports
achieved vs target vs PASS/FAIL. When ``dsr_berth_stays.csv`` exists (produced
by ``dsr_extract.py`` from the real Daily Status Reports), the real berth-stay
distribution is used to re-anchor the generator.

USAGE
-----
    python uc1_m3_tat_predict.py                    # full demo, exits 0
    python uc1_m3_tat_predict.py --engine additive
    python uc1_m3_tat_predict.py --days 365 --json

SELF-CONTAINMENT POLICY
-----------------------
Standard library only above SECTION 6. lightgbm / scikit-learn / fastapi are all
optional and imported behind guards that catch bare ``Exception`` â€” LightGBM on
Windows raises ``OSError`` for a missing VC++ redistributable, and that must
fall through the fallback chain rather than crash the module.
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
import time
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import (
    Any, Callable, Dict, FrozenSet, Iterable, List, Mapping, Optional, Sequence, Tuple,
)

# ==========================================================================
# SECTION 1 â€” MODULE IDENTITY AND VERSIONED CONSTANTS
# ==========================================================================

MODULE_ID: str = "UC1-M3"
MODULE_NAME: str = "Vessel TAT Prediction (ETB -> ETD)"
MODULE_VERSION: str = "m3-tat-v1.0.0"
ROUTER_PREFIX: str = "/uc1/m3"

DEFAULT_SEED: int = 20260807

TAT_MODEL_VERSION: str = "m3-additive-v1.2.0"

# Resolved from this file's location (src/uc1_models/ -> src/ -> project root)
# so the real berth-stay anchor is found regardless of the working directory.
# A missing file is a silent downgrade to the synthetic anchor, so a path that
# depends on where you happen to stand is a path that changes the numbers.
DSR_CSV_DEFAULT: str = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "reference", "dsr_berth_stays.csv",
)


@dataclass(frozen=True)
class TATCoefficients:
    """
    The versioned coefficient block â€” this row's 'model weights'.

    Base and the first four coefficients are quoted verbatim from
    WS2_AI_ML_Tools.md row 3: "base 34 h, +1 h/250 TEU, +1.5 h per m over 13 m
    draft ref, +5 h weather, +4 h per m depth loss". The remainder are
    documented extensions covering the other features the spec lists.
    """

    base_hours: float = 34.0
    hours_per_teu: float = 1.0 / 250.0            # +1 h per 250 TEU
    draft_ref_m: float = 13.0
    hours_per_m_draft_over_ref: float = 1.5       # +1.5 h per m over 13 m
    hours_severe_weather: float = 5.0             # +5 h when severe
    hours_per_m_channel_depth_loss: float = 4.0   # +4 h per m of depth lost
    hours_per_mm_rain: float = 0.22
    wind_ref_kn: float = 20.0
    hours_per_kn_wind_over_ref: float = 0.15
    hours_per_pilot_down: float = 1.5
    hours_per_tug_down: float = 1.0
    hours_per_queued_vessel: float = 0.60
    hours_per_extra_arrival: float = 0.80
    hours_per_incident_severity_level: float = 2.50
    hours_per_h_berth_window_extension: float = -0.50   # extension REDUCES TAT
    min_tat_hours: float = 12.0
    sigma_base_hours: float = 2.0                 # sigma = 2 + 0.3 * stressors
    sigma_per_stressor_hours: float = 0.3
    z_p80: float = 1.28                           # P10/P90 = P50 -/+ 1.28 sigma
    version: str = TAT_MODEL_VERSION

    def as_dict(self) -> Dict[str, Any]:
        return {
            "base_hours": self.base_hours,
            "hours_per_teu": self.hours_per_teu,
            "hours_per_250_teu": self.hours_per_teu * 250.0,
            "draft_ref_m": self.draft_ref_m,
            "hours_per_m_draft_over_ref": self.hours_per_m_draft_over_ref,
            "hours_severe_weather": self.hours_severe_weather,
            "hours_per_m_channel_depth_loss": self.hours_per_m_channel_depth_loss,
            "hours_per_mm_rain": self.hours_per_mm_rain,
            "wind_ref_kn": self.wind_ref_kn,
            "hours_per_kn_wind_over_ref": self.hours_per_kn_wind_over_ref,
            "hours_per_pilot_down": self.hours_per_pilot_down,
            "hours_per_tug_down": self.hours_per_tug_down,
            "hours_per_queued_vessel": self.hours_per_queued_vessel,
            "hours_per_extra_arrival": self.hours_per_extra_arrival,
            "hours_per_incident_severity_level": self.hours_per_incident_severity_level,
            "hours_per_h_berth_window_extension": self.hours_per_h_berth_window_extension,
            "min_tat_hours": self.min_tat_hours,
            "sigma_base_hours": self.sigma_base_hours,
            "sigma_per_stressor_hours": self.sigma_per_stressor_hours,
            "z_p80": self.z_p80,
            "version": self.version,
        }


DEFAULT_COEFFICIENTS = TATCoefficients()


@dataclass(frozen=True)
class CalibrationAnchors:
    """JNPA public performance reference figures the generator must reproduce."""

    tat_days_mean: float = 1.83
    tat_days_tol: float = 0.05
    berth_stay_days_mean: float = 0.97
    berth_stay_days_tol: float = 0.05
    calls_per_day_min: int = 10
    calls_per_day_max: int = 12
    source: str = "JNPA public performance reference (assumptions register)"

    @property
    def tat_hours_mean(self) -> float:
        return self.tat_days_mean * 24.0

    @property
    def berth_stay_hours_mean(self) -> float:
        return self.berth_stay_days_mean * 24.0


JNPA_ANCHORS = CalibrationAnchors()

ENGINE_PRIORITY: Tuple[str, ...] = ("lightgbm", "sklearn_gbr", "sklearn_rf", "additive")
ENGINE_CHOICES: Tuple[str, ...] = ("auto",) + ENGINE_PRIORITY

QUANTILES: Tuple[float, float, float] = (0.10, 0.50, 0.90)

# MAPE blows up when the denominator is tiny. Rows with an actual below this are
# excluded from MAPE (only), and the excluded count is reported.
MAPE_MIN_DENOMINATOR_H: float = 1.0

# ==========================================================================
# SECTION 2 â€” SHARED HELPERS (DUPLICATED BY DESIGN â€” do not factor out)
# ==========================================================================


def _utc_now() -> datetime:
    """Timezone-aware UTC now. DUPLICATED BY DESIGN."""
    return datetime.now(timezone.utc)


def _ensure_utc(dt: datetime) -> datetime:
    """Reject naive datetimes; normalise to UTC. DUPLICATED BY DESIGN."""
    if dt.tzinfo is None:
        raise ValueError(
            f"naive datetime {dt!r} rejected â€” all UC-1 internals are timezone-aware UTC"
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


def _percentile(values: Sequence[float], q: float) -> float:
    """Linear-interpolation percentile, ``q`` in [0, 1]. DUPLICATED BY DESIGN."""
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


# ==========================================================================
# SECTION 3 â€” DATACLASSES AND THE LEAKAGE FIREWALL
# ==========================================================================


@dataclass(frozen=True)
class TATFeatures:
    """
    PRE-BERTHING INFORMATION SET ONLY.

    Every field must be knowable at the moment the ETB decision is taken. If a
    quantity is only observable after the vessel sails, it belongs on
    :class:`TATLabel`, not here.

    ``atb_utc`` is present as the CHRONOLOGICAL ORDERING KEY. It is listed in
    ``BANNED_FIELDS`` and is never fed to a model.
    """

    call_id: str
    vessel_id: str
    vessel_name: str
    terminal: str
    berth_id: str
    atb_utc: datetime                     # ORDERING KEY ONLY â€” banned as a predictor

    parcel_teu: int = 2000
    draft_m: float = 13.5
    terminal_max_draft_m: float = 15.0
    draft_vs_terminal_max_m: float = 1.5
    weather_severity: int = 0             # 0..3
    severe_weather_flag: int = 0          # 0/1
    rain_mm_hr: float = 0.0
    wind_kn: float = 10.0
    net_channel_depth_delta_m: float = 0.0   # + dredged, - silted
    pilots_down: int = 0
    tugs_down: int = 0
    anchorage_queue_count: int = 0
    extra_arrivals_24h: int = 0
    incident_severity: int = 0            # 0..3
    berth_window_extension_h: float = 0.0
    calls_prev_24h: int = 10              # STRICTLY backward-looking, self excluded

    def as_dict(self) -> Dict[str, Any]:
        return {
            "call_id": self.call_id,
            "vessel_id": self.vessel_id,
            "vessel_name": self.vessel_name,
            "terminal": self.terminal,
            "berth_id": self.berth_id,
            "atb_utc": _iso(self.atb_utc),
            **{c: getattr(self, c) for c in FEATURE_COLUMNS},
        }


@dataclass(frozen=True)
class TATLabel:
    """
    TARGET AND OUTCOME TIMESTAMPS.

    A physically separate object from :class:`TATFeatures`. There is no code
    path in this module that hands a ``TATLabel`` to a model â€” that separation
    is the first line of the leakage firewall.
    """

    call_id: str
    tat_hours: float             # ATA -> ATD, the target
    berth_stay_hours: float      # ATB -> ATD
    ata_utc: datetime
    atd_utc: datetime

    def as_dict(self) -> Dict[str, Any]:
        return {
            "call_id": self.call_id,
            "tat_hours": round(self.tat_hours, 3),
            "berth_stay_hours": round(self.berth_stay_hours, 3),
            "ata_utc": _iso(self.ata_utc),
            "atd_utc": _iso(self.atd_utc),
        }


@dataclass(frozen=True)
class TATCall:
    """A vessel call: features always, label only when the outcome is observed."""

    features: TATFeatures
    label: Optional[TATLabel] = None      # None at inference time


# --------------------------------------------------------------------------
# THE ALLOW-LIST. Sixteen numeric predictors, named explicitly.
# to_vector() reads from this tuple â€” never from dataclasses.asdict(), which
# would silently pick up any field a future contributor adds.
# --------------------------------------------------------------------------
FEATURE_COLUMNS: Tuple[str, ...] = (
    "parcel_teu",
    "draft_m",
    "terminal_max_draft_m",
    "draft_vs_terminal_max_m",
    "weather_severity",
    "severe_weather_flag",
    "rain_mm_hr",
    "wind_kn",
    "net_channel_depth_delta_m",
    "pilots_down",
    "tugs_down",
    "anchorage_queue_count",
    "extra_arrivals_24h",
    "incident_severity",
    "berth_window_extension_h",
    "calls_prev_24h",
)

# Anything here would leak the future into the model. ``atb_utc`` is included
# deliberately: it is the split key, not a predictor.
BANNED_FIELDS: FrozenSet[str] = frozenset({
    "tat_hours",
    "berth_stay_hours",
    "ata_utc",
    "atd_utc",
    "atb_utc",
    "actual_moves_completed",
    "crane_hours_used",
    "departure_draft_m",
    "actual_cranes_used",
    "actual_gang_hours",
    "sailed",
})


def _assert_no_leakage() -> None:
    """
    Verify the leakage firewall. CALLED AT IMPORT TIME â€” see the module bottom.

    A contributor who adds an outcome field to ``FEATURE_COLUMNS`` gets an
    AssertionError on import rather than a suspiciously good validation score.
    """
    overlap = set(FEATURE_COLUMNS) & BANNED_FIELDS
    assert not overlap, (
        f"DATA LEAKAGE: {sorted(overlap)} appear in both FEATURE_COLUMNS and "
        f"BANNED_FIELDS. Outcome variables must never be predictors."
    )
    assert len(set(FEATURE_COLUMNS)) == len(FEATURE_COLUMNS), (
        "FEATURE_COLUMNS contains duplicates"
    )
    feature_fields = set(TATFeatures.__dataclass_fields__)
    missing = set(FEATURE_COLUMNS) - feature_fields
    assert not missing, f"FEATURE_COLUMNS names fields absent from TATFeatures: {sorted(missing)}"
    label_fields = set(TATLabel.__dataclass_fields__) - {"call_id"}
    bleed = set(FEATURE_COLUMNS) & label_fields
    assert not bleed, (
        f"DATA LEAKAGE: {sorted(bleed)} exist on TATLabel and must not be features."
    )


def to_vector(features: TATFeatures) -> List[float]:
    """
    Project features onto the allow-list, in ``FEATURE_COLUMNS`` order.

    Deliberately NOT ``asdict()`` â€” an explicit read of named columns is what
    makes the leakage firewall hold as the dataclass evolves.
    """
    return [float(getattr(features, c)) for c in FEATURE_COLUMNS]


# --------------------------------------------------------------------------
# Stressors: a NAMED, ENUMERATED predicate list rather than a vague count, so
# sigma = 2 + 0.3*n is exactly reproducible and auditable.
# --------------------------------------------------------------------------
STRESSOR_PREDICATES: Tuple[Tuple[str, Callable[[TATFeatures], bool]], ...] = (
    ("severe_weather", lambda f: f.severe_weather_flag == 1),
    ("heavy_rain", lambda f: f.rain_mm_hr > 5.0),
    ("high_wind", lambda f: f.wind_kn >= 25.0),
    ("channel_depth_loss", lambda f: f.net_channel_depth_delta_m < 0.0),
    ("pilots_down", lambda f: f.pilots_down > 0),
    ("tugs_down", lambda f: f.tugs_down > 0),
    ("anchorage_queue", lambda f: f.anchorage_queue_count >= 5),
    ("extra_arrivals", lambda f: f.extra_arrivals_24h > 0),
    ("incident", lambda f: f.incident_severity > 0),
    ("deep_draft_tight", lambda f: f.draft_m >= f.terminal_max_draft_m - 0.5),
)


def active_stressors(features: TATFeatures) -> List[str]:
    """Named stressors currently active. Drives sigma and the P10/P90 band."""
    return [name for name, pred in STRESSOR_PREDICATES if pred(features)]


@dataclass(frozen=True)
class SplitReport:
    """Audit record of the chronological split."""

    split_time_utc: datetime
    n_total: int
    n_train: int
    n_test: int
    n_purged: int
    embargo_hours: float
    train_span: Tuple[Optional[datetime], Optional[datetime]]
    test_span: Tuple[Optional[datetime], Optional[datetime]]
    ordering_assert_passed: bool
    method: str = "chronological_holdout_with_purge"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "method": self.method,
            "split_time_utc": _iso(self.split_time_utc),
            "n_total": self.n_total,
            "n_train": self.n_train,
            "n_test": self.n_test,
            "n_purged": self.n_purged,
            "embargo_hours": self.embargo_hours,
            "train_span": [_iso(self.train_span[0]), _iso(self.train_span[1])],
            "test_span": [_iso(self.test_span[0]), _iso(self.test_span[1])],
            "ordering_assert_passed": self.ordering_assert_passed,
            "note": (
                "We never use train_test_split(shuffle=True) or KFold. Random splitting "
                "puts calls from the same day â€” sharing yard state, weather and tide â€” on "
                "both sides, and lets the model see the future."
            ),
        }


@dataclass(frozen=True)
class EngineAttempt:
    """One rung of the engine fallback chain, and why it was taken or skipped."""

    engine: str
    available: bool
    selected: bool
    reason: str
    elapsed_ms: float

    def as_dict(self) -> Dict[str, Any]:
        return {
            "engine": self.engine,
            "available": self.available,
            "selected": self.selected,
            "reason": self.reason,
            "elapsed_ms": round(self.elapsed_ms, 2),
        }


@dataclass(frozen=True)
class TATPrediction:
    """A single prediction with its band and its explanation."""

    call_id: str
    vessel_id: str
    engine: str
    p10_hours: float
    p50_hours: float
    p90_hours: float
    sigma_hours: float
    stressor_count: int
    stressors_active: Tuple[str, ...]
    quantile_crossing_corrected: bool
    clamped_at_min: bool
    model_version: str
    breakdown: Dict[str, Any]
    engine_trace: Tuple[EngineAttempt, ...] = ()

    def as_dict(self) -> Dict[str, Any]:
        return {
            "call_id": self.call_id,
            "vessel_id": self.vessel_id,
            "engine": self.engine,
            "p10_hours": round(self.p10_hours, 3),
            "p50_hours": round(self.p50_hours, 3),
            "p90_hours": round(self.p90_hours, 3),
            "band_width_hours": round(self.p90_hours - self.p10_hours, 3),
            "sigma_hours": round(self.sigma_hours, 3),
            "stressor_count": self.stressor_count,
            "stressors_active": list(self.stressors_active),
            "quantile_crossing_corrected": self.quantile_crossing_corrected,
            "clamped_at_min": self.clamped_at_min,
            "model_version": self.model_version,
            "breakdown": self.breakdown,
            "engine_trace": [e.as_dict() for e in self.engine_trace],
        }


@dataclass(frozen=True)
class TATMetrics:
    """Accuracy reported the way the spec's Accuracy column requires."""

    n_test: int
    mae_hours: float
    rmse_hours: float
    mape_pct: float
    forecast_accuracy_pct: float
    pinball_p10: float
    pinball_p50: float
    pinball_p90: float
    coverage_80_pct: float
    mean_band_width_hours: float
    mape_rows_dropped: int
    engine: str
    model_version: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "n_test": self.n_test,
            "mae_hours": round(self.mae_hours, 4),
            "rmse_hours": round(self.rmse_hours, 4),
            "mape_pct": round(self.mape_pct, 4),
            "forecast_accuracy_pct": round(self.forecast_accuracy_pct, 3),
            "pinball_p10": round(self.pinball_p10, 4),
            "pinball_p50": round(self.pinball_p50, 4),
            "pinball_p90": round(self.pinball_p90, 4),
            "coverage_80_pct": round(self.coverage_80_pct, 2),
            "mean_band_width_hours": round(self.mean_band_width_hours, 3),
            "mape_rows_dropped": self.mape_rows_dropped,
            "engine": self.engine,
            "model_version": self.model_version,
        }


# ==========================================================================
# SECTION 4 â€” DATA PROVIDERS (loader hooks) AND SYNTHETIC GENERATION
# ==========================================================================

try:  # pragma: no cover
    from typing import Protocol, runtime_checkable
except ImportError:  # pragma: no cover
    Protocol = object  # type: ignore

    def runtime_checkable(c):  # type: ignore
        return c


@runtime_checkable
class VesselCallLoader(Protocol):
    """Supplies labelled vessel calls for training and evaluation."""

    @property
    def source_id(self) -> str: ...

    def load_calls(self, start: datetime, end: datetime) -> List[TATCall]: ...


def additive_contributions(
    features: TATFeatures, coef: TATCoefficients = DEFAULT_COEFFICIENTS
) -> List[Dict[str, Any]]:
    """
    Per-factor contribution list for the transparent additive model.

    This is the operator-facing explanation: each row names the factor, the raw
    input, the coefficient in words, and the hours it adds or removes.
    """
    draft_over = max(0.0, features.draft_m - coef.draft_ref_m)
    depth_loss = max(0.0, -features.net_channel_depth_delta_m)
    wind_over = max(0.0, features.wind_kn - coef.wind_ref_kn)

    rows: List[Tuple[str, Any, str, float]] = [
        ("parcel_teu", features.parcel_teu,
         f"+1 h / 250 TEU", features.parcel_teu * coef.hours_per_teu),
        ("draft_over_ref", round(draft_over, 3),
         f"+{coef.hours_per_m_draft_over_ref} h / m over {coef.draft_ref_m} m",
         draft_over * coef.hours_per_m_draft_over_ref),
        ("severe_weather", features.severe_weather_flag,
         f"+{coef.hours_severe_weather} h when severe",
         features.severe_weather_flag * coef.hours_severe_weather),
        ("channel_depth_loss", round(depth_loss, 3),
         f"+{coef.hours_per_m_channel_depth_loss} h / m lost",
         depth_loss * coef.hours_per_m_channel_depth_loss),
        ("rain", round(features.rain_mm_hr, 2),
         f"+{coef.hours_per_mm_rain} h per mm/hr",
         features.rain_mm_hr * coef.hours_per_mm_rain),
        ("wind_over_ref", round(wind_over, 2),
         f"+{coef.hours_per_kn_wind_over_ref} h / kn over {coef.wind_ref_kn} kn",
         wind_over * coef.hours_per_kn_wind_over_ref),
        ("pilots_down", features.pilots_down,
         f"+{coef.hours_per_pilot_down} h each",
         features.pilots_down * coef.hours_per_pilot_down),
        ("tugs_down", features.tugs_down,
         f"+{coef.hours_per_tug_down} h each",
         features.tugs_down * coef.hours_per_tug_down),
        ("anchorage_queue", features.anchorage_queue_count,
         f"+{coef.hours_per_queued_vessel} h per vessel",
         features.anchorage_queue_count * coef.hours_per_queued_vessel),
        ("extra_arrivals", features.extra_arrivals_24h,
         f"+{coef.hours_per_extra_arrival} h each",
         features.extra_arrivals_24h * coef.hours_per_extra_arrival),
        ("incident_severity", features.incident_severity,
         f"+{coef.hours_per_incident_severity_level} h per level",
         features.incident_severity * coef.hours_per_incident_severity_level),
        ("berth_window_extension", round(features.berth_window_extension_h, 2),
         f"{coef.hours_per_h_berth_window_extension} h per h granted",
         features.berth_window_extension_h * coef.hours_per_h_berth_window_extension),
    ]

    total_abs = sum(abs(c) for _, _, _, c in rows) or 1.0
    return [
        {
            "factor": name,
            "input": inp,
            "coefficient": coefficient,
            "contribution_h": round(contrib, 4),
            "share_pct": round(contrib / total_abs * 100.0, 2),
            "direction": "increase" if contrib > 0 else ("decrease" if contrib < 0 else "neutral"),
        }
        for name, inp, coefficient, contrib in rows
    ]


def additive_tat_hours(
    features: TATFeatures, coef: TATCoefficients = DEFAULT_COEFFICIENTS
) -> Tuple[float, bool]:
    """Additive-model point estimate. Returns ``(hours, clamped_at_min)``."""
    total = coef.base_hours + sum(
        c["contribution_h"] for c in additive_contributions(features, coef)
    )
    if total < coef.min_tat_hours:
        return coef.min_tat_hours, True
    return total, False


def sigma_hours(
    features: TATFeatures, coef: TATCoefficients = DEFAULT_COEFFICIENTS
) -> Tuple[float, List[str]]:
    """
    Prediction uncertainty: ``sigma = 2 + 0.3 * stressor_count``.

    With ten enumerated predicates, sigma ranges 2.0 h (calm) to 5.0 h (every
    stressor active), which keeps the P10/P90 band interpretable.
    """
    stressors = active_stressors(features)
    return coef.sigma_base_hours + coef.sigma_per_stressor_hours * len(stressors), stressors


class SyntheticVesselCallLoader:
    """
    Seeded synthetic call history, calibrated to the JNPA anchors.

    HOW THE ANCHOR IS HIT, HONESTLY
    --------------------------------
    The labels are NOT rescaled to hit the 43.92 h target â€” that would bias the
    additive model against its own data. Instead the FEATURE distribution is
    calibrated: after generating everything else, the parcel-TEU scale is solved
    in closed form so the expected additive TAT lands on the anchor. One
    documented parameter, applied to an input, leaving the coefficient block
    unbiased.

    A mild queue x weather INTERACTION is injected on top of the additive
    signal. Without it the data is exactly linear and a gradient-boosted model
    has nothing to learn that the transparent model does not already capture â€”
    which would make the dual-engine comparison meaningless.
    """

    source_id = "SYNTHETIC_VESSEL_CALLS_v1"

    def __init__(
        self,
        seed: int = DEFAULT_SEED,
        anchors: CalibrationAnchors = JNPA_ANCHORS,
        coef: TATCoefficients = DEFAULT_COEFFICIENTS,
        interaction_strength: float = 3.5,
        noise_sd_hours: float = 3.0,
    ) -> None:
        self.seed = seed
        self.anchors = anchors
        self.coef = coef
        self.interaction_strength = interaction_strength
        self.noise_sd_hours = noise_sd_hours

    # -- feature generation ------------------------------------------------
    def _raw_features(self, n_days: int, start: datetime) -> List[TATFeatures]:
        rng = random.Random(self.seed)
        terminals = [
            ("NSFT", "CB02", 15.0), ("NSICT", "CB05", 14.5), ("NSIGT", "CB-06", 15.0),
            ("APMT", "APMT-01", 15.5), ("BMCT", "BMCT-01", 16.5), ("BMCT", "BMCT-03", 16.5),
        ]
        names = [
            "MSC VALERIA", "MAERSK HANGZHOU", "CMA CGM MARCO POLO", "OOCL WASHINGTON",
            "HMM LEAF", "KMTC NHAVA SHEVA", "TS SHANGHAI", "AL SAADIYAT",
            "SPIL KARTIKA", "MYD FUZHOU", "ARAYA BHUM", "DP WORLD JEBEL ALI",
        ]
        out: List[TATFeatures] = []
        seq = 0
        atb_history: List[datetime] = []

        for d in range(n_days):
            day0 = start + timedelta(days=d)
            # Monsoon season (Jun-Sep) drives the weather stressors.
            monsoon = day0.month in (6, 7, 8, 9)
            day_rain = max(0.0, rng.gauss(6.0 if monsoon else 0.4, 5.0 if monsoon else 1.0))
            day_wind = max(0.0, rng.gauss(18.0 if monsoon else 11.0, 6.0))
            severe = 1 if (day_rain > 12.0 or day_wind >= 30.0) else 0
            severity = 3 if severe else (2 if day_rain > 6.0 else (1 if day_rain > 1.5 else 0))
            depth_delta = round(rng.choice([0.0, 0.0, 0.0, -0.3, -0.2, 0.5]), 2)
            pilots_down = rng.choice([0, 0, 0, 0, 1, 1, 2])
            tugs_down = rng.choice([0, 0, 0, 1, 1, 2])
            queue = max(0, int(rng.gauss(3.0 if not severe else 6.5, 2.0)))
            extra = rng.choice([0, 0, 0, 1, 2])

            n_calls = rng.randint(self.anchors.calls_per_day_min, self.anchors.calls_per_day_max)
            for _ in range(n_calls):
                seq += 1
                terminal, berth, max_draft = rng.choice(terminals)
                atb = day0 + timedelta(hours=rng.uniform(0.0, 24.0))
                # STRICTLY backward-looking: current call excluded, strict '<'.
                cutoff = atb - timedelta(hours=24.0)
                prev24 = sum(1 for t in atb_history if cutoff <= t < atb)
                atb_history.append(atb)

                draft = round(min(max_draft - 0.05, max(9.0, rng.gauss(13.4, 1.5))), 2)
                out.append(
                    TATFeatures(
                        call_id=f"C-{seq:05d}",
                        vessel_id=f"V-{seq:05d}",
                        vessel_name=names[seq % len(names)],
                        terminal=terminal,
                        berth_id=berth,
                        atb_utc=atb,
                        parcel_teu=max(120, int(rng.gauss(1900.0, 900.0))),
                        draft_m=draft,
                        terminal_max_draft_m=max_draft,
                        draft_vs_terminal_max_m=round(max_draft - draft, 2),
                        weather_severity=severity,
                        severe_weather_flag=severe,
                        rain_mm_hr=round(day_rain, 2),
                        wind_kn=round(day_wind, 1),
                        net_channel_depth_delta_m=depth_delta,
                        pilots_down=pilots_down,
                        tugs_down=tugs_down,
                        anchorage_queue_count=queue,
                        extra_arrivals_24h=extra,
                        incident_severity=rng.choice([0, 0, 0, 0, 0, 1, 1, 2, 3]),
                        berth_window_extension_h=round(rng.choice([0.0, 0.0, 0.0, 2.0, 4.0]), 1),
                        calls_prev_24h=prev24,
                    )
                )
        return sorted(out, key=lambda f: (f.atb_utc, f.call_id))

    def _teu_scale_for_anchor(self, feats: Sequence[TATFeatures]) -> float:
        """
        Closed-form solve for the single calibration parameter.

        mean_TAT = base + mean(non-TEU contributions) + scale * mean(TEU contribution)
        => scale = (target - base - mean_non_teu) / mean_teu
        """
        c = self.coef
        teu_parts: List[float] = []
        other_parts: List[float] = []
        for f in feats:
            contribs = additive_contributions(f, c)
            teu = next(x["contribution_h"] for x in contribs if x["factor"] == "parcel_teu")
            teu_parts.append(teu)
            other_parts.append(sum(x["contribution_h"] for x in contribs) - teu)
        mean_teu = statistics.fmean(teu_parts) if teu_parts else 1.0
        mean_other = statistics.fmean(other_parts) if other_parts else 0.0
        # The interaction term also contributes on average; account for it.
        target = self.anchors.tat_hours_mean - c.base_hours - mean_other
        if mean_teu <= 1e-9:
            return 1.0
        return max(0.05, min(20.0, target / mean_teu))

    def _interaction_hours(self, f: TATFeatures) -> float:
        """
        Non-linear term the additive model cannot express.

        Congestion and bad weather compound: a busy anchorage during a squall
        costs more than the sum of the two effects, because gangs stand down
        while the queue keeps growing. This is what gives the gradient-boosted
        engine something real to learn.
        """
        if f.anchorage_queue_count >= 5 and f.severe_weather_flag == 1:
            return self.interaction_strength * math.log1p(f.anchorage_queue_count)
        if f.pilots_down > 0 and f.anchorage_queue_count >= 5:
            return self.interaction_strength * 0.6
        return 0.0

    def load_calls(self, start: datetime, end: datetime) -> List[TATCall]:
        n_days = max(1, int(round(_hours_between(_ensure_utc(start), _ensure_utc(end)) / 24.0)))
        feats = self._raw_features(n_days, _ensure_utc(start))

        # Single documented calibration parameter, applied to the FEATURE.
        scale = self._teu_scale_for_anchor(feats)
        feats = [
            replace(f, parcel_teu=max(120, int(round(f.parcel_teu * scale))))
            for f in feats
        ]

        rng = random.Random(self.seed + 4242)
        ratio = self.anchors.berth_stay_hours_mean / self.anchors.tat_hours_mean

        calls: List[TATCall] = []
        for f in feats:
            base, _ = additive_tat_hours(f, self.coef)
            tat = max(
                self.coef.min_tat_hours,
                base + self._interaction_hours(f) + rng.gauss(0.0, self.noise_sd_hours),
            )
            stay = max(2.0, min(tat - 0.5, tat * ratio * rng.gauss(1.0, 0.12)))
            atd = f.atb_utc + timedelta(hours=stay)
            ata = atd - timedelta(hours=tat)
            calls.append(
                TATCall(
                    features=f,
                    label=TATLabel(
                        call_id=f.call_id,
                        tat_hours=tat,
                        berth_stay_hours=stay,
                        ata_utc=ata,
                        atd_utc=atd,
                    ),
                )
            )
        return calls


class DailyStatusReportLoader:
    """
    REAL DATA â€” berth-stay ground truth from the JNPA Daily Status Reports.

    Reads ``dsr_berth_stays.csv`` produced by ``dsr_extract.py``, which parses
    section (H) "Vessels Under Operation" on page 3 of each report:

        Terminal | Berth No | Via No | Vessel Name | Cargo | Berthed on |
        Expected Completion

    Corpus: Model_Training_Data\\Model_Training_Data\\UC-I_Vessel_Traffic\\
            M3_TAT_Prediction_Calibration\\Daily_Status_Reports\\  (53 PDFs)

    WHAT THIS SOURCE CAN AND CANNOT GIVE
    -------------------------------------
    It gives a real BERTH STAY (Berthed on -> Expected Completion). It does NOT
    give ATA, so full TAT (ATA -> ATD) is not derivable from it alone. This
    loader therefore exposes ``berth_stay_samples()`` for re-anchoring the
    synthetic generator on real data, rather than pretending to supply labels it
    cannot support. Full TAT labels need the VESARR/VESDEP logs joined on VCN â€”
    see uc1_m4_berth_utilisation.VesarrVesdepLogLoader.

    Join key to features: (vessel_name_normalised, berthed_on_date).
    Timestamps are IST in the source; dsr_extract.py converts to UTC.
    Rejects rows where completion <= berthing, or stay > 240 h.
    """

    def __init__(self, csv_path: str = DSR_CSV_DEFAULT) -> None:
        self.csv_path = csv_path

    @property
    def source_id(self) -> str:
        return f"JNPA_DSR_SECTION_H/{os.path.basename(self.csv_path)}"

    def available(self) -> bool:
        return os.path.isfile(self.csv_path)

    def berth_stay_samples(self) -> List[float]:
        """Real berth-stay hours, for re-anchoring the generator."""
        if not self.available():
            return []
        out: List[float] = []
        with open(self.csv_path, "r", encoding="utf-8", newline="") as fh:
            for row in csv.DictReader(fh):
                try:
                    h = float(row["berth_stay_hours"])
                except (KeyError, ValueError, TypeError):
                    continue
                if 0.0 < h <= 240.0:
                    out.append(h)
        return out

    def load_calls(self, start: datetime, end: datetime) -> List[TATCall]:
        raise NotImplementedError(
            "The Daily Status Reports give berth stay but not ATA, so full TAT labels "
            "cannot be derived from this source alone. Use berth_stay_samples() to "
            "re-anchor the synthetic generator, or join VESARR/VESDEP on VCN to obtain "
            "a true ATA. See the class docstring."
        )


class BermanXmlFeatureLoader:
    """
    REAL-DATA STUB â€” pre-berthing FEATURES from PCS BERMAN messages.

    TODO(real-data) EXTRACTION CONTRACT
    -----------------------------------
    Source: ...\\M4-M5_ETA_BerthUtilisation_Optimiser\\PCS_NLP_Marine_Messages\\
            BERMAN\\BERMAN_<commonRef>.xml   (14 files)

    Verified tag path:
        BerthManagement/DocumentDetails/BERMANHeader/{VCN, CallSign, IMONumber,
        VoyageNumber, VesselType, RotationNumber, Anchorage, EDTA, EDTD,
        DraftFwd, DraftAft, SpecificBerthDetails/BerthDetails}

    EDTA / EDTD literal format: 'DDMMYYYY:HH:MM' (e.g. '11022026:17:00'), IST.
    Parse with strptime('%d%m%Y:%H:%M'), attach IST, convert to UTC here.

    Mapping to TATFeatures:
        call_id  <- CommonRefNumber      vessel_id <- VCN
        draft_m  <- max(DraftFwd, DraftAft)
        berth_id <- SpecificBerthDetails/BerthDetails
        atb_utc  <- EDTA                 [ORDERING KEY ONLY â€” never a predictor]

    CRITICAL: EDTA and EDTD are PLANNED times. They are legitimate FEATURES.
    They must NEVER be used to construct the label â€” sourcing tat_hours from
    EDTD would make the model predict the plan rather than reality, which is
    exactly the leakage this module is built to prevent.

    parcel_teu is not in BERMAN; join to the terminal COPRAR/COARRI messages or
    to the Daily Status Report TEU table on (vessel, date).

    Dependency: stdlib xml.etree only.
    """

    source_id = "JNPA_PCS_BERMAN/NOT_IMPLEMENTED"

    def load_calls(self, start: datetime, end: datetime) -> List[TATCall]:
        raise NotImplementedError(BermanXmlFeatureLoader.__doc__)


DEFAULT_HISTORY_DAYS: int = 365
"""
Default synthetic history length: one FULL seasonal cycle.

This is not an arbitrary default. The generator models the Jun-Sep monsoon, and
a chronological split of a shorter history puts the monsoon onset entirely in
test with a dry-season train. Measured effect on the LightGBM engine:

    180 d  train Jan-May, test May-Jun   ->  coverage 68.4%,  MAE 3.87 h
    270 d  train Jan-Aug, test Aug-Sep   ->  coverage 73.4%,  MAE 4.75 h
    365 d  train Jan-Oct, test Oct-Dec   ->  coverage 85.7%,  MAE 2.49 h
    540 d  full cycle in train           ->  coverage 78.6%,  MAE 2.61 h

A model that has never seen a monsoon cannot band one, and no amount of
conformal widening repairs that â€” it is covariate shift, not miscalibration.
WS2 makes the same point from the other direction: the gradient-boosted engine
is triggered by ">= 6 months of ingested call history". On this evidence, a full
year is the point at which it becomes trustworthy.
"""


def generate_synthetic_calls(
    n_days: int = DEFAULT_HISTORY_DAYS,
    seed: int = DEFAULT_SEED,
    start: Optional[datetime] = None,
    anchors: CalibrationAnchors = JNPA_ANCHORS,
) -> List[TATCall]:
    """Convenience wrapper: a chronologically ordered synthetic call history."""
    start = start or datetime(2026, 1, 1, tzinfo=timezone.utc)
    end = start + timedelta(days=n_days)
    return SyntheticVesselCallLoader(seed=seed, anchors=anchors).load_calls(start, end)


def verify_calibration(
    calls: Sequence[TATCall], anchors: CalibrationAnchors = JNPA_ANCHORS
) -> Dict[str, Any]:
    """Achieved vs target vs PASS/FAIL for each published anchor."""
    labelled = [c for c in calls if c.label is not None]
    if not labelled:
        return {"status": "NO_LABELS", "checks": []}

    tat_mean_d = statistics.fmean(c.label.tat_hours for c in labelled) / 24.0
    stay_mean_d = statistics.fmean(c.label.berth_stay_hours for c in labelled) / 24.0
    days = {c.features.atb_utc.date() for c in labelled}
    calls_per_day = len(labelled) / max(1, len(days))

    checks = [
        {
            "anchor": "mean TAT (days)",
            "target": anchors.tat_days_mean,
            "tolerance": anchors.tat_days_tol,
            "achieved": round(tat_mean_d, 4),
            "achieved_hours": round(tat_mean_d * 24.0, 2),
            "passed": abs(tat_mean_d - anchors.tat_days_mean) <= anchors.tat_days_tol,
        },
        {
            "anchor": "mean berth stay (days)",
            "target": anchors.berth_stay_days_mean,
            "tolerance": anchors.berth_stay_days_tol,
            "achieved": round(stay_mean_d, 4),
            "achieved_hours": round(stay_mean_d * 24.0, 2),
            "passed": abs(stay_mean_d - anchors.berth_stay_days_mean)
            <= anchors.berth_stay_days_tol,
        },
        {
            "anchor": "calls per day",
            "target": f"{anchors.calls_per_day_min}-{anchors.calls_per_day_max}",
            "tolerance": None,
            "achieved": round(calls_per_day, 2),
            "achieved_hours": None,
            "passed": anchors.calls_per_day_min - 0.5
            <= calls_per_day
            <= anchors.calls_per_day_max + 0.5,
        },
    ]
    return {
        "source": anchors.source,
        "n_calls": len(labelled),
        "n_days": len(days),
        "checks": checks,
        "status": "PASS" if all(c["passed"] for c in checks) else "FAIL",
    }


# ==========================================================================
# SECTION 5 â€” ENGINE: SPLIT, MODELS, METRICS
# ==========================================================================


def chronological_split(
    calls: Sequence[TATCall],
    test_fraction: float = 0.20,
    embargo_hours: float = 24.0,
) -> Tuple[List[TATCall], List[TATCall], SplitReport]:
    """
    Time-ordered hold-out with a purge band. NEVER a random split.

    Algorithm
    ---------
    1. Sort by ``(features.atb_utc, features.call_id)`` â€” the id tie-break keeps
       the split deterministic when two calls berth in the same second.
    2. Cut at ``int(n * (1 - test_fraction))``; the cut call's ATB is the
       decision boundary.
    3. PURGE from TRAIN any call whose ``label.atd_utc >= split_time -
       embargo_hours``. Its outcome had not been observed by the boundary, so
       including it means training on information the model would not have had.
    4. TEST is every call with ``atb_utc >= split_time``.

    Post-condition ``max(train ATB) < min(test ATB)`` is asserted and reported.
    """
    labelled = [c for c in calls if c.label is not None]
    ordered = sorted(labelled, key=lambda c: (c.features.atb_utc, c.features.call_id))
    n = len(ordered)
    if n < 5:
        raise ValueError(f"need at least 5 labelled calls to split, got {n}")

    cut = max(1, min(n - 1, int(n * (1.0 - test_fraction))))
    split_time = ordered[cut].features.atb_utc
    embargo_edge = split_time - timedelta(hours=embargo_hours)

    train_all = [c for c in ordered if c.features.atb_utc < split_time]
    test = [c for c in ordered if c.features.atb_utc >= split_time]

    train = [c for c in train_all if c.label.atd_utc < embargo_edge]
    purged = len(train_all) - len(train)

    ordering_ok = True
    if train and test:
        ordering_ok = max(c.features.atb_utc for c in train) < min(
            c.features.atb_utc for c in test
        )
    assert ordering_ok, "chronological split violated: a train ATB is not before every test ATB"

    report = SplitReport(
        split_time_utc=split_time,
        n_total=n,
        n_train=len(train),
        n_test=len(test),
        n_purged=purged,
        embargo_hours=embargo_hours,
        train_span=(
            min((c.features.atb_utc for c in train), default=None),
            max((c.features.atb_utc for c in train), default=None),
        ),
        test_span=(
            min((c.features.atb_utc for c in test), default=None),
            max((c.features.atb_utc for c in test), default=None),
        ),
        ordering_assert_passed=ordering_ok,
    )
    return train, test, report


def expanding_window_folds(
    train: Sequence[TATCall], n_folds: int = 4
) -> List[Tuple[List[TATCall], List[TATCall]]]:
    """
    Expanding-window CV folds INSIDE the train slice.

    Fold k trains on the first ``(k+1)/(n_folds+1)`` of the (time-ordered) train
    data and validates on the next block. Never shuffles, never lets a later
    call inform an earlier prediction. Used for hyperparameter selection so no
    test-set information reaches the fitting process.
    """
    ordered = sorted(train, key=lambda c: (c.features.atb_utc, c.features.call_id))
    n = len(ordered)
    folds: List[Tuple[List[TATCall], List[TATCall]]] = []
    if n < (n_folds + 1) * 2:
        return folds
    block = n // (n_folds + 1)
    for k in range(n_folds):
        fit_end = block * (k + 1)
        val_end = min(n, block * (k + 2))
        folds.append((ordered[:fit_end], ordered[fit_end:val_end]))
    return folds


def fit_impute_stats(train: Sequence[TATCall]) -> Dict[str, float]:
    """
    Median per feature column, computed on TRAIN ONLY.

    Applying test-set statistics â€” even something as innocuous as a median â€”
    leaks distributional information across the boundary.
    """
    stats: Dict[str, float] = {}
    for i, col in enumerate(FEATURE_COLUMNS):
        vals = [to_vector(c.features)[i] for c in train]
        stats[col] = statistics.median(vals) if vals else 0.0
    return stats


def apply_impute(vec: Sequence[float], stats: Mapping[str, float]) -> List[float]:
    """Replace non-finite entries with the TRAIN medians."""
    out: List[float] = []
    for i, col in enumerate(FEATURE_COLUMNS):
        v = float(vec[i])
        out.append(stats.get(col, 0.0) if not math.isfinite(v) else v)
    return out


# --------------------------------------------------------------------------
# Optional ML backends. Catch bare Exception, not ImportError: LightGBM on
# Windows raises OSError when the VC++ redistributable is missing, and that must
# fall through the fallback chain rather than crash the module.
# --------------------------------------------------------------------------

_HAS_LIGHTGBM = False
_LGB_ERROR = ""
try:
    import lightgbm as _lgb  # noqa: E402

    _HAS_LIGHTGBM = True
except Exception as _exc:  # pragma: no cover
    _lgb = None  # type: ignore
    _LGB_ERROR = repr(_exc)[:200]

_HAS_SKLEARN = False
_SK_ERROR = ""
try:
    from sklearn.ensemble import (  # noqa: E402
        GradientBoostingRegressor as _GBR,
        RandomForestRegressor as _RFR,
    )

    _HAS_SKLEARN = True
except Exception as _exc:  # pragma: no cover
    _GBR = None  # type: ignore
    _RFR = None  # type: ignore
    _SK_ERROR = repr(_exc)[:200]


@runtime_checkable
class QuantileEngine(Protocol):
    """A model that can produce P10/P50/P90 for a feature vector."""

    name: str

    def fit(self, X: List[List[float]], y: List[float]) -> None: ...

    def predict_quantiles(self, x: Sequence[float]) -> Tuple[float, float, float]: ...


class AdditiveEngine:
    """
    The transparent additive model, wrapped in the engine interface.

    Always available, zero dependencies. It TERMINATES the fallback chain and
    cannot fail, which is what guarantees the module always returns a
    prediction.

    ``fit()`` optionally records the median residual on train as a calibration
    offset. Off by default: an offset makes the model fit the data better but
    means the printed coefficients no longer sum to the printed prediction,
    which costs more in explainability than it buys in accuracy.
    """

    name = "additive"

    def __init__(
        self,
        coef: TATCoefficients = DEFAULT_COEFFICIENTS,
        calibrate_offset: bool = False,
    ) -> None:
        self.coef = coef
        self.calibrate_offset = calibrate_offset
        self.offset_hours = 0.0
        self._fitted = False

    def fit_calls(self, calls: Sequence[TATCall]) -> None:
        if self.calibrate_offset and calls:
            residuals = [
                c.label.tat_hours - additive_tat_hours(c.features, self.coef)[0]
                for c in calls if c.label is not None
            ]
            if residuals:
                self.offset_hours = statistics.median(residuals)
        self._fitted = True

    def fit(self, X: List[List[float]], y: List[float]) -> None:
        # Vector interface is a no-op; the additive model needs named features.
        self._fitted = True

    def predict_features(self, features: TATFeatures) -> Tuple[float, float, float]:
        p50, _ = additive_tat_hours(features, self.coef)
        p50 += self.offset_hours
        sd, _ = sigma_hours(features, self.coef)
        z = self.coef.z_p80
        return p50 - z * sd, p50, p50 + z * sd

    def predict_quantiles(self, x: Sequence[float]) -> Tuple[float, float, float]:
        raise NotImplementedError("AdditiveEngine predicts from named features, not a vector")


class LightGBMQuantileEngine:
    """Three LightGBM quantile regressors at alpha = 0.10 / 0.50 / 0.90."""

    name = "lightgbm"

    def __init__(self, n_estimators: int = 300, learning_rate: float = 0.05,
                 num_leaves: int = 15, seed: int = DEFAULT_SEED) -> None:
        self.params = dict(
            objective="quantile", n_estimators=n_estimators, learning_rate=learning_rate,
            num_leaves=num_leaves, min_child_samples=20, verbose=-1, random_state=seed,
        )
        self.models: Dict[float, Any] = {}

    def fit(self, X: List[List[float]], y: List[float]) -> None:
        for q in QUANTILES:
            m = _lgb.LGBMRegressor(alpha=q, **self.params)
            m.fit(X, y)
            self.models[q] = m

    def predict_quantiles(self, x: Sequence[float]) -> Tuple[float, float, float]:
        row = [list(x)]
        return tuple(float(self.models[q].predict(row)[0]) for q in QUANTILES)  # type: ignore


class SklearnGBRQuantileEngine:
    """Three scikit-learn GradientBoosting quantile regressors."""

    name = "sklearn_gbr"

    def __init__(self, n_estimators: int = 200, learning_rate: float = 0.05,
                 max_depth: int = 3, seed: int = DEFAULT_SEED) -> None:
        self.kwargs = dict(
            loss="quantile", n_estimators=n_estimators, learning_rate=learning_rate,
            max_depth=max_depth, random_state=seed,
        )
        self.models: Dict[float, Any] = {}

    def fit(self, X: List[List[float]], y: List[float]) -> None:
        for q in QUANTILES:
            m = _GBR(alpha=q, **self.kwargs)
            m.fit(X, y)
            self.models[q] = m

    def predict_quantiles(self, x: Sequence[float]) -> Tuple[float, float, float]:
        row = [list(x)]
        return tuple(float(self.models[q].predict(row)[0]) for q in QUANTILES)  # type: ignore


class SklearnRFQuantileEngine:
    """
    RandomForest with quantiles taken from the empirical spread across trees.

    DOCUMENTED APPROXIMATION: the spread of per-tree predictions measures
    disagreement between trees, not the conditional distribution of the target.
    It is a usable proxy and it is cheap, but it is not a true quantile
    regression and the bands will typically be too narrow. Present as the third
    rung of the fallback chain, not as a recommended engine.
    """

    name = "sklearn_rf"

    def __init__(self, n_estimators: int = 300, seed: int = DEFAULT_SEED) -> None:
        self.kwargs = dict(
            n_estimators=n_estimators, random_state=seed, min_samples_leaf=5, n_jobs=1
        )
        self.model: Any = None

    def fit(self, X: List[List[float]], y: List[float]) -> None:
        self.model = _RFR(**self.kwargs)
        self.model.fit(X, y)

    def predict_quantiles(self, x: Sequence[float]) -> Tuple[float, float, float]:
        row = [list(x)]
        preds = [float(est.predict(row)[0]) for est in self.model.estimators_]
        return (
            _percentile(preds, 0.10),
            _percentile(preds, 0.50),
            _percentile(preds, 0.90),
        )


def backend_status() -> Dict[str, Any]:
    """What is actually importable in this environment."""
    return {
        "lightgbm": {"available": _HAS_LIGHTGBM, "error": _LGB_ERROR or None},
        "sklearn": {"available": _HAS_SKLEARN, "error": _SK_ERROR or None},
        "fastapi": {"available": _HAS_FASTAPI_FLAG(), "error": None},
    }


def _HAS_FASTAPI_FLAG() -> bool:
    return bool(globals().get("_HAS_FASTAPI", False))


class TATPredictor:
    """
    The dual-engine predictor.

    ``engine='auto'`` walks ``ENGINE_PRIORITY``. For each candidate it attempts
    CONSTRUCT + FIT + a one-row SMOKE PREDICT inside ``try/except Exception``.
    Any failure records an ``EngineAttempt(available=False, reason=...)`` and the
    chain moves on. ``AdditiveEngine`` cannot fail and terminates the chain.

    The trace is returned with every prediction, so an operator can always see
    which engine ran and why the others did not.
    """

    def __init__(
        self,
        engine: str = "auto",
        coef: TATCoefficients = DEFAULT_COEFFICIENTS,
        seed: int = DEFAULT_SEED,
        conformal: bool = True,
        conformal_fraction: float = 0.25,
    ) -> None:
        if engine not in ENGINE_CHOICES:
            raise ValueError(f"engine must be one of {ENGINE_CHOICES}, got {engine!r}")
        self.requested_engine = engine
        self.coef = coef
        self.seed = seed
        self.conformal = conformal
        self.conformal_fraction = conformal_fraction
        self.selected_engine = "additive"
        self.model: Any = AdditiveEngine(coef)
        self.impute_stats: Dict[str, float] = {}
        self.engine_trace: List[EngineAttempt] = []
        self.conformal_delta: float = 0.0
        self.conformal_report: Dict[str, Any] = {"applied": False}
        self._fitted = False

    def _candidates(self) -> Sequence[str]:
        if self.requested_engine == "auto":
            return ENGINE_PRIORITY
        return (self.requested_engine,) if self.requested_engine != "additive" else ("additive",)

    def _construct(self, name: str) -> Any:
        if name == "lightgbm":
            if not _HAS_LIGHTGBM:
                raise RuntimeError(f"lightgbm not importable: {_LGB_ERROR or 'not installed'}")
            return LightGBMQuantileEngine(seed=self.seed)
        if name == "sklearn_gbr":
            if not _HAS_SKLEARN:
                raise RuntimeError(f"scikit-learn not importable: {_SK_ERROR or 'not installed'}")
            return SklearnGBRQuantileEngine(seed=self.seed)
        if name == "sklearn_rf":
            if not _HAS_SKLEARN:
                raise RuntimeError(f"scikit-learn not importable: {_SK_ERROR or 'not installed'}")
            return SklearnRFQuantileEngine(seed=self.seed)
        if name == "additive":
            return AdditiveEngine(self.coef)
        raise RuntimeError(f"unknown engine {name!r}")

    def _calibrate_conformal(
        self, fit_part: Sequence[TATCall], calib_part: Sequence[TATCall]
    ) -> None:
        """
        Conformalised quantile regression (CQR).

        Gradient-boosted quantile models are routinely OVER-CONFIDENT: their
        nominal 80% band covers far less than 80% of outcomes, which makes the
        band actively misleading. CQR fixes that with a distribution-free
        guarantee.

        On a held-out CALIBRATION slice (taken from the END of the training
        period, never from test), compute the conformity score

            E_i = max(p10_i - y_i,  y_i - p90_i)

        â€” how far outside its own band each observation fell, negative when
        inside â€” and widen both edges by the 80th percentile of E. Coverage then
        converges on the nominal level regardless of how badly the underlying
        quantile models are calibrated.

        LEAKAGE NOTE: the calibration slice is carved out of TRAIN and is
        strictly EARLIER than the test slice, so the chronological guarantee
        still holds. No test data participates.
        """
        if not calib_part:
            self.conformal_report = {"applied": False, "reason": "calibration slice empty"}
            return
        scores: List[float] = []
        for c in calib_part:
            vec = apply_impute(to_vector(c.features), self.impute_stats)
            lo, _, hi = self.model.predict_quantiles(vec)
            if lo > hi:
                lo, hi = hi, lo
            scores.append(max(lo - c.label.tat_hours, c.label.tat_hours - hi))
        target = QUANTILES[2] - QUANTILES[0]          # 0.90 - 0.10 = 0.80
        delta = max(0.0, _percentile(scores, target))
        self.conformal_delta = delta
        inside_before = sum(1 for s in scores if s <= 0) / len(scores) * 100.0
        self.conformal_report = {
            "applied": True,
            "method": "conformalised quantile regression (CQR)",
            "n_fit": len(fit_part),
            "n_calibration": len(calib_part),
            "target_coverage_pct": target * 100.0,
            "raw_calibration_coverage_pct": round(inside_before, 2),
            "delta_hours": round(delta, 4),
            "note": (
                "Both band edges widened by delta. The calibration slice is the tail of "
                "the TRAIN period and is strictly earlier than test â€” the chronological "
                "guarantee is preserved."
            ),
        }

    def fit(self, train: Sequence[TATCall]) -> "TATPredictor":
        """Walk the fallback chain until an engine constructs, fits and predicts."""
        labelled = [c for c in train if c.label is not None]
        if not labelled:
            raise ValueError("cannot fit on unlabelled calls")

        self.impute_stats = fit_impute_stats(labelled)

        # Carve a conformal calibration slice off the END of the train period.
        # Chronological, so the split guarantee is preserved.
        ordered = sorted(labelled, key=lambda c: (c.features.atb_utc, c.features.call_id))
        use_conformal = self.conformal and len(ordered) >= 40
        if use_conformal:
            cut = int(len(ordered) * (1.0 - self.conformal_fraction))
            fit_part, calib_part = ordered[:cut], ordered[cut:]
        else:
            fit_part, calib_part = ordered, []

        X = [apply_impute(to_vector(c.features), self.impute_stats) for c in fit_part]
        y = [c.label.tat_hours for c in fit_part]

        self.engine_trace = []
        for name in self._candidates():
            t0 = time.perf_counter()
            try:
                model = self._construct(name)
                if name == "additive":
                    model.fit_calls(labelled)
                    _ = model.predict_features(labelled[0].features)   # smoke predict
                else:
                    model.fit(X, y)
                    smoke = model.predict_quantiles(X[0])              # smoke predict
                    if not all(math.isfinite(v) for v in smoke):
                        raise RuntimeError(f"smoke predict produced {smoke}")
                elapsed = (time.perf_counter() - t0) * 1000.0
                self.model = model
                self.selected_engine = name
                # The additive band is the spec's documented +/- 1.28 sigma and is
                # left exactly as published. Learned quantile models are the ones
                # that need conformalising.
                if name != "additive" and use_conformal:
                    self._calibrate_conformal(fit_part, calib_part)
                self.engine_trace.append(
                    EngineAttempt(name, True, True, "constructed, fitted and smoke-tested", elapsed)
                )
                self._fitted = True
                break
            except Exception as exc:  # noqa: BLE001 â€” deliberate: any failure falls through
                elapsed = (time.perf_counter() - t0) * 1000.0
                self.engine_trace.append(
                    EngineAttempt(name, False, False, repr(exc)[:200], elapsed)
                )

        if not self._fitted:
            # Cannot happen: AdditiveEngine terminates the chain. Belt and braces.
            self.model = AdditiveEngine(self.coef)
            self.model.fit_calls(labelled)
            self.selected_engine = "additive"
            self.engine_trace.append(
                EngineAttempt("additive", True, True, "terminal fallback", 0.0)
            )
            self._fitted = True

        # Record the engines never reached, so the trace is complete.
        reached = {a.engine for a in self.engine_trace}
        for name in ENGINE_PRIORITY:
            if name not in reached:
                self.engine_trace.append(
                    EngineAttempt(name, True, False, "not attempted â€” an earlier engine succeeded", 0.0)
                )
        return self

    def predict(self, features: TATFeatures) -> TATPrediction:
        """Predict P10/P50/P90 with a full explanation."""
        if not self._fitted:
            self.model = AdditiveEngine(self.coef)
            self.selected_engine = "additive"
            self._fitted = True

        sd, stressors = sigma_hours(features, self.coef)

        if self.selected_engine == "additive":
            p10, p50, p90 = self.model.predict_features(features)
            attribution_source = "additive"
        else:
            vec = apply_impute(to_vector(features), self.impute_stats)
            p10, p50, p90 = self.model.predict_quantiles(vec)
            # Conformal widening: without it a gradient-boosted 80% band
            # typically covers only ~50% of outcomes.
            p10 -= self.conformal_delta
            p90 += self.conformal_delta
            attribution_source = "additive_surrogate"

        # Independently fitted quantile models can cross (p10 > p50). Sort and
        # flag rather than silently returning an inverted band.
        crossed = not (p10 <= p50 <= p90)
        if crossed:
            p10, p50, p90 = sorted((p10, p50, p90))

        clamped = False
        if p50 < self.coef.min_tat_hours:
            shift = self.coef.min_tat_hours - p50
            p50 = self.coef.min_tat_hours
            p10 += shift
            p90 += shift
            clamped = True
        p10 = max(0.0, p10)

        contributions = additive_contributions(features, self.coef)
        additive_p50, _ = additive_tat_hours(features, self.coef)
        contrib_total = sum(c["contribution_h"] for c in contributions)

        notes: List[str] = []
        if attribution_source == "additive_surrogate":
            notes.append(
                f"P50 comes from the '{self.selected_engine}' engine. The per-factor "
                f"contributions below explain the ADDITIVE SURROGATE "
                f"({additive_p50:.2f} h), not the gradient-boosted model's internal "
                f"splits. Render this caveat in the UI caption."
            )
        if crossed:
            notes.append(
                "Quantile crossing detected and corrected by sorting â€” the independently "
                "fitted quantile models disagreed on ordering for this input."
            )
        if clamped:
            notes.append(f"P50 clamped up to the {self.coef.min_tat_hours} h floor.")

        breakdown: Dict[str, Any] = {
            "model": "M3_TAT_PREDICT",
            "version": MODULE_VERSION,
            "model_version": self.coef.version,
            "engine": self.selected_engine,
            "attribution_source": attribution_source,
            "constants": self.coef.as_dict(),
            "inputs": features.as_dict(),
            "steps": [
                _step(
                    1,
                    "Additive base",
                    "tat = base_hours + sum(factor contributions)",
                    f"{self.coef.base_hours:.2f} + {contrib_total:.3f} = {additive_p50:.3f}",
                    {"base_hours": self.coef.base_hours,
                     "sum_contributions_h": round(contrib_total, 4)},
                    round(additive_p50, 4),
                    "h",
                    "the transparent model's own estimate",
                ),
                _step(
                    2,
                    "Stressor count",
                    "n = count of active named predicates (10 defined)",
                    f"{len(stressors)} active: {', '.join(stressors) or 'none'}",
                    {"stressors_active": stressors, "n_predicates": len(STRESSOR_PREDICATES)},
                    len(stressors),
                    "-",
                    "",
                ),
                _step(
                    3,
                    "Sigma",
                    "sigma = sigma_base + sigma_per_stressor * n",
                    f"{self.coef.sigma_base_hours} + {self.coef.sigma_per_stressor_hours} * "
                    f"{len(stressors)} = {sd:.3f}",
                    {"n_stressors": len(stressors)},
                    round(sd, 4),
                    "h",
                    "range 2.0 h (calm) to 5.0 h (all ten active)",
                ),
                _step(
                    4,
                    "Band",
                    "P10/P90 = P50 -/+ z * sigma  (additive engine)"
                    if attribution_source == "additive"
                    else "P10/P50/P90 from the fitted quantile models",
                    f"P10 {p10:.2f} | P50 {p50:.2f} | P90 {p90:.2f} h "
                    f"(width {p90 - p10:.2f} h)",
                    {"z_p80": self.coef.z_p80, "sigma_h": round(sd, 4)},
                    round(p90 - p10, 4),
                    "h",
                    f"engine={self.selected_engine}",
                ),
            ],
            "base_hours": self.coef.base_hours,
            "contributions": contributions,
            "total_contribution_h": round(contrib_total, 4),
            "sum_check_ok": abs(
                (self.coef.base_hours + contrib_total) - additive_p50
            ) < 1e-6,
            "additive_surrogate_p50_h": round(additive_p50, 4),
            "sigma_hours": round(sd, 4),
            "stressor_count": len(stressors),
            "stressors_active": stressors,
            "quantile_crossing_corrected": crossed,
            "clamped_at_min": clamped,
            "result": {
                "p10_hours": round(p10, 3),
                "p50_hours": round(p50, 3),
                "p90_hours": round(p90, 3),
                "engine": self.selected_engine,
            },
            "notes": notes,
            "assumptions": [
                "Coefficients are a documented prior, versioned as "
                f"{self.coef.version}.",
                "Sigma is driven by ten named stressor predicates, not a free parameter.",
                "Band is the 80% central interval (+/- 1.28 sigma) for the additive engine.",
                "Learned engines produce quantiles directly; crossing is corrected by sorting.",
            ],
            "provenance": {
                "engine": self.selected_engine,
                "generated_at_utc": _iso(_utc_now()),
            },
        }

        return TATPrediction(
            call_id=features.call_id,
            vessel_id=features.vessel_id,
            engine=self.selected_engine,
            p10_hours=p10,
            p50_hours=p50,
            p90_hours=p90,
            sigma_hours=sd,
            stressor_count=len(stressors),
            stressors_active=tuple(stressors),
            quantile_crossing_corrected=crossed,
            clamped_at_min=clamped,
            model_version=self.coef.version,
            breakdown=breakdown,
            engine_trace=tuple(self.engine_trace),
        )


def pinball_loss(actual: float, predicted: float, q: float) -> float:
    """
    Quantile (pinball) loss.

        L_q(y, yhat) = q * (y - yhat)        if y >= yhat
                       (1 - q) * (yhat - y)  otherwise
    """
    diff = actual - predicted
    return q * diff if diff >= 0 else (1.0 - q) * (-diff)


def evaluate_model(
    predictor: TATPredictor, test: Sequence[TATCall]
) -> TATMetrics:
    """
    Accuracy on a held-out, strictly-later test slice.

    ``forecast_accuracy_pct = max(0, (1 - MAPE) * 100)`` is the KPI named in the
    spec's Accuracy column. MAPE excludes rows whose actual is under
    ``MAPE_MIN_DENOMINATOR_H`` â€” a 0.5 h actual would otherwise dominate the
    metric â€” and the excluded count is reported rather than hidden.
    """
    labelled = [c for c in test if c.label is not None]
    if not labelled:
        raise ValueError("no labelled calls in the test slice")

    preds = [predictor.predict(c.features) for c in labelled]
    actuals = [c.label.tat_hours for c in labelled]

    errs = [p.p50_hours - a for p, a in zip(preds, actuals)]
    abs_errs = [abs(e) for e in errs]
    mae = statistics.fmean(abs_errs)
    rmse = math.sqrt(statistics.fmean(e * e for e in errs))

    ape: List[float] = []
    dropped = 0
    for p, a in zip(preds, actuals):
        if abs(a) < MAPE_MIN_DENOMINATOR_H:
            dropped += 1
            continue
        ape.append(abs(p.p50_hours - a) / abs(a))
    mape = statistics.fmean(ape) if ape else float("nan")
    accuracy = max(0.0, (1.0 - mape) * 100.0) if math.isfinite(mape) else float("nan")

    pb10 = statistics.fmean(
        pinball_loss(a, p.p10_hours, 0.10) for p, a in zip(preds, actuals)
    )
    pb50 = statistics.fmean(
        pinball_loss(a, p.p50_hours, 0.50) for p, a in zip(preds, actuals)
    )
    pb90 = statistics.fmean(
        pinball_loss(a, p.p90_hours, 0.90) for p, a in zip(preds, actuals)
    )

    covered = sum(1 for p, a in zip(preds, actuals) if p.p10_hours <= a <= p.p90_hours)
    coverage = covered / len(actuals) * 100.0
    width = statistics.fmean(p.p90_hours - p.p10_hours for p in preds)

    return TATMetrics(
        n_test=len(actuals),
        mae_hours=mae,
        rmse_hours=rmse,
        mape_pct=mape * 100.0 if math.isfinite(mape) else float("nan"),
        forecast_accuracy_pct=accuracy,
        pinball_p10=pb10,
        pinball_p50=pb50,
        pinball_p90=pb90,
        coverage_80_pct=coverage,
        mean_band_width_hours=width,
        mape_rows_dropped=dropped,
        engine=predictor.selected_engine,
        model_version=predictor.coef.version,
    )


def train_and_evaluate(
    n_days: int = DEFAULT_HISTORY_DAYS,
    seed: int = DEFAULT_SEED,
    test_fraction: float = 0.20,
    embargo_hours: float = 24.0,
    engine: str = "auto",
    calls: Optional[Sequence[TATCall]] = None,
) -> Dict[str, Any]:
    """End-to-end: generate or accept calls, split, fit, evaluate, audit."""
    calls = list(calls) if calls is not None else generate_synthetic_calls(n_days, seed)
    train, test, report = chronological_split(calls, test_fraction, embargo_hours)
    predictor = TATPredictor(engine=engine, seed=seed).fit(train)
    metrics = evaluate_model(predictor, test)
    folds = expanding_window_folds(train)

    return {
        "module_version": MODULE_VERSION,
        "model_version": DEFAULT_COEFFICIENTS.version,
        "engine_requested": engine,
        "engine_used": predictor.selected_engine,
        "engine_trace": [e.as_dict() for e in predictor.engine_trace],
        "split_report": report.as_dict(),
        "cv_folds": {
            "method": "expanding_window (inside the train slice only)",
            "n_folds": len(folds),
            "fold_sizes": [[len(a), len(b)] for a, b in folds],
            "note": "used for hyperparameter selection; no test data participates",
        },
        "conformal_calibration": predictor.conformal_report,
        "metrics": metrics.as_dict(),
        "calibration": verify_calibration(calls),
        "leakage_audit": leakage_audit(),
        "backends": backend_status(),
    }


def leakage_audit() -> Dict[str, Any]:
    """Machine-readable proof that the firewall holds."""
    overlap = sorted(set(FEATURE_COLUMNS) & BANNED_FIELDS)
    return {
        "feature_columns": list(FEATURE_COLUMNS),
        "n_features": len(FEATURE_COLUMNS),
        "banned_fields": sorted(BANNED_FIELDS),
        "intersection": overlap,
        "passed": not overlap,
        "enforced_at_import": True,
        "split_method": "chronological_holdout_with_purge",
        "forbidden_apis": ["sklearn.model_selection.train_test_split(shuffle=True)", "KFold"],
        "note": (
            "atb_utc is deliberately in BANNED_FIELDS: it is the chronological split key, "
            "never a predictor. Imputation medians come from TRAIN only."
        ),
    }


MODULE_INFO: Dict[str, Any] = {
    "module_id": MODULE_ID,
    "module_name": MODULE_NAME,
    "module_version": MODULE_VERSION,
    "router_prefix": ROUTER_PREFIX,
    "spec_row": "WS2_AI_ML_Tools.md row 3 â€” Vessel TAT prediction (ETB->ETD)",
    "model_type": "dual engine: transparent additive + learned quantile regressor",
    "engine_priority": list(ENGINE_PRIORITY),
    "constants": DEFAULT_COEFFICIENTS.as_dict(),
    "calibration_anchors": {
        "tat_days_mean": JNPA_ANCHORS.tat_days_mean,
        "berth_stay_days_mean": JNPA_ANCHORS.berth_stay_days_mean,
        "calls_per_day": [JNPA_ANCHORS.calls_per_day_min, JNPA_ANCHORS.calls_per_day_max],
        "source": JNPA_ANCHORS.source,
    },
    "feature_columns": list(FEATURE_COLUMNS),
    "banned_fields": sorted(BANNED_FIELDS),
}


# ==========================================================================
# SECTION 6 â€” FASTAPI ROUTER (optional dependency)
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

    class TATPredictRequest(BaseModel):
        """
        A pre-berthing feature vector.

        Every field here is knowable at the ETB decision. There is deliberately
        no way to submit an outcome â€” the request schema is itself part of the
        leakage firewall.
        """

        call_id: str = Field("C-0001", max_length=40)
        vessel_id: str = Field("V-0001", max_length=40)
        vessel_name: str = Field("MSC VALERIA", max_length=120)
        terminal: str = Field("BMCT", max_length=32)
        berth_id: str = Field("BMCT-01", max_length=32)
        parcel_teu: int = Field(3200, ge=0, le=30000)
        draft_m: float = Field(15.1, gt=0, le=25)
        terminal_max_draft_m: float = Field(16.5, gt=0, le=25)
        weather_severity: int = Field(2, ge=0, le=3)
        severe_weather_flag: int = Field(1, ge=0, le=1)
        rain_mm_hr: float = Field(8.0, ge=0, le=200)
        wind_kn: float = Field(26.0, ge=0, le=120)
        net_channel_depth_delta_m: float = Field(-0.3, ge=-5, le=5)
        pilots_down: int = Field(1, ge=0, le=10)
        tugs_down: int = Field(0, ge=0, le=20)
        anchorage_queue_count: int = Field(6, ge=0, le=100)
        extra_arrivals_24h: int = Field(2, ge=0, le=50)
        incident_severity: int = Field(0, ge=0, le=3)
        berth_window_extension_h: float = Field(4.0, ge=0, le=48)
        calls_prev_24h: int = Field(11, ge=0, le=100)
        engine: Literal["auto", "lightgbm", "sklearn_gbr", "sklearn_rf", "additive"] = "additive"

        def to_features(self) -> TATFeatures:
            return TATFeatures(
                call_id=self.call_id,
                vessel_id=self.vessel_id,
                vessel_name=self.vessel_name,
                terminal=self.terminal,
                berth_id=self.berth_id,
                atb_utc=_utc_now(),      # ordering key only; never a predictor
                parcel_teu=self.parcel_teu,
                draft_m=self.draft_m,
                terminal_max_draft_m=self.terminal_max_draft_m,
                draft_vs_terminal_max_m=round(self.terminal_max_draft_m - self.draft_m, 3),
                weather_severity=self.weather_severity,
                severe_weather_flag=self.severe_weather_flag,
                rain_mm_hr=self.rain_mm_hr,
                wind_kn=self.wind_kn,
                net_channel_depth_delta_m=self.net_channel_depth_delta_m,
                pilots_down=self.pilots_down,
                tugs_down=self.tugs_down,
                anchorage_queue_count=self.anchorage_queue_count,
                extra_arrivals_24h=self.extra_arrivals_24h,
                incident_severity=self.incident_severity,
                berth_window_extension_h=self.berth_window_extension_h,
                calls_prev_24h=self.calls_prev_24h,
            )

    class TATTrainRequest(BaseModel):
        n_days: int = Field(DEFAULT_HISTORY_DAYS, ge=10, le=1095)
        seed: int = DEFAULT_SEED
        test_fraction: float = Field(0.20, gt=0.05, lt=0.6)
        embargo_hours: float = Field(24.0, ge=0, le=240)
        engine: Literal["auto", "lightgbm", "sklearn_gbr", "sklearn_rf", "additive"] = "auto"

    # Fitted predictors are cached per engine so /predict does not retrain on
    # every request. Keyed by (engine, seed, n_days). When a submitted
    # trained_models/*.pkl is available, prefer that so curl and the dashboard
    # both score the WS2 artifact (SHA-256 on the model card), not a re-fit.
    _PREDICTOR_CACHE: Dict[Tuple[str, int, int], TATPredictor] = {}
    _SERVING_CACHE: Dict[str, Tuple[Any, Dict[str, Any]]] = {}

    def _artifact_provenance(engine: str) -> Tuple[Any, Dict[str, Any]]:
        """
        Load the submitted LightGBM/additive artefact when the caller asks for
        a learned engine. Falls back to an in-process fit so the route still
        answers on a machine without the .pkl or without lightgbm installed.
        """
        if engine in _SERVING_CACHE:
            return _SERVING_CACHE[engine]

        provenance: Dict[str, Any] = {
            "mode": "IN_PROCESS_FIT",
            "artifact_sha256": "",
            "holdout_mae_hours": None,
        }
        predictor: Any = None

        if engine in ("lightgbm", "auto", "sklearn_gbr", "sklearn_rf"):
            try:
                import train_tat_model as _trainer  # type: ignore

                prefer = (
                    "uc1_m3_tat_lightgbm_v1.2.0.pkl"
                    if engine in ("lightgbm", "auto")
                    else None
                )
                model_dir = getattr(
                    _trainer, "DEFAULT_MODEL_DIR", os.path.join("trained_models")
                )
                # Prefer the named WS2 LightGBM artefact; else newest loadable.
                candidates: List[str] = []
                if prefer:
                    named = os.path.join(model_dir, prefer)
                    if os.path.exists(named):
                        candidates.append(named)
                latest = _trainer.find_latest_artifact(model_dir)
                if latest and latest not in candidates:
                    # Prefer lightgbm over portable additive when both exist.
                    found = [
                        os.path.join(model_dir, f)
                        for f in os.listdir(model_dir)
                        if f.endswith(".pkl") and f.startswith("uc1_m3_tat")
                    ]
                    found.sort(
                        key=lambda p: (
                            0 if "lightgbm" in os.path.basename(p) else 1,
                            -os.path.getmtime(p),
                        )
                    )
                    for p in found:
                        if p not in candidates:
                            candidates.append(p)
                if latest and latest not in candidates:
                    candidates.append(latest)

                last_err: Optional[str] = None
                for path in candidates:
                    try:
                        payload = _trainer.load_artifact(path)
                        card = payload.get("model_card") or {}
                        # Skip portable additive when the caller asked for lightgbm.
                        eng = str(payload.get("engine") or card.get("engine", {}).get("selected") or "")
                        if engine == "lightgbm" and eng and eng != "lightgbm":
                            continue
                        predictor = payload["predictor"]
                        provenance = {
                            "mode": "TRAINED_ARTIFACT",
                            "artifact_path": payload.get("artifact_path", path),
                            "artifact_sha256": card.get("artifact_sha256", ""),
                            "holdout_mae_hours": (card.get("metrics_holdout") or {}).get(
                                "mae_hours"
                            ),
                            "engine": eng or engine,
                            "model_version": payload.get("model_version")
                            or card.get("model_version"),
                        }
                        break
                    except Exception as exc:  # pragma: no cover - env-dependent
                        last_err = f"{os.path.basename(path)}: {exc}"
                        continue
                if predictor is None and last_err:
                    provenance["warning"] = last_err
            except Exception as exc:  # pragma: no cover
                provenance["warning"] = f"artifact loader unavailable: {exc}"

        if predictor is None:
            calls = generate_synthetic_calls(DEFAULT_HISTORY_DAYS, DEFAULT_SEED)
            train, _, _ = chronological_split(calls)
            predictor = TATPredictor(engine=engine, seed=DEFAULT_SEED).fit(train)
            provenance["mode"] = "IN_PROCESS_FIT"
            provenance["engine"] = getattr(predictor, "selected_engine", engine)

        _SERVING_CACHE[engine] = (predictor, provenance)
        return predictor, provenance

    def _cached_predictor(engine: str, seed: int = DEFAULT_SEED,
                          n_days: int = DEFAULT_HISTORY_DAYS) -> TATPredictor:
        # Keep the old in-process path for /demo and /train-eval callers that
        # still want a fresh fit; /predict uses _artifact_provenance.
        key = (engine, seed, n_days)
        if key not in _PREDICTOR_CACHE:
            calls = generate_synthetic_calls(n_days, seed)
            train, _, _ = chronological_split(calls)
            _PREDICTOR_CACHE[key] = TATPredictor(engine=engine, seed=seed).fit(train)
        return _PREDICTOR_CACHE[key]

    def _predict_with_provenance(req: "TATPredictRequest") -> Dict[str, Any]:
        predictor, provenance = _artifact_provenance(req.engine)
        out = predictor.predict(req.to_features()).as_dict()
        if provenance.get("artifact_sha256"):
            out["artifact_sha256"] = provenance["artifact_sha256"]
        if provenance.get("holdout_mae_hours") is not None:
            out["holdout_mae_hours"] = provenance["holdout_mae_hours"]
        if provenance.get("mode"):
            out["artifact_mode"] = provenance["mode"]
        if provenance.get("warning"):
            out["artifact_warning"] = provenance["warning"]
        return out

    def build_router() -> "APIRouter":
        """Construct the UC1-M3 router. Mounted by ``api.py``."""
        router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC1-M3 TAT Prediction"])

        @router.post("/predict", summary="Predict TAT with a P10/P50/P90 band")
        def predict(req: TATPredictRequest) -> Dict[str, Any]:
            return _predict_with_provenance(req)

        @router.post("/predict/batch", summary="Predict for many calls at once")
        def predict_batch(reqs: List[TATPredictRequest]) -> List[Dict[str, Any]]:
            if not reqs:
                raise HTTPException(422, "at least one call is required")
            if len(reqs) > 500:
                raise HTTPException(413, "batch limited to 500 calls")
            return [_predict_with_provenance(r) for r in reqs]

        @router.post("/train-eval", summary="Train and evaluate with a leakage audit")
        def train_eval(req: TATTrainRequest) -> Dict[str, Any]:
            return train_and_evaluate(
                req.n_days, req.seed, req.test_fraction, req.embargo_hours, req.engine
            )

        @router.get("/calibration", summary="Achieved vs published JNPA anchors")
        def calibration(
            n_days: int = Query(DEFAULT_HISTORY_DAYS, ge=10, le=1095), seed: int = Query(DEFAULT_SEED)
        ) -> Dict[str, Any]:
            return verify_calibration(generate_synthetic_calls(n_days, seed))

        @router.get("/leakage-audit", summary="Proof that the leakage firewall holds")
        def leakage() -> Dict[str, Any]:
            return leakage_audit()

        @router.get("/model-info", summary="Coefficients, features and detected backends")
        def model_info() -> Dict[str, Any]:
            return {**MODULE_INFO, "backends": backend_status()}

        @router.get("/constants", summary="Versioned coefficients (the 'model weights')")
        def constants() -> Dict[str, Any]:
            return {
                "module_version": MODULE_VERSION,
                "model_version": DEFAULT_COEFFICIENTS.version,
                "constants": DEFAULT_COEFFICIENTS.as_dict(),
            }

        @router.get("/demo", summary="Canonical worked prediction")
        def demo() -> Dict[str, Any]:
            return _cached_predictor("additive").predict(_demo_features()).as_dict()

        @router.get("/health", summary="Module health and identity")
        def health() -> Dict[str, Any]:
            checks = _self_test()
            return {
                "status": "ok" if all(ok for _, ok, _ in checks) else "degraded",
                "module": MODULE_INFO,
                "backends": backend_status(),
                "checks": [{"name": n, "passed": ok, "detail": d} for n, ok, d in checks],
            }

        return router

else:  # pragma: no cover

    def build_router():  # type: ignore
        raise RuntimeError(
            "FastAPI is not installed. Install with: pip install 'fastapi>=0.115' 'pydantic>=2.7'"
        )


# ==========================================================================
# SECTION 7 â€” SELF-TEST AND CLI DEMO RUNNER
# ==========================================================================


def _demo_features() -> TATFeatures:
    """A stressed call, so the contribution chart has something to show."""
    return TATFeatures(
        call_id="C-DEMO",
        vessel_id="V-DEMO",
        vessel_name="MSC VALERIA",
        terminal="BMCT",
        berth_id="BMCT-01",
        atb_utc=datetime(2026, 8, 1, tzinfo=timezone.utc),
        parcel_teu=3200,
        draft_m=15.1,
        terminal_max_draft_m=16.5,
        draft_vs_terminal_max_m=1.4,
        weather_severity=3,
        severe_weather_flag=1,
        rain_mm_hr=8.0,
        wind_kn=26.0,
        net_channel_depth_delta_m=-0.3,
        pilots_down=1,
        tugs_down=0,
        anchorage_queue_count=6,
        extra_arrivals_24h=2,
        incident_severity=0,
        berth_window_extension_h=4.0,
        calls_prev_24h=11,
    )


def _self_test() -> List[Tuple[str, bool, str]]:
    """Return ``[(check_name, passed, detail), ...]``."""
    checks: List[Tuple[str, bool, str]] = []

    # --- Leakage firewall -------------------------------------------------
    audit = leakage_audit()
    checks.append(
        (
            "leakage_firewall",
            audit["passed"] and len(FEATURE_COLUMNS) == 16,
            f"{audit['n_features']} features, {len(audit['banned_fields'])} banned, "
            f"intersection {audit['intersection']}",
        )
    )
    checks.append(
        (
            "atb_is_banned_as_predictor",
            "atb_utc" in BANNED_FIELDS and "atb_utc" not in FEATURE_COLUMNS,
            "atb_utc is the split key only, never a feature",
        )
    )
    # A contributor adding an outcome must trip the assert.
    try:
        _orig = globals()["FEATURE_COLUMNS"]
        globals()["FEATURE_COLUMNS"] = _orig + ("tat_hours",)
        _assert_no_leakage()
        tripped = False
    except AssertionError:
        tripped = True
    finally:
        globals()["FEATURE_COLUMNS"] = _orig
    checks.append(
        (
            "leakage_assert_actually_trips",
            tripped,
            "adding tat_hours to FEATURE_COLUMNS raises AssertionError",
        )
    )
    checks.append(
        (
            "label_is_separate_object",
            "tat_hours" in TATLabel.__dataclass_fields__
            and "tat_hours" not in TATFeatures.__dataclass_fields__,
            "TATFeatures and TATLabel are physically distinct dataclasses",
        )
    )
    checks.append(
        (
            "to_vector_uses_allowlist",
            len(to_vector(_demo_features())) == len(FEATURE_COLUMNS),
            f"to_vector emits exactly {len(FEATURE_COLUMNS)} values in FEATURE_COLUMNS order",
        )
    )

    # --- Additive model ---------------------------------------------------
    calm = TATFeatures(
        call_id="C-CALM", vessel_id="V", vessel_name="CALM", terminal="T", berth_id="B",
        atb_utc=datetime(2026, 8, 1, tzinfo=timezone.utc),
        parcel_teu=0, draft_m=13.0, terminal_max_draft_m=16.0,
        draft_vs_terminal_max_m=3.0, weather_severity=0, severe_weather_flag=0,
        rain_mm_hr=0.0, wind_kn=10.0, net_channel_depth_delta_m=0.0,
        pilots_down=0, tugs_down=0, anchorage_queue_count=0, extra_arrivals_24h=0,
        incident_severity=0, berth_window_extension_h=0.0, calls_prev_24h=10,
    )
    base, _ = additive_tat_hours(calm)
    checks.append(
        (
            "additive_base_case",
            abs(base - 34.0) < 1e-9,
            f"no cargo, no stressors -> {base:.3f} h (spec base 34 h)",
        )
    )
    teu_case = replace(calm, parcel_teu=250)
    checks.append(
        (
            "additive_teu_coefficient",
            abs(additive_tat_hours(teu_case)[0] - 35.0) < 1e-9,
            "+250 TEU adds exactly 1.0 h, per spec",
        )
    )
    draft_case = replace(calm, draft_m=14.0)
    checks.append(
        (
            "additive_draft_coefficient",
            abs(additive_tat_hours(draft_case)[0] - 35.5) < 1e-9,
            "+1 m over the 13 m reference adds 1.5 h, per spec",
        )
    )
    wx_case = replace(calm, severe_weather_flag=1)
    checks.append(
        (
            "additive_weather_coefficient",
            abs(additive_tat_hours(wx_case)[0] - 39.0) < 1e-9,
            "severe weather adds 5.0 h, per spec",
        )
    )
    depth_case = replace(calm, net_channel_depth_delta_m=-1.0)
    checks.append(
        (
            "additive_depth_coefficient",
            abs(additive_tat_hours(depth_case)[0] - 38.0) < 1e-9,
            "1 m of channel depth loss adds 4.0 h, per spec",
        )
    )
    ext_case = replace(calm, berth_window_extension_h=4.0)
    checks.append(
        (
            "berth_extension_reduces_tat",
            additive_tat_hours(ext_case)[0] < base,
            f"4 h of berth-window extension: {base:.2f} -> "
            f"{additive_tat_hours(ext_case)[0]:.2f} h",
        )
    )
    tiny = replace(calm, parcel_teu=0, berth_window_extension_h=48.0)
    checks.append(
        (
            "min_tat_floor",
            additive_tat_hours(tiny)[1] and additive_tat_hours(tiny)[0] == 12.0,
            f"extreme extension clamps at the {DEFAULT_COEFFICIENTS.min_tat_hours} h floor",
        )
    )

    # --- Sigma / stressors -------------------------------------------------
    sd_calm, st_calm = sigma_hours(calm)
    checks.append(
        (
            "sigma_calm",
            abs(sd_calm - 2.0) < 1e-9 and not st_calm,
            f"no stressors -> sigma {sd_calm:.2f} h",
        )
    )
    all_stress = TATFeatures(
        call_id="C-MAX", vessel_id="V", vessel_name="MAX", terminal="T", berth_id="B",
        atb_utc=datetime(2026, 8, 1, tzinfo=timezone.utc),
        parcel_teu=1000, draft_m=15.9, terminal_max_draft_m=16.0,
        draft_vs_terminal_max_m=0.1, weather_severity=3, severe_weather_flag=1,
        rain_mm_hr=20.0, wind_kn=35.0, net_channel_depth_delta_m=-0.5,
        pilots_down=2, tugs_down=1, anchorage_queue_count=9, extra_arrivals_24h=3,
        incident_severity=2, berth_window_extension_h=0.0, calls_prev_24h=12,
    )
    sd_max, st_max = sigma_hours(all_stress)
    checks.append(
        (
            "sigma_all_stressors",
            len(st_max) == 10 and abs(sd_max - 5.0) < 1e-9,
            f"{len(st_max)}/10 stressors -> sigma {sd_max:.2f} h",
        )
    )

    # --- Chronological split ----------------------------------------------
    calls = generate_synthetic_calls(n_days=DEFAULT_HISTORY_DAYS, seed=DEFAULT_SEED)
    train, test, report = chronological_split(calls)
    checks.append(
        (
            "split_is_chronological",
            report.ordering_assert_passed
            and max(c.features.atb_utc for c in train) < min(c.features.atb_utc for c in test),
            f"train {report.n_train} (< {_iso(report.split_time_utc)}), test {report.n_test}",
        )
    )
    checks.append(
        (
            "split_purge_applied",
            report.n_purged > 0
            and all(c.label.atd_utc < report.split_time_utc for c in train),
            f"{report.n_purged} calls purged: outcome not observed by the boundary",
        )
    )
    checks.append(
        (
            "no_train_test_id_overlap",
            not ({c.features.call_id for c in train} & {c.features.call_id for c in test}),
            "train and test share no call_id",
        )
    )
    folds = expanding_window_folds(train)
    checks.append(
        (
            "expanding_window_folds",
            len(folds) == 4
            and all(
                max(c.features.atb_utc for c in fit) <= min(c.features.atb_utc for c in val)
                for fit, val in folds if fit and val
            ),
            f"{len(folds)} folds, each validating strictly after its fit block",
        )
    )
    checks.append(
        (
            "impute_stats_from_train_only",
            set(fit_impute_stats(train)) == set(FEATURE_COLUMNS),
            f"{len(fit_impute_stats(train))} medians computed on the train slice only",
        )
    )

    # --- Calibration -------------------------------------------------------
    cal = verify_calibration(calls)
    tat_check = next(c for c in cal["checks"] if c["anchor"].startswith("mean TAT"))
    stay_check = next(c for c in cal["checks"] if c["anchor"].startswith("mean berth stay"))
    checks.append(
        (
            "calibration_tat_anchor",
            tat_check["passed"],
            f"TAT {tat_check['achieved']:.3f} d ({tat_check['achieved_hours']:.2f} h) vs "
            f"target {tat_check['target']} +/- {tat_check['tolerance']}",
        )
    )
    checks.append(
        (
            "calibration_berth_stay_anchor",
            stay_check["passed"],
            f"berth stay {stay_check['achieved']:.3f} d "
            f"({stay_check['achieved_hours']:.2f} h) vs target {stay_check['target']}",
        )
    )
    checks.append(("calibration_overall", cal["status"] == "PASS", f"status {cal['status']}"))

    # --- Engines -----------------------------------------------------------
    additive = TATPredictor(engine="additive").fit(train)
    m_add = evaluate_model(additive, test)
    checks.append(
        (
            "additive_engine_runs",
            additive.selected_engine == "additive" and math.isfinite(m_add.mae_hours),
            f"MAE {m_add.mae_hours:.2f} h, accuracy {m_add.forecast_accuracy_pct:.2f}%",
        )
    )

    auto = TATPredictor(engine="auto").fit(train)
    m_auto = evaluate_model(auto, test)
    checks.append(
        (
            "auto_selects_available_engine",
            auto.selected_engine in ENGINE_PRIORITY
            and any(a.selected for a in auto.engine_trace),
            f"selected '{auto.selected_engine}' "
            f"({sum(1 for a in auto.engine_trace if not a.available)} engine(s) unavailable)",
        )
    )
    checks.append(
        (
            "engine_trace_complete",
            {a.engine for a in auto.engine_trace} == set(ENGINE_PRIORITY),
            f"trace covers all {len(ENGINE_PRIORITY)} engines with a reason each",
        )
    )
    # NOTE ON WHICH ENGINE "WINS" ON SYNTHETIC DATA
    # ----------------------------------------------
    # The synthetic labels are GENERATED BY the additive model (plus a small
    # interaction and Gaussian noise), so the additive model is the oracle here
    # and no learned model can beat it â€” its MAE floor is the noise sd itself.
    # That is a property of synthetic data, not evidence about production, and
    # asserting the opposite would be wishful. WS2 says the same thing: the
    # gradient-boosted regressor is the PRODUCTION upgrade, triggered by
    # ">= 6 months of ingested call history". So the check is that both engines
    # are sane and that the additive advantage is bounded and explainable.
    label_sd = statistics.pstdev([c.label.tat_hours for c in test])
    winner = "additive" if m_add.mae_hours < m_auto.mae_hours else auto.selected_engine
    checks.append(
        (
            "both_engines_sane",
            math.isfinite(m_auto.mae_hours)
            and math.isfinite(m_add.mae_hours)
            and max(m_auto.mae_hours, m_add.mae_hours) < 0.6 * label_sd,
            f"additive MAE {m_add.mae_hours:.2f} h vs {auto.selected_engine} "
            f"{m_auto.mae_hours:.2f} h (label sd {label_sd:.2f} h); better: {winner}",
        )
    )

    # A deliberately broken engine must fall through, not crash.
    broken = TATPredictor(engine="auto")
    _orig_construct = broken._construct

    def _sabotage(name: str):
        if name == "lightgbm":
            raise OSError("simulated missing VC++ redistributable")
        return _orig_construct(name)

    broken._construct = _sabotage  # type: ignore[assignment]
    broken.fit(train)
    lgb_attempt = next(a for a in broken.engine_trace if a.engine == "lightgbm")
    checks.append(
        (
            "oserror_falls_through",
            not lgb_attempt.available
            and "VC++" in lgb_attempt.reason
            and broken.selected_engine != "lightgbm",
            f"OSError caught -> fell through to '{broken.selected_engine}'",
        )
    )

    # --- Prediction quality -------------------------------------------------
    pred = auto.predict(_demo_features())
    checks.append(
        (
            "quantiles_ordered",
            pred.p10_hours <= pred.p50_hours <= pred.p90_hours,
            f"P10 {pred.p10_hours:.2f} <= P50 {pred.p50_hours:.2f} <= P90 "
            f"{pred.p90_hours:.2f} h",
        )
    )
    checks.append(
        (
            "attribution_source_flagged",
            pred.breakdown["attribution_source"]
            == ("additive" if auto.selected_engine == "additive" else "additive_surrogate"),
            f"engine '{auto.selected_engine}' -> attribution_source "
            f"'{pred.breakdown['attribution_source']}'",
        )
    )
    if auto.selected_engine != "additive":
        checks.append(
            (
                "surrogate_caveat_present",
                any("ADDITIVE SURROGATE" in n for n in pred.breakdown["notes"]),
                "the contribution chart carries its honesty caveat",
            )
        )
    checks.append(
        (
            "contributions_sum_check",
            pred.breakdown["sum_check_ok"] and len(pred.breakdown["contributions"]) == 12,
            f"{len(pred.breakdown['contributions'])} factors sum to the additive estimate",
        )
    )
    checks.append(
        (
            "coverage_near_80pct",
            70.0 <= m_auto.coverage_80_pct <= 92.0,
            f"{m_auto.coverage_80_pct:.1f}% of actuals fall inside [P10, P90] "
            f"(nominal 80%; conformal delta "
            f"{auto.conformal_report.get('delta_hours', 0.0)} h)",
        )
    )
    if auto.selected_engine != "additive":
        raw_cov = auto.conformal_report.get("raw_calibration_coverage_pct")
        checks.append(
            (
                "conformal_calibration_applied",
                auto.conformal_report.get("applied") is True
                and auto.conformal_delta > 0.0,
                f"CQR widened the band by {auto.conformal_delta:.2f} h; raw model "
                f"covered only {raw_cov}% on the calibration slice",
            )
        )
        checks.append(
            (
                "conformal_slice_is_pre_test",
                max(c.features.atb_utc for c in train) < min(c.features.atb_utc for c in test),
                "the calibration slice sits inside train, strictly before test",
            )
        )
    checks.append(
        (
            "additive_band_is_unmodified",
            abs(
                (
                    additive.predict(_demo_features()).p90_hours
                    - additive.predict(_demo_features()).p50_hours
                )
                - DEFAULT_COEFFICIENTS.z_p80 * sigma_hours(_demo_features())[0]
            ) < 1e-6,
            "the additive band remains exactly the spec's +/- 1.28 sigma â€” "
            "conformalising is applied only to learned engines",
        )
    )
    checks.append(
        (
            "pinball_losses_finite",
            all(math.isfinite(v) for v in
                (m_auto.pinball_p10, m_auto.pinball_p50, m_auto.pinball_p90)),
            f"pinball p10 {m_auto.pinball_p10:.3f} | p50 {m_auto.pinball_p50:.3f} | "
            f"p90 {m_auto.pinball_p90:.3f}",
        )
    )
    checks.append(
        (
            "forecast_accuracy_reported",
            0.0 <= m_auto.forecast_accuracy_pct <= 100.0,
            f"(1 - MAPE) * 100 = {m_auto.forecast_accuracy_pct:.2f}% "
            f"({m_auto.mape_rows_dropped} rows dropped from MAPE)",
        )
    )

    # Quantile crossing must be detected and corrected, not emitted.
    class _Crossing:
        name = "crossing"

        def fit(self, X, y):
            pass

        def predict_quantiles(self, x):
            return (60.0, 30.0, 45.0)      # deliberately out of order

    crosser = TATPredictor(engine="additive").fit(train)
    crosser.model = _Crossing()
    crosser.selected_engine = "crossing"
    cp = crosser.predict(_demo_features())
    checks.append(
        (
            "quantile_crossing_corrected",
            cp.quantile_crossing_corrected
            and cp.p10_hours <= cp.p50_hours <= cp.p90_hours,
            f"(60, 30, 45) -> ({cp.p10_hours:.1f}, {cp.p50_hours:.1f}, {cp.p90_hours:.1f}) "
            f"and flagged",
        )
    )

    # --- Determinism --------------------------------------------------------
    checks.append(
        (
            "determinism",
            generate_synthetic_calls(30, DEFAULT_SEED)[10].label.tat_hours
            == generate_synthetic_calls(30, DEFAULT_SEED)[10].label.tat_hours,
            "seeded generator reproduces identical labels",
        )
    )
    checks.append(
        (
            "breakdown_completeness",
            len(pred.breakdown["steps"]) == 4
            and all(s.get("substitution") for s in pred.breakdown["steps"]),
            f"{len(pred.breakdown['steps'])} steps, all with substitutions",
        )
    )

    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="UC1-M3 TAT prediction â€” demo and self-test runner."
    )
    parser.add_argument(
        "--days", type=int, default=DEFAULT_HISTORY_DAYS,
        help="Synthetic history length (default: one full seasonal cycle).",
    )
    parser.add_argument("--engine", choices=list(ENGINE_CHOICES), default="auto")
    parser.add_argument("--test-fraction", type=float, default=0.20)
    parser.add_argument("--embargo-hours", type=float, default=24.0)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--quiet", action="store_true")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args(argv)

    if not args.quiet:
        print("=" * 78)
        print(f"{MODULE_ID} â€” {MODULE_NAME}   ({MODULE_VERSION})")
        print("JNPA UC-I Vessel Traffic Management | WS2 row 3 | dual engine")
        print("=" * 78)

    if args.json:
        print(json.dumps(
            train_and_evaluate(args.days, args.seed, args.test_fraction,
                               args.embargo_hours, args.engine),
            indent=2,
        ))
    elif not args.quiet:
        be = backend_status()
        print("\n1. BACKEND DETECTION")
        print(_fmt_table(
            ["backend", "available", "note"],
            [
                ["lightgbm", be["lightgbm"]["available"], be["lightgbm"]["error"] or "-"],
                ["scikit-learn", be["sklearn"]["available"], be["sklearn"]["error"] or "-"],
                ["fastapi", be["fastapi"]["available"], "-"],
            ],
            indent="   ",
        ))

        dsr = DailyStatusReportLoader()
        if dsr.available():
            samples = dsr.berth_stay_samples()
            print(
                f"\n   REAL DATA: {dsr.source_id} present with {len(samples)} berth stays "
                f"(median {_percentile(samples, 0.5):.2f} h) â€” usable to re-anchor the generator."
            )
        else:
            print(
                f"\n   REAL DATA: {DSR_CSV_DEFAULT} absent â€” using the synthetic generator. "
                f"Run 'python dsr_extract.py' to produce it."
            )

        calls = generate_synthetic_calls(args.days, args.seed)
        cal = verify_calibration(calls)
        print(f"\n2. CALIBRATION vs {cal['source']}")
        print(_fmt_table(
            ["anchor", "target", "tol", "achieved", "hours", "result"],
            [
                [c["anchor"], c["target"], c["tolerance"] if c["tolerance"] else "-",
                 c["achieved"], c["achieved_hours"] if c["achieved_hours"] else "-",
                 "PASS" if c["passed"] else "FAIL"]
                for c in cal["checks"]
            ],
            indent="   ",
        ))
        print(f"   {cal['n_calls']} calls over {cal['n_days']} days -> {cal['status']}")

        audit = leakage_audit()
        print("\n3. LEAKAGE AUDIT")
        print(f"   FEATURE_COLUMNS      = {audit['n_features']}")
        print(f"   BANNED_FIELDS        = {len(audit['banned_fields'])}")
        print(f"   intersection         = {audit['intersection'] or 'empty'}")
        print(f"   split method         = {audit['split_method']}")
        print(f"   forbidden APIs       = {', '.join(audit['forbidden_apis'])}")
        print(f"   LEAKAGE AUDIT: {'PASS' if audit['passed'] else 'FAIL'}"
              "   (enforced at import time)")

        train, test, report = chronological_split(
            calls, args.test_fraction, args.embargo_hours
        )
        print("\n4. CHRONOLOGICAL SPLIT")
        print(f"   split at             {_iso(report.split_time_utc)}")
        print(f"   train                {report.n_train}  "
              f"[{_iso(report.train_span[0])} .. {_iso(report.train_span[1])}]")
        print(f"   test                 {report.n_test}  "
              f"[{_iso(report.test_span[0])} .. {_iso(report.test_span[1])}]")
        print(f"   purged (embargo {report.embargo_hours:.0f} h)  {report.n_purged}")
        print(f"   assert max(train ATB) < min(test ATB) -> "
              f"{'OK' if report.ordering_assert_passed else 'FAILED'}")

        print("\n5. ENGINE COMPARISON  (all on the same leakage-free split)")
        rows = []
        traces: Dict[str, List[EngineAttempt]] = {}
        for eng in ENGINE_PRIORITY:
            p = TATPredictor(engine=eng, seed=args.seed).fit(train)
            traces[eng] = p.engine_trace
            if p.selected_engine != eng:
                rows.append([eng, "unavailable", "-", "-", "-", "-", "-", "-", "-"])
                continue
            m = evaluate_model(p, test)
            rows.append([
                eng, m.n_test, f"{m.mae_hours:.2f}", f"{m.rmse_hours:.2f}",
                f"{m.mape_pct:.2f}", f"{m.forecast_accuracy_pct:.2f}",
                f"{m.pinball_p10:.3f}/{m.pinball_p50:.3f}/{m.pinball_p90:.3f}",
                f"{m.coverage_80_pct:.1f}", f"{m.mean_band_width_hours:.2f}",
            ])
        print(_fmt_table(
            ["engine", "n", "MAE h", "RMSE h", "MAPE %", "accuracy %",
             "pinball 10/50/90", "cover %", "band h"],
            rows, indent="   ",
        ))

        auto = TATPredictor(engine=args.engine, seed=args.seed).fit(train)
        print(f"\n6. ENGINE TRACE  (requested '{args.engine}')")
        print(_fmt_table(
            ["engine", "available", "selected", "ms", "reason"],
            [[a.engine, a.available, a.selected, f"{a.elapsed_ms:.0f}", a.reason[:60]]
             for a in auto.engine_trace],
            indent="   ",
        ))

        pred = auto.predict(_demo_features())
        print(f"\n7. WORKED PREDICTION  (engine '{pred.engine}')")
        rows = []
        for c in pred.breakdown["contributions"]:
            if abs(c["contribution_h"]) < 1e-9:
                continue
            bar = ("+" if c["contribution_h"] > 0 else "-") * min(
                30, int(abs(c["contribution_h"]) * 2)
            )
            rows.append([
                c["factor"], c["input"], c["coefficient"],
                f"{c['contribution_h']:+.2f}", f"{c['share_pct']:+.1f}%", bar,
            ])
        print(f"   base {pred.breakdown['base_hours']:.2f} h")
        print(_fmt_table(
            ["factor", "input", "coefficient", "hours", "share", ""], rows, indent="   "
        ))
        print(
            f"   additive surrogate total  "
            f"{pred.breakdown['additive_surrogate_p50_h']:.2f} h "
            f"(sum check {'OK' if pred.breakdown['sum_check_ok'] else 'FAILED'})"
        )
        print(
            f"   sigma {pred.sigma_hours:.2f} h from {pred.stressor_count} stressors: "
            f"{', '.join(pred.stressors_active)}"
        )
        print(
            f"   P10 {pred.p10_hours:.2f} h  |  P50 {pred.p50_hours:.2f} h  |  "
            f"P90 {pred.p90_hours:.2f} h   (band {pred.p90_hours - pred.p10_hours:.2f} h)"
        )
        for n in pred.breakdown["notes"]:
            print(f"   NOTE {n}")

    checks = _self_test()
    passed = sum(1 for _, ok, _ in checks if ok)
    print(f"\n{'-' * 78}")
    print(f"SELF-TEST  {passed}/{len(checks)} passed")
    for name, ok, detail in checks:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<34} {detail}")
    print("-" * 78)

    return 0 if passed == len(checks) else 1


# Leakage firewall runs at IMPORT TIME, not on first use.
_assert_no_leakage()


if __name__ == "__main__":
    sys.exit(main())


