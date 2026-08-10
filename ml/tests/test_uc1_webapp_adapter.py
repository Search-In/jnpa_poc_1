"""
Contract tests for the live-AIS adapter — the things a module cannot check
about itself.

`uc1_webapp_adapter.selftest()` covers the translations (draft banding, the ATA
rule, the speed floor). This file covers what only an outside caller can see:
the response contract the UC-1 frontend renders, the fact that the adapter's
numbers are the SAME numbers the audited spreadsheet path produces, and the
refusals that stop a wrong prediction reaching a screen.

    pytest tests/test_uc1_webapp_adapter.py -q
"""

from __future__ import annotations

import copy

import pytest

import uc1_webapp_adapter as adapter


@pytest.fixture(scope="module")
def demo_doc():
    """One scoring run of the demo fleet, reused across assertions."""
    return adapter.predict_fleet(list(adapter.DEMO_FLEET), adapter.DEMO_CONTEXT)


def test_module_selftest_passes():
    failed = [c for c in adapter.selftest() if not c["passed"]]
    assert not failed, failed


# ---------------------------------------------------------------------------
# The response contract the frontend depends on
# ---------------------------------------------------------------------------


def test_envelope_shape(demo_doc):
    assert demo_doc["schema"] == adapter.SCHEMA_VERSION
    assert demo_doc["adapter"]["moduleId"] == adapter.MODULE_ID
    assert demo_doc["adapter"]["scope"] == "FLEET"
    assert demo_doc["dashboard"]["schema"].startswith("uc1-dashboard/")


def test_every_model_block_the_ui_renders_is_present(demo_doc):
    """The eight block ids <VesselPredictionsSheet> orders by must all appear."""
    expected = {
        "m1_under_keel_clearance", "m2_tidal_window", "m3_turnaround_time",
        "m4_eta_confidence", "m5_berth_plan", "m6_jit_arrival",
        "m7_port_craft", "m8_risk_chain",
    }
    for vessel in demo_doc["dashboard"]["vessels"]:
        assert expected <= set(vessel["models"]), (
            f"{vessel['vessel']} missing {expected - set(vessel['models'])}"
        )


def test_mmsi_and_source_survive_onto_the_response(demo_doc):
    """The UI joins the response back to its table row on MMSI."""
    got = {v["mmsi"] for v in demo_doc["dashboard"]["vessels"]}
    assert got == {v["MMSI"] for v in adapter.DEMO_FLEET}
    assert {v["source"] for v in demo_doc["dashboard"]["vessels"]} == {"live", "mock"}


def test_every_rendered_key_has_a_glossary_entry(demo_doc):
    """
    The panel renders each field with its definition as a tooltip, so a key with
    no glossary entry reaches an operator undefined. ``dashboard_json`` has its
    own self-test for this; assert it from the ADAPTER's output too, because that
    is the document the UI actually receives — and the adapter reaches models
    with inputs the spreadsheet path never produces.

    The exemption list is imported, not restated: a second copy would drift, and
    a drifted copy either fails spuriously or hides a genuinely undefined key.
    """
    import dashboard_json

    glossary = demo_doc["dashboard"]["glossary"]
    missing = set()
    for vessel in demo_doc["dashboard"]["vessels"]:
        missing |= {k for k in vessel["input"] if k not in glossary}
        for block in vessel["models"].values():
            missing |= {k for k in block if k not in glossary}
    missing -= dashboard_json.SELF_EVIDENT_KEYS
    assert not missing, f"keys rendered without a definition: {sorted(missing)}"


def test_mapping_ledger_accounts_for_every_input(demo_doc):
    for vessel in demo_doc["dashboard"]["vessels"]:
        mapping = vessel["mapping"]
        assert mapping is not None
        assert mapping["inputs_observed"] + mapping["inputs_assumed"] == len(mapping["derived"])
        # degraded must agree with the assumption list — a badge that can
        # disagree with its evidence is worse than no badge.
        assert mapping["degraded"] == bool(mapping["assumptions"])
        assert mapping["degraded"] == vessel["degraded"]


def test_an_assumed_input_is_never_reported_as_observed():
    """A hull with no draught, no cargo and no ATA must say so on every count."""
    doc = adapter.predict_vessel(
        {"MMSI": "1", "VESSEL_NAME": "BARE ROW", "NAV_STATUS": "underway"})
    mapping = doc["dashboard"]["vessels"][0]["mapping"]
    assumed = " ".join(mapping["assumptions"])
    for field in ("LOA_m", "Draft_m", "Total_TEU", "ATA"):
        assert field in assumed, f"{field} was substituted without being named"


# ---------------------------------------------------------------------------
# Agreement with the audited path
# ---------------------------------------------------------------------------


def test_a_fully_specified_row_degrades_on_nothing_but_cargo_and_arrival():
    """
    Send everything AIS *can* carry and the only substitutions left are the ones
    AIS genuinely never carries: the cargo parcel, its split, and the ATA.

    ATA stays on the list even for a hull reporting an ETA, and that is correct:
    an ETA is a claim about the future, not a recorded arrival. The adapter says
    which timestamp it used and why, rather than presenting a predicted arrival
    as an observed one.
    """
    doc = adapter.predict_vessel({
        "MMSI": "419000999", "VESSEL_NAME": "FULLY SPECIFIED",
        "VESSEL_TYPE": "Container Ship", "NAV_STATUS": "approaching",
        "SOG": 12.0, "LAT": 18.9, "LON": 72.9, "LOA_M": 300.0, "DRAFT_M": 14.0,
        "BERTH_ID": "NSICT-01", "TIMESTAMP": 1_785_000_000_000,
        "ETA": 1_785_030_000_000, "SOURCE": "live",
    })
    mapping = doc["dashboard"]["vessels"][0]["mapping"]
    substituted = {a.split("=")[0] for a in mapping["assumptions"]}
    assert substituted == {"Total_TEU", "Import_TEU/Export_TEU", "ATA"}, mapping["assumptions"]
    # Draft and LOA were reported, so neither may appear — those are the two the
    # under-keel clearance rests on.
    assert "Draft_m" not in substituted and "LOA_m" not in substituted


def test_the_adapter_runs_the_same_models_as_the_spreadsheet_path():
    """
    Same runner, same options, same dashboard builder — so a number on the panel
    is a number the audit file defends. Asserted by construction rather than by
    comparing figures: the two paths take different INPUTS, and pinning a value
    here would pin the demo fleet, not the agreement.
    """
    import run_model

    assert adapter.ALL_MODELS == tuple(run_model.MODELS)
    opts = adapter._run_options()
    assert opts["wait_model"] == "optimiser"
    assert opts["tide_policy"] == "harmonic"
    assert opts["roster_preset"] == "real"


def test_scoring_is_deterministic_for_the_same_feed():
    """Two identical requests must not produce two different berth plans."""
    # The demo fleet carries fixed fix times for exactly this reason: a row with
    # neither an ETA nor a TIMESTAMP falls back to "now", and the berth plan
    # would then differ between two calls a second apart.
    fleet = list(adapter.DEMO_FLEET)
    ctx = dict(adapter.DEMO_CONTEXT)
    first = adapter.predict_fleet(copy.deepcopy(fleet), ctx)["dashboard"]["vessels"]
    second = adapter.predict_fleet(copy.deepcopy(fleet), ctx)["dashboard"]["vessels"]
    assert [v["models"] for v in first] == [v["models"] for v in second]


# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------


def test_unknown_model_is_refused_not_dropped():
    with pytest.raises(ValueError, match="unknown model"):
        adapter.predict_fleet(list(adapter.DEMO_FLEET), models=["m1", "m99"])


def test_empty_fleet_is_refused():
    with pytest.raises(ValueError, match="no vessels"):
        adapter.predict_fleet([])


def test_a_non_object_row_is_refused_rather_than_coerced():
    with pytest.raises(ValueError, match="not an object"):
        adapter.predict_fleet(["MSC ANNA"])


def test_fleet_is_capped_and_the_drop_is_reported():
    """An over-large feed must lose vessels loudly, never silently."""
    fleet = [
        {"MMSI": str(i), "VESSEL_NAME": f"V{i}", "NAV_STATUS": "underway",
         "TIMESTAMP": 1_785_000_000_000}
        for i in range(adapter.MAX_FLEET + 5)
    ]
    doc = adapter.predict_fleet(fleet, models=["m1"])
    run = doc["dashboard"]["run"]
    assert run["vessels_requested"] == adapter.MAX_FLEET + 5
    assert run["vessels_dropped"] == 5
    assert str(adapter.MAX_FLEET) in run["dropped_reason"]
    assert len(doc["dashboard"]["vessels"]) == adapter.MAX_FLEET


# ---------------------------------------------------------------------------
# The published substitution catalogue
# ---------------------------------------------------------------------------


def test_mapping_catalogue_publishes_every_constant_the_adapter_may_substitute():
    cat = adapter.mapping_catalogue()
    assert cat["defaults"]["default_loa_m"] == adapter.DEFAULT_LOA_M
    assert cat["defaults"]["parcel_share_of_capacity"] == adapter.PARCEL_SHARE_OF_CAPACITY
    assert cat["defaults"]["min_transit_speed_kn"] == adapter.MIN_TRANSIT_SPEED_KN
    assert cat["defaults"]["max_fleet"] == adapter.MAX_FLEET
    assert len(cat["loa_bands"]) == len(adapter.LOA_BANDS)
    assert set(cat["models"]) == set(adapter.ALL_MODELS)


def test_mapping_preview_needs_no_model_run():
    """The translation must be inspectable on its own, before anything is run."""
    values, ledger = adapter.map_ais_row(
        {"MMSI": "1", "VESSEL_NAME": "PREVIEW", "NAV_STATUS": "moored",
         "TIMESTAMP": 1_785_000_000_000, "LOA_M": 200.0})
    assert values["vessel_name"] == "PREVIEW"
    assert values["draft_m"] > 0
    assert ledger.degraded and ledger.assumptions
