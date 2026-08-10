"""
Tests for the integration layer: jnpa_input, train_tat_model, predict, run_model.

The eight model modules are covered by test_uc1_models.py. This file covers the
path from a spreadsheet to a prediction, and pins the failure modes found while
building it:

  * a target column (ETB/TAT/ETD) appearing in the input must be a hard error
  * IST -> UTC must happen exactly once, at the boundary
  * the stdlib .xlsx reader must agree with openpyxl cell for cell
  * a trained artefact must round-trip to identical predictions
  * a modified .pkl must be refused
  * ETD - ATA == TAT and ETB - ATA == wait must hold on every row
  * M8's DUKC column is the reference vessel, not the row's vessel
"""

from __future__ import annotations

import csv
import os
import sys
from datetime import datetime, time, timedelta, timezone

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src", "pipeline"))

import jnpa_paths  # noqa: E402

jnpa_paths.ensure_on_syspath()

import jnpa_input as jio  # noqa: E402
import predict as pr  # noqa: E402
import run_model as rm  # noqa: E402
import train_tat_model as trainer  # noqa: E402

HERE = ROOT
SAMPLE = jnpa_paths.SAMPLE_INPUT_XLSX
MODEL_DIR = jnpa_paths.TRAINED_MODELS_DIR

requires_sample = pytest.mark.skipif(
    not os.path.exists(SAMPLE), reason="Vessel_Training_Input_Sample.xlsx not present"
)


@pytest.fixture(scope="module")
def batch():
    return jio.load_input(SAMPLE)


@pytest.fixture(scope="module")
def predictor():
    p, prov = pr.resolve_predictor(None, MODEL_DIR)
    return p, prov


# ---------------------------------------------------------------------------
# jnpa_input -- parsers and canonicalisation
# ---------------------------------------------------------------------------


def test_selftest_all_pass():
    checks = jio._self_test()
    failed = [(n, d) for n, ok, d in checks if not ok]
    assert not failed, f"jnpa_input self-test failures: {failed}"


@pytest.mark.parametrize("raw,expected", [
    ("2026-07-29 06:00", datetime(2026, 7, 29, 0, 30, tzinfo=timezone.utc)),
    ("29-07-2026 06:00", datetime(2026, 7, 29, 0, 30, tzinfo=timezone.utc)),
    ("29/07/2026 06:00", datetime(2026, 7, 29, 0, 30, tzinfo=timezone.utc)),
    ("11022026:17:00", datetime(2026, 2, 11, 11, 30, tzinfo=timezone.utc)),  # BERMAN XML
])
def test_ist_to_utc_conversion(raw, expected):
    assert jio.parse_datetime_ist(raw) == expected


def test_utc_conversion_is_not_applied_twice():
    """An input that already carries an offset must be respected, not shifted again."""
    aware = "2026-07-29T06:00:00+05:30"
    assert jio.parse_datetime_ist(aware) == datetime(2026, 7, 29, 0, 30, tzinfo=timezone.utc)


@pytest.mark.parametrize("raw,terminal,expected", [
    ("CB04", "NSICT", "CB-04"),
    ("CB-04", "NSICT", "CB-04"),
    ("BM05", "BMCT", "BMCT-05"),
    ("BMCT05", "BMCT", "BMCT-05"),
    ("CCB-N", "NSDT", "CCB-N"),
    ("5", "BMCT", "BMCT-05"),
])
def test_berth_canonicalisation(raw, terminal, expected):
    assert jio.canonical_berth(raw, terminal) == expected


def test_jnpct_is_the_former_name_of_nsft():
    assert jio.canonical_terminal("JNPCT") == "NSFT"


@pytest.mark.parametrize("raw,expected", [("13.2 m", 13.2), ("68%", 68.0),
                                          ("52,000", 52000.0), ("8 kn", 8.0)])
def test_float_parsing_strips_units(raw, expected):
    assert jio.parse_float(raw) == expected


def test_float_parsing_rejects_text():
    with pytest.raises(jio.ParseError) as exc:
        jio.parse_float("not a number")
    assert exc.value.code == "not_a_number"


def test_range_violation_is_reported(tmp_path):
    path = tmp_path / "bad_draft.csv"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Vessel", "ATA", "Draft_m"])
        w.writerow(["X", "2026-07-29 06:00", "99.0"])   # 99 m draft is impossible
    b = jio.load_input(str(path))
    assert any(i.code == "above_range" for i in b.all_issues)
    assert not b.ok


def test_target_column_in_input_is_a_hard_error(tmp_path):
    """Silently ignoring a target column is how leakage gets into a pipeline."""
    path = tmp_path / "leaky.csv"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Vessel", "ATA", "Draft_m", "TAT"])
        w.writerow(["X", "2026-07-29 06:00", "13.0", "44"])
    b = jio.load_input(str(path))
    errors = [i for i in b.all_issues if i.severity == "ERROR"]
    assert any(i.code == "target_column_in_input" for i in errors)
    assert not b.ok


@pytest.mark.parametrize("target", ["ETB", "TAT", "ETD", "ATB", "ATD"])
def test_every_target_name_is_blocked(target):
    assert jio._key(target) in jio._TARGET_KEYS


def test_tide_window_crossing_midnight(tmp_path):
    path = tmp_path / "midnight.csv"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Vessel", "ATA", "Draft_m", "Tide_Window_Start", "Tide_Window_End"])
        w.writerow(["X", "2026-07-29 20:00", "13.0", "22:00", "02:00"])
    row = jio.load_input(str(path)).valid_rows[0]
    assert row.tide_window_end_utc > row.tide_window_start_utc
    span = (row.tide_window_end_utc - row.tide_window_start_utc).total_seconds() / 3600.0
    assert span == pytest.approx(4.0)


def test_calls_prev_24h_never_counts_itself(batch):
    for r in batch.valid_rows:
        assert r.calls_prev_24h < len(batch.valid_rows)


def test_measured_tide_overrides_the_synthetic_model(tmp_path):
    path = tmp_path / "tide.csv"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Vessel", "ATA", "Draft_m", "Tide_Height_m"])
        w.writerow(["X", "2026-07-29 06:00", "13.0", "2.85"])
    row = jio.load_input(str(path)).valid_rows[0]
    assert row.tide_height_m == 2.85
    assert row.tide_source == "COLUMN_Tide_Height_m"


def test_synthetic_tide_is_labelled_as_such(batch):
    assert all(r.tide_source == "SYNTHETIC_HARMONIC_v1" for r in batch.valid_rows)


# ---------------------------------------------------------------------------
# jnpa_input -- readers
# ---------------------------------------------------------------------------


@requires_sample
def test_stdlib_xlsx_reader_agrees_with_openpyxl():
    """The zero-dependency fallback must not quietly disagree with openpyxl."""
    openpyxl = pytest.importorskip("openpyxl")
    _, grid_a = jio._read_xlsx_stdlib(SAMPLE)
    wb = openpyxl.load_workbook(SAMPLE, data_only=True, read_only=True)
    try:
        grid_b = [list(r) for r in wb.worksheets[0].iter_rows(values_only=True)]
    finally:
        wb.close()
    assert [str(x) for x in grid_a[0]] == [str(x) for x in grid_b[0] if x is not None]
    for row_a, row_b in zip(grid_a[1:], grid_b[1:]):
        assert [str(x) for x in row_a] == [str(x) for x in row_b[:len(row_a)]]


@requires_sample
def test_sample_workbook_loads_cleanly(batch):
    assert batch.ok
    assert len(batch.valid_rows) == 3
    assert batch.error_count == 0
    assert len(batch.header_map) == 25


@requires_sample
def test_sample_ata_converted_to_utc(batch):
    # 07:45 IST on 2026-07-29 is 02:15 UTC.
    assert batch.valid_rows[0].ata_utc == datetime(2026, 7, 29, 2, 15, tzinfo=timezone.utc)


def test_csv_and_json_round_trip(tmp_path):
    import json as _json

    rows = [{"Vessel": "X", "ATA": "2026-07-29 06:00", "Draft_m": 13.0}]
    json_path = tmp_path / "in.json"
    json_path.write_text(_json.dumps(rows), encoding="utf-8")
    csv_path = tmp_path / "in.csv"
    with open(csv_path, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)

    a = jio.load_input(str(json_path)).valid_rows[0]
    b = jio.load_input(str(csv_path)).valid_rows[0]
    assert a.ata_utc == b.ata_utc
    assert a.draft_m == b.draft_m


# ---------------------------------------------------------------------------
# jnpa_input -- adapters
# ---------------------------------------------------------------------------


@requires_sample
def test_m3_adapter_emits_no_banned_field(batch):
    import uc1_m3_tat_predict as m3

    features = jio.to_m3_features(batch.valid_rows[0])
    assert len(m3.to_vector(features)) == len(m3.FEATURE_COLUMNS)
    assert not (set(m3.FEATURE_COLUMNS) & m3.BANNED_FIELDS)


@requires_sample
def test_dukc_status_is_carried_but_never_fed_to_m1(batch):
    """The sheet's DUKC_Status is a label. It must reach the row and stop there."""
    import dataclasses

    row = batch.valid_rows[0]
    assert row.dukc_status_reported == "SAFE"
    vessel = jio.to_m1_vessel(row)
    channel = jio.to_m1_channel(row)
    for obj in (vessel, channel):
        for f in dataclasses.fields(obj):
            assert "status" not in f.name.lower()


@requires_sample
def test_m8_adapter_only_perturbs_exogenous_nodes(batch):
    import uc1_m8_causal_chain as m8

    for row in batch.valid_rows:
        for d in jio.to_m8_disruptions(row):
            assert d.node_id in m8._EXOGENOUS


@requires_sample
def test_m8_adapter_skips_values_equal_to_baseline():
    import uc1_m8_causal_chain as m8

    graph = m8.build_graph()
    row = jio.VesselCallInput(
        row=2, call_id="C-0002", vessel_name="X",
        ata_utc=datetime(2026, 7, 29, tzinfo=timezone.utc), draft_m=13.0,
        wind_kn=graph.nodes["WX_WIND_KN"].baseline,
        rain_mm_hr=graph.nodes["WX_RAIN_MMHR"].baseline,
        tide_height_m=graph.nodes["TIDE_HEIGHT_M"].baseline,
        pilots_available=int(graph.nodes["PILOT_AVAIL_N"].baseline),
        tugs_available=int(graph.nodes["TUG_AVAIL_N"].baseline),
    )
    ids = {d.node_id for d in jio.to_m8_disruptions(row)}
    assert "WX_WIND_KN" not in ids
    assert "TIDE_HEIGHT_M" not in ids


# ---------------------------------------------------------------------------
# train_tat_model
# ---------------------------------------------------------------------------


@pytest.mark.slow
def test_trainer_selftest_all_pass():
    checks = trainer._self_test()
    failed = [(n, d) for n, ok, d in checks if not ok]
    assert not failed, f"trainer self-test failures: {failed}"


@pytest.mark.slow
def test_artifact_round_trip_is_identical(tmp_path):
    res = trainer.train(days=40, engine="additive")
    pkl, card = trainer.save_artifact(res, str(tmp_path))
    loaded = trainer.load_artifact(pkl)

    features = res["test_calls"][0].features
    before = res["predictor"].predict(features)
    after = loaded["predictor"].predict(features)
    assert before.p10_hours == pytest.approx(after.p10_hours, abs=1e-9)
    assert before.p50_hours == pytest.approx(after.p50_hours, abs=1e-9)
    assert before.p90_hours == pytest.approx(after.p90_hours, abs=1e-9)


@pytest.mark.slow
def test_modified_artifact_is_refused(tmp_path):
    res = trainer.train(days=40, engine="additive")
    pkl, _ = trainer.save_artifact(res, str(tmp_path))
    with open(pkl, "ab") as fh:
        fh.write(b"\x00tamper")
    with pytest.raises(Exception):
        trainer.load_artifact(pkl)


def test_missing_artifact_says_how_to_train_one(tmp_path):
    with pytest.raises(FileNotFoundError) as exc:
        trainer.load_artifact(str(tmp_path / "nope.pkl"))
    assert "run.py train" in str(exc.value)


@pytest.mark.slow
def test_artifact_filename_names_the_engine_that_won(tmp_path):
    res = trainer.train(days=40, engine="additive")
    pkl, _ = trainer.save_artifact(res, str(tmp_path))
    assert "additive" in os.path.basename(pkl)


def test_coverage_gate_rejects_a_band_that_covers_everything():
    """A band covering 99% is uninformative, not good. The gate must catch it."""
    import dataclasses

    import uc1_m3_tat_predict as m3

    good = m3.TATMetrics(
        n_test=100, mae_hours=2.5, rmse_hours=3.0, mape_pct=6.0,
        forecast_accuracy_pct=94.0, pinball_p10=0.5, pinball_p50=1.2, pinball_p90=0.6,
        coverage_80_pct=85.0, mean_band_width_hours=9.0, mape_rows_dropped=0,
        engine="additive", model_version="test",
    )
    assert trainer.evaluate_gates(good)["passed"]
    too_wide = dataclasses.replace(good, coverage_80_pct=99.5)
    assert not trainer.evaluate_gates(too_wide)["passed"]
    too_narrow = dataclasses.replace(good, coverage_80_pct=41.0)
    assert not trainer.evaluate_gates(too_narrow)["passed"]


# ---------------------------------------------------------------------------
# predict -- the three targets
# ---------------------------------------------------------------------------


@requires_sample
def test_predict_selftest_all_pass():
    checks = pr._self_test()
    failed = [(n, d) for n, ok, d in checks if not ok]
    assert not failed, f"predict self-test failures: {failed}"


@requires_sample
def test_target_arithmetic_closes(batch, predictor):
    p, _ = predictor
    preds, _ = pr.predict_batch(batch, p, wait_model="optimiser")
    assert len(preds) == len(batch.valid_rows)
    for row in preds:
        etd_minus_ata = (row.etd_utc - row.ata_utc).total_seconds() / 3600.0
        etb_minus_ata = (row.etb_utc - row.ata_utc).total_seconds() / 3600.0
        assert etd_minus_ata == pytest.approx(row.tat_hours, abs=1e-6)
        assert etb_minus_ata == pytest.approx(row.wait_hours, abs=1e-6)
        assert row.berth_stay_hours == pytest.approx(row.tat_hours - row.wait_hours, abs=1e-6)
        assert row.ata_utc <= row.etb_utc <= row.etd_utc
        assert row.tat_p10_hours <= row.tat_hours <= row.tat_p90_hours


@requires_sample
def test_berth_stay_floor_is_enforced(batch, predictor):
    p, _ = predictor
    preds, _ = pr.predict_batch(batch, p, wait_model="queue", wait_percentile=90)
    for row in preds:
        assert row.berth_stay_hours >= pr.MIN_BERTH_STAY_H - 1e-9
        if row.berth_stay_hours == pytest.approx(pr.MIN_BERTH_STAY_H):
            assert "ETD_RECONCILED" in row.flags


@requires_sample
def test_predictions_are_deterministic(batch, predictor):
    p, _ = predictor
    a, _ = pr.predict_batch(batch, p, wait_model="optimiser")
    b, _ = pr.predict_batch(batch, p, wait_model="optimiser")
    assert [x.tat_hours for x in a] == [x.tat_hours for x in b]
    assert [x.etd_utc for x in a] == [x.etd_utc for x in b]


@requires_sample
def test_small_sample_is_flagged_as_a_lower_bound(batch, predictor):
    """A 3-row file cannot show real berth contention. It must say so."""
    p, _ = predictor
    preds, _ = pr.predict_batch(batch, p, wait_model="optimiser")
    assert any("WAIT_IS_LOWER_BOUND" in row.flags for row in preds)


@requires_sample
def test_wait_model_none_puts_etb_at_ata(batch, predictor):
    p, _ = predictor
    preds, _ = pr.predict_batch(batch, p, wait_model="none")
    assert all(row.wait_hours == 0.0 and row.etb_utc == row.ata_utc for row in preds)


def test_explicit_missing_artifact_is_not_silently_replaced(tmp_path):
    """
    Scoring with a different model than the one you named would be worse than
    stopping, so an explicit --artifact that does not exist must raise.
    """
    with pytest.raises(FileNotFoundError):
        pr.resolve_predictor(str(tmp_path / "nope.pkl"), str(tmp_path))


@pytest.mark.slow
def test_digest_mismatch_propagates_rather_than_falling_back(tmp_path):
    """A modified .pkl is an integrity failure, not a compatibility one."""
    res = trainer.train(days=40, engine="additive")
    pkl, _ = trainer.save_artifact(res, str(tmp_path))
    with open(pkl, "ab") as fh:
        fh.write(b"\x00tamper")
    with pytest.raises(Exception) as exc:
        pr.resolve_predictor(pkl, str(tmp_path))
    assert not isinstance(exc.value, SystemExit)


def test_no_artifact_falls_back_and_says_so(tmp_path):
    _, prov = pr.resolve_predictor(None, str(tmp_path))
    assert prov["mode"] == "UNTRAINED_FALLBACK"
    assert prov["engine"] == "additive"
    assert "run.py train" in prov["warning"]


def test_queue_wait_never_returns_nan():
    """The DSR corpus has no ATA; the fallback must fire rather than emit NaN."""
    import math

    stats = pr.wait_from_queue(50)
    assert math.isfinite(stats["wait_hours"])
    assert stats["wait_hours"] > 0
    if stats["fallback_reason"]:
        assert "fallback" in stats["data_source"].lower()


@requires_sample
def test_synthetic_tide_is_flagged_on_every_row(batch, predictor):
    p, _ = predictor
    preds, _ = pr.predict_batch(batch, p, wait_model="none")
    assert all("TIDE_SYNTHETIC" in row.flags for row in preds)


@requires_sample
def test_ml_attribution_is_labelled_as_a_surrogate(batch, predictor):
    p, prov = predictor
    preds, _ = pr.predict_batch(batch, p, wait_model="none")
    for row in preds:
        if row.engine != "additive":
            assert row.attribution_source != row.engine
            assert any("surrogate" in n for n in row.notes)


# ---------------------------------------------------------------------------
# run_model
# ---------------------------------------------------------------------------


def test_registry_has_eight_models():
    assert len(rm.MODELS) == 8
    assert set(rm.MODELS) == {f"m{i}" for i in range(1, 9)}
    assert set(rm.MODEL_SCOPE) == set(rm.MODELS)


@requires_sample
@pytest.mark.parametrize("key", sorted(rm.MODELS))
def test_every_model_runs_on_the_sample(key, batch):
    res = rm.run_one(key, batch, {"model_dir": MODEL_DIR, "roster_preset": "real"})
    assert res.ok, f"{key} failed: {res.error}"
    assert res.rows, f"{key} produced no rows"


@requires_sample
def test_per_row_models_cover_every_vessel(batch):
    opts = {"model_dir": MODEL_DIR, "roster_preset": "real"}
    for key, scope in rm.MODEL_SCOPE.items():
        if scope != "per-row":
            continue
        res = rm.run_one(key, batch, opts)
        assert len(res.rows) == len(batch.valid_rows), key


@requires_sample
def test_m1_scores_itself_against_the_sheet_label(batch):
    res = rm.run_one("m1", batch, {"model_dir": MODEL_DIR})
    assert "validation_vs_sheet" in res.summary
    v = res.summary["validation_vs_sheet"]
    assert v["scored"] == len(batch.valid_rows)
    assert v["agree"] + v["disagree"] == v["scored"]
    for row in res.rows:
        assert "Status" in row and "Sheet_DUKC_Status" in row


@requires_sample
def test_m8_logs_one_step_per_node(batch):
    res = rm.run_one("m8", batch, {"model_dir": MODEL_DIR})
    assert res.summary["nodes"] == 23
    assert res.summary["edges"] == 30
    for row in res.rows:
        assert row["Propagation_Steps"] == 23


@requires_sample
def test_m8_dukc_is_the_reference_vessel_not_the_row_vessel(batch):
    """
    M8's DUKC node tracks a 15.0 m reference ULCV. It answers 'is the port open
    to deep-draft traffic', so it may disagree with M1's per-vessel verdict --
    and the runner must declare the reference so the difference is explicable.
    """
    res = rm.run_one("m8", batch, {"model_dir": MODEL_DIR})
    assert res.summary["reference_vessel_draft_m"] == 15.0
    assert any("REFERENCE" in n for n in res.notes)


@requires_sample
def test_m7_explains_why_there_are_no_conflicts(batch):
    """None of the sample movements overlap, so no roster size can conflict."""
    res = rm.run_one("m7", batch, {"model_dir": MODEL_DIR, "roster_preset": "poc",
                                   "down_craft": "PL-01,PL-02"})
    assert res.summary["conflicts"] == 0
    assert any("overlap" in n for n in res.notes)


def test_m7_detects_conflicts_when_movements_overlap(tmp_path):
    path = tmp_path / "overlapping.csv"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Vessel", "ATA", "Draft_m", "LOA_m", "Terminal", "Requested_Berth"])
        for i, name in enumerate(["MSC ANNA", "EVER GIVEN", "CMA CGM", "MAERSK"]):
            w.writerow([name, f"2026-07-29 06:{i * 15:02d}", "15.1", "399",
                        "BMCT", f"BMCT-0{i + 1}"])
    b = jio.load_input(str(path))
    res = rm.run_one("m7", b, {"roster_preset": "poc", "down_craft": "PL-01,PL-02"})
    assert res.ok
    assert res.summary["conflicts"] > 0
    assert res.summary["status"] == "CONFLICT_DETECTED"
    assert res.summary["proposals"] > 0


def test_m5_prefers_a_berth_shift_to_waiting(tmp_path):
    """A shift costs 0.5 and an hour of waiting costs 1.0, so shifting must win."""
    path = tmp_path / "contended.csv"
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["Vessel", "ATA", "Draft_m", "LOA_m", "Terminal", "Requested_Berth"])
        for i, name in enumerate(["A", "B", "C"]):
            # All three request the same berth at nearly the same time.
            w.writerow([name, f"2026-07-29 06:{i * 15:02d}", "13.0", "250",
                        "BMCT", "BMCT-01"])
    b = jio.load_input(str(path))
    res = rm.run_one("m5", b, {})
    assert res.ok
    assert res.summary["assigned"] == 3
    assert res.summary["berth_shifts"] >= 1


@requires_sample
def test_unknown_model_key_is_rejected():
    assert rm.main(["--model", "m9", "--input", SAMPLE]) == 1


@requires_sample
def test_outputs_are_written(tmp_path, batch):
    opts = {"model_dir": MODEL_DIR, "roster_preset": "real"}
    results = [rm.run_one(k, batch, opts) for k in ("m1", "m2")]
    written = rm.write_outputs(results, batch, str(tmp_path), "both", opts)
    assert len(written) >= 2
    assert all(os.path.exists(w) for w in written)

    import json as _json

    payload = _json.loads(open(next(w for w in written if w.endswith(".json")),
                               encoding="utf-8").read())
    assert len(payload["results"]) == 2
    assert payload["results"][0]["model_id"] == "UC1-M1"


@requires_sample
def test_runner_selftest_all_pass():
    checks = rm._self_test()
    failed = [(n, d) for n, ok, d in checks if not ok]
    assert not failed, f"run_model self-test failures: {failed}"


# ---------------------------------------------------------------------------
# dashboard_json -- the small file the UI consumes
# ---------------------------------------------------------------------------


@requires_sample
def test_dashboard_selftest_all_pass():
    import dashboard_json

    checks = dashboard_json._self_test()
    failed = [(n, d) for n, ok, d in checks if not ok]
    assert not failed, f"dashboard_json self-test failures: {failed}"


@requires_sample
def test_dashboard_is_one_block_per_vessel_per_model(batch):
    import dashboard_json

    opts = {"model_dir": MODEL_DIR, "roster_preset": "real", "wait_model": "optimiser"}
    results = [rm.run_one(k, batch, opts) for k in ("m1", "m3")]
    doc = dashboard_json.build(results, batch, opts)

    assert len(doc["vessels"]) == len(batch.valid_rows)
    for vessel in doc["vessels"]:
        # Only the models that actually ran appear; no empty placeholders.
        assert set(vessel["models"]) == {"m1_under_keel_clearance", "m3_turnaround_time"}
        assert vessel["call_id"] and vessel["vessel"]


@requires_sample
def test_dashboard_numbers_match_the_full_output(batch):
    """The dashboard file selects from the audit file; it must never re-derive."""
    import dashboard_json

    opts = {"model_dir": MODEL_DIR, "roster_preset": "real", "wait_model": "optimiser"}
    results = [rm.run_one("m1", batch, opts)]
    doc = dashboard_json.build(results, batch, opts)

    full = {r["Row"]: r for r in results[0].rows}
    for vessel, call in zip(doc["vessels"], batch.valid_rows):
        row = full[call.row]
        block = vessel["models"]["m1_under_keel_clearance"]
        assert block["status"] == row["Status"]
        assert block["net_ukc_m"] == round(row["Net_UKC_m"], 2)
        assert block["binding_reach"] == row["Binding_Reach"]


@requires_sample
def test_dashboard_is_written_alongside_the_full_json(tmp_path, batch):
    opts = {"model_dir": MODEL_DIR, "roster_preset": "real"}
    results = [rm.run_one("m1", batch, opts)]
    written = rm.write_outputs(results, batch, str(tmp_path), "json", opts)

    dash = [w for w in written if w.endswith("_dashboard.json")]
    assert len(dash) == 1, written

    import json as _json

    doc = _json.loads(open(dash[0], encoding="utf-8").read())
    assert doc["schema"].startswith("uc1-dashboard/")
    # The file has to explain itself: glossary plus a pointer back to the audit file.
    assert doc["glossary"] and doc["run"]["full_detail_file"].endswith(".json")


@requires_sample
def test_dashboard_is_far_smaller_than_the_audit_file(tmp_path, batch):
    opts = {"model_dir": MODEL_DIR, "roster_preset": "real"}
    results = [rm.run_one(k, batch, opts) for k in ("m1", "m3", "m8")]
    written = rm.write_outputs(results, batch, str(tmp_path), "json", opts)

    dash = next(w for w in written if w.endswith("_dashboard.json"))
    full = next(w for w in written if not w.endswith("_dashboard.json"))
    assert os.path.getsize(dash) * 4 < os.path.getsize(full), (
        f"dashboard {os.path.getsize(dash)} B vs full {os.path.getsize(full)} B"
    )
