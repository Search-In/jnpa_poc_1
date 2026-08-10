"""
api — JNPA UC-I Unified FastAPI Application
===========================================

Jawaharlal Nehru Port Authority (JNPA) — Workstream 2, UC-I Vessel Traffic
Management & Optimization. Tender ref GeM/2026/B/7297343.

Mounts all eight UC-I models behind one HTTP surface so a React / Next.js / Vue
frontend can consume every model as JSON.

    /uc1/m1   DUKC / RTUKC engine
    /uc1/m2   Tidal window computation & extension
    /uc1/m3   Vessel TAT prediction (dual engine)
    /uc1/m4   ETA uncertainty & berth utilisation
    /uc1/m5   Dynamic berth plan optimisation
    /uc1/m6   JIT arrival / RTA advisory
    /uc1/m7   Port-craft assignment & conflict detection
    /uc1/m8   Reactive confidence chain (causal DAG)

Every module also exposes ``/constants`` (the versioned coefficients — literally
the tender's "Link to Model Weights" column served over HTTP), ``/demo`` and
``/health``.

THE FINGERPRINT GATE
--------------------
M1, M2, M6 and M8 each carry a byte-identical copy of the DUKC core, because the
flat-file architecture is a deliberate requirement: every module must run in
isolation. The cost of that choice is the risk of the copies drifting apart, and
a silent drift in a safety-of-navigation calculation is the worst failure this
system could have.

So it is not left to discipline. ``verify_dukc_core_consistency()`` compares the
four fingerprints AND re-runs each module's golden-value self-test at import
time. If they disagree, the app REFUSES TO START rather than serving two
different definitions of "safe". ``GET /health`` re-exposes the fingerprint so
the same drift is visible in production, not merely at boot.

RUN
---
    pip install -r requirements.txt
    uvicorn api:app --reload

    http://127.0.0.1:8000/docs          interactive OpenAPI
    http://127.0.0.1:8000/health        all 8 modules + fingerprint
    http://127.0.0.1:8000/uc1/manifest  route and version discovery
"""

from __future__ import annotations

import importlib
import os
import sys
import traceback
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# src/service/api.py -> src/service -> src -> src/pipeline holds jnpa_paths,
# which in turn puts the model + pipeline folders on sys.path. Doing it here
# means `uvicorn api:app` works without the caller setting PYTHONPATH.
sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pipeline")
)

import jnpa_paths  # noqa: E402

jnpa_paths.ensure_on_syspath()

# --------------------------------------------------------------------------
# Hard dependencies. Unlike the model modules — which must import on a bare
# Python install — the API layer legitimately requires FastAPI.
# --------------------------------------------------------------------------
try:
    from fastapi import FastAPI, HTTPException
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import JSONResponse
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "FastAPI is required to run the API layer.\n"
        "Install with:  pip install -r requirements.txt\n"
        f"Import error: {exc!r}\n\n"
        "Note the eight model modules themselves run with no third-party "
        "packages at all — try:  python uc1_m1_dukc.py"
    ) from exc

APP_NAME = "JNPA UC-I Vessel Traffic Management & Optimization"
APP_VERSION = "uc1-api-v1.0.0"
TENDER_REF = "GeM/2026/B/7297343"

# (import name, short label, carries the duplicated DUKC core)
MODULE_SPECS: Tuple[Tuple[str, str, bool], ...] = (
    ("uc1_m1_dukc", "M1 DUKC / RTUKC", True),
    ("uc1_m2_tidal_window", "M2 Tidal Windows", True),
    ("uc1_m3_tat_predict", "M3 TAT Prediction", False),
    ("uc1_m4_berth_utilisation", "M4 ETA & Berth Utilisation", False),
    ("uc1_m5_berth_optimiser", "M5 Berth Optimiser", False),
    ("uc1_m6_jit_rta", "M6 JIT Arrival / RTA", True),
    ("uc1_m7_port_craft", "M7 Port Craft", False),
    ("uc1_m8_causal_chain", "M8 Reactive Confidence Chain", True),
)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def json_safe(obj: Any) -> Any:
    """
    Recursively replace non-finite floats with ``None``.

    ``json.dumps`` emits bare ``Infinity`` / ``NaN`` for these, which is invalid
    JSON: Starlette's encoder rejects it and the whole response 500s. Legitimate
    non-finite values do occur here — M4 uses ``+inf`` as an open-ended
    confidence-band edge, and a percentile over an empty sample is ``NaN`` — so
    the fix is to sanitise at the boundary rather than to forbid them upstream.
    """
    import math as _math

    if isinstance(obj, float):
        return None if (_math.isinf(obj) or _math.isnan(obj)) else obj
    if isinstance(obj, dict):
        return {k: json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [json_safe(v) for v in obj]
    return obj


def load_modules() -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    """
    Import the eight model modules.

    A module that fails to import is recorded rather than crashing the app, so
    seven working models still serve while the eighth is diagnosed. The failure
    is surfaced loudly in ``/health``.
    """
    loaded: Dict[str, Any] = {}
    failures: List[Dict[str, str]] = []
    for name, label, _ in MODULE_SPECS:
        try:
            loaded[name] = importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001 — report, do not abort
            failures.append({
                "module": name,
                "label": label,
                "error": repr(exc)[:300],
                "traceback": traceback.format_exc(limit=3)[-600:],
            })
    return loaded, failures


def verify_dukc_core_consistency(modules: Dict[str, Any]) -> Dict[str, Any]:
    """
    The mount-time gate on the duplicated DUKC core.

    Two independent checks, because a matching fingerprint alone would not catch
    someone editing a formula without touching the constant:

      1. All four modules report the SAME ``DUKC_CORE_FINGERPRINT``.
      2. Each module's ``_dukc_core_selftest()`` passes its golden values.

    Returns a report. ``consistent`` False means the app must not start.
    """
    carriers = [name for name, _, has_core in MODULE_SPECS if has_core]
    fingerprints: Dict[str, str] = {}
    selftests: Dict[str, str] = {}

    for name in carriers:
        mod = modules.get(name)
        if mod is None:
            fingerprints[name] = "MODULE_NOT_LOADED"
            selftests[name] = "MODULE_NOT_LOADED"
            continue
        fingerprints[name] = getattr(mod, "DUKC_CORE_FINGERPRINT", "MISSING")
        try:
            mod._dukc_core_selftest()
            selftests[name] = "PASS"
        except AssertionError as exc:
            selftests[name] = f"FAIL: {exc}"
        except Exception as exc:  # noqa: BLE001
            selftests[name] = f"ERROR: {exc!r}"

    distinct = sorted(set(fingerprints.values()))
    all_pass = all(v == "PASS" for v in selftests.values())
    consistent = len(distinct) == 1 and "MISSING" not in distinct and all_pass

    return {
        "consistent": consistent,
        "carrier_modules": carriers,
        "fingerprints": fingerprints,
        "distinct_fingerprints": distinct,
        "golden_value_selftests": selftests,
        "explanation": (
            "M1/M2/M6/M8 carry a byte-identical copy of the DUKC core so each can run "
            "in isolation. Drift between the copies would mean two different "
            "definitions of 'safe under-keel clearance', so the app refuses to start "
            "unless all four agree and all four pass their golden-value self-tests."
        ),
    }


MODULES, IMPORT_FAILURES = load_modules()
CORE_CHECK = verify_dukc_core_consistency(MODULES)

if not CORE_CHECK["consistent"]:
    lines = [
        "",
        "=" * 78,
        "FATAL: DUKC core consistency check FAILED — refusing to start.",
        "=" * 78,
        "",
        "The duplicated DUKC core has drifted between modules, or a golden-value",
        "self-test failed. Serving under-keel clearance from inconsistent physics",
        "is not acceptable, so the application will not start.",
        "",
        "Fingerprints:",
    ]
    for name, fp in CORE_CHECK["fingerprints"].items():
        lines.append(f"  {name:<28} {fp}")
    lines.append("")
    lines.append("Golden-value self-tests:")
    for name, res in CORE_CHECK["golden_value_selftests"].items():
        lines.append(f"  {name:<28} {res}")
    lines += [
        "",
        "Fix: make SECTION 2 byte-identical across uc1_m1_dukc.py,",
        "uc1_m2_tidal_window.py, uc1_m6_jit_rta.py and uc1_m8_causal_chain.py,",
        "then re-run:  python uc1_m1_dukc.py",
        "=" * 78,
        "",
    ]
    raise SystemExit("\n".join(lines))


app = FastAPI(
    title=APP_NAME,
    version=APP_VERSION,
    description=(
        f"All eight UC-I models behind one HTTP surface. Tender ref {TENDER_REF}.\n\n"
        "Every model exposes `/constants` (versioned coefficients — the tender's "
        "'Link to Model Weights' column), `/demo` and `/health`. Deterministic "
        "models return a step-by-step `breakdown` dict showing each formula with "
        "its real numbers substituted in.\n\n"
        "**Commercial figures in M6 are labelled SIMULATED** and rest on named "
        "assumptions. **M3's per-factor attribution explains the additive surrogate**, "
        "not the gradient-boosted model, whenever a learned engine supplies P50."
    ),
)

# Permissive CORS: this is a PoC serving a separate frontend dev server.
# Tighten allow_origins to the deployed frontend before any public exposure.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

MOUNTED: List[Dict[str, Any]] = []
MOUNT_FAILURES: List[Dict[str, str]] = []

for _name, _label, _has_core in MODULE_SPECS:
    _mod = MODULES.get(_name)
    if _mod is None:
        continue
    try:
        app.include_router(_mod.build_router())
        MOUNTED.append({
            "module": _name,
            "label": _label,
            "module_id": getattr(_mod, "MODULE_ID", "?"),
            "module_version": getattr(_mod, "MODULE_VERSION", "?"),
            "prefix": getattr(_mod, "ROUTER_PREFIX", "?"),
            "carries_dukc_core": _has_core,
        })
    except Exception as exc:  # noqa: BLE001
        MOUNT_FAILURES.append({"module": _name, "error": repr(exc)[:300]})

# The live-AIS ingest adapter. It is NOT a ninth model: it translates an AIS
# position report into the vessel call the eight models take, then runs them
# through the same runner and the same dashboard builder the spreadsheet path
# uses. Mounted separately because it lives in src/pipeline (it depends on the
# loader and the runner), and because a failure here must not be reported as a
# model outage — seven models plus a broken translator is a different fault
# from a broken model.
ADAPTER: Dict[str, Any] = {"mounted": False, "error": ""}
try:
    import uc1_webapp_adapter as _adapter  # noqa: E402

    app.include_router(_adapter.build_router())
    ADAPTER = {
        "mounted": True,
        "error": "",
        "module": "uc1_webapp_adapter",
        "module_id": _adapter.MODULE_ID,
        "module_version": _adapter.MODULE_VERSION,
        "prefix": _adapter.ROUTER_PREFIX,
        "max_fleet": _adapter.MAX_FLEET,
    }
except Exception as exc:  # noqa: BLE001 — report, do not abort
    ADAPTER = {"mounted": False, "error": repr(exc)[:300],
               "traceback": traceback.format_exc(limit=3)[-600:]}


@app.get("/", tags=["meta"], summary="Service banner")
def root() -> Dict[str, Any]:
    return {
        "service": APP_NAME,
        "version": APP_VERSION,
        "tender_ref": TENDER_REF,
        "modules_mounted": len(MOUNTED),
        "live_ais_adapter": ADAPTER.get("prefix") if ADAPTER["mounted"] else None,
        "docs": "/docs",
        "manifest": "/uc1/manifest",
        "health": "/health",
    }


@app.get("/health", tags=["meta"], summary="All modules, self-tests and the DUKC fingerprint")
def health(deep: bool = False) -> JSONResponse:
    """
    Service health.

    ``deep=true`` runs every module's full ``_self_test()``. That is slower —
    M3 trains a model — so it is off by default and intended for a smoke test
    after deployment rather than a liveness probe.
    """
    modules: List[Dict[str, Any]] = []
    degraded = False

    for entry in MOUNTED:
        mod = MODULES[entry["module"]]
        info: Dict[str, Any] = {
            **entry,
            "info": getattr(mod, "MODULE_INFO", {}),
        }
        if deep:
            try:
                checks = mod._self_test()
                passed = sum(1 for _, ok, _ in checks if ok)
                info["self_test"] = {
                    "passed": passed,
                    "total": len(checks),
                    "ok": passed == len(checks),
                    "failures": [
                        {"name": n, "detail": d} for n, ok, d in checks if not ok
                    ],
                }
                if passed != len(checks):
                    degraded = True
            except Exception as exc:  # noqa: BLE001
                info["self_test"] = {"error": repr(exc)[:300]}
                degraded = True
        modules.append(info)

    if IMPORT_FAILURES or MOUNT_FAILURES or len(MOUNTED) != len(MODULE_SPECS):
        degraded = True

    # A dead adapter means the web app's Predictions surface is dead, even
    # though all eight models are fine. Report it as degraded rather than
    # letting a green /health hide a broken frontend feature.
    adapter = dict(ADAPTER)
    if not adapter["mounted"]:
        degraded = True
    elif deep:
        try:
            checks = _adapter.selftest()
            adapter["self_test"] = {
                "passed": sum(1 for c in checks if c["passed"]),
                "total": len(checks),
                "failures": [c for c in checks if not c["passed"]],
            }
            if adapter["self_test"]["failures"]:
                degraded = True
        except Exception as exc:  # noqa: BLE001
            adapter["self_test"] = {"error": repr(exc)[:300]}
            degraded = True

    payload = {
        "status": "degraded" if degraded else "ok",
        "service": APP_NAME,
        "version": APP_VERSION,
        "generated_at_utc": _utc_now_iso(),
        "modules_expected": len(MODULE_SPECS),
        "modules_mounted": len(MOUNTED),
        "dukc_core": CORE_CHECK,
        "live_ais_adapter": adapter,
        "modules": modules,
        "import_failures": IMPORT_FAILURES,
        "mount_failures": MOUNT_FAILURES,
        "deep": deep,
    }
    return JSONResponse(json_safe(payload), status_code=200 if not degraded else 503)


@app.get("/uc1/manifest", tags=["meta"], summary="Route and version discovery for the frontend")
def manifest() -> Dict[str, Any]:
    """
    Everything a frontend needs to discover the surface without hard-coding it.

    Lists every mounted route with its method, the module that owns it, and that
    module's version — so a UI can render the model catalogue, and a smoke test
    can walk every GET endpoint.
    """
    # Enumerate via the OpenAPI schema, NOT app.routes. FastAPI 0.115+ wraps
    # included routers in a lazy `_IncludedRouter` object that carries no
    # `.path`, so walking app.routes silently returns only the app-level routes
    # and reports every module as having zero endpoints. The generated schema is
    # the version-stable source of truth.
    by_prefix: Dict[str, List[Dict[str, Any]]] = {}
    try:
        paths = app.openapi().get("paths", {})
    except Exception:  # pragma: no cover - schema generation should not 500 this
        paths = {}

    for path, operations in paths.items():
        if not path.startswith("/uc1/"):
            continue
        methods = sorted(
            m.upper() for m in operations
            if m.lower() in ("get", "post", "put", "patch", "delete")
        )
        if not methods:
            continue
        prefix = "/".join(path.split("/")[:3])
        summary = ""
        for m in operations.values():
            if isinstance(m, dict) and m.get("summary"):
                summary = m["summary"]
                break
        by_prefix.setdefault(prefix, []).append({
            "path": path,
            "methods": methods,
            "summary": summary,
        })

    modules = []
    for entry in MOUNTED:
        mod = MODULES[entry["module"]]
        info = getattr(mod, "MODULE_INFO", {})
        modules.append({
            **entry,
            "spec_row": info.get("spec_row", ""),
            "model_type": info.get("model_type", ""),
            "routes": sorted(
                by_prefix.get(entry["prefix"], []), key=lambda r: r["path"]
            ),
        })

    adapter_manifest = dict(ADAPTER)
    if ADAPTER["mounted"]:
        adapter_manifest["routes"] = sorted(
            by_prefix.get(ADAPTER["prefix"], []), key=lambda r: r["path"]
        )
        adapter_manifest["note"] = (
            "Send the AIS feed to POST {p}/predictions and render the returned "
            "uc1-dashboard document. Each vessel carries a `mapping` ledger naming "
            "every input the adapter had to assume — show it: AIS position reports "
            "carry no draught, no cargo and no ATA."
        ).format(p=ADAPTER["prefix"])

    return {
        "service": APP_NAME,
        "version": APP_VERSION,
        "tender_ref": TENDER_REF,
        "generated_at_utc": _utc_now_iso(),
        "dukc_core_fingerprint": CORE_CHECK["distinct_fingerprints"][0],
        "live_ais_adapter": adapter_manifest,
        "conventions": {
            "breakdown": (
                "Deterministic models return a `breakdown` dict whose `steps` each carry "
                "`formula`, `substitution` (the formula with real numbers AND the result) "
                "and `terms`. Render `substitution` for an auditable trail."
            ),
            "constants": (
                "GET <prefix>/constants returns the versioned coefficient block — the "
                "tender's 'Link to Model Weights' column, served over HTTP."
            ),
            "simulated": (
                "M6 commercial figures carry `savings_label: SIMULATED` and name the "
                "assumption each rests on. M7 quotes gap-closed minutes on the same basis."
            ),
            "attribution": (
                "M3 returns `attribution_source`. When it is `additive_surrogate` the "
                "contribution chart explains the transparent model, NOT the gradient-"
                "boosted engine that produced P50 — render that caveat."
            ),
        },
        "modules": modules,
    }


@app.get("/uc1/constants", tags=["meta"], summary="Every module's versioned constants")
def all_constants() -> Dict[str, Any]:
    """One call returning the complete 'model weights' picture for the tender pack."""
    out: Dict[str, Any] = {
        "generated_at_utc": _utc_now_iso(),
        "dukc_core_fingerprint": CORE_CHECK["distinct_fingerprints"][0],
        "modules": {},
    }
    for entry in MOUNTED:
        mod = MODULES[entry["module"]]
        info = getattr(mod, "MODULE_INFO", {})
        out["modules"][entry["module_id"]] = {
            "module_version": entry["module_version"],
            "spec_row": info.get("spec_row", ""),
            "constants": info.get("constants", {}),
        }
    return out


@app.get("/uc1/demo-all", tags=["meta"], summary="Run every module's demo in one call")
def demo_all() -> Dict[str, Any]:
    """
    Smoke-test surface: runs each module's canonical demo and returns the
    headline result. Handy for a dashboard's first paint, and for proving the
    whole stack works after a deploy.
    """
    results: Dict[str, Any] = {}
    for entry in MOUNTED:
        mod = MODULES[entry["module"]]
        mid = entry["module_id"]
        try:
            if mid == "UC1-M1":
                v = mod.VesselState("V-1001", "MSC VALERIA", "CONTAINER", 15.0, 10.0)
                c = mod.ChannelState(mod.DEFAULT_REACHES["CH-INNER"], 2.6)
                r = mod.evaluate_dukc(v, c)
                results[mid] = {
                    "status": r.status, "net_ukc_m": round(r.net_ukc_m, 3),
                    "recommendation": r.recommendation,
                }
            elif mid == "UC1-M2":
                v = mod.VesselState("V-1002", "MAERSK", "CONTAINER", 15.5, 10.0)
                r = mod.evaluate_tidal_windows(v)
                results[mid] = {
                    "windows": r.baseline.window_count,
                    "usable_hours": round(r.baseline.total_usable_hours, 2),
                    "extension": [c.as_dict() for c in r.comparisons],
                }
            elif mid == "UC1-M3":
                calls = mod.generate_synthetic_calls(90, mod.DEFAULT_SEED)
                train, _, _ = mod.chronological_split(calls)
                p = mod.TATPredictor(engine="additive").fit(train)
                pred = p.predict(mod._demo_features())
                results[mid] = {
                    "engine": pred.engine,
                    "p10_p50_p90": [round(pred.p10_hours, 2), round(pred.p50_hours, 2),
                                    round(pred.p90_hours, 2)],
                    "stressors": list(pred.stressors_active),
                }
            elif mid == "UC1-M4":
                grid = []
                for h in (2.0, 24.0):
                    for s in (0.0, 180.0):
                        sg = mod.eta_sigma_hours(h, s)
                        grid.append({"horizon_h": h, "staleness_min": s,
                                     "sigma_h": round(sg, 3),
                                     "confidence": mod.confidence_label(sg)})
                results[mid] = {"eta_sigma_grid": grid}
            elif mid == "UC1-M5":
                plan = mod.optimise(*mod.scenario_baseline(), mod.DEFAULT_WEIGHTS, "greedy")
                results[mid] = {
                    "assignments": len(plan.assignments),
                    "total_cost": round(plan.cost.total_cost, 3),
                    "cost": plan.cost.as_dict()["per_request"][:1],
                }
            elif mid == "UC1-M6":
                v, rd = mod._canonical_case()
                r = mod.evaluate_jit(v, rd)
                results[mid] = {
                    "rta": mod._iso(r.rta), "driver": r.rta_driver,
                    "recommended_speed_kn": round(r.recommended_speed_kn, 2),
                    "headline_saving": r.headline.as_dict(),
                }
            elif mid == "UC1-M7":
                r = mod.scenario_two_pilots_down(roster_preset="poc")
                results[mid] = {
                    "status": r.status, "conflicts": len(r.conflicts),
                    "top_proposal": r.proposals[0].as_dict() if r.proposals else None,
                }
            elif mid == "UC1-M8":
                r = mod.run_scenario("S5")
                results[mid] = {
                    "confidence": [round(r.confidence_before, 3), round(r.confidence_after, 3)],
                    "alert": r.alert_level,
                    "dukc": [r.dukc_status_before, r.dukc_status_after],
                    "root_causes": [[n, round(v, 1)] for n, v in r.top_root_causes],
                }
        except Exception as exc:  # noqa: BLE001
            results[mid] = {"error": repr(exc)[:300]}
    return {"generated_at_utc": _utc_now_iso(), "results": results}


def _print_banner() -> None:
    print("=" * 78)
    print(f"{APP_NAME}")
    print(f"{APP_VERSION}   ·   tender {TENDER_REF}")
    print("=" * 78)
    print(f"\nDUKC core fingerprint: {CORE_CHECK['distinct_fingerprints'][0]}")
    print(
        f"  consistency gate: PASS across "
        f"{', '.join(CORE_CHECK['carrier_modules'])}"
    )
    print(f"\nMounted {len(MOUNTED)}/{len(MODULE_SPECS)} modules:")
    for e in MOUNTED:
        core = " [DUKC core]" if e["carries_dukc_core"] else ""
        print(f"  {e['prefix']:<10} {e['module_id']:<8} {e['label']:<32} "
              f"{e['module_version']}{core}")
    if IMPORT_FAILURES:
        print("\nIMPORT FAILURES:")
        for f in IMPORT_FAILURES:
            print(f"  {f['module']}: {f['error']}")
    if MOUNT_FAILURES:
        print("\nMOUNT FAILURES:")
        for f in MOUNT_FAILURES:
            print(f"  {f['module']}: {f['error']}")
    print("\nStart with:  uvicorn api:app --reload")
    print("  docs      http://127.0.0.1:8000/docs")
    print("  health    http://127.0.0.1:8000/health?deep=true")
    print("  manifest  http://127.0.0.1:8000/uc1/manifest")
    print("  demo all  http://127.0.0.1:8000/uc1/demo-all")
    print("=" * 78)


if __name__ == "__main__":
    _print_banner()
    ok = (
        len(MOUNTED) == len(MODULE_SPECS)
        and not IMPORT_FAILURES
        and not MOUNT_FAILURES
        and CORE_CHECK["consistent"]
    )
    sys.exit(0 if ok else 1)
