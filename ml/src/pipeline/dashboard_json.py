"""
dashboard_json.py -- the small, readable prediction file the dashboard consumes.

WHY THIS FILE EXISTS
--------------------
``out/uc1_all_models.json`` is the audit artefact. It carries every formula,
every substitution, every intermediate node of the causal graph and the full
constant block of each model -- roughly 780 KB for three vessels. That detail is
required: JNPA's acceptance criteria ask us to show how each number was reached,
and a reviewer must be able to reconstruct any figure by hand.

It is the wrong file to put behind a dashboard. A UI needs one object per
vessel, the handful of numbers it will actually draw, and nothing else.

This module produces that second file. Same run, same numbers -- it selects,
it never recomputes. Every field it emits exists verbatim in the full JSON.

SHAPE
-----
    {
      "run":       what produced this, from what input, when
      "glossary":  every non-obvious key explained in one line
      "vessels": [
        {
          "vessel":   name / IMO / voyage / terminal / call_id
          "input":    what the sheet said about this call
          "models": {
            "m1_under_keel_clearance": {...}
            ... one block per model, 5-9 keys each
          }
        }
      ],
      "port_summary": the batch-level numbers (fleet totals, berth occupancy,
                      craft roster) that belong to no single vessel
    }

THE RULE FOR ADDING A KEY
-------------------------
A key belongs here only if a dashboard would render it -- as a number, a status
chip, a time, or a one-line explanation under one of those. If it exists to
prove *how* a number was derived, it stays in the full JSON. Every key that
survives that test is listed in ``GLOSSARY`` below, which is emitted with the
data so the file explains itself without a side document.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Sequence

SCHEMA_VERSION: str = "uc1-dashboard/1.0.0"

# Keys whose meaning IS their name, and which therefore need no glossary line.
# Hoisted to module scope (it used to be a local inside ``_self_test``) so the
# web app's own contract test can assert the SAME exemption list rather than
# restating it -- two copies of this set would drift, and the second copy would
# then either fail spuriously or hide a genuinely undefined key.
SELF_EVIDENT_KEYS: frozenset = frozenset({
    "status", "recommendation", "windows", "terminal", "requested_berth",
    "vessel_class", "teu_import", "teu_export", "cranes_available", "weather",
    "wind_kn", "eta_ist", "start_ist",
})


# ---------------------------------------------------------------------------
# glossary -- shipped inside the output so the file is self-describing
# ---------------------------------------------------------------------------

GLOSSARY: Dict[str, str] = {
    # --- identifiers -------------------------------------------------------
    "call_id": "Our id for this vessel call (one row of the input sheet). Not a port system id.",
    "imo": "IMO number: the vessel's permanent hull id, unchanged across renames and reflagging.",
    "voyage": "The carrier's voyage number for this specific trip.",

    # --- input -------------------------------------------------------------
    "ata_ist": "Actual Time of Arrival at the anchorage/pilot station, Indian Standard Time.",
    "draft_m": "How deep the loaded hull sits below the waterline, in metres. Drives every depth check.",
    "loa_m": "Length Overall. A berth shorter than this cannot take the vessel.",
    "teu_total": "Containers to move this call, in twenty-foot equivalent units. The main driver of TAT.",
    "tide_m": "Height of tide above chart datum at arrival. Adds directly to available water depth.",
    "channel_depth_m": "Charted depth of the approach channel before tide, siltation and dredging.",
    "anchorage_queue": "Vessels already waiting at anchorage when this one arrived.",
    "berth_occupancy_pct": "How full the terminal's berths were at arrival, percent.",

    # --- M1 ----------------------------------------------------------------
    "net_ukc_m": "Under-keel clearance after squat and the 1.0 m safety margin. This is the go/no-go number.",
    "squat_m": "Extra draft a moving hull gains from its own bow wave. Grows with the square of speed.",
    "binding_reach": "The channel section with the least clearance. It, not the shallowest section, sets the verdict.",
    "min_tide_for_safe_m": "Tide height at which this transit would become SAFE. Below it, wait for water.",
    "max_safe_speed_kn": "Fastest speed that still leaves a safe clearance, because slowing down cuts squat.",
    "matches_sheet": "Whether our verdict agrees with the DUKC_Status the sheet already recorded. A scoring check, never an input.",

    # --- M2 ----------------------------------------------------------------
    "required_tide_m": "Tide this vessel needs before the binding reach is passable.",
    "usable_hours": "Hours in the next 120 h during which the vessel could transit.",
    "availability_pct": "usable_hours as a share of the scan horizon.",
    "longest_window_h": "The single longest uninterrupted transit opportunity.",
    "max_wait_h": "Worst gap between windows -- the longest the vessel could be held waiting for tide.",
    "next_window_start_ist": "Start of the next usable window.",
    "dredging_gain_h": "Extra usable hours a +0.5 m dredge would buy. The investment case, in hours.",

    # --- M3 ----------------------------------------------------------------
    "tat_hours": "Turnaround time: arrival to departure, in hours. The headline prediction (p50).",
    "tat_p10_hours": "Optimistic end of the 80% band -- 10% of calls finish faster than this.",
    "tat_p90_hours": "Pessimistic end of the 80% band -- 90% of calls finish within it. Plan against this one.",
    "etb_ist": "Estimated Time of Berthing = arrival + waiting time.",
    "etd_ist": "Estimated Time of Departure = arrival + tat_hours.",
    "wait_hours": "Predicted wait between arrival and getting alongside.",
    "berth_stay_hours": "Time actually alongside working cargo = tat_hours - wait_hours.",
    "confidence": "HIGH/MEDIUM/LOW, from how wide the p10-p90 band came out.",
    "engine": "Which predictor produced the number: lightgbm, sklearn or the additive fallback.",
    "top_drivers": "The three input factors contributing most to this TAT, with their hours and share.",

    # --- M4 ----------------------------------------------------------------
    "eta_p50_ist": "Most likely arrival time from the current AIS fix.",
    "eta_p10_ist": "Earliest plausible arrival (10th percentile).",
    "eta_p90_ist": "Latest plausible arrival (90th percentile).",
    "eta_band_hours": "Width of the p10-p90 arrival window. Wider means less certain.",
    "sigma_hours": "Standard deviation of the arrival estimate. Grows with forecast horizon and stale AIS.",

    # --- M5 ----------------------------------------------------------------
    "assigned_berth": "Berth the optimiser allocated, which may differ from the one requested.",
    "berth_changed": "True when the optimiser moved the vessel off its requested berth.",
    "misses_tidal_window": "True when the assigned start falls outside every usable tidal window.",
    "algorithm": "Solver that produced this assignment: cpsat (exact) or greedy (fallback).",
    "reason": "One sentence on why the optimiser chose this berth and start time.",

    # --- M6 ----------------------------------------------------------------
    "recommended_speed_kn": "Speed to arrive just in time instead of early. Lower speed, less fuel.",
    "required_speed_kn": "Speed needed to hit the target arrival exactly. Above the vessel's cap it is not achievable.",
    "rta_ist": "Requested Time of Arrival -- when the port actually wants the vessel, not when she can get there.",
    "fuel_saved_t": "Tonnes of bunker fuel saved by slow-steaming to the RTA instead of arriving early and waiting.",
    "co2_saved_t": "Tonnes of CO2 avoided, at 3.114 t CO2 per tonne of fuel.",
    "anchorage_hours_saved": "Hours of anchorage waiting removed by arriving just in time.",
    "achievable": "False when the vessel cannot reach the RTA even at full speed -- there is no saving to take.",

    # --- M7 ----------------------------------------------------------------
    "movement": "The berthing or unberthing manoeuvre this craft assignment serves.",
    "pilots_tugs_mooring": "Craft assigned to the movement: pilot / tug / mooring-gang ids.",
    "shortfall": "Craft the movement needed but could not be given. Empty means fully resourced.",
    "response_gap_min": "Minutes by which the nearest craft is late for the movement start.",
    "resourced": "True when every required craft was assigned on time.",

    # --- M8 ----------------------------------------------------------------
    "system_confidence": "0-1 score for how much of the plan survives today's disruptions. 1.0 is undisturbed.",
    "alert_level": "NORMAL / WARNING / CRITICAL, from system_confidence and which rules fired.",
    "tat_delay_h": "Extra turnaround hours the causal chain attributes to the current disruptions.",
    "root_causes": "The exogenous conditions contributing most to the confidence drop, with their share.",
    "disruptions": "The conditions fed into the chain for this vessel, in plain words.",

    # --- provenance --------------------------------------------------------
    "flags": "Caveats attached to the row. TIDE_SYNTHETIC = tide was modelled, not measured. "
             "WAIT_IS_LOWER_BOUND = the wait was computed against this file only, so it under-states a real queue. "
             "QUEUE_DERIVED = anchorage queue was inferred from occupancy, not observed.",
    "data_quality": "Where each estimated input came from. MEASURED beats DERIVED beats SYNTHETIC.",
}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _num(value: Any, digits: int = 2) -> Optional[float]:
    """Round for display; leave non-numerics (and None) alone."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        try:
            return round(float(value), digits)
        except (ValueError, OverflowError):
            return None
    return None


def _blank_to_none(value: Any) -> Any:
    """Empty strings read as noise in a JSON viewer; None reads as 'nothing here'."""
    return None if value == "" else value


def _rows_by_vessel_row(result: Optional[Dict[str, Any]]) -> Dict[int, Dict[str, Any]]:
    """Index one model's flat rows by input-sheet row number."""
    if not result or not result.get("ok"):
        return {}
    return {r["Row"]: r for r in result.get("rows", []) if "Row" in r}


def _parse_driver(text: str) -> Optional[Dict[str, Any]]:
    """
    "parcel_teu +14.40 h (90.57%)" -> {"factor", "hours", "share_pct"}.

    The runner already formats drivers for a spreadsheet cell. Splitting the
    string here beats re-deriving the attribution: it guarantees the dashboard
    and the audit file quote the same three drivers in the same order.
    """
    if not text or " " not in text:
        return None
    try:
        factor, rest = text.split(" ", 1)
        hours_part, share_part = rest.split(" h (", 1)
        return {
            "factor": factor,
            "hours": round(float(hours_part), 2),
            "share_pct": round(float(share_part.rstrip("%)")), 1),
        }
    except (ValueError, IndexError):
        return {"factor": text, "hours": None, "share_pct": None}


def _split_list(text: Any) -> List[str]:
    """"A, B, C" -> ["A", "B", "C"]; "" and "none" -> []."""
    if not isinstance(text, str) or not text.strip() or text.strip().lower() == "none":
        return []
    return [part.strip() for part in text.split(",") if part.strip()]


# ---------------------------------------------------------------------------
# per-model views
# ---------------------------------------------------------------------------


def _m1(row: Dict[str, Any]) -> Dict[str, Any]:
    """Can she transit? One verdict plus the two levers that would change it."""
    return {
        "status": row.get("Status"),
        "net_ukc_m": _num(row.get("Net_UKC_m"), 2),
        "squat_m": _num(row.get("Squat_m"), 2),
        "binding_reach": row.get("Binding_Reach"),
        "min_tide_for_safe_m": _num(row.get("Min_Tide_For_SAFE_m"), 2),
        "max_safe_speed_kn": row.get("Max_SAFE_Speed_kn"),
        "matches_sheet": row.get("Model_vs_Sheet") == "AGREE" if row.get("Sheet_DUKC_Status") else None,
        "recommendation": row.get("Recommendation"),
    }


def _m2(row: Dict[str, Any]) -> Dict[str, Any]:
    """When can she transit, for how long, and what would dredging buy?"""
    return {
        "required_tide_m": _num(row.get("Required_Tide_m"), 2),
        "windows": row.get("Windows"),
        "usable_hours": _num(row.get("Usable_Hours"), 1),
        "availability_pct": _num(row.get("Availability_pct"), 1),
        "longest_window_h": _num(row.get("Longest_Window_h"), 1),
        "max_wait_h": _num(row.get("Max_Gap_h"), 1),
        "next_window_start_ist": _blank_to_none(row.get("Next_Window_Start_IST")),
        "dredging_gain_h": _num(row.get("Dredged_Delta_h"), 1),
    }


def _m3(row: Dict[str, Any]) -> Dict[str, Any]:
    """The headline: berthing, turnaround, departure -- with the band and the why."""
    drivers = [
        d for d in (_parse_driver(row.get(f"Top_Driver_{i}", "")) for i in (1, 2, 3)) if d
    ]
    return {
        "tat_hours": _num(row.get("TAT_Hours"), 1),
        "tat_p10_hours": _num(row.get("TAT_P10_Hours"), 1),
        "tat_p90_hours": _num(row.get("TAT_P90_Hours"), 1),
        "etb_ist": _blank_to_none(row.get("ETB_IST")),
        "etd_ist": _blank_to_none(row.get("ETD_IST")),
        "wait_hours": _num(row.get("Wait_Hours"), 1),
        "berth_stay_hours": _num(row.get("Berth_Stay_Hours"), 1),
        "confidence": row.get("Confidence"),
        "engine": row.get("Engine"),
        "top_drivers": drivers,
    }


def _m4(row: Dict[str, Any]) -> Dict[str, Any]:
    """How sure are we she arrives when she says she will?"""
    return {
        "eta_p50_ist": _blank_to_none(row.get("ETA_P50_IST")),
        "eta_p10_ist": _blank_to_none(row.get("ETA_P10_IST")),
        "eta_p90_ist": _blank_to_none(row.get("ETA_P90_IST")),
        "eta_band_hours": _num(row.get("Band_Width_h"), 1),
        "sigma_hours": _num(row.get("Sigma_h"), 2),
        "confidence": row.get("Confidence"),
    }


def _m5(row: Dict[str, Any]) -> Dict[str, Any]:
    """Which berth, starting when, and did the plan have to move her?"""
    return {
        "assigned_berth": row.get("Assigned_Berth"),
        "requested_berth": row.get("Requested_Berth"),
        "berth_changed": bool(row.get("Berth_Shift")),
        "start_ist": _blank_to_none(row.get("Assigned_Start_IST")),
        "wait_hours": _num(row.get("Wait_h"), 1),
        "misses_tidal_window": bool(row.get("Tide_Miss")),
        "algorithm": row.get("Algorithm"),
        "reason": row.get("Rationale"),
    }


def _m6(row: Dict[str, Any]) -> Dict[str, Any]:
    """Slow down to arrive just in time -- what does it save, and is it possible?"""
    return {
        "rta_ist": _blank_to_none(row.get("RTA_IST")),
        "recommended_speed_kn": _num(row.get("Recommended_Speed_kn"), 1),
        "required_speed_kn": _num(row.get("Required_Speed_kn"), 1),
        "achievable": bool(row.get("Feasible")),
        "fuel_saved_t": _num(row.get("Fuel_Saved_t"), 1),
        "co2_saved_t": _num(row.get("CO2_Saved_t"), 1),
        "anchorage_hours_saved": _num(row.get("Anchorage_h_Eliminated"), 1),
        "recommendation": row.get("Recommendation"),
    }


def _m7(row: Dict[str, Any]) -> Dict[str, Any]:
    """Are the pilots, tugs and mooring gangs there when she needs them?"""
    assigned = [
        row.get("Assigned_Pilots") or "",
        row.get("Assigned_Tugs") or "",
        row.get("Assigned_Mooring") or "",
    ]
    return {
        "movement": row.get("Type"),
        "start_ist": _blank_to_none(row.get("Start_IST")),
        "pilots_tugs_mooring": [a for a in assigned if a],
        "shortfall": _split_list(row.get("Shortfall")),
        "response_gap_min": _num(row.get("Response_Gap_min"), 0),
        "resourced": bool(row.get("Feasible")),
    }


def _m8(row: Dict[str, Any]) -> Dict[str, Any]:
    """What today's disruptions do to the whole plan for this vessel."""
    causes = [c for c in (row.get(f"Root_Cause_{i}") for i in (1, 2, 3)) if c and c != "none"]
    return {
        "system_confidence": _num(row.get("System_Confidence"), 2),
        "alert_level": row.get("Alert_Level"),
        "tat_delay_h": _num(row.get("TAT_Delay_h"), 1),
        "root_causes": causes,
        "disruptions": row.get("Disruptions"),
    }


# Model key -> (output block name, human title, row->dict builder).
MODEL_VIEWS = (
    ("m1", "m1_under_keel_clearance", "Can she safely transit the channel?", _m1),
    ("m2", "m2_tidal_window", "When is there enough water, and for how long?", _m2),
    ("m3", "m3_turnaround_time", "When does she berth, finish and leave?", _m3),
    ("m4", "m4_eta_confidence", "How certain is the arrival time?", _m4),
    ("m5", "m5_berth_plan", "Which berth, and starting when?", _m5),
    ("m6", "m6_jit_arrival", "What does arriving just in time save?", _m6),
    ("m7", "m7_port_craft", "Are pilots, tugs and mooring gangs available?", _m7),
    ("m8", "m8_risk_chain", "What do today's disruptions do to the plan?", _m8),
)

MODEL_TITLES: Dict[str, str] = {block: title for _, block, title, _ in MODEL_VIEWS}


# ---------------------------------------------------------------------------
# input view
# ---------------------------------------------------------------------------


def _vessel_input(call: Any) -> Dict[str, Any]:
    """
    What the sheet said about this call -- the subset the models actually consume.

    ``DUKC_Status`` is deliberately absent. It is M1's *output* recorded by the
    duty officer, and the models never read it; showing it beside the inputs
    would invite the reader to treat a label as a feature.
    """
    return {
        "ata_ist": call.raw.get("ata_ist"),
        "eta_ist": call.raw.get("eta_ist"),
        "terminal": call.terminal,
        "requested_berth": call.requested_berth,
        "vessel_class": call.vessel_class,
        "loa_m": _num(call.loa_m, 1),
        "draft_m": _num(call.draft_m, 2),
        "teu_total": call.total_teu,
        "teu_import": call.import_teu,
        "teu_export": call.export_teu,
        "cranes_available": call.cranes_available,
        "tide_m": _num(call.tide_height_m, 2),
        "channel_depth_m": _num(call.channel_depth_m, 1),
        "weather": call.weather_raw or "Clear",
        "wind_kn": _num(call.wind_kn, 1),
        "anchorage_queue": call.anchorage_queue_count,
        "berth_occupancy_pct": _num(call.berth_occupancy_pct, 1),
    }


def _data_quality(call: Any) -> Dict[str, str]:
    """
    Where the estimated inputs came from.

    JNPA's acceptance criteria require degraded and synthetic inputs to stay
    visibly badged rather than blended into the output. These four fields are
    the badge; they are cheap to carry and they stop a modelled tide from being
    quoted as a measured one.
    """
    return {
        "tide": call.tide_source,
        "channel_depth": call.depth_source,
        "anchorage_queue": call.queue_source,
        "distance": call.distance_source,
    }


# ---------------------------------------------------------------------------
# port-level summary
# ---------------------------------------------------------------------------


def _port_summary(by_key: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    """
    The numbers that belong to the berth or the fleet, not to one vessel.

    M4's occupancy, M5's plan cost, M6's fleet savings and M7's craft roster are
    computed across the whole batch; repeating them inside every vessel would be
    both wrong and noisy.
    """
    out: Dict[str, Any] = {}

    m4 = by_key.get("m4", {}).get("summary", {})
    if m4:
        out["berth_utilisation"] = {
            "occupancy_pct": _num(m4.get("overall_occupancy_pct"), 1),
            "berths": m4.get("berths"),
            "occupancy_source": m4.get("occupancy_source"),
            "occupancy_records": m4.get("occupancy_records"),
            "median_wait_h": _num(m4.get("waiting_p50_h"), 1),
        }

    m5 = by_key.get("m5", {}).get("summary", {})
    if m5:
        out["berth_plan"] = {
            "requests": m5.get("requests"),
            "assigned": m5.get("assigned"),
            "total_wait_hours": _num(m5.get("total_wait_hours"), 1),
            "berth_changes": m5.get("berth_shifts"),
            "tide_misses": m5.get("tide_misses"),
            "solver": "cpsat" if m5.get("cpsat_available") else "greedy",
        }

    m6 = by_key.get("m6", {}).get("summary", {})
    if m6:
        out["jit_savings"] = {
            "fuel_saved_t": _num(m6.get("fleet_fuel_saved_t"), 1),
            "co2_saved_t": _num(m6.get("fleet_co2_saved_t"), 1),
            "bunker_saved_usd": _num(m6.get("fleet_bunker_saved_usd"), 0),
            "anchorage_hours_saved": _num(m6.get("fleet_anchorage_hours_eliminated"), 1),
            "figures_are": m6.get("commercial_figures"),
        }

    m7 = by_key.get("m7", {}).get("summary", {})
    if m7:
        out["port_craft"] = {
            "status": m7.get("status"),
            "movements": m7.get("movements"),
            "roster_size": m7.get("roster_size"),
            "conflicts": m7.get("conflicts"),
            "utilisation_pct": m7.get("utilisation_by_role"),
        }

    m8 = by_key.get("m8", {}).get("summary", {})
    if m8:
        out["risk"] = {
            "lowest_confidence": _num(m8.get("min_confidence"), 2),
            "any_critical": m8.get("any_critical"),
            "alert_levels": m8.get("alert_levels"),
        }

    m1 = by_key.get("m1", {}).get("summary", {})
    if m1:
        out["transit_safety"] = {
            "safe": m1.get("safe"),
            "marginal": m1.get("marginal"),
            "no_go": m1.get("no_go"),
            "agreement_with_sheet_pct":
                _num((m1.get("validation_vs_sheet") or {}).get("agreement_pct"), 1),
        }

    m3 = by_key.get("m3", {}).get("summary", {})
    if m3:
        out["turnaround"] = {
            "mean_tat_hours": _num(m3.get("mean_tat_hours"), 1),
            "engine": m3.get("engine"),
            "model_mode": m3.get("model_mode"),
            "holdout_mae_hours": _num(m3.get("holdout_mae_hours"), 2),
            "holdout_coverage_pct": _num(m3.get("holdout_coverage_pct"), 1),
        }

    return out


# ---------------------------------------------------------------------------
# builder
# ---------------------------------------------------------------------------


def build(results: Sequence[Any], batch: Any, options: Optional[Dict[str, Any]] = None,
          generated_at_utc: str = "", full_detail_file: str = "") -> Dict[str, Any]:
    """
    Fold the eight per-model tables into one vessel-keyed document.

    ``results`` are ``run_model.RunResult`` objects (or their ``as_dict()``
    form); ``batch`` is the parsed ``jnpa_input.InputBatch``. A model that
    failed, or that was not requested in this run, is simply absent from each
    vessel's ``models`` block -- the file never carries an empty placeholder
    that a dashboard would have to special-case.
    """
    by_key: Dict[str, Dict[str, Any]] = {}
    for res in results:
        as_dict = res.as_dict() if hasattr(res, "as_dict") else dict(res)
        key = as_dict["model_id"].split("-")[-1].lower()   # "UC1-M3" -> "m3"
        by_key[key] = as_dict

    indexed = {key: _rows_by_vessel_row(by_key.get(key)) for key, _, _, _ in MODEL_VIEWS}

    vessels: List[Dict[str, Any]] = []
    for call in batch.valid_rows:
        models: Dict[str, Any] = {}
        for key, block, _title, view in MODEL_VIEWS:
            row = indexed.get(key, {}).get(call.row)
            if row:
                models[block] = view(row)

        # M3 owns the caveats that apply to the whole row: a synthetic tide or a
        # lower-bound wait affects every downstream number, not just the TAT.
        m3_row = indexed.get("m3", {}).get(call.row, {})

        vessels.append({
            "call_id": call.call_id,
            "vessel": call.vessel_name,
            "imo": call.imo,
            "voyage": call.voyage,
            "terminal": call.terminal,
            "input": _vessel_input(call),
            "data_quality": _data_quality(call),
            "flags": _split_list(m3_row.get("Flags")),
            "models": models,
        })

    ran = [by_key[k]["model_id"] for k, _, _, _ in MODEL_VIEWS if k in by_key]
    failed = [
        {"model": v["model_id"], "error": v.get("error", "")}
        for v in by_key.values() if not v.get("ok", True)
    ]

    return {
        "schema": SCHEMA_VERSION,
        "run": {
            "generated_at_utc": generated_at_utc,
            "input_file": os.path.basename(batch.source_file or ""),
            "vessels": len(batch.valid_rows),
            "models_run": ran,
            "models_failed": failed,
            "wait_model": (options or {}).get("wait_model"),
            "tide_policy": (options or {}).get("tide_policy"),
            # Where to go when a number needs to be defended rather than displayed.
            "full_detail_file": full_detail_file,
        },
        "model_questions": MODEL_TITLES,
        "glossary": GLOSSARY,
        "vessels": vessels,
        "port_summary": _port_summary(by_key),
    }


def write(doc: Dict[str, Any], path: str) -> str:
    """Write the document, creating the directory if needed. Returns the path."""
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False, default=str)
    return path


# ---------------------------------------------------------------------------
# self-test
# ---------------------------------------------------------------------------


def _self_test() -> List[Any]:
    """Checks that this file stays honest: no orphan keys, no recomputation."""
    checks: List[Any] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, bool(ok), detail))

    import jnpa_paths

    jnpa_paths.ensure_on_syspath()
    import jnpa_input as jio
    import run_model as rm

    if not os.path.exists(jnpa_paths.SAMPLE_INPUT_XLSX):
        check("sample_present", False, "sample workbook not found")
        return checks

    batch = jio.load_input(jnpa_paths.SAMPLE_INPUT_XLSX)
    opts = {
        "model_dir": jnpa_paths.TRAINED_MODELS_DIR,
        "wait_model": "optimiser",
        "wait_percentile": 50,
        "cluster_gap_hours": 72.0,
        "horizon_hours": 120.0,
        "ais_staleness_min": 15.0,
        "roster_preset": "real",
        "down_craft": "",
        "tide_policy": "harmonic",
    }
    results = [rm.run_one(k, batch, opts) for k in rm.MODELS]
    doc = build(results, batch, opts, generated_at_utc="1970-01-01T00:00:00+00:00")

    check("one_entry_per_vessel", len(doc["vessels"]) == len(batch.valid_rows),
          f"{len(doc['vessels'])} vessels")
    check("all_eight_models_present",
          all(len(v["models"]) == 8 for v in doc["vessels"]),
          f"{[len(v['models']) for v in doc['vessels']]}")

    # Every key a vessel block emits must be explained, or the file is not
    # self-describing and the reader is back to guessing.
    emitted = set()
    for vessel in doc["vessels"]:
        emitted.update(vessel["input"])
        for block in vessel["models"].values():
            emitted.update(block)
    # Keys whose meaning is their name; everything else needs a glossary line.
    missing = sorted(emitted - set(GLOSSARY) - SELF_EVIDENT_KEYS)
    check("every_key_explained", not missing, f"unexplained: {missing}" if missing else "")

    # The point of this file is selection, not recomputation.
    m3_row = next(r for r in next(x for x in results if x.model_id == "UC1-M3").rows
                  if r["Row"] == batch.valid_rows[0].row)
    v0 = doc["vessels"][0]["models"]["m3_turnaround_time"]
    check("matches_full_output",
          abs(v0["tat_hours"] - round(m3_row["TAT_Hours"], 1)) < 1e-9,
          f"{v0['tat_hours']} vs {m3_row['TAT_Hours']}")

    # A dashboard file that is not dramatically smaller has missed its purpose.
    small = len(json.dumps(doc, default=str))
    full = len(json.dumps({"results": [r.as_dict() for r in results]}, default=str))
    check("smaller_than_full_output", small < full / 4,
          f"{small // 1024} KB vs {full // 1024} KB full")

    return checks


if __name__ == "__main__":
    print(f"dashboard_json {SCHEMA_VERSION}")
    passed = 0
    for name, ok, detail in _self_test():
        print(f"  [{'PASS' if ok else 'FAIL'}] {name:<32} {detail}")
        passed += ok
    print(f"  {passed} checks passed")
