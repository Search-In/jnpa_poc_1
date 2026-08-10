"""
Regression suite for the eight JNPA UC-I models.

SCOPE — what this file is for
------------------------------
Each module already runs its own ``_self_test()`` from ``__main__`` and via
``GET <prefix>/health``. Those are re-run here in one place (``test_module_self_tests``)
so ``pytest`` alone is a sufficient gate.

The rest of this file pins the SPECIFIC failure modes found while building the
system, so they cannot come back:

  * DUKC squat clamp and the exact 0.6 / 1.0 status-band boundaries
  * M2's 481-sample count and the window-duration off-by-one
  * M3's import-time leakage assert and the chronological ordering guarantee
  * M4's union-vs-sum occupancy, cross-midnight day cells, >100% cells
  * M5's berth exclusivity and independent cost recomputation
  * M7's craft double-allocation — the defect found in the prior codebase
  * M8's acyclicity, the 23/30 shape, and full-log completeness
  * cross-module DUKC core fingerprint agreement
  * every module imports with zero third-party packages available

Run:
    pytest tests -v
    pytest tests -v -m "not slow"        # skip the model-training tests
"""

from __future__ import annotations

import builtins
import importlib
import math
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
MODELS_SRC = ROOT / "src" / "uc1_models"
if str(MODELS_SRC) not in sys.path:
    sys.path.insert(0, str(MODELS_SRC))

import uc1_m1_dukc as m1                    # noqa: E402
import uc1_m2_tidal_window as m2            # noqa: E402
import uc1_m3_tat_predict as m3             # noqa: E402
import uc1_m4_berth_utilisation as m4       # noqa: E402
import uc1_m5_berth_optimiser as m5         # noqa: E402
import uc1_m6_jit_rta as m6                 # noqa: E402
import uc1_m7_port_craft as m7              # noqa: E402
import uc1_m8_causal_chain as m8            # noqa: E402

ALL_MODULES = [m1, m2, m3, m4, m5, m6, m7, m8]
CORE_CARRIERS = [m1, m2, m6, m8]
UTC = timezone.utc


# ==========================================================================
# The umbrella gate: every module's own self-test must pass.
# ==========================================================================

@pytest.mark.parametrize("mod", ALL_MODULES, ids=lambda m: m.MODULE_ID)
def test_module_self_tests(mod):
    """Each module's ``_self_test()`` must pass every check."""
    checks = mod._self_test()
    failed = [(n, d) for n, ok, d in checks if not ok]
    assert not failed, f"{mod.MODULE_ID} failures: {failed}"
    assert len(checks) >= 10, f"{mod.MODULE_ID} has suspiciously few checks"


@pytest.mark.parametrize("mod", ALL_MODULES, ids=lambda m: m.MODULE_ID)
def test_module_contract(mod):
    """Every module exports the contract ``api.py`` relies on."""
    assert isinstance(mod.MODULE_ID, str) and mod.MODULE_ID.startswith("UC1-M")
    assert isinstance(mod.MODULE_VERSION, str)
    assert mod.ROUTER_PREFIX.startswith("/uc1/m")
    assert isinstance(mod.MODULE_INFO, dict)
    assert "spec_row" in mod.MODULE_INFO
    assert callable(mod.build_router)
    assert callable(mod._self_test)


# ==========================================================================
# Cross-module: the duplicated DUKC core must not drift.
# ==========================================================================

def test_dukc_core_fingerprints_agree():
    """All four carriers must report the same fingerprint."""
    prints = {m.MODULE_ID: m.DUKC_CORE_FINGERPRINT for m in CORE_CARRIERS}
    assert len(set(prints.values())) == 1, f"DUKC core drift: {prints}"


@pytest.mark.parametrize("mod", CORE_CARRIERS, ids=lambda m: m.MODULE_ID)
def test_dukc_core_golden_values(mod):
    """Each carrier's golden-value self-test must pass independently."""
    mod._dukc_core_selftest()


def test_dukc_core_constants_identical():
    """The constants themselves, not just the fingerprint, must match."""
    names = [
        "UKC_SAFETY_MARGIN_M", "UKC_MARGINAL_BAND_M", "MAX_SQUAT_CLAMP_M",
        "CB_CONTAINER", "CB_BULK",
    ]
    for name in names:
        values = {m.MODULE_ID: getattr(m, name) for m in CORE_CARRIERS}
        assert len(set(values.values())) == 1, f"{name} differs: {values}"


def test_dukc_core_functions_agree_numerically():
    """Same inputs, same outputs, in every carrier."""
    for cb, speed in ((0.65, 10.0), (0.80, 20.0), (0.65, 14.0), (0.65, 0.0)):
        results = {m.MODULE_ID: m._squat_m(cb, speed) for m in CORE_CARRIERS}
        assert len(set(results.values())) == 1, f"squat({cb},{speed}) differs: {results}"
    for net in (1.5, 1.0, 0.95, 0.6, 0.59, -1.0):
        results = {m.MODULE_ID: m._ukc_status(net) for m in CORE_CARRIERS}
        assert len(set(results.values())) == 1, f"status({net}) differs: {results}"


# ==========================================================================
# M1 — DUKC
# ==========================================================================

def test_m1_squat_clamp_binds_at_2_5():
    assert m1.squat_m(0.80, 20.0) == pytest.approx(2.5)
    assert m1.squat_m(0.80, 100.0) == pytest.approx(2.5)
    assert m1.squat_m(0.65, 0.0) == pytest.approx(0.0)


def test_m1_squat_is_speed_squared():
    """Doubling speed must quadruple squat, below the clamp."""
    assert m1.squat_m(0.65, 10.0) == pytest.approx(4 * m1.squat_m(0.65, 5.0))


@pytest.mark.parametrize(
    "net,expected",
    [
        (1.50, "SAFE"), (1.00, "SAFE"),          # boundary: 1.0 IS safe
        (0.999, "MARGINAL"), (0.95, "MARGINAL"),
        (0.60, "MARGINAL"),                       # boundary: 0.6 IS marginal
        (0.599, "NO GO"), (0.0, "NO GO"), (-2.0, "NO GO"),
    ],
)
def test_m1_status_band_boundaries_are_exact(net, expected):
    """The 0.6 / 1.0 boundaries are inclusive-below. Off-by-one here is unsafe."""
    assert m1.ukc_status(net) == expected


def test_m1_canonical_case():
    v = m1.VesselState("V", "MSC VALERIA", "CONTAINER", 15.0, 10.0)
    c = m1.ChannelState(m1.DEFAULT_REACHES["CH-INNER"], 2.6)
    r = m1.evaluate_dukc(v, c)
    assert r.squat_m == pytest.approx(0.650)
    assert r.gross_ukc_m == pytest.approx(1.950)
    assert r.net_ukc_m == pytest.approx(0.950)
    assert r.status == "MARGINAL"


def test_m1_inverse_solves_round_trip():
    """Solving for the boundary then evaluating there must land on SAFE."""
    v = m1.VesselState("V", "X", "CONTAINER", 15.0, 10.0)
    c = m1.ChannelState(m1.DEFAULT_REACHES["CH-INNER"], 2.6)
    r = m1.evaluate_dukc(v, c)

    at_tide = m1.evaluate_dukc(
        v, m1.ChannelState(m1.DEFAULT_REACHES["CH-INNER"], r.min_tide_for_safe_m + 1e-9),
        with_sensitivity=False,
    )
    assert at_tide.status == "SAFE"

    slower = m1.VesselState("V", "X", "CONTAINER", 15.0, r.max_safe_speed_kn - 1e-6)
    assert m1.evaluate_dukc(slower, c, with_sensitivity=False).status == "SAFE"


def test_m1_levers_are_monotonic():
    v = m1.VesselState("V", "X", "CONTAINER", 15.0, 10.0)
    reach = m1.DEFAULT_REACHES["CH-INNER"]
    silted = m1.evaluate_dukc(v, m1.ChannelState(reach, 2.6, 0.5, 0.0), with_sensitivity=False)
    base = m1.evaluate_dukc(v, m1.ChannelState(reach, 2.6), with_sensitivity=False)
    dredged = m1.evaluate_dukc(v, m1.ChannelState(reach, 2.6, 0.0, 0.5), with_sensitivity=False)
    assert dredged.net_ukc_m > base.net_ukc_m > silted.net_ukc_m


def test_m1_sensitivity_grid_is_3x3():
    v = m1.VesselState("V", "X", "CONTAINER", 15.0, 10.0)
    pts = m1.ukc_sensitivity(v, m1.ChannelState(m1.DEFAULT_REACHES["CH-INNER"], 2.6))
    assert len(pts) == 9
    assert sum(1 for p in pts if p.is_baseline) == 1


def test_m1_binding_reach_is_argmin_not_shallowest():
    """The turning basin shares CH-INNER's depth but its 6 kn cap saves it."""
    v = m1.VesselState("V", "X", "CONTAINER", 15.0, 10.0)
    ar = m1.evaluate_all_reaches(v, tide_m=2.6, siltation_m=0.30)
    assert ar.binding_reach_id == "CH-INNER"
    turning = next(r for r in ar.results if r.reach_id == "TURNING-CIRCLE")
    inner = next(r for r in ar.results if r.reach_id == "CH-INNER")
    assert turning.charted_depth_m == inner.charted_depth_m
    assert turning.net_ukc_m > inner.net_ukc_m


def test_m1_breakdown_is_auditable():
    v = m1.VesselState("V", "X", "CONTAINER", 15.0, 10.0)
    r = m1.evaluate_dukc(v, m1.ChannelState(m1.DEFAULT_REACHES["CH-INNER"], 2.6))
    assert len(r.breakdown["steps"]) == 6
    for s in r.breakdown["steps"]:
        assert s["substitution"], f"step {s['step']} has no substitution"
        assert s["formula"]


# ==========================================================================
# M2 — Tidal windows
# ==========================================================================

def test_m2_sample_count_is_481():
    """120 h at 0.25 h, inclusive of both endpoints."""
    assert m2.EXPECTED_SAMPLES == 481
    v = m2.VesselState("V", "X", "CONTAINER", 15.5, 10.0)
    assert m2.evaluate_tidal_windows(v).samples == 481


def test_m2_window_duration_convention_no_off_by_one():
    """Indices i..j inclusive give (j-i)*step, so two samples are 0.25 h."""
    t0 = datetime(2026, 8, 1, tzinfo=UTC)
    samples = [
        m2.ScanSample(0, t0, 3.0, "CH-INNER", 0.1, "NO GO", False),
        m2.ScanSample(1, t0 + timedelta(hours=0.25), 3.5, "CH-INNER", 1.1, "SAFE", True),
        m2.ScanSample(2, t0 + timedelta(hours=0.50), 3.6, "CH-INNER", 1.2, "SAFE", True),
        m2.ScanSample(3, t0 + timedelta(hours=0.75), 3.0, "CH-INNER", 0.1, "NO GO", False),
    ]
    windows, _ = m2.windows_from_samples(samples, 0.25, min_window_h=0.0)
    assert len(windows) == 1
    assert windows[0].duration_h == pytest.approx(0.25)
    wall = (windows[0].end - windows[0].start).total_seconds() / 3600.0
    assert wall == pytest.approx(0.25)


def test_m2_short_windows_discarded_and_counted():
    t0 = datetime(2026, 8, 1, tzinfo=UTC)
    samples = [
        m2.ScanSample(0, t0, 3.0, "CH-INNER", 0.1, "NO GO", False),
        m2.ScanSample(1, t0 + timedelta(hours=0.25), 3.5, "CH-INNER", 1.1, "SAFE", True),
        m2.ScanSample(2, t0 + timedelta(hours=0.50), 3.0, "CH-INNER", 0.1, "NO GO", False),
    ]
    windows, discarded = m2.windows_from_samples(samples, 0.25, min_window_h=0.5)
    assert windows == []
    assert discarded == 1


def test_m2_dredging_widens_siltation_shrinks():
    v = m2.VesselState("V", "X", "CONTAINER", 15.5, 10.0)
    res = m2.evaluate_tidal_windows(v)
    dredged = next(s for s in res.scenarios if s.scenario_id == "DREDGED")
    silted = next(s for s in res.scenarios if s.scenario_id == "SILTED")
    assert dredged.total_usable_hours > res.baseline.total_usable_hours
    assert res.baseline.total_usable_hours > silted.total_usable_hours
    verdicts = {c.scenario_id: c.verdict for c in res.comparisons}
    assert verdicts["DREDGED"] == "WIDENED"
    assert verdicts["SILTED"] == "SHRANK"


def test_m2_marginal_hours_not_counted_as_usable():
    """SAFE-only is the default; MARGINAL is reported but never claimed."""
    v = m2.VesselState("V", "X", "CONTAINER", 15.5, 10.0)
    res = m2.evaluate_tidal_windows(v)
    assert res.baseline.min_status == "SAFE"
    assert res.conditional.total_usable_hours >= res.baseline.total_usable_hours


def test_m2_every_feasible_sample_meets_threshold():
    v = m2.VesselState("V", "X", "CONTAINER", 15.5, 10.0)
    res = m2.evaluate_tidal_windows(v)
    for row in res.breakdown["full_curve"]:
        if row["feasible"]:
            assert row["status"] == "SAFE"


def test_m2_undeep_vessel_yields_no_windows_not_a_crash():
    v = m2.VesselState("V", "TOO DEEP", "CONTAINER", 20.0, 10.0)
    res = m2.evaluate_tidal_windows(v)
    assert res.baseline.window_count == 0
    assert "NO transit window" in res.recommendation


# ==========================================================================
# M3 — TAT prediction and the leakage firewall
# ==========================================================================

def test_m3_leakage_firewall_holds():
    audit = m3.leakage_audit()
    assert audit["passed"]
    assert audit["intersection"] == []
    assert len(m3.FEATURE_COLUMNS) == 16


def test_m3_atb_is_split_key_not_predictor():
    assert "atb_utc" in m3.BANNED_FIELDS
    assert "atb_utc" not in m3.FEATURE_COLUMNS


def test_m3_leakage_assert_actually_trips():
    """Adding an outcome to the feature list must raise, not merely warn."""
    original = m3.FEATURE_COLUMNS
    try:
        m3.FEATURE_COLUMNS = original + ("tat_hours",)
        with pytest.raises(AssertionError):
            m3._assert_no_leakage()
    finally:
        m3.FEATURE_COLUMNS = original
    m3._assert_no_leakage()          # restored state must still pass


def test_m3_label_fields_never_in_features():
    label_fields = set(m3.TATLabel.__dataclass_fields__) - {"call_id"}
    assert not (set(m3.FEATURE_COLUMNS) & label_fields)
    assert "tat_hours" not in m3.TATFeatures.__dataclass_fields__


def test_m3_to_vector_uses_allowlist_not_asdict():
    vec = m3.to_vector(m3._demo_features())
    assert len(vec) == len(m3.FEATURE_COLUMNS)
    assert all(isinstance(x, float) for x in vec)


@pytest.mark.slow
def test_m3_chronological_split_ordering():
    """Every training ATB must precede every test ATB. No exceptions."""
    calls = m3.generate_synthetic_calls(180, m3.DEFAULT_SEED)
    train, test, report = m3.chronological_split(calls)
    assert report.ordering_assert_passed
    assert max(c.features.atb_utc for c in train) < min(c.features.atb_utc for c in test)
    assert not ({c.features.call_id for c in train} & {c.features.call_id for c in test})


@pytest.mark.slow
def test_m3_purge_removes_unobserved_outcomes():
    calls = m3.generate_synthetic_calls(180, m3.DEFAULT_SEED)
    train, _, report = m3.chronological_split(calls, embargo_hours=24.0)
    assert report.n_purged > 0
    for c in train:
        assert c.label.atd_utc < report.split_time_utc


@pytest.mark.slow
def test_m3_expanding_window_folds_never_look_forward():
    calls = m3.generate_synthetic_calls(180, m3.DEFAULT_SEED)
    train, _, _ = m3.chronological_split(calls)
    for fit, val in m3.expanding_window_folds(train):
        if fit and val:
            assert max(c.features.atb_utc for c in fit) <= min(
                c.features.atb_utc for c in val
            )


@pytest.mark.parametrize(
    "field,value,expected_hours",
    [
        ("parcel_teu", 250, 35.0),                    # +1 h per 250 TEU
        ("draft_m", 14.0, 35.5),                      # +1.5 h per m over 13 m
        ("severe_weather_flag", 1, 39.0),             # +5 h severe weather
        ("net_channel_depth_delta_m", -1.0, 38.0),    # +4 h per m depth lost
    ],
)
def test_m3_additive_coefficients_match_spec(field, value, expected_hours):
    """The four coefficients quoted verbatim in WS2 row 3."""
    from dataclasses import replace

    calm = m3.TATFeatures(
        call_id="C", vessel_id="V", vessel_name="X", terminal="T", berth_id="B",
        atb_utc=datetime(2026, 8, 1, tzinfo=UTC),
        parcel_teu=0, draft_m=13.0, terminal_max_draft_m=16.0,
        draft_vs_terminal_max_m=3.0, weather_severity=0, severe_weather_flag=0,
        rain_mm_hr=0.0, wind_kn=10.0, net_channel_depth_delta_m=0.0,
        pilots_down=0, tugs_down=0, anchorage_queue_count=0, extra_arrivals_24h=0,
        incident_severity=0, berth_window_extension_h=0.0, calls_prev_24h=10,
    )
    assert m3.additive_tat_hours(calm)[0] == pytest.approx(34.0)
    assert m3.additive_tat_hours(replace(calm, **{field: value}))[0] == pytest.approx(
        expected_hours
    )


def test_m3_sigma_formula():
    """sigma = 2 + 0.3 * n, bounded 2.0 to 5.0 by the ten predicates."""
    assert len(m3.STRESSOR_PREDICATES) == 10
    calm = m3.TATFeatures(
        call_id="C", vessel_id="V", vessel_name="X", terminal="T", berth_id="B",
        atb_utc=datetime(2026, 8, 1, tzinfo=UTC),
        parcel_teu=0, draft_m=13.0, terminal_max_draft_m=16.0,
        draft_vs_terminal_max_m=3.0, weather_severity=0, severe_weather_flag=0,
        rain_mm_hr=0.0, wind_kn=10.0, net_channel_depth_delta_m=0.0,
        pilots_down=0, tugs_down=0, anchorage_queue_count=0, extra_arrivals_24h=0,
        incident_severity=0, berth_window_extension_h=0.0, calls_prev_24h=10,
    )
    sd, active = m3.sigma_hours(calm)
    assert sd == pytest.approx(2.0) and active == []


def test_m3_quantile_crossing_is_corrected():
    """Independently fitted quantile models can invert. That must never ship."""
    class Crossing:
        name = "crossing"

        def fit(self, X, y):
            pass

        def predict_quantiles(self, x):
            return (60.0, 30.0, 45.0)

    p = m3.TATPredictor(engine="additive")
    p._fitted = True
    p.model = Crossing()
    p.selected_engine = "crossing"
    p.impute_stats = {c: 0.0 for c in m3.FEATURE_COLUMNS}
    pred = p.predict(m3._demo_features())
    assert pred.quantile_crossing_corrected
    assert pred.p10_hours <= pred.p50_hours <= pred.p90_hours


def test_m3_additive_engine_needs_no_ml_libraries():
    """The transparent engine must work with nothing installed."""
    p = m3.TATPredictor(engine="additive")
    p._fitted = True
    pred = p.predict(m3._demo_features())
    assert pred.engine == "additive"
    assert pred.breakdown["attribution_source"] == "additive"
    assert math.isfinite(pred.p50_hours)


@pytest.mark.slow
def test_m3_attribution_source_flags_the_surrogate():
    """When an ML engine gives P50, the chart must say it explains something else."""
    calls = m3.generate_synthetic_calls(120, m3.DEFAULT_SEED)
    train, _, _ = m3.chronological_split(calls)
    p = m3.TATPredictor(engine="auto").fit(train)
    pred = p.predict(m3._demo_features())
    if p.selected_engine != "additive":
        assert pred.breakdown["attribution_source"] == "additive_surrogate"
        assert any("ADDITIVE SURROGATE" in n for n in pred.breakdown["notes"])


def test_m3_engine_fallback_survives_oserror():
    """LightGBM raises OSError on Windows without VC++. It must not crash."""
    calls = m3.generate_synthetic_calls(60, m3.DEFAULT_SEED)
    train, _, _ = m3.chronological_split(calls)
    p = m3.TATPredictor(engine="auto")
    original = p._construct

    def sabotage(name):
        if name == "lightgbm":
            raise OSError("simulated missing VC++ redistributable")
        return original(name)

    p._construct = sabotage
    p.fit(train)
    attempt = next(a for a in p.engine_trace if a.engine == "lightgbm")
    assert not attempt.available
    assert p.selected_engine != "lightgbm"


@pytest.mark.slow
def test_m3_calibration_hits_published_anchors():
    calls = m3.generate_synthetic_calls(m3.DEFAULT_HISTORY_DAYS, m3.DEFAULT_SEED)
    cal = m3.verify_calibration(calls)
    assert cal["status"] == "PASS", cal["checks"]


# ==========================================================================
# M4 — ETA uncertainty and occupancy
# ==========================================================================

def test_m4_eta_sigma_both_terms():
    assert m4.eta_sigma_hours(24.0, 0.0) == pytest.approx(1.44)
    assert m4.eta_sigma_hours(0.0, 60.0) == pytest.approx(3.0)
    assert m4.eta_sigma_hours(2.0, 180.0) == pytest.approx(9.12)


def test_m4_eta_horizon_clamped_for_past_eta():
    now = datetime(2026, 8, 1, tzinfo=UTC)
    band = m4.compute_eta_band(
        m4.EtaObservation("C", "V", now, now - timedelta(hours=5), 0.0)
    )
    assert band.horizon_hours == 0.0
    assert band.sigma_hours == 0.0


def test_m4_percentile_linear_interpolation():
    assert m4._percentile([1.0, 2.0, 3.0, 4.0], 0.5) == pytest.approx(2.5)
    assert m4._percentile([1.0, 2.0, 3.0, 4.0], 0.9) == pytest.approx(3.7)
    assert math.isnan(m4._percentile([], 0.5))


def test_m4_overlap_and_merge():
    t = datetime(2026, 8, 1, tzinfo=UTC)
    assert m4._overlap_hours(t, t + timedelta(hours=1),
                             t + timedelta(hours=2), t + timedelta(hours=3)) == 0.0
    assert m4._overlap_hours(t, t + timedelta(hours=3),
                             t + timedelta(hours=2), t + timedelta(hours=5)
                             ) == pytest.approx(1.0)
    merged = m4._merge_intervals([
        (t, t + timedelta(hours=2)),
        (t + timedelta(hours=1), t + timedelta(hours=3)),
        (t + timedelta(hours=5), t + timedelta(hours=6)),
    ])
    assert len(merged) == 2


def _dirty_fixture():
    """A 40 h stay, a nested double-booking, an open-ended stay, a corrupt row."""
    berths = [m4.BerthSpec("B1", "T1", 350.0, 15.0), m4.BerthSpec("B2", "T1", 350.0, 15.0)]
    w0 = datetime(2026, 8, 1, 6, tzinfo=UTC)      # 06:00Z = 11:30 IST
    w1 = w0 + timedelta(days=3)
    start = datetime(2026, 8, 1, 8, tzinfo=UTC)
    records = [
        m4.BerthingRecord("H1", "V1", "B1", "T1", actual_ata_utc=start - timedelta(hours=6),
                          actual_atb_utc=start, actual_atd_utc=start + timedelta(hours=40)),
        m4.BerthingRecord("H2", "V2", "B1", "T1", actual_ata_utc=start,
                          actual_atb_utc=start + timedelta(hours=10),
                          actual_atd_utc=start + timedelta(hours=20)),
        m4.BerthingRecord("H3", "V3", "B2", "T1", actual_ata_utc=w1 - timedelta(hours=30),
                          actual_atb_utc=w1 - timedelta(hours=24), actual_atd_utc=None),
        m4.BerthingRecord("H4", "V4", "B2", "T1", actual_ata_utc=w0,
                          actual_atb_utc=w0 + timedelta(hours=5),
                          actual_atd_utc=w0 + timedelta(hours=2)),
    ]
    return records, berths, w0, w1


def test_m4_union_is_less_than_raw_sum():
    records, berths, w0, w1 = _dirty_fixture()
    union = m4.occupancy_calendar(records, berths, w0, w1, mode="union")
    raw = m4.occupancy_calendar(records, berths, w0, w1, mode="sum")
    assert union.total_occupied_hours < raw.total_occupied_hours
    assert union.breakdown["occupied_hours"]["double_booked"] == pytest.approx(10.0)


def test_m4_cross_midnight_stay_writes_three_day_cells():
    records, berths, w0, w1 = _dirty_fixture()
    cal = m4.occupancy_calendar(records, berths, w0, w1, mode="union")
    cells = [c for c in cal.cells if c.berth_id == "B1" and c.occupied_hours > 0]
    assert len(cells) == 3


def test_m4_no_cell_exceeds_100_percent():
    records, berths, w0, w1 = _dirty_fixture()
    cal = m4.occupancy_calendar(records, berths, w0, w1, mode="union")
    assert all(c.occupancy_pct <= 100.0 + 1e-9 for c in cal.cells)


def test_m4_day_cells_tile_the_window_exactly():
    """Partial days must get a partial denominator, and the parts must sum."""
    records, berths, w0, w1 = _dirty_fixture()
    cal = m4.occupancy_calendar(records, berths, w0, w1, mode="union")
    total = sum(c.available_hours for c in cal.cells if c.berth_id == "B1")
    assert total == pytest.approx(cal.window_hours)
    assert any(abs(c.available_hours - 24.0) > 1e-9 for c in cal.cells)


def test_m4_open_ended_stay_clipped_not_dropped():
    records, berths, w0, w1 = _dirty_fixture()
    cal = m4.occupancy_calendar(records, berths, w0, w1, mode="union")
    assert cal.breakdown["occupied_hours"]["open_ended_clipped"] == 1


def test_m4_corrupt_record_dropped_with_a_reason():
    records, berths, w0, w1 = _dirty_fixture()
    cal = m4.occupancy_calendar(records, berths, w0, w1, mode="union")
    reasons = {d["reason"] for d in cal.breakdown["data_quality"]["dropped"]}
    assert "atd_before_atb" in reasons


def test_m4_rejects_naive_datetimes():
    with pytest.raises(ValueError):
        m4._ensure_utc(datetime(2026, 8, 1))


def test_m4_confidence_bands_are_json_safe():
    """float('inf') is not valid JSON and once 500'd the health endpoint."""
    import json

    json.dumps(m4.MODULE_INFO["constants"], allow_nan=False)


# ==========================================================================
# M5 — Berth optimiser
# ==========================================================================

def test_m5_plan_respects_all_hard_constraints():
    reqs, berths, windows = m5.scenario_baseline()
    plan = m5.greedy_optimise(reqs, berths, windows)
    ok, problems = m5.validate_plan(plan, reqs, berths)
    assert ok, problems


def test_m5_cost_recomputes_independently():
    reqs, berths, windows = m5.scenario_baseline()
    plan = m5.greedy_optimise(reqs, berths, windows)
    assert m5.score_plan(plan.assignments).total_cost == pytest.approx(plan.cost.total_cost)


def test_m5_objective_matches_the_spec_formula():
    reqs, berths, windows = m5.scenario_baseline()
    plan = m5.greedy_optimise(reqs, berths, windows)
    c = plan.cost
    assert c.total_cost == pytest.approx(
        1.0 * c.wait_hours_total + 2.0 * c.tide_misses + 0.5 * c.berth_shifts
    )


def test_m5_no_negative_wait_credit():
    """Early berthing must not earn a discount, or the optimiser games it."""
    reqs, berths, windows = m5.scenario_baseline()
    plan = m5.greedy_optimise(reqs, berths, windows)
    assert all(a.wait_hours >= 0.0 for a in plan.assignments)


def test_m5_is_deterministic_and_order_independent():
    import random

    reqs, berths, windows = m5.scenario_baseline()
    base = m5.greedy_optimise(reqs, berths, windows).cost.total_cost
    assert m5.greedy_optimise(reqs, berths, windows).cost.total_cost == base
    shuffled = list(reqs)
    random.Random(7).shuffle(shuffled)
    assert m5.greedy_optimise(shuffled, berths, windows).cost.total_cost == pytest.approx(base)


def test_m5_tide_policy_soft_vs_hard():
    reqs, berths, windows = m5.scenario_baseline()
    deep = m5.BerthRequest(
        "R-DEEP", "V", "TOO DEEP", 399.0, 15.9, "BMCT-01",
        datetime(2026, 8, 1, 4, tzinfo=UTC), 20.0, priority=1,
    )
    soft = m5.greedy_optimise([deep], berths, windows, tide_policy="soft")
    hard = m5.greedy_optimise([deep], berths, windows, tide_policy="hard")
    assert soft.cost.tide_misses == 1 and not soft.unassigned_request_ids
    assert len(hard.unassigned_request_ids) == 1


def test_m5_outage_berth_is_never_used():
    reqs, berths, windows = m5.scenario_berth_outage("BMCT-01")
    plan = m5.greedy_optimise(reqs, berths, windows)
    assert all(a.berth_id != "BMCT-01" for a in plan.assignments if a.feasible)


def test_m5_disruption_never_reduces_cost():
    base = m5.greedy_optimise(*m5.scenario_baseline())
    outage = m5.greedy_optimise(*m5.scenario_berth_outage("BMCT-01"))
    assert outage.cost.total_cost >= base.cost.total_cost


def test_m5_every_assignment_explains_itself():
    reqs, berths, windows = m5.scenario_baseline()
    plan = m5.greedy_optimise(reqs, berths, windows)
    for a in plan.assignments:
        assert len(a.rationale) > 20


def test_m5_degrades_cleanly_without_ortools():
    """auto must never return a worse plan than the greedy floor."""
    reqs, berths, windows = m5.scenario_baseline()
    greedy = m5.greedy_optimise(reqs, berths, windows)
    auto = m5.optimise(reqs, berths, windows, m5.DEFAULT_WEIGHTS, "auto")
    assert auto.cost.total_cost <= greedy.cost.total_cost + 1e-9
    comparison = auto.breakdown["algorithm_comparison"]
    assert comparison["cpsat_available"] == m5.cpsat_available()


@pytest.mark.skipif(not m5.cpsat_available(), reason="ortools not installed")
def test_m5_cpsat_produces_a_valid_plan():
    reqs, berths, windows = m5.scenario_baseline()
    plan = m5.solve_cpsat(reqs, berths, windows)
    assert plan is not None
    ok, problems = m5.validate_plan(plan, reqs, berths)
    assert ok, problems


# ==========================================================================
# M7 — Port craft. The double-allocation defect is pinned permanently.
# ==========================================================================

def _no_double_allocation(allocations, movements):
    by_mv = {m.movement_id: m for m in movements}
    commitments = {}
    for a in allocations:
        mv = by_mv.get(a.movement_id)
        if not mv:
            continue
        for cid in a.all_ids():
            commitments.setdefault(cid, []).append((mv.start_utc, mv.end_utc, mv.movement_id))
    for cid, spans in commitments.items():
        spans.sort()
        for (s1, e1, m1_), (s2, e2, m2_) in zip(spans, spans[1:]):
            if max(s1, s2) < min(e1, e2):
                return False, f"{cid} double-allocated to {m1_} and {m2_}"
    return True, "ok"


@pytest.mark.parametrize("preset", ["real", "poc"])
def test_m7_no_craft_double_allocation(preset):
    """
    THE REGRESSION. The prior implementation sliced an availability pool per
    movement and handed the same pilot to overlapping jobs — the conflict report
    looked fine while the plan was physically impossible.
    """
    start = datetime(2026, 8, 1, 6, tzinfo=UTC)
    movements = m7.SyntheticMovementLoader(m7.DEFAULT_SEED, 8).load_movements(
        start, start + timedelta(hours=12)
    )
    roster = m7.build_default_roster(preset)
    allocs = m7.allocate_craft(movements, roster, start - timedelta(hours=1))
    ok, detail = _no_double_allocation(allocs, movements)
    assert ok, detail


def test_m7_no_double_allocation_under_outage():
    """The temptation to over-assign is greatest when the roster is short."""
    start = datetime(2026, 8, 1, 6, tzinfo=UTC)
    movements = m7.SyntheticMovementLoader(m7.DEFAULT_SEED, 8).load_movements(
        start, start + timedelta(hours=12)
    )
    roster = m7.apply_outage(m7.build_default_roster("poc"), ["PL-02", "PL-03"])
    allocs = m7.allocate_craft(movements, roster, start - timedelta(hours=1))
    ok, detail = _no_double_allocation(allocs, movements)
    assert ok, detail


def test_m7_single_craft_serves_only_one_overlapping_movement():
    solo = [
        m7.PortCraft("PL-X", "Solo Pilot", "Pilot Launch", ("PILOT",), 10),
        m7.PortCraft("TG-X", "Solo Tug", "Tug", ("TUG",), 10),
        m7.PortCraft("MB-X", "Solo Mooring", "Mooring Boat", ("MOORING",), 10),
    ]
    t0 = datetime(2026, 8, 1, 12, tzinfo=UTC)
    twin = [
        m7.VesselMovement("MV-A", "V-A", "ALPHA", "BERTHING", "FEEDER", "B1",
                          t0, t0 + timedelta(hours=2), 1, 1, 1, priority=3),
        m7.VesselMovement("MV-B", "V-B", "BRAVO", "BERTHING", "FEEDER", "B2",
                          t0 + timedelta(minutes=30), t0 + timedelta(hours=2, minutes=30),
                          1, 1, 1, priority=7),
    ]
    allocs = m7.allocate_craft(twin, solo, t0 - timedelta(hours=1))
    served = [a for a in allocs if a.feasible]
    assert len(served) == 1
    assert served[0].movement_id == "MV-A"          # higher priority wins


def test_m7_response_time_is_enforced():
    slow = [m7.PortCraft("PL-S", "Slow", "Pilot Launch", ("PILOT",), 120)]
    t0 = datetime(2026, 8, 1, 12, tzinfo=UTC)
    urgent = [m7.VesselMovement("MV-U", "V", "URGENT", "SAILING", "FEEDER", "B1",
                                t0, t0 + timedelta(hours=1), 1, 0, 0)]
    alloc = m7.allocate_craft(urgent, slow, t0 - timedelta(minutes=30))
    assert not alloc[0].feasible
    assert alloc[0].shortfall.get("PILOT") == 1


def test_m7_real_roster_matches_the_source_pdf():
    """18 craft, not the 9 the spec claims. Documented discrepancy."""
    assert len(m7.JNPA_ROSTER_REAL) == 18
    supply = m7.serviceable_supply(m7.JNPA_ROSTER_REAL)
    assert len(supply["TUG"]) == 10
    assert len(supply["PILOT"]) == 4
    assert all("ASSUMED" in c.response_time_source for c in m7.JNPA_ROSTER_REAL)


def test_m7_poc_roster_matches_the_spec():
    assert len(m7.JNPA_ROSTER_POC) == 9
    supply = m7.serviceable_supply(m7.JNPA_ROSTER_POC)
    assert (len(supply["PILOT"]), len(supply["TUG"]), len(supply["MOORING"])) == (3, 4, 2)


def test_m7_two_pilots_down_triggers_conflict():
    report = m7.scenario_two_pilots_down(roster_preset="poc")
    assert report.status == "CONFLICT_DETECTED"
    assert any(c.role == "PILOT" for c in report.conflicts)
    ok, detail = _no_double_allocation(report.allocations, report.movements)
    assert ok, detail


def test_m7_conflicts_are_merged_blocks_not_per_timestep():
    report = m7.scenario_two_pilots_down(roster_preset="poc")
    for c in report.conflicts:
        assert c.end_utc > c.start_utc
        assert c.peak_deficit >= 1


def test_m7_proposals_are_single_unit_and_simulated():
    report = m7.scenario_two_pilots_down(roster_preset="poc")
    assert report.proposals
    for p in report.proposals:
        assert p.basis.startswith("SIMULATED")
        changes = sum([bool(p.craft_id_from), bool(p.craft_id_to), bool(p.delay_minutes)])
        assert changes <= 2, f"{p.action} changes too much to be a single-unit swap"


def test_m7_delay_never_targets_a_tide_locked_movement():
    report = m7.scenario_two_pilots_down(roster_preset="poc")
    locked = {m.movement_id for m in report.movements if m.tide_locked}
    for p in report.proposals:
        if p.action == "DELAY":
            assert p.movement_id not in locked


def test_m7_no_bow_thruster_adds_a_tug():
    with_t = m7.requirements_for("BERTHING", "ULCV", True)
    without = m7.requirements_for("BERTHING", "ULCV", False)
    assert without.tugs == with_t.tugs + m7.NO_BOW_THRUSTER_EXTRA_TUGS


# ==========================================================================
# M6 — JIT
# ==========================================================================

def test_m6_canonical_case_numbers():
    v, rd = m6._canonical_case()
    r = m6.evaluate_jit(v, rd)
    assert r.rta_driver == "BERTH_READY"
    assert r.required_speed_kn == pytest.approx(12.0)
    assert r.baseline.steaming_fuel_t == pytest.approx(48.0)
    assert r.jit.steaming_fuel_t == pytest.approx(27.0)
    assert r.headline.fuel_saved_t == pytest.approx(21.0)
    assert r.headline.co2_saved_t == pytest.approx(21.0 * 3.114)
    assert r.headline.bunker_saved_usd == pytest.approx(12600.0)


def test_m6_headline_is_the_conservative_figure():
    v, rd = m6._canonical_case()
    r = m6.evaluate_jit(v, rd)
    assert r.headline.basis == "STEAMING_ONLY" and r.headline.is_headline
    assert r.secondary.basis == "ANCHORAGE_INCLUSIVE" and not r.secondary.is_headline
    assert r.secondary.fuel_saved_t > r.headline.fuel_saved_t


def test_m6_fuel_is_cubic_in_speed():
    assert m6.fuel_tons(8.0, 1.0) == pytest.approx(3.2 * (0.5 ** 3))
    assert m6.fuel_tons(16.0, 1.0) == pytest.approx(3.2)


def test_m6_rta_is_max_of_constraints():
    now = datetime(2026, 8, 1, tzinfo=UTC)
    rd = m6.PortReadiness("B", now + timedelta(hours=16),
                          tidal_window_start=now + timedelta(hours=22))
    rta, driver = m6.compute_rta(rd)
    assert rta == now + timedelta(hours=22)
    assert driver == "TIDAL_WINDOW"


def test_m6_no_slack_yields_no_saving():
    v, rd = m6._canonical_case(distance_nm=400.0, berth_ready_h=10.0, window_start_h=9.0)
    r = m6.evaluate_jit(v, rd)
    assert r.rta_driver == "MAX_SPEED_LIMIT"
    assert not r.feasible
    assert r.headline.fuel_saved_t == pytest.approx(0.0)


def test_m6_below_steerage_is_clamped():
    v, rd = m6._canonical_case(distance_nm=100.0, berth_ready_h=40.0, window_start_h=39.0)
    r = m6.evaluate_jit(v, rd)
    assert r.speed_clamped
    assert r.recommended_speed_kn == pytest.approx(m6.MIN_STEERAGE_SPEED_KN)
    assert r.jit.anchorage_wait_hours > 0


def test_m6_commercial_figures_are_labelled_simulated():
    v, rd = m6._canonical_case()
    r = m6.evaluate_jit(v, rd)
    assert r.headline.label == "SIMULATED"
    assert r.breakdown["provenance"]["commercial_figures"] == "SIMULATED"


def test_m6_speed_sweep_is_monotonic():
    curve = m6.speed_sweep(*m6._canonical_case())
    fuels = [p["steaming_fuel_t"] for p in curve]
    assert fuels == sorted(fuels)


# ==========================================================================
# M8 — Causal DAG
# ==========================================================================

def test_m8_graph_shape_and_acyclicity():
    g = m8.build_graph()
    v = g.validate()
    assert v["node_count"] == 23
    assert v["edge_count"] == 30
    assert v["all_edges_forward"] and v["kahn_ok"]
    assert v["orphan_nodes"] == []


def test_m8_every_edge_runs_forward_in_rank():
    g = m8.build_graph()
    for e in g.edges:
        assert g.nodes[e.source].idx < g.nodes[e.target].idx, e.edge_id


def test_m8_backwards_edge_is_refused():
    bad = list(m8._edge_specs()) + [
        m8.CausalEdge("E99", "SYS_CONFIDENCE", "WX_WIND_KN", 0.5, 1,
                      m8.BASIS_JUDGEMENT, "cycle")
    ]
    with pytest.raises(AssertionError):
        m8.CausalGraph(m8._node_specs(), bad)


def test_m8_dukc_baseline_is_computed_by_the_core():
    """0.95 m — identical to M1's canonical case, because it is the same core."""
    g = m8.build_graph()
    squat = m8._squat_m(m8.CB_CONTAINER, m8.REFERENCE_SPEED_KN)
    _, expected = m8._net_ukc_m(15.0, m8.TIDE_MEAN_M, 0.0, m8.REFERENCE_DRAFT_M, squat)
    assert g.nodes["DUKC_NET_UKC_M"].baseline == pytest.approx(expected)
    assert expected == pytest.approx(0.95)
    v = m1.VesselState("V", "X", "CONTAINER", 15.0, 10.0)
    r = m1.evaluate_dukc(v, m1.ChannelState(m1.DEFAULT_REACHES["CH-INNER"], 2.6))
    assert r.net_ukc_m == pytest.approx(expected), "M1 and M8 disagree on the same case"


def test_m8_exact_physics_edges_are_exactly_exact():
    g = m8.build_graph()
    silt = m8._quiet_propagate(g, [m8.Disruption("SILTATION_M", 1.0)])
    assert silt["CONTROLLING_DEPTH_M"] - g.nodes["CONTROLLING_DEPTH_M"].baseline == \
        pytest.approx(-1.0)
    assert silt["DUKC_NET_UKC_M"] - g.nodes["DUKC_NET_UKC_M"].baseline == pytest.approx(-1.0)
    tide = m8._quiet_propagate(g, [m8.Disruption("TIDE_HEIGHT_M", m8.TIDE_MEAN_M + 1.0)])
    assert tide["DUKC_NET_UKC_M"] - g.nodes["DUKC_NET_UKC_M"].baseline == pytest.approx(1.0)


def test_m8_e14_calibration_within_tolerance():
    cal = m8.calibrate_e14(m8.build_graph())
    assert cal["all_within_10pct"], cal["cases"]


def test_m8_named_chains_are_real_paths():
    g = m8.build_graph()
    by_id = {e.edge_id: e for e in g.edges}
    for chain_id, (_, edge_ids) in m8.NAMED_CHAINS.items():
        for a, b in zip(edge_ids, edge_ids[1:]):
            assert by_id[a].target == by_id[b].source, chain_id


def test_m8_every_edge_declares_its_basis():
    g = m8.build_graph()
    valid = {m8.BASIS_EXACT, m8.BASIS_CALIBRATED, m8.BASIS_JUDGEMENT}
    assert all(e.basis in valid for e in g.edges)
    assert sum(1 for e in g.edges if e.basis == m8.BASIS_EXACT) == 4
    assert sum(1 for e in g.edges if e.basis == m8.BASIS_CALIBRATED) == 1


def test_m8_propagation_log_covers_every_node():
    """The audit requirement: all 23 steps, every run, including unchanged."""
    g = m8.build_graph()
    result = m8.run_scenario("S5")
    assert len(result.propagation_log) == 23
    assert {s.node_id for s in result.propagation_log} == set(g.nodes)
    assert all(s.substitution for s in result.propagation_log)


def test_m8_unchanged_nodes_are_still_logged():
    result = m8.run_scenario("S3")
    assert any(s.kind == "UNCHANGED" for s in result.propagation_log)


def test_m8_scenario_ordering():
    r = {sid: m8.run_scenario(sid) for sid in m8.SCENARIOS}
    assert r["S4"].confidence_after >= r["S1"].confidence_after      # lever helps
    assert r["S3"].confidence_after < r["S1"].confidence_after       # siltation hurts
    assert r["S6"].confidence_after > r["S5"].confidence_after       # lever recovers
    assert r["S5"].confidence_after == min(x.confidence_after for x in r.values())


def test_m8_wind_rule_fires_at_30_knots():
    result = m8.run_scenario("S5")
    fired = {t.rule.rule_id for t in result.triggered_rules}
    assert "R1" in fired
    assert result.final_state["PILOTAGE_HOLD"] >= 0.90 - 1e-9


def test_m8_rule_contribution_is_isolatable():
    with_rules = m8.run_scenario("S5", apply_rules=True)
    without = m8.run_scenario("S5", apply_rules=False)
    assert with_rules.confidence_after != without.confidence_after


def test_m8_derived_node_injection_is_rejected():
    g = m8.build_graph()
    with pytest.raises(ValueError):
        m8.propagate(g, [m8.Disruption("SYS_CONFIDENCE", 0.5)])
    with pytest.raises(ValueError):
        m8.propagate(g, [m8.Disruption("NOT_A_NODE", 1.0)])


def test_m8_values_respect_clamps_under_extremes():
    g = m8.build_graph()
    state = m8._quiet_propagate(g, [m8.Disruption("WX_WIND_KN", 60.0)])
    for nid, val in state.items():
        assert g.nodes[nid].lo - 1e-9 <= val <= g.nodes[nid].hi + 1e-9


def test_m8_root_cause_shares_sum_to_100():
    result = m8.run_scenario("S5")
    total = sum(v for _, v in result.top_root_causes)
    assert total == pytest.approx(100.0)


def test_m8_graphviz_export_has_all_edges():
    dot = m8.graph_to_dot(m8.build_graph())
    assert dot.startswith("digraph")
    assert dot.count("->") == 30


# ==========================================================================
# Portability: the modules must import with no third-party packages.
# ==========================================================================

@pytest.mark.parametrize(
    "module_name",
    ["uc1_m1_dukc", "uc1_m2_tidal_window", "uc1_m3_tat_predict",
     "uc1_m4_berth_utilisation", "uc1_m5_berth_optimiser", "uc1_m6_jit_rta",
     "uc1_m7_port_craft", "uc1_m8_causal_chain"],
)
def test_module_imports_without_third_party_packages(module_name):
    """
    The self-containment claim, actually tested.

    A subprocess blocks fastapi, pydantic, lightgbm, sklearn and ortools at the
    import hook, then imports the module and runs its self-test. This is the
    only honest way to verify "runs on a bare Python install".
    """
    script = f"""
import sys, builtins
BLOCKED = {{'fastapi', 'pydantic', 'lightgbm', 'sklearn', 'ortools', 'numpy', 'pandas'}}
_real_import = builtins.__import__
def guarded(name, *a, **kw):
    root = name.split('.')[0]
    if root in BLOCKED:
        raise ImportError(f'{{root}} blocked for the portability test')
    return _real_import(name, *a, **kw)
builtins.__import__ = guarded
for mod in list(sys.modules):
    if mod.split('.')[0] in BLOCKED:
        del sys.modules[mod]
sys.path.insert(0, r'{MODELS_SRC}')
import {module_name} as m
assert not getattr(m, '_HAS_FASTAPI', False), 'fastapi leaked into the sandbox'
checks = m._self_test()
failed = [(n, d) for n, ok, d in checks if not ok]
assert not failed, failed
try:
    m.build_router()
    raise SystemExit('build_router should have raised without fastapi')
except RuntimeError:
    pass
print('OK', len(checks))
"""
    proc = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=900
    )
    assert proc.returncode == 0, (
        f"{module_name} failed without third-party packages:\n"
        f"STDOUT: {proc.stdout}\nSTDERR: {proc.stderr[-2500:]}"
    )
    assert "OK" in proc.stdout


# ==========================================================================
# API layer
# ==========================================================================

def test_api_mounts_all_eight_modules():
    import api

    assert len(api.MOUNTED) == 8
    assert not api.IMPORT_FAILURES
    assert not api.MOUNT_FAILURES
    assert api.CORE_CHECK["consistent"]


def test_api_manifest_lists_routes_for_every_module():
    """Regression: FastAPI's lazy _IncludedRouter once made this report zero."""
    import api

    manifest = api.manifest()
    assert len(manifest["modules"]) == 8
    for m in manifest["modules"]:
        assert len(m["routes"]) >= 5, f"{m['module_id']} exposes no routes"


def test_api_json_safe_handles_non_finite():
    import api

    cleaned = api.json_safe(
        {"a": float("inf"), "b": [float("nan"), 1.0], "c": {"d": float("-inf")}}
    )
    assert cleaned == {"a": None, "b": [None, 1.0], "c": {"d": None}}


def test_api_health_payload_is_serialisable():
    import json

    import api

    payload = json.loads(api.health(deep=False).body)
    assert payload["status"] == "ok"
    assert payload["modules_mounted"] == 8


def test_api_gate_rejects_drifted_fingerprint():
    """A safety gate that has never been shown to fire is not a gate."""
    import api

    original = m6.DUKC_CORE_FINGERPRINT
    try:
        m6.DUKC_CORE_FINGERPRINT = "dukc-core/1.0.1/TAMPERED"
        check = api.verify_dukc_core_consistency(api.MODULES)
        assert check["consistent"] is False
        assert len(check["distinct_fingerprints"]) == 2
    finally:
        m6.DUKC_CORE_FINGERPRINT = original
    assert api.verify_dukc_core_consistency(api.MODULES)["consistent"]


def test_api_gate_rejects_drifted_formula_with_intact_fingerprint():
    """
    The case a fingerprint comparison ALONE would miss: someone edits the squat
    formula but leaves the version constant untouched. The gate also re-runs each
    module's golden-value self-test, which is what catches this.
    """
    import api

    original_squat = m6._squat_m
    original_selftest = m6._dukc_core_selftest

    def tampered_selftest():
        assert abs(m6._squat_m(0.65, 10.0) - 0.650) < 1e-9, "squat(0.65,10) != 0.650"

    try:
        m6._squat_m = lambda cb, kn: original_squat(cb, kn) * 1.10
        m6._dukc_core_selftest = tampered_selftest
        check = api.verify_dukc_core_consistency(api.MODULES)
        assert len(set(check["fingerprints"].values())) == 1, "fingerprints should still agree"
        assert check["consistent"] is False, "golden-value self-test failed to catch drift"
        assert "FAIL" in check["golden_value_selftests"]["uc1_m6_jit_rta"]
    finally:
        m6._squat_m = original_squat
        m6._dukc_core_selftest = original_selftest
    assert api.verify_dukc_core_consistency(api.MODULES)["consistent"]
