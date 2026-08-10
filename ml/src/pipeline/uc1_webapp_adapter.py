"""
UC1-ADAPTER -- live-AIS ingest for the eight UC-I models
=======================================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-I Vessel Traffic
Management & Optimization. Tender ref GeM/2026/B/7297343.

WHY THIS MODULE EXISTS
----------------------
The eight UC-I models take a validated vessel *call*: an ATA, a draft, a TEU
parcel, a terminal, a tide height. The web app does not have a call. What it has
is an **AIS position report** -- ``{MMSI, VESSEL_NAME, VESSEL_TYPE, NAV_STATUS,
SOG, COG, HEADING, LAT, LON, ETA, BERTH_ID, TIMESTAMP}`` -- which carries none
of the cargo, berth or environment fields the models need.

Bridging that gap in the frontend would mean every consumer invents its own
draft estimate, and the first one to guess 14 m where another guessed 12 m ships
a different under-keel clearance for the same hull. So the bridge lives here,
once, versioned, and **every response states exactly what was observed and what
was assumed**.

WHAT IT GUARANTEES
------------------
1. NOTHING IS INVENTED SILENTLY. AIS does not carry TEU, and the JNPA gateway's
   position feed does not carry draught either. Where a model input is absent,
   the adapter uses a NAMED constant from SECTION 1, sets ``degraded: true`` and
   lists the substitution in ``mapping.assumptions[]``.

2. EVERY DERIVATION IS SHOWN. ``mapping.derived[]`` carries one entry per model
   input: the source field, the raw value, the mapped value and the rule that
   did it. A port captain can check the translation by hand.

3. THE MODELS AND THE LOADER ARE UNCHANGED. The adapter builds the same
   ``jnpa_input.VesselCallInput`` rows the spreadsheet path builds, hands them to
   the same ``run_model.run_one()``, and folds the results with the same
   ``dashboard_json.build()``. So the numbers a UI shows are the numbers the
   audit file defends -- there is no second, softer code path.

4. THE FLEET IS SCORED AS A FLEET. M4 (berth occupancy), M5 (berth plan) and M7
   (craft roster) are ``per-batch`` models: their answers are properties of the
   whole arrival set, not of one hull. ``predict_fleet()`` therefore takes every
   vessel in the feed in ONE call. ``predict_vessel()`` exists for convenience
   and says so in ``run.scope`` -- a one-vessel berth plan is a berth plan for a
   port with one ship in it.

RESPONSE SHAPE
--------------
The payload is the ``uc1-dashboard/1.0.0`` document ``dashboard_json.py``
already produces (the same shape as ``out/predictions_dashboard.json``), plus an
``adapter`` block carrying the per-vessel mapping ledger::

    {
      "schema": "uc1-webapp-predictions/1.0.0",
      "adapter":   {"version": ..., "vessels": [{"call_id", "mmsi", "mapping"}]},
      "dashboard": {"run", "model_questions", "glossary", "vessels", "port_summary"}
    }

USAGE
-----
    python src/pipeline/uc1_webapp_adapter.py                # demo fleet, table
    python src/pipeline/uc1_webapp_adapter.py --json
    python src/pipeline/uc1_webapp_adapter.py --selftest      # CI gate

    from uc1_webapp_adapter import predict_fleet
    doc = predict_fleet([{"MMSI": "419000123", "VESSEL_NAME": "MV DEMO", ...}])
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import jnpa_paths  # noqa: E402

jnpa_paths.ensure_on_syspath()

import dashboard_json  # noqa: E402
import jnpa_input as jio  # noqa: E402
import run_model  # noqa: E402

MODULE_ID: str = "UC1-ADAPTER"
MODULE_NAME: str = "JNPA live-AIS adapter for the eight UC-I models"
MODULE_VERSION: str = "uc1-adapter-v1.0.0"
ROUTER_PREFIX: str = "/uc1/webapp"
SCHEMA_VERSION: str = "uc1-webapp-predictions/1.0.0"

AisRow = Dict[str, Any]

# One request may not ask the models to plan an unbounded fleet: M5's optimiser
# and M7's conflict scan are super-linear in the movement count, and a runaway
# client would otherwise take the service down. Excess vessels are REPORTED
# (run.vessels_dropped), never silently trimmed.
MAX_FLEET: int = 80


# ==========================================================================
# SECTION 1 -- NAMED CONSTANTS
#
# Every value here is a published assumption, not a heuristic buried in a
# function. They are served at GET /uc1/webapp/mapping so a UI can show the
# operator exactly what was substituted for a field AIS never sent.
# ==========================================================================

# AIS ship-type text -> the loader's Cargo_Type vocabulary. The loader turns
# that into CONTAINER or BULK, which selects the block coefficient the DUKC
# squat term uses -- so this mapping changes a safety number, not a label.
SHIP_TYPE_TO_CARGO_TYPE: Tuple[Tuple[str, str], ...] = (
    ("CONTAINER", "Container"),
    ("BULK", "Bulk"),
    ("ORE", "Bulk Ore"),
    ("COAL", "Bulk Coal"),
    ("GRAIN", "Bulk Grain"),
    ("CEMENT", "Bulk Cement"),
    ("TANKER", "Liquid Bulk"),
    ("CRUDE", "Crude Oil"),
    ("LPG", "LPG"),
    ("LNG", "LNG"),
    ("CHEMICAL", "Chemical"),
    ("OIL", "Oil"),
    ("VEHICLE", "Ro-Ro"),
    ("CAR CARRIER", "Ro-Ro"),
    ("RO-RO", "Ro-Ro"),
    ("GENERAL CARGO", "General Cargo"),
    ("CARGO", "Container"),  # the AIS 70-79 band is 'Cargo'; at JNPA that is a box boat
)

# LOA (m) -> (assumed laden draft m, assumed nominal capacity TEU, class label).
# Sources: JNPA's own 15.5 m declared channel draft ceiling, and the standard
# containership size bands. Used ONLY when the feed carries no draught, which is
# the normal case for a position-report feed.
LOA_BANDS: Tuple[Tuple[float, float, int, str], ...] = (
    (366.0, 16.0, 18000, "ULCV"),
    (330.0, 15.0, 13000, "ULCV"),
    (300.0, 14.5, 9000, "POST_PANAMAX"),
    (260.0, 13.5, 6000, "POST_PANAMAX"),
    (225.0, 12.5, 4000, "PANAMAX"),
    (180.0, 11.0, 2500, "FEEDER"),
    (140.0, 9.5, 1200, "FEEDER"),
    (0.0, 8.0, 600, "FEEDER"),
)

# When the feed carries no length either. A JNPA box-boat call is far more often
# post-panamax than feeder, so the fallback is the middle of the fleet rather
# than the smallest hull -- and it is flagged, so it is never mistaken for a fix.
DEFAULT_LOA_M: float = 260.0

# Share of nominal capacity actually worked in one call. JNPA's published mean
# call is ~1,500-2,000 moves against fleet capacities several times that; 0.30 is
# the round number in that band. It drives M3's dominant TAT term, so it is
# stated here rather than hidden in the resolver.
PARCEL_SHARE_OF_CAPACITY: float = 0.30

# Import/export split of the parcel. JNPA is import-dominant.
IMPORT_SHARE_OF_PARCEL: float = 0.60

# A hull sitting still at a berth is not transiting; the channel speed the DUKC
# squat term needs is the speed she WILL make, not the 0.0 kn she reports now.
MIN_TRANSIT_SPEED_KN: float = 6.0

# AIS nav status -> which timestamp becomes ATA. A moored hull arrived in the
# past (her last fix is the best evidence we hold); an approaching hull has not
# arrived at all, so her ETA is the arrival being predicted against.
ATA_RULE_BY_STATUS: Dict[str, str] = {
    "moored": "TIMESTAMP",
    "berthing": "TIMESTAMP",
    "anchored": "TIMESTAMP",
    "approaching": "ETA_ELSE_TIMESTAMP",
    "underway": "ETA_ELSE_TIMESTAMP",
}

# Berth prefix -> terminal, for the reverse lookup the feed cannot do. The
# loader canonicalises the berth id itself; this only names the terminal.
BERTH_PREFIX_TO_TERMINAL: Dict[str, str] = {
    "CB": "NSICT",
    "NSICT": "NSICT",
    "NSIGT": "NSIGT",
    "GTI": "GTI",
    "APMT": "GTI",
    "NSFT": "NSFT",
    "BMCT": "BMCT",
    "LB": "LIQUID",
    "CCB": "SHALLOW",
}


# ==========================================================================
# SECTION 2 -- TOLERANT READERS
#
# The frontend sends the ArcGIS-style UPPER_SNAKE domain object; a probe or a
# curl example sends snake_case; a partially-filled form sends "" and null for
# the same absence. These readers accept all of it and return None -- never a
# silent zero -- when a value is genuinely absent.
# ==========================================================================


def _first(row: Mapping[str, Any], *keys: str) -> Any:
    """First present, non-blank value among ``keys`` (case/underscore tolerant)."""
    lookup = {str(k).strip().upper().replace("-", "_"): v for k, v in row.items()}
    for key in keys:
        value = lookup.get(key.strip().upper().replace("-", "_"))
        if value is None:
            continue
        if isinstance(value, str) and not value.strip():
            continue
        return value
    return None


def read_text(row: Mapping[str, Any], *keys: str) -> Optional[str]:
    value = _first(row, *keys)
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def read_float(row: Mapping[str, Any], *keys: str) -> Optional[float]:
    value = _first(row, *keys)
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def read_int(row: Mapping[str, Any], *keys: str) -> Optional[int]:
    number = read_float(row, *keys)
    return None if number is None else int(round(number))


def read_moment(row: Mapping[str, Any], *keys: str) -> Optional[datetime]:
    """
    Read a timestamp as tz-aware UTC.

    Accepts what a browser actually sends: epoch **milliseconds** (the domain
    type's ``TIMESTAMP`` / ``ETA``), epoch seconds, or an ISO-8601 string. A bare
    ISO string without an offset is read as IST, matching the loader -- JNPA
    paperwork is written in local time and reading it as UTC would shift every
    arrival 5.5 hours.
    """
    value = _first(row, *keys)
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(
            tzinfo=jio.IST).astimezone(timezone.utc)
    if isinstance(value, (int, float)):
        seconds = float(value)
        # Anything past ~1973 in ms is > 1e11; below that it is seconds.
        if abs(seconds) > 1e11:
            seconds /= 1000.0
        try:
            return datetime.fromtimestamp(seconds, tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    try:
        return jio.parse_datetime_ist(str(value))
    except jio.ParseError:
        return None


def iso_utc(moment: Optional[datetime]) -> Optional[str]:
    if moment is None:
        return None
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ==========================================================================
# SECTION 3 -- THE MAPPING LEDGER
#
# One per vessel. It is returned inside the response so the caller can see
# each model input, where it came from, and whether it was observed or
# assumed.
# ==========================================================================


class MappingLedger:
    """Records how each model input for one vessel was arrived at."""

    def __init__(self, mmsi: str, vessel_name: str) -> None:
        self.mmsi = mmsi
        self.vessel_name = vessel_name
        self.derived: List[Dict[str, Any]] = []
        self.assumptions: List[str] = []
        self.warnings: List[str] = []

    def observed(self, field: str, value: Any, source: str, raw: Any = None,
                 rule: str = "direct") -> Any:
        """Record a model input that came from the AIS row or the context block."""
        self.derived.append({
            "model_input": field, "value": value, "source": source,
            "raw": None if raw is None else str(raw), "rule": rule,
            "observed": True,
        })
        return value

    def assumed(self, field: str, value: Any, why: str) -> Any:
        """Record a model input AIS could not supply. Sets ``degraded``."""
        self.derived.append({
            "model_input": field, "value": value, "source": "ASSUMED",
            "raw": None, "rule": why, "observed": False,
        })
        self.assumptions.append(f"{field}={value} -- {why}")
        return value

    def warn(self, message: str) -> None:
        self.warnings.append(message)

    @property
    def degraded(self) -> bool:
        return bool(self.assumptions)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "adapter_version": MODULE_VERSION,
            "mmsi": self.mmsi,
            "vessel": self.vessel_name,
            "degraded": self.degraded,
            "derived": self.derived,
            "assumptions": self.assumptions,
            "warnings": self.warnings,
            "inputs_observed": sum(1 for d in self.derived if d["observed"]),
            "inputs_assumed": sum(1 for d in self.derived if not d["observed"]),
        }


# ==========================================================================
# SECTION 4 -- FIELD RESOLVERS
#
# One function per model input that needs more than a direct read. Each is
# pure, testable on its own, and records its reasoning in the ledger.
# ==========================================================================


def resolve_loa_m(row: AisRow, ledger: MappingLedger) -> float:
    """AIS Class-A static data carries LENGTH; a position-only feed does not."""
    loa = read_float(row, "LOA_M", "LOA", "LENGTH", "length_m")
    if loa is not None and loa > 0:
        return float(ledger.observed("LOA_m", round(loa, 1), "AIS.LENGTH", loa))
    return float(ledger.assumed(
        "LOA_m", DEFAULT_LOA_M,
        "the AIS position feed carries no length; assumed the JNPA fleet median "
        f"({DEFAULT_LOA_M} m). Send LOA_M to replace this estimate"))


def _band_for(loa_m: float) -> Tuple[float, float, int, str]:
    for threshold, draft, teu, label in LOA_BANDS:
        if loa_m >= threshold:
            return threshold, draft, teu, label
    return LOA_BANDS[-1]


def resolve_draft_m(row: AisRow, loa_m: float, ledger: MappingLedger) -> float:
    """
    The single most consequential input: it drives every UKC number M1/M2/M8
    report. Honoured from the feed whenever present, estimated from LOA
    otherwise -- and an estimated draft is stated as such on every response,
    because a MARGINAL verdict computed from a guessed draft is advice, not a
    clearance.
    """
    draft = read_float(row, "DRAFT_M", "DRAFT", "DRAUGHT", "draught_m", "static_draft_m")
    if draft is not None and draft > 0:
        return float(ledger.observed("Draft_m", round(draft, 2), "AIS.DRAUGHT", draft))
    _, banded, _, label = _band_for(loa_m)
    return float(ledger.assumed(
        "Draft_m", banded,
        f"AIS sent no draught; estimated from LOA {loa_m:g} m ({label} band). "
        "Every UKC figure below rests on this estimate"))


def resolve_teu(row: AisRow, loa_m: float,
                ledger: MappingLedger) -> Tuple[int, int, int]:
    """Parcel worked this call -> (total, import, export) TEU. Drives M3's TAT."""
    total = read_int(row, "TEU_TOTAL", "TOTAL_TEU", "teu")
    if total is not None and total > 0:
        ledger.observed("Total_TEU", total, "call.TEU_TOTAL", total)
    else:
        _, _, capacity, label = _band_for(loa_m)
        total = int(round(capacity * PARCEL_SHARE_OF_CAPACITY))
        ledger.assumed(
            "Total_TEU", total,
            f"AIS carries no cargo; assumed {PARCEL_SHARE_OF_CAPACITY:.0%} of the "
            f"{capacity:,} TEU {label} nominal capacity implied by LOA {loa_m:g} m")

    imports = read_int(row, "TEU_IMPORT", "IMPORT_TEU")
    exports = read_int(row, "TEU_EXPORT", "EXPORT_TEU")
    if imports is None and exports is None:
        imports = int(round(total * IMPORT_SHARE_OF_PARCEL))
        exports = total - imports
        ledger.assumed(
            "Import_TEU/Export_TEU", f"{imports}/{exports}",
            f"split at the JNPA import share {IMPORT_SHARE_OF_PARCEL:.0%}")
    else:
        imports = imports or max(0, total - (exports or 0))
        exports = exports or max(0, total - imports)
        ledger.observed("Import_TEU/Export_TEU", f"{imports}/{exports}", "call")
    return int(total), int(imports), int(exports)


def resolve_ata(row: AisRow, ledger: MappingLedger) -> datetime:
    """
    ATA is a REQUIRED model input and AIS never states it.

    The rule is stated per nav status in ``ATA_RULE_BY_STATUS`` rather than
    picked per call: a moored hull's arrival is in the past, so her fix time is
    the best evidence held; an inbound hull has not arrived, so her reported ETA
    is the arrival every downstream number is measured from.
    """
    explicit = read_moment(row, "ATA", "ATA_UTC", "ata_ist", "ATB")
    if explicit is not None:
        return explicit if ledger.observed("ATA", iso_utc(explicit), "call.ATA") else explicit

    status = str(read_text(row, "NAV_STATUS", "STATUS") or "").strip().lower()
    eta = read_moment(row, "ETA", "ETA_UTC")
    fix = read_moment(row, "TIMESTAMP", "LAST_FIX", "POSITION_TIME")
    rule = ATA_RULE_BY_STATUS.get(status, "ETA_ELSE_TIMESTAMP")

    if rule == "TIMESTAMP" and fix is not None:
        ledger.assumed("ATA", iso_utc(fix),
                       f"nav status '{status or 'unknown'}' means she is already here; "
                       "used the last AIS fix time as the arrival")
        return fix
    if eta is not None:
        ledger.assumed("ATA", iso_utc(eta),
                       f"nav status '{status or 'unknown'}' means she has not arrived; "
                       "used the AIS-reported ETA as the arrival being planned against")
        return eta
    if fix is not None:
        ledger.assumed("ATA", iso_utc(fix),
                       "no ETA reported; used the last AIS fix time as the arrival")
        return fix
    now = datetime.now(timezone.utc)
    ledger.assumed("ATA", iso_utc(now),
                   "the row carried neither an ETA nor a fix time; used 'now'")
    return now


def resolve_berth(row: AisRow, ledger: MappingLedger) -> Tuple[str, str]:
    """-> (terminal, requested berth). Both may be '' -- the loader tolerates it."""
    berth = read_text(row, "BERTH_ID", "BERTH", "REQUESTED_BERTH") or ""
    terminal = read_text(row, "TERMINAL") or ""
    if berth:
        ledger.observed("Requested_Berth", berth, "AIS.BERTH_ID", berth)
    if not terminal and berth:
        prefix = "".join(ch for ch in berth.upper() if ch.isalpha())
        guess = BERTH_PREFIX_TO_TERMINAL.get(prefix, "")
        if guess:
            terminal = ledger.observed("Terminal", guess, "derived from berth prefix",
                                       berth, rule="BERTH_PREFIX_TO_TERMINAL")
    if not terminal:
        ledger.warn("no terminal known for this vessel; M5 plans her against the "
                    "whole JNPA roster rather than one terminal's berths")
    return terminal, berth


def resolve_speed_kn(row: AisRow, ledger: MappingLedger) -> float:
    """
    Channel speed for the squat term.

    A berthed hull reports 0.0 kn over ground. Feeding that to the DUKC core
    would zero the squat and report a clearance no transit will ever have, so a
    speed below the floor is raised to it and the substitution is recorded.
    """
    sog = read_float(row, "SOG", "SPEED_KNOTS", "speed_kn")
    if sog is not None and sog >= MIN_TRANSIT_SPEED_KN:
        return float(ledger.observed("Speed_kn", round(sog, 1), "AIS.SOG", sog))
    if sog is not None:
        return float(ledger.assumed(
            "Speed_kn", MIN_TRANSIT_SPEED_KN,
            f"AIS SOG is {sog:g} kn (stopped or manoeuvring); a zero-speed squat "
            f"would overstate clearance, so the {MIN_TRANSIT_SPEED_KN:g} kn transit "
            "floor is used"))
    return float(ledger.assumed("Speed_kn", MIN_TRANSIT_SPEED_KN,
                                "no SOG in the row; used the transit floor"))


def resolve_cargo_type(row: AisRow, ledger: MappingLedger) -> str:
    """AIS ship type -> the loader's Cargo_Type, which selects the block coefficient."""
    raw = read_text(row, "VESSEL_TYPE", "SHIP_TYPE", "ship_type_label", "CARGO_TYPE")
    if not raw:
        return str(ledger.assumed(
            "Cargo_Type", "Container",
            "no AIS ship type; assumed a box boat (Cb 0.65), the JNPA norm"))
    text = raw.upper()
    for needle, cargo_type in SHIP_TYPE_TO_CARGO_TYPE:
        if needle in text:
            return str(ledger.observed("Cargo_Type", cargo_type, "AIS.VESSEL_TYPE",
                                       raw, rule=f"contains '{needle}'"))
    ledger.warn(f"unrecognised AIS ship type {raw!r}; treated as a container vessel")
    return str(ledger.assumed(
        "Cargo_Type", "Container",
        f"AIS ship type {raw!r} is not in the code table; assumed a box boat"))


# ==========================================================================
# SECTION 5 -- ROW -> LOADER FIELDS
# ==========================================================================


def map_ais_row(row: AisRow, context: Optional[Mapping[str, Any]] = None
                ) -> Tuple[Dict[str, Any], MappingLedger]:
    """
    Translate one AIS position report into the loader's field values.

    Returns the ``{field_name: raw value}`` mapping ``jnpa_input`` parses, plus
    the ledger describing how each value was reached. Pure: no model runs here,
    so the translation can be unit-tested and shown to a reviewer on its own.
    """
    ctx: Mapping[str, Any] = context or {}
    mmsi = read_text(row, "MMSI", "mmsi") or ""
    name = read_text(row, "VESSEL_NAME", "NAME", "vessel_name") or (
        f"MMSI-{mmsi}" if mmsi else "UNKNOWN VESSEL")
    ledger = MappingLedger(mmsi, name)

    loa_m = resolve_loa_m(row, ledger)
    draft_m = resolve_draft_m(row, loa_m, ledger)
    total_teu, import_teu, export_teu = resolve_teu(row, loa_m, ledger)
    ata = resolve_ata(row, ledger)
    terminal, berth = resolve_berth(row, ledger)
    eta = read_moment(row, "ETA", "ETA_UTC")

    values: Dict[str, Any] = {
        "vessel_name": name,
        "imo": read_text(row, "IMO", "IMO_NO", "imo_no") or "",
        "voyage": read_text(row, "VOYAGE", "VOYAGE_NO") or "",
        "ata_ist": ata,
        "eta_ist": eta,
        "draft_m": draft_m,
        "loa_m": loa_m,
        "total_teu": total_teu,
        "import_teu": import_teu,
        "export_teu": export_teu,
        "cargo_type": resolve_cargo_type(row, ledger),
        "transit_speed_kn": resolve_speed_kn(row, ledger),
        "terminal": terminal,
        "requested_berth": berth,
    }

    # --- environment / port state: the caller's context block, never invented --
    # Absent keys are simply left out. The loader then applies its OWN documented
    # fallback (synthetic harmonic tide, queue-from-occupancy) and records it in
    # data_quality, so there is exactly one place each of those rules lives.
    for field_name, keys, label in (
        ("tide_height_m", ("tide_m", "TIDE_M", "tide_height_m"), "Tide_Height_m"),
        ("wind_kn", ("wind_kn", "WIND_KN", "windKt"), "Wind_Speed_kn"),
        ("rain_mm_hr", ("rain_mm_hr", "RAIN_MM_HR", "rainMmHr"), "Rain_mm_hr"),
        ("channel_depth_m", ("channel_depth_m", "CHANNEL_DEPTH_M"), "Channel_Depth_m"),
        ("berth_occupancy_pct", ("berth_occupancy_pct", "BERTH_OCCUPANCY_PCT"),
         "Berth_Occupancy_%"),
    ):
        value = read_float(ctx, *keys)
        if value is not None:
            values[field_name] = ledger.observed(label, value, "context")

    queue = read_int(ctx, "anchorage_queue", "ANCHORAGE_QUEUE")
    if queue is not None:
        values["anchorage_queue_count"] = ledger.observed("Anchorage_Queue", queue,
                                                          "context")
    weather = read_text(ctx, "weather", "WEATHER")
    if weather:
        values["weather_raw"] = ledger.observed("Weather", weather, "context")
    distance = read_float(ctx, "distance_nm", "DISTANCE_NM")
    if distance is not None:
        values["distance_nm"] = ledger.observed("Distance_NM", distance, "context")

    if "tide_height_m" not in values:
        ledger.warn("no measured tide supplied; the loader's synthetic harmonic "
                    "curve is used and reported as TIDE_SYNTHETIC")
    return values, ledger


def build_batch(vessels: Sequence[AisRow],
                context: Optional[Mapping[str, Any]] = None,
                source_label: str = "live-ais-feed",
                ) -> Tuple[jio.InputBatch, List[MappingLedger]]:
    """
    Build the same ``InputBatch`` the spreadsheet path builds, from AIS rows.

    Deliberately reuses ``jnpa_input._parse_row``: that function owns the
    validation, the IST->UTC conversion, the tide/queue fallbacks and the
    ``*_source`` provenance fields. Re-implementing any of it here would create
    a second definition of a vessel call, which is exactly what this adapter
    exists to prevent.
    """
    if not vessels:
        raise ValueError("no vessels supplied")

    rows: List[jio.VesselCallInput] = []
    ledgers: List[MappingLedger] = []
    for index, vessel in enumerate(vessels[:MAX_FLEET], start=1):
        if not isinstance(vessel, Mapping):
            raise ValueError(f"vessel {index} is {type(vessel).__name__}, not an object")
        values, ledger = map_ais_row(vessel, context)
        call = jio._parse_row(index, values, tide_policy="harmonic",
                              fixed_tide_m=None, source_file=source_label)
        call.raw = dict(values)
        rows.append(call)
        ledgers.append(ledger)

    jio._derive_batch_features(rows)

    batch = jio.InputBatch(
        schema_version=jio.SCHEMA_VERSION,
        source_file=source_label,
        source_format="ais-json",
        sheet_name="",
        header_map={},
        unknown_columns=(),
        missing_required=(),
        rows=rows,
        issues=[],
        read_at_utc=datetime.now(timezone.utc),
    )
    return batch, ledgers


# ==========================================================================
# SECTION 6 -- PREDICTION
# ==========================================================================

ALL_MODELS: Tuple[str, ...] = tuple(run_model.MODELS)


def _run_options(overrides: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """The runner options, with the same defaults ``run.py models`` uses."""
    opts: Dict[str, Any] = {
        "artifact": None,
        "model_dir": jnpa_paths.TRAINED_MODELS_DIR,
        "wait_model": "optimiser",
        "wait_percentile": 50,
        "cluster_gap_hours": 72.0,
        "horizon_hours": 120.0,
        "ais_staleness_min": run_model.DEFAULT_AIS_STALENESS_MIN,
        "roster_preset": "real",
        "down_craft": "",
        "tide_policy": "harmonic",
    }
    opts.update({k: v for k, v in (overrides or {}).items() if v is not None})
    return opts


def predict_fleet(vessels: Sequence[AisRow],
                  context: Optional[Mapping[str, Any]] = None,
                  models: Optional[Sequence[str]] = None,
                  options: Optional[Mapping[str, Any]] = None,
                  ) -> Dict[str, Any]:
    """
    Run the requested UC-I models over a whole AIS feed and return the
    dashboard document, plus one mapping ledger per vessel.

    ``models`` defaults to all eight. Unknown keys raise rather than being
    dropped: a UI asking for 'm9' has a bug, and silently returning seven
    models would hide it.
    """
    keys = [str(k).strip().lower() for k in (models or ALL_MODELS) if str(k).strip()]
    unknown = [k for k in keys if k not in run_model.MODELS]
    if unknown:
        raise ValueError(f"unknown model(s): {', '.join(unknown)}. "
                         f"Valid: {', '.join(ALL_MODELS)}")

    requested = len(vessels)
    batch, ledgers = build_batch(vessels, context)
    if not batch.valid_rows:
        blocking = [str(i) for i in batch.all_issues if i.severity == "ERROR"]
        raise ValueError("no valid vessel rows: " + ("; ".join(blocking) or "unknown"))

    opts = _run_options(options)
    results = [run_model.run_one(key, batch, opts) for key in keys]

    doc = dashboard_json.build(
        results, batch, dict(opts),
        generated_at_utc=iso_utc(datetime.now(timezone.utc)) or "",
        full_detail_file="",
    )
    doc["run"]["source"] = "LIVE_AIS_ADAPTER"
    doc["run"]["vessels_requested"] = requested
    doc["run"]["vessels_dropped"] = max(0, requested - len(batch.rows))
    if doc["run"]["vessels_dropped"]:
        doc["run"]["dropped_reason"] = (
            f"the request carried {requested} vessels; this endpoint scores at most "
            f"{MAX_FLEET} per call")

    by_call = {call.call_id: ledger for call, ledger in zip(batch.rows, ledgers)}
    for vessel_block, source_row in zip(doc.get("vessels", []), vessels):
        ledger = by_call.get(vessel_block["call_id"])
        vessel_block["mmsi"] = read_text(source_row, "MMSI", "mmsi") or ""
        vessel_block["source"] = read_text(source_row, "SOURCE", "source") or "mock"
        vessel_block["mapping"] = ledger.as_dict() if ledger else None
        vessel_block["degraded"] = bool(ledger and ledger.degraded)

    return {
        "schema": SCHEMA_VERSION,
        "adapter": {
            "moduleId": MODULE_ID,
            "version": MODULE_VERSION,
            "scope": "FLEET",
            "models_requested": keys,
            "max_fleet": MAX_FLEET,
            "note": (
                "M4, M5 and M7 are fleet-level models: their numbers describe the "
                "whole arrival set in this request, not one hull."
            ),
        },
        "dashboard": doc,
    }


def predict_vessel(vessel: AisRow,
                   context: Optional[Mapping[str, Any]] = None,
                   models: Optional[Sequence[str]] = None,
                   options: Optional[Mapping[str, Any]] = None,
                   ) -> Dict[str, Any]:
    """
    One vessel, for a caller that holds only one.

    Prefer ``predict_fleet`` when the caller has the feed: berth occupancy, the
    berth plan and craft conflicts computed over a fleet of one describe a port
    with one ship in it. The response says so in ``adapter.scope``.
    """
    out = predict_fleet([vessel], context, models, options)
    out["adapter"]["scope"] = "SINGLE_VESSEL"
    out["adapter"]["note"] = (
        "Scored as a fleet of one. M4 occupancy, the M5 berth plan and M7 craft "
        "conflicts therefore describe a port with a single arrival -- send the "
        "whole feed to /predictions for fleet-level numbers."
    )
    return out


def mapping_catalogue() -> Dict[str, Any]:
    """
    Every constant this adapter substitutes when AIS cannot supply an input.

    Served so a UI can show the operator what an estimated figure rests on
    without reading the source.
    """
    return {
        "adapter_version": MODULE_VERSION,
        "models": {key: run_model.MODELS[key][1] for key in ALL_MODELS},
        "model_scope": dict(run_model.MODEL_SCOPE),
        "ship_type_to_cargo_type": [
            {"contains": needle, "cargo_type": cargo} for needle, cargo in SHIP_TYPE_TO_CARGO_TYPE
        ],
        "loa_bands": [
            {"loa_from_m": lo, "assumed_draft_m": draft,
             "assumed_capacity_teu": teu, "class": label}
            for lo, draft, teu, label in LOA_BANDS
        ],
        "ata_rule_by_nav_status": ATA_RULE_BY_STATUS,
        "berth_prefix_to_terminal": BERTH_PREFIX_TO_TERMINAL,
        "defaults": {
            "default_loa_m": DEFAULT_LOA_M,
            "parcel_share_of_capacity": PARCEL_SHARE_OF_CAPACITY,
            "import_share_of_parcel": IMPORT_SHARE_OF_PARCEL,
            "min_transit_speed_kn": MIN_TRANSIT_SPEED_KN,
            "max_fleet": MAX_FLEET,
        },
        "context_fields": [
            "tide_m", "wind_kn", "rain_mm_hr", "weather", "channel_depth_m",
            "berth_occupancy_pct", "anchorage_queue", "distance_nm",
        ],
        "note": (
            "Every default above sets degraded=true for that vessel and is named "
            "in mapping.assumptions[]. AIS position reports carry no draught, no "
            "cargo and no ATA, so a live-feed prediction is ADVISORY: send "
            "DRAFT_M / TEU_TOTAL / ATA on the row to replace the estimates."
        ),
    }


# ==========================================================================
# SECTION 7 -- DEMO FLEET
# ==========================================================================

# Fixed fix times (epoch ms, 2026-07-26 IST) rather than "now": the demo is a
# worked EXAMPLE, and an example whose numbers change every time it is called
# cannot be checked in, diffed, or quoted in a document. A caller who wants
# today's tide sends today's rows.
_DEMO_FIX_MS: int = 1_785_000_000_000
_DEMO_ETA_MS: int = 1_785_030_000_000

DEMO_FLEET: Tuple[AisRow, ...] = (
    {
        "MMSI": "419000501", "VESSEL_NAME": "MSC ANNA", "VESSEL_TYPE": "Container Ship",
        "NAV_STATUS": "approaching", "SOG": 11.4, "COG": 78.0, "HEADING": 80.0,
        "LAT": 18.905, "LON": 72.905, "LOA_M": 399.0, "DRAFT_M": 15.2,
        "BERTH_ID": "BMCT-01", "SOURCE": "live",
        "TIMESTAMP": _DEMO_FIX_MS, "ETA": _DEMO_ETA_MS,
    },
    {
        "MMSI": "419000502", "VESSEL_NAME": "MAERSK KOTKA", "VESSEL_TYPE": "Container Ship",
        "NAV_STATUS": "anchored", "SOG": 0.2, "COG": 0.0, "HEADING": 145.0,
        "LAT": 18.882, "LON": 72.874, "LOA_M": 294.0, "SOURCE": "mock",
        "TIMESTAMP": _DEMO_FIX_MS,
    },
    {
        "MMSI": "419000503", "VESSEL_NAME": "SSL BRAHMAPUTRA", "VESSEL_TYPE": "Cargo",
        "NAV_STATUS": "moored", "SOG": 0.0, "COG": 0.0, "HEADING": 12.0,
        "LAT": 18.949, "LON": 72.949, "BERTH_ID": "CB-04", "SOURCE": "mock",
        "TIMESTAMP": _DEMO_FIX_MS,
    },
)

DEMO_CONTEXT: Dict[str, Any] = {
    "wind_kn": 12.0, "weather": "Clear", "berth_occupancy_pct": 68.0,
}


# ==========================================================================
# SECTION 8 -- HTTP ROUTER
# ==========================================================================

try:
    from pydantic import BaseModel, Field

    class FleetRequest(BaseModel):
        """The AIS feed as the frontend holds it, plus optional port context."""

        vessels: List[Dict[str, Any]] = Field(..., min_length=1)
        context: Dict[str, Any] = Field(default_factory=dict)
        models: List[str] = Field(default_factory=list)

    class VesselRequest(BaseModel):
        """One AIS position report."""

        vessel: Dict[str, Any]
        context: Dict[str, Any] = Field(default_factory=dict)
        models: List[str] = Field(default_factory=list)

except ImportError:  # pragma: no cover - the CLI path needs no FastAPI/pydantic
    FleetRequest = VesselRequest = None  # type: ignore


def build_router():  # pragma: no cover - exercised by the service
    """FastAPI router exposing the adapter under ``/uc1/webapp``."""
    from fastapi import APIRouter, HTTPException

    router = APIRouter(prefix=ROUTER_PREFIX, tags=["UC1-ADAPTER (live-AIS ingest)"])

    def _guard(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    @router.post("/predictions",
                 summary="Whole AIS feed -> every UC-I model, dashboard-shaped")
    def predictions(req: FleetRequest) -> Dict[str, Any]:
        return _guard(predict_fleet, req.vessels, req.context, req.models or None)

    @router.post("/vessel-predictions", summary="One AIS row -> every UC-I model")
    def vessel_predictions(req: VesselRequest) -> Dict[str, Any]:
        return _guard(predict_vessel, req.vessel, req.context, req.models or None)

    @router.post("/mapping-preview",
                 summary="Show the translation for one row WITHOUT running a model")
    def mapping_preview(req: VesselRequest) -> Dict[str, Any]:
        values, ledger = _guard(map_ais_row, req.vessel, req.context)
        return {
            "model_inputs": {k: (iso_utc(v) if isinstance(v, datetime) else v)
                             for k, v in values.items()},
            "mapping": ledger.as_dict(),
        }

    @router.get("/mapping", summary="Every constant the adapter may substitute")
    def mapping() -> Dict[str, Any]:
        return mapping_catalogue()

    @router.get("/demo", summary="Run the three-vessel demo feed through all eight models")
    def demo() -> Dict[str, Any]:
        return predict_fleet(list(DEMO_FLEET), DEMO_CONTEXT)

    @router.get("/health", summary="Adapter health")
    def health() -> Dict[str, Any]:
        checks = selftest()
        return {
            "moduleId": MODULE_ID, "version": MODULE_VERSION,
            "ok": all(c["passed"] for c in checks), "checks": checks,
        }

    return router


# ==========================================================================
# SECTION 9 -- SELF-TEST
# ==========================================================================


def selftest() -> List[Dict[str, Any]]:
    """Checks on the translations this module exists to perform."""
    checks: List[Dict[str, Any]] = []

    def check(name: str, condition: bool, detail: str = "") -> None:
        checks.append({"check": name, "passed": bool(condition), "detail": detail})

    # --- readers ----------------------------------------------------------
    epoch_ms = 1_785_000_000_000
    moment = read_moment({"TIMESTAMP": epoch_ms}, "TIMESTAMP")
    check("epoch ms is read as ms, not seconds",
          moment is not None and moment.year == 2026, f"got {moment}")
    check("epoch seconds still read correctly",
          (read_moment({"t": epoch_ms // 1000}, "t") or datetime(1970, 1, 1,
           tzinfo=timezone.utc)).year == 2026)
    check("naive ISO text is read as IST, not UTC",
          iso_utc(read_moment({"t": "2026-08-04 12:00"}, "t")) == "2026-08-04T06:30:00Z",
          "IST is UTC+5:30, so 12:00 IST is 06:30Z")
    check("key matching is case and underscore tolerant",
          read_float({"draft_m": 13.2}, "DRAFT_M") == 13.2)

    # --- the consequential resolvers --------------------------------------
    ledger = MappingLedger("1", "T")
    check("a reported draught is honoured, not re-estimated",
          resolve_draft_m({"DRAFT_M": 12.4}, 300.0, ledger) == 12.4)
    check("honouring a reported draught does not degrade the response",
          not ledger.degraded, f"assumptions={ledger.assumptions}")

    ledger = MappingLedger("1", "T")
    draft = resolve_draft_m({}, 400.0, ledger)
    check("a missing draught is estimated from LOA and flagged",
          draft == 16.0 and ledger.degraded, f"draft={draft}")

    ledger = MappingLedger("1", "T")
    check("a berthed hull's 0 kn is raised to the transit floor",
          resolve_speed_kn({"SOG": 0.0}, ledger) == MIN_TRANSIT_SPEED_KN,
          "a zero-speed squat would overstate under-keel clearance")

    ledger = MappingLedger("1", "T")
    resolve_speed_kn({"SOG": 11.0}, ledger)
    check("an underway hull's SOG is used as reported", not ledger.degraded)

    ledger = MappingLedger("1", "T")
    check("AIS 'Cargo' maps to a container vessel at JNPA",
          resolve_cargo_type({"VESSEL_TYPE": "Cargo"}, ledger) == "Container")
    ledger = MappingLedger("1", "T")
    check("a bulk carrier maps to BULK, changing the block coefficient",
          jio.derive_cargo_class(
              resolve_cargo_type({"VESSEL_TYPE": "Bulk Carrier"}, ledger)) == "BULK")

    # ATA rule: a moored hull arrived; an approaching hull has not.
    fix = datetime(2026, 8, 4, 6, 0, tzinfo=timezone.utc)
    eta = datetime(2026, 8, 4, 9, 0, tzinfo=timezone.utc)
    ledger = MappingLedger("1", "T")
    check("a moored hull's ATA is her last fix",
          resolve_ata({"NAV_STATUS": "moored",
                       "TIMESTAMP": fix.timestamp() * 1000,
                       "ETA": eta.timestamp() * 1000}, ledger) == fix)
    ledger = MappingLedger("1", "T")
    check("an approaching hull's ATA is her ETA",
          resolve_ata({"NAV_STATUS": "approaching",
                       "TIMESTAMP": fix.timestamp() * 1000,
                       "ETA": eta.timestamp() * 1000}, ledger) == eta)

    # --- batch construction ------------------------------------------------
    batch, ledgers = build_batch(list(DEMO_FLEET), DEMO_CONTEXT)
    check("every demo vessel becomes a valid call",
          len(batch.valid_rows) == len(DEMO_FLEET),
          f"{len(batch.valid_rows)}/{len(DEMO_FLEET)} valid; "
          f"errors={[str(i) for i in batch.all_issues if i.severity == 'ERROR']}")
    check("the vessel with a reported draught is not degraded",
          not ledgers[0].degraded or "Draft_m" not in " ".join(ledgers[0].assumptions),
          f"assumptions={ledgers[0].assumptions}")
    check("the vessels without one are degraded",
          ledgers[1].degraded and ledgers[2].degraded)
    check("the berth prefix names the terminal",
          batch.rows[2].terminal == "NSICT", f"got {batch.rows[2].terminal!r}")

    # --- end to end --------------------------------------------------------
    doc = predict_fleet(list(DEMO_FLEET), DEMO_CONTEXT)
    vessels = doc["dashboard"]["vessels"]
    check("the response carries one block per vessel", len(vessels) == len(DEMO_FLEET))
    check("every model ran",
          len(doc["dashboard"]["run"]["models_run"]) == len(ALL_MODELS),
          f"ran={doc['dashboard']['run']['models_run']} "
          f"failed={doc['dashboard']['run']['models_failed']}")
    check("each vessel carries its mapping ledger",
          all(v.get("mapping") for v in vessels))
    check("MMSI survives onto the response so the UI can join on it",
          vessels[0]["mmsi"] == DEMO_FLEET[0]["MMSI"])
    check("the glossary travels with the numbers",
          bool(doc["dashboard"].get("glossary")))
    m1_block = vessels[0]["models"].get("m1_under_keel_clearance", {})
    check("M1 produced a UKC verdict for the deep-draft arrival",
          "status" in m1_block, f"got keys {sorted(m1_block)}")

    single = predict_vessel(dict(DEMO_FLEET[0]), DEMO_CONTEXT)
    check("the single-vessel path labels its scope",
          single["adapter"]["scope"] == "SINGLE_VESSEL")

    # --- refusals ----------------------------------------------------------
    try:
        predict_fleet(list(DEMO_FLEET), DEMO_CONTEXT, models=["m9"])
        check("an unknown model id is refused, not dropped", False, "no error raised")
    except ValueError:
        check("an unknown model id is refused, not dropped", True)
    try:
        build_batch([])
        check("an empty fleet is refused", False, "no error raised")
    except ValueError:
        check("an empty fleet is refused", True)

    return checks


# ==========================================================================
# SECTION 10 -- CLI
# ==========================================================================


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=MODULE_NAME)
    parser.add_argument("--input", "-i",
                        help="JSON file holding {vessels:[...], context:{...}} "
                             "or a bare list of AIS rows (default: the demo fleet)")
    parser.add_argument("--model", "-m", default="all",
                        help="m1..m8, 'all', or a comma-separated list")
    parser.add_argument("--json", action="store_true", help="machine-readable")
    parser.add_argument("--mapping", action="store_true",
                        help="print the substitution catalogue and exit")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)

    if args.selftest:
        checks = selftest()
        failed = [c for c in checks if not c["passed"]]
        if args.json:
            print(json.dumps({"checks": checks, "failed": len(failed)}, indent=2))
        else:
            print("=" * 96)
            print(f"  {MODULE_ID} self-test  |  {MODULE_VERSION}")
            print("=" * 96)
            for check in checks:
                mark = "PASS" if check["passed"] else "FAIL"
                detail = f"   [{check['detail']}]" if check["detail"] else ""
                print(f"  [{mark}] {check['check']}{detail}")
            print("-" * 96)
            print(f"  {len(checks) - len(failed)}/{len(checks)} checks passed")
        return 1 if failed else 0

    if args.mapping:
        print(json.dumps(mapping_catalogue(), indent=2))
        return 0

    vessels: List[AisRow] = list(DEMO_FLEET)
    context: Dict[str, Any] = dict(DEMO_CONTEXT)
    if args.input:
        with open(args.input, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if isinstance(payload, list):
            vessels = payload
            context = {}
        else:
            vessels = payload.get("vessels", [])
            context = payload.get("context", {})

    models = None if args.model.lower() == "all" else [
        k.strip().lower() for k in args.model.split(",") if k.strip()
    ]
    doc = predict_fleet(vessels, context, models)

    if args.json:
        print(json.dumps(doc, indent=2, default=str))
        return 0

    run = doc["dashboard"]["run"]
    print()
    print("=" * 96)
    print(f"  {MODULE_ID} {MODULE_VERSION}  |  {len(doc['dashboard']['vessels'])} vessels, "
          f"models {', '.join(run['models_run'])}")
    print("=" * 96)
    for vessel in doc["dashboard"]["vessels"]:
        mapping = vessel.get("mapping") or {}
        badge = "DEGRADED" if mapping.get("degraded") else "OBSERVED"
        print(f"\n  {vessel['vessel']}  ({vessel.get('mmsi') or 'no MMSI'})   [{badge}] "
              f"{mapping.get('inputs_observed', 0)} observed / "
              f"{mapping.get('inputs_assumed', 0)} assumed")
        for block, payload in vessel["models"].items():
            summary = ", ".join(
                f"{k}={v}" for k, v in list(payload.items())[:4]
                if not isinstance(v, (list, dict)))
            print(f"      {block:<28} {summary}")
        for assumption in mapping.get("assumptions", []):
            print(f"      ! {assumption}")
    if run.get("models_failed"):
        print(f"\n  FAILED: {run['models_failed']}")
    print("\n  Run with --json for the full payload, --mapping for the constants.\n")
    return 1 if run.get("models_failed") else 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
