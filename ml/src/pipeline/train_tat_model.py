"""
train_tat_model.py -- train the UC1-M3 TAT predictor and persist it to disk.
==========================================================================

WHY THIS FILE EXISTS
--------------------
Seven of the eight UC-1 models are deterministic: DUKC physics, tidal geometry,
interval arithmetic, an optimiser, a causal graph. They have no weights to learn,
so their "model file" is a versioned constant block that ships inside the module
and is served at ``GET /uc1/mN/constants``.

M3 is the exception. It is the only model that *learns* from history, so it is
the only one that produces a genuine trained artefact. This script performs that
training once and writes the result to disk:

    train_tat_model.py  --->  trained_models/uc1_m3_tat_<version>.pkl   (fitted model)
                              trained_models/uc1_m3_tat_<version>.json  (model card)

    predict.py          <---  loads the .pkl and scores an input file
                              without retraining anything.

Splitting training from inference is not cosmetic. It means the numbers you
report to JNPA come from one frozen, dated, auditable object rather than from a
model that quietly re-fits itself -- with a different random draw -- every time
somebody runs a prediction.

THE MODEL CARD
--------------
The ``.json`` sidecar is written for a human and for a reviewer. It records the
engine that won the fallback chain and why the others lost, the chronological
split boundary, the leakage audit result, the held-out metrics, the calibration
check, and the SHA-256 of the ``.pkl``. You can answer "what is this model and
is it any good?" without unpickling anything.

TRAINING DATA
-------------
By default the model trains on 365 days of calibrated synthetic vessel calls
(anchored to JNPA's published 1.83 d TAT / 0.97 d berth stay). That is a
deliberate choice, not an oversight: the real corpus in this repository has no
column that yields a true ATA, so a true end-to-end TAT cannot be measured from
it. What the corpus *does* contain is real berth-stay data, which
``dsr_extract.py`` recovers and which is used to anchor the berth-stay component.

Why 365 days and not 180: a model trained on a short window sees one season. Its
80% band then covers only ~68% of held-out reality because the test slice
includes weather it never met. Extending to a full year raised measured coverage
to ~86%. That is covariate shift, not miscalibration, and the fix is data span.

    --days 180  -> coverage ~68%, MAE ~3.9 h
    --days 365  -> coverage ~86%, MAE ~2.5 h    (default)

SECURITY NOTE ON PICKLE
-----------------------
The artefact is a Python pickle, which executes code on load. Load only
artefacts you produced yourself. ``predict.py`` verifies the SHA-256 recorded in
the model card before unpickling and refuses to load a file whose digest does
not match, which catches corruption and casual tampering -- it is an integrity
check, not a security boundary.

CLI
---
    python run.py train
    python run.py train --days 365 --engine auto --out trained_models/
    python run.py train --engine additive --tag portable
    python run.py train --compare-engines
    python run.py train --selftest

Exit code 0 on success, 1 if training failed or a quality gate was not met.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pickle
import platform
import sys
import time
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Tuple

import jnpa_paths

jnpa_paths.ensure_on_syspath()

import uc1_m3_tat_predict as m3  # noqa: E402

MODULE_ID: str = "UC1-M3-TRAINER"
MODULE_VERSION: str = "train-tat-v1.0.0"
ARTIFACT_SCHEMA: str = "jnpa-tat-artifact/1.0.0"

DEFAULT_MODEL_DIR: str = jnpa_paths.TRAINED_MODELS_DIR
DEFAULT_DAYS: int = 365
DEFAULT_SEED: int = 20260807
DEFAULT_TEST_FRACTION: float = 0.20
DEFAULT_EMBARGO_HOURS: float = 24.0

# Quality gates. Training fails loudly rather than shipping a bad model.
GATE_MAX_MAE_HOURS: float = 8.0
GATE_MIN_ACCURACY_PCT: float = 80.0
GATE_MIN_COVERAGE_PCT: float = 60.0
GATE_MAX_COVERAGE_PCT: float = 95.0
"""
Coverage is gated on both sides on purpose. A band that covers 99% of outcomes
is not a good band -- it is an uninformative one, and it will be too wide to plan
against. The nominal target is 80%.
"""


# ---------------------------------------------------------------------------
# artefact write / read
# ---------------------------------------------------------------------------


def _sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def artifact_paths(out: str, tag: str = "", engine: str = "") -> Tuple[str, str]:
    """
    Resolve ``--out`` into ``(pkl_path, json_path)``.

    ``--out`` may be a directory (a versioned filename is generated) or an
    explicit ``.pkl`` path. The generated name carries the engine that actually
    won the fallback chain, so ``uc1_m3_tat_lightgbm_v1.2.0.pkl`` is never
    mistaken for the additive model. ``TAT_MODEL_VERSION`` names the *coefficient
    set*, not the engine, which is why only its version suffix is used here.
    """
    if out.lower().endswith(".pkl"):
        base = out[:-4]
    else:
        coef_version = m3.TAT_MODEL_VERSION.rsplit("-", 1)[-1]  # "m3-additive-v1.2.0" -> "v1.2.0"
        stem = f"uc1_m3_tat_{engine or 'model'}_{coef_version}"
        if tag:
            stem += f"_{tag}"
        base = os.path.join(out, stem)
    parent = os.path.dirname(os.path.abspath(base))
    if parent:
        os.makedirs(parent, exist_ok=True)
    return base + ".pkl", base + ".json"


def train(
    *,
    days: int = DEFAULT_DAYS,
    seed: int = DEFAULT_SEED,
    engine: str = "auto",
    test_fraction: float = DEFAULT_TEST_FRACTION,
    embargo_hours: float = DEFAULT_EMBARGO_HOURS,
    conformal: bool = True,
) -> Dict[str, Any]:
    """
    Fit the predictor and return everything needed to write the artefact.

    The split is chronological with a purge and a 24 h embargo, exactly as M3
    defines it -- no shuffling, no random K-fold. Imputation statistics are fitted
    on the training slice only.
    """
    t0 = time.time()
    calls = m3.generate_synthetic_calls(n_days=days, seed=seed)
    calibration = m3.verify_calibration(calls)

    train_calls, test_calls, split = m3.chronological_split(
        calls, test_fraction=test_fraction, embargo_hours=embargo_hours
    )

    predictor = m3.TATPredictor(engine=engine, seed=seed, conformal=conformal)
    predictor.fit(train_calls)
    metrics = m3.evaluate_model(predictor, test_calls)

    # A real berth-stay anchor from the DSR corpus, when the CSV is present.
    dsr = m3.DailyStatusReportLoader()
    dsr_available = bool(getattr(dsr, "available", lambda: False)())

    return {
        "predictor": predictor,
        "calls_total": len(calls),
        "train_calls": train_calls,
        "test_calls": test_calls,
        "split": split,
        "metrics": metrics,
        "calibration": calibration,
        "leakage_audit": m3.leakage_audit(),
        "backends": m3.backend_status(),
        "dsr_available": dsr_available,
        "elapsed_s": round(time.time() - t0, 2),
        "config": {
            "days": days,
            "seed": seed,
            "engine_requested": engine,
            "test_fraction": test_fraction,
            "embargo_hours": embargo_hours,
            "conformal": conformal,
        },
    }


def build_model_card(result: Dict[str, Any], pkl_path: str, pkl_sha256: str) -> Dict[str, Any]:
    """The human-readable + reviewer-readable sidecar."""
    predictor = result["predictor"]
    metrics = result["metrics"]
    split = result["split"]
    return {
        "artifact_schema": ARTIFACT_SCHEMA,
        "model_id": "UC1-M3",
        "model_name": "JNPA UC-1 Turnaround Time (TAT) predictor",
        "model_version": m3.TAT_MODEL_VERSION,
        "module_version": m3.MODULE_VERSION,
        "trained_by": MODULE_VERSION,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "artifact_file": os.path.basename(pkl_path),
        "artifact_sha256": pkl_sha256,
        "engine": {
            "selected": predictor.selected_engine,
            "requested": result["config"]["engine_requested"],
            "priority_chain": list(m3.ENGINE_PRIORITY),
            "trace": [asdict(a) for a in predictor.engine_trace],
        },
        "training_data": {
            "source": "SYNTHETIC_CALIBRATED_v1",
            "days": result["config"]["days"],
            "seed": result["config"]["seed"],
            "n_calls_total": result["calls_total"],
            "n_train": split.n_train,
            "n_test": split.n_test,
            "n_purged": split.n_purged,
            "dsr_berth_stay_anchor_available": result["dsr_available"],
            "note": (
                "TAT labels are synthetic and calibrated to JNPA's published "
                "1.83 d mean TAT. The corpus in this repository contains no "
                "column yielding a true ATA, so an end-to-end TAT cannot be "
                "measured from it. Real berth-stay data from dsr_extract.py "
                "anchors the berth-stay component when the CSV is present."
            ),
        },
        "split": {
            "method": split.method,
            "split_time_utc": split.split_time_utc.isoformat(),
            "embargo_hours": split.embargo_hours,
            "train_span": [x.isoformat() if x else None for x in split.train_span],
            "test_span": [x.isoformat() if x else None for x in split.test_span],
            "ordering_assert_passed": split.ordering_assert_passed,
            "note": "Chronological with purge + embargo. No shuffled split, no K-fold.",
        },
        "leakage_audit": result["leakage_audit"],
        "features": {
            "columns": list(m3.FEATURE_COLUMNS),
            "count": len(m3.FEATURE_COLUMNS),
            "banned_from_features": sorted(m3.BANNED_FIELDS),
        },
        "metrics_holdout": asdict(metrics),
        "calibration": result["calibration"],
        "quality_gates": evaluate_gates(metrics),
        "backends_at_train_time": result["backends"],
        "coefficients": asdict(m3.DEFAULT_COEFFICIENTS),
        "elapsed_s": result["elapsed_s"],
        "usage": {
            "predict_cli": "python run.py predict --input <file.xlsx> --artifact "
                           + os.path.basename(pkl_path),
            "load_python": "from train_tat_model import load_artifact; "
                           "art = load_artifact('<path.pkl>'); "
                           "pred = art['predictor'].predict(features)",
        },
    }


def evaluate_gates(metrics: "m3.TATMetrics") -> Dict[str, Any]:
    """Check the trained model against the shipping thresholds."""
    gates = [
        ("mae_within_limit", metrics.mae_hours <= GATE_MAX_MAE_HOURS,
         f"MAE {metrics.mae_hours:.2f} h <= {GATE_MAX_MAE_HOURS} h"),
        ("accuracy_above_floor", metrics.forecast_accuracy_pct >= GATE_MIN_ACCURACY_PCT,
         f"accuracy {metrics.forecast_accuracy_pct:.2f}% >= {GATE_MIN_ACCURACY_PCT}%"),
        ("coverage_not_too_low", metrics.coverage_80_pct >= GATE_MIN_COVERAGE_PCT,
         f"coverage {metrics.coverage_80_pct:.1f}% >= {GATE_MIN_COVERAGE_PCT}%"),
        ("coverage_not_too_wide", metrics.coverage_80_pct <= GATE_MAX_COVERAGE_PCT,
         f"coverage {metrics.coverage_80_pct:.1f}% <= {GATE_MAX_COVERAGE_PCT}% "
         f"(a band that covers everything is uninformative)"),
        ("band_is_usable", metrics.mean_band_width_hours <= 48.0,
         f"mean band width {metrics.mean_band_width_hours:.2f} h <= 48 h"),
    ]
    return {
        "passed": all(ok for _, ok, _ in gates),
        "checks": [{"name": n, "passed": ok, "detail": d} for n, ok, d in gates],
    }


def save_artifact(result: Dict[str, Any], out: str, tag: str = "") -> Tuple[str, str]:
    """Write the ``.pkl`` and its ``.json`` model card. Returns both paths."""
    pkl_path, json_path = artifact_paths(out, tag, result["predictor"].selected_engine)

    payload = {
        "artifact_schema": ARTIFACT_SCHEMA,
        "model_version": m3.TAT_MODEL_VERSION,
        "module_version": m3.MODULE_VERSION,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "engine": result["predictor"].selected_engine,
        "feature_columns": list(m3.FEATURE_COLUMNS),
        "predictor": result["predictor"],
        "coefficients": m3.DEFAULT_COEFFICIENTS,
        "config": result["config"],
    }
    with open(pkl_path, "wb") as fh:
        pickle.dump(payload, fh, protocol=pickle.HIGHEST_PROTOCOL)

    card = build_model_card(result, pkl_path, _sha256_file(pkl_path))
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(card, fh, indent=2, default=str)
    return pkl_path, json_path


def load_artifact(pkl_path: str, *, verify: bool = True) -> Dict[str, Any]:
    """
    Load a trained artefact, verifying its SHA-256 against the model card.

    Raises ``FileNotFoundError`` if the ``.pkl`` is missing and ``ValueError`` if
    the digest does not match the card. Pass ``verify=False`` only when the card
    is deliberately absent.
    """
    if not os.path.exists(pkl_path):
        raise FileNotFoundError(
            f"model artefact not found: {pkl_path}\n"
            f"  train one first:  python run.py train --out trained_models/"
        )
    json_path = pkl_path[:-4] + ".json" if pkl_path.endswith(".pkl") else pkl_path + ".json"
    card: Dict[str, Any] = {}
    if os.path.exists(json_path):
        with open(json_path, "r", encoding="utf-8") as fh:
            card = json.load(fh)
        if verify:
            expected = card.get("artifact_sha256", "")
            actual = _sha256_file(pkl_path)
            if expected and expected != actual:
                raise ValueError(
                    f"artefact digest mismatch for {pkl_path}\n"
                    f"  model card says : {expected}\n"
                    f"  file on disk is : {actual}\n"
                    f"  The .pkl has changed since it was trained. Retrain rather "
                    f"than loading it."
                )
    elif verify:
        raise ValueError(
            f"no model card beside {pkl_path}; cannot verify integrity. "
            f"Retrain, or pass verify=False if you know the file is yours."
        )

    with open(pkl_path, "rb") as fh:
        payload = pickle.load(fh)

    if payload.get("artifact_schema") != ARTIFACT_SCHEMA:
        raise ValueError(
            f"{pkl_path}: artefact schema {payload.get('artifact_schema')!r} "
            f"is not {ARTIFACT_SCHEMA!r}; retrain with this version of the trainer"
        )
    if list(payload.get("feature_columns", [])) != list(m3.FEATURE_COLUMNS):
        raise ValueError(
            f"{pkl_path}: the artefact's feature list no longer matches "
            f"uc1_m3_tat_predict.FEATURE_COLUMNS. The model was trained against a "
            f"different schema -- retrain it."
        )
    payload["model_card"] = card
    payload["artifact_path"] = os.path.abspath(pkl_path)
    return payload


def find_latest_artifact(model_dir: str = DEFAULT_MODEL_DIR) -> Optional[str]:
    """Newest ``.pkl`` in ``model_dir``, or None."""
    if not os.path.isdir(model_dir):
        return None
    candidates = [
        os.path.join(model_dir, f) for f in os.listdir(model_dir)
        if f.endswith(".pkl") and f.startswith("uc1_m3_tat")
    ]
    if not candidates:
        return None
    return max(candidates, key=os.path.getmtime)


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------


def _print_report(result: Dict[str, Any], pkl_path: str, json_path: str) -> None:
    predictor = result["predictor"]
    metrics = result["metrics"]
    split = result["split"]
    cfg = result["config"]

    print("=" * 78)
    print(f"  UC1-M3 TAT MODEL TRAINING  |  {MODULE_VERSION}")
    print("=" * 78)

    print("\n  1. BACKENDS")
    for name, status in sorted(result["backends"].items()):
        available = status.get("available") if isinstance(status, dict) else bool(status)
        detail = (status.get("error") or "") if isinstance(status, dict) else ""
        print(f"     {name:<18} {'available' if available else 'not installed'}"
              f"{('  ' + str(detail)[:44]) if detail else ''}")

    print("\n  2. TRAINING DATA")
    print(f"     source            SYNTHETIC_CALIBRATED_v1 "
          f"({cfg['days']} days, seed {cfg['seed']})")
    print(f"     calls             {result['calls_total']}")
    print(f"     DSR berth anchor  {'present' if result['dsr_available'] else 'absent (synthetic only)'}")
    cal = result["calibration"]
    for key in ("tat_days", "berth_stay_days"):
        if key in cal:
            entry = cal[key]
            print(f"     {key:<17} achieved {entry.get('achieved'):.3f} "
                  f"vs target {entry.get('target')} "
                  f"-> {'PASS' if entry.get('passed') else 'FAIL'}")

    print("\n  3. LEAKAGE AUDIT")
    audit = result["leakage_audit"]
    print(f"     banned n features  {audit.get('intersection', audit.get('overlap', []))}")
    print(f"     verdict            {'PASS' if audit.get('passed', True) else 'FAIL'}"
          f"  (BANNED_FIELDS is disjoint from FEATURE_COLUMNS)")

    print("\n  4. CHRONOLOGICAL SPLIT")
    print(f"     method            {split.method}")
    print(f"     split at (UTC)    {split.split_time_utc.isoformat()}")
    print(f"     train / test      {split.n_train} / {split.n_test} "
          f"({split.n_purged} purged by the {split.embargo_hours:g} h embargo)")
    print(f"     ordering assert   {'PASS' if split.ordering_assert_passed else 'FAIL'}"
          f"  (max train ATB < min test ATB)")

    print("\n  5. ENGINE SELECTION")
    print(f"     {'engine':<16} {'available':<10} {'selected':<9} reason")
    print("     " + "-" * 66)
    for a in predictor.engine_trace:
        print(f"     {a.engine:<16} {str(a.available):<10} {str(a.selected):<9} {a.reason[:38]}")
    print(f"     -> selected: {predictor.selected_engine}")

    print("\n  6. HELD-OUT METRICS")
    rows = [
        ("test calls", f"{metrics.n_test}"),
        ("MAE", f"{metrics.mae_hours:.2f} h"),
        ("RMSE", f"{metrics.rmse_hours:.2f} h"),
        ("MAPE", f"{metrics.mape_pct:.2f} %"),
        ("forecast accuracy", f"{metrics.forecast_accuracy_pct:.2f} %  ((1-MAPE)*100)"),
        ("pinball p10/p50/p90", f"{metrics.pinball_p10:.3f} / {metrics.pinball_p50:.3f} / "
                                f"{metrics.pinball_p90:.3f}"),
        ("80% band coverage", f"{metrics.coverage_80_pct:.1f} %  (target 80%)"),
        ("mean band width", f"{metrics.mean_band_width_hours:.2f} h"),
    ]
    for label, value in rows:
        print(f"     {label:<22} {value}")

    print("\n  7. QUALITY GATES")
    gates = evaluate_gates(metrics)
    for c in gates["checks"]:
        print(f"     [{'PASS' if c['passed'] else 'FAIL'}] {c['name']:<24} {c['detail']}")

    print("\n  8. ARTEFACT WRITTEN")
    size_kb = os.path.getsize(pkl_path) / 1024.0
    print(f"     model   {pkl_path}  ({size_kb:,.1f} KB)")
    print(f"     card    {json_path}")
    print(f"     sha256  {_sha256_file(pkl_path)}")
    print(f"     time    {result['elapsed_s']:.2f} s")

    print("\n  NEXT STEP")
    print(f"     python run.py predict --input data/input/Vessel_Training_Input_Sample.xlsx "
          f"--artifact {pkl_path}")
    print()


def compare_engines(days: int, seed: int) -> List[Dict[str, Any]]:
    """Train every available engine and tabulate them. Diagnostic, not shipping."""
    out: List[Dict[str, Any]] = []
    for name in m3.ENGINE_PRIORITY:
        try:
            res = train(days=days, seed=seed, engine=name)
            mt = res["metrics"]
            out.append({
                "engine": name,
                "selected": res["predictor"].selected_engine,
                "mae_hours": round(mt.mae_hours, 3),
                "accuracy_pct": round(mt.forecast_accuracy_pct, 2),
                "coverage_80_pct": round(mt.coverage_80_pct, 1),
                "band_width_h": round(mt.mean_band_width_hours, 2),
                "ok": True,
            })
        except Exception as exc:  # pragma: no cover - engine unavailable
            out.append({"engine": name, "ok": False, "error": repr(exc)[:120]})
    return out


# ---------------------------------------------------------------------------
# self-test
# ---------------------------------------------------------------------------


def _self_test() -> List[Tuple[str, bool, str]]:
    import tempfile

    checks: List[Tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, bool(ok), detail))

    # A short, fast run: the point is the round trip, not the accuracy.
    res = train(days=45, seed=DEFAULT_SEED, engine="additive")
    check("trains", res["predictor"].selected_engine == "additive",
          res["predictor"].selected_engine)
    check("split_is_chronological", res["split"].ordering_assert_passed,
          "max train ATB < min test ATB")
    check("no_leakage", res["leakage_audit"].get("passed", False),
          "BANNED_FIELDS disjoint from FEATURE_COLUMNS")

    with tempfile.TemporaryDirectory() as tmp:
        pkl, card = save_artifact(res, tmp, tag="selftest")
        check("artifact_written", os.path.exists(pkl) and os.path.exists(card),
              os.path.basename(pkl))

        loaded = load_artifact(pkl)
        check("artifact_loads", loaded["engine"] == "additive", loaded["engine"])
        check("model_card_attached", bool(loaded["model_card"].get("artifact_sha256")),
              "sha256 present in the card")

        # Same input must give the same answer before and after the round trip.
        feats = res["test_calls"][0].features
        before = res["predictor"].predict(feats)
        after = loaded["predictor"].predict(feats)
        check("round_trip_is_identical",
              abs(before.p50_hours - after.p50_hours) < 1e-9
              and abs(before.p10_hours - after.p10_hours) < 1e-9
              and abs(before.p90_hours - after.p90_hours) < 1e-9,
              f"p50 {before.p50_hours:.4f} h before, {after.p50_hours:.4f} h after")

        # Corrupt the .pkl and confirm the digest check fires.
        with open(pkl, "ab") as fh:
            fh.write(b"\x00tamper")
        try:
            load_artifact(pkl)
            check("digest_mismatch_refused", False, "corrupted artefact was accepted")
        except ValueError as exc:
            check("digest_mismatch_refused", "digest mismatch" in str(exc),
                  "a modified .pkl is refused")
        except Exception as exc:
            # A pickle that no longer parses is also a refusal, just a blunter one.
            check("digest_mismatch_refused", True, f"refused: {type(exc).__name__}")

        try:
            load_artifact(os.path.join(tmp, "does_not_exist.pkl"))
            check("missing_artifact_message", False, "no exception")
        except FileNotFoundError as exc:
            check("missing_artifact_message", "run.py train" in str(exc),
                  "error tells you how to train one")

    check("quality_gates_evaluated",
          isinstance(evaluate_gates(res["metrics"])["passed"], bool),
          f"MAE {res['metrics'].mae_hours:.2f} h on a 45-day toy run")
    return checks


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: Optional[Sequence[str]] = None) -> int:
    p = argparse.ArgumentParser(
        description="Train the UC1-M3 TAT predictor and write a versioned artefact.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  python run.py train                          # 365 d, best engine\n"
            "  python run.py train --days 540 --engine lightgbm\n"
            "  python run.py train --engine additive --tag portable\n"
            "  python run.py train --out models/my_model.pkl\n"
            "  python run.py train --compare-engines\n"
        ),
    )
    p.add_argument("--days", type=int, default=DEFAULT_DAYS,
                   help=f"days of history to train on (default {DEFAULT_DAYS}; "
                        f"shorter windows under-cover -- see the module docstring)")
    p.add_argument("--seed", type=int, default=DEFAULT_SEED, help="RNG seed")
    p.add_argument("--engine", default="auto",
                   choices=("auto",) + tuple(m3.ENGINE_PRIORITY),
                   help="engine to use; 'auto' walks the fallback chain")
    p.add_argument("--test-fraction", type=float, default=DEFAULT_TEST_FRACTION)
    p.add_argument("--embargo-hours", type=float, default=DEFAULT_EMBARGO_HOURS,
                   help="purge window at the split boundary (default 24)")
    p.add_argument("--no-conformal", action="store_true",
                   help="disable conformal band calibration (not recommended)")
    p.add_argument("--out", default=DEFAULT_MODEL_DIR,
                   help="output directory or explicit .pkl path")
    p.add_argument("--tag", default="", help="suffix for the artefact filename")
    p.add_argument("--compare-engines", action="store_true",
                   help="train every engine and print a comparison table, writing nothing")
    p.add_argument("--json", action="store_true", help="print the model card as JSON")
    p.add_argument("--force", action="store_true",
                   help="write the artefact even if a quality gate fails")
    p.add_argument("--selftest", action="store_true", help="run the built-in checks")
    args = p.parse_args(argv)

    if args.selftest:
        checks = _self_test()
        passed = sum(1 for _, ok, _ in checks if ok)
        print("=" * 78)
        print(f"  train_tat_model.py self-test  |  {MODULE_VERSION}")
        print("=" * 78)
        for name, ok, detail in checks:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name:<28} {detail}")
        print("-" * 78)
        print(f"  {passed}/{len(checks)} checks passed")
        return 0 if passed == len(checks) else 1

    if args.compare_engines:
        rows = compare_engines(args.days, args.seed)
        print("=" * 78)
        print(f"  ENGINE COMPARISON  |  {args.days} days, seed {args.seed}")
        print("=" * 78)
        print(f"  {'engine':<16} {'MAE h':>8} {'acc %':>8} {'cov %':>8} {'band h':>8}")
        print("  " + "-" * 52)
        for r in rows:
            if r["ok"]:
                print(f"  {r['engine']:<16} {r['mae_hours']:>8.2f} {r['accuracy_pct']:>8.2f} "
                      f"{r['coverage_80_pct']:>8.1f} {r['band_width_h']:>8.2f}")
            else:
                print(f"  {r['engine']:<16} {'unavailable':>34}  {r['error'][:24]}")
        print("\n  Note: on synthetic data the additive model generated the labels, so it")
        print("  is the oracle and no learned engine can beat it. That is a property of")
        print("  the data, not evidence the GBM is better or worse. On real labelled")
        print("  history the ordering is expected to reverse.")
        return 0

    try:
        result = train(
            days=args.days, seed=args.seed, engine=args.engine,
            test_fraction=args.test_fraction, embargo_hours=args.embargo_hours,
            conformal=not args.no_conformal,
        )
    except Exception as exc:
        print(f"ERROR: training failed: {exc}", file=sys.stderr)
        return 1

    gates = evaluate_gates(result["metrics"])
    if not gates["passed"] and not args.force:
        print("=" * 78)
        print("  QUALITY GATE FAILED -- artefact NOT written")
        print("=" * 78)
        for c in gates["checks"]:
            print(f"  [{'PASS' if c['passed'] else 'FAIL'}] {c['name']:<24} {c['detail']}")
        print("\n  Fix the data or the configuration, or re-run with --force to write anyway.")
        return 1

    pkl_path, json_path = save_artifact(result, args.out, args.tag)

    if args.json:
        with open(json_path, "r", encoding="utf-8") as fh:
            print(fh.read())
    else:
        _print_report(result, pkl_path, json_path)
    return 0 if gates["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
