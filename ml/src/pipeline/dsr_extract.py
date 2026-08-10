"""
dsr_extract — Real-Data Extractor for JNPA Daily Status Reports, section (H)
=============================================================================

Jawaharlal Nehru Port Authority (JNPA) — Workstream 2, UC-I supporting tool.
Tender ref GeM/2026/B/7297343.

WHAT THIS EXTRACTS AND WHY IT IS THE ONE SOURCE WORTH PARSING
---------------------------------------------------------------
The shared corpus is almost entirely PDF. Most of it is layout-heterogeneous:
five terminals publish five different berthing-report formats, and the tide
tables sit in free-text headers. Section (H) of the Daily Status Report is the
exception — it is ONE ruled table with the SAME seven columns in all 54 reports:

    Terminal | Berth No | Via No | Vessel Name | Cargo-Commodity |
    Berthed on | Expected Completion

That yields roughly a thousand real berth-stay intervals, which is the only
real, tabular, machine-readable ground truth in the UC-I corpus. It feeds:

    UC1-M3  real berth-stay distribution, to re-anchor the TAT generator
    UC1-M4  real occupancy intervals and the real berth roster
    UC1-M5  the real 20-berth JNPA berth list

WHAT IT CANNOT GIVE — stated plainly
-------------------------------------
The report prints "Berthed on" and "Expected Completion". It does NOT print
ATA. Therefore:

  * berth stay (ATB -> ATD)      IS derivable and is what this tool emits.
  * waiting time (ATB - ATA)     IS NOT derivable from this source.
  * full TAT (ATA -> ATD)        IS NOT derivable from this source.

Waiting and TAT need a true ATA, which lives in the PCS VESARR/VESDEP logs
joined on VCN. Do not let a downstream module quietly treat berth stay as TAT.

"Expected Completion" is also a FORECAST, not an actual. It is the terminal's
own estimate at the time of publication. Rows carry ``completion_is_forecast``
so no consumer mistakes it for a recorded departure.

EXTRACTION NOTES THAT MATTER
-----------------------------
* Use ``page.extract_tables()``, NOT raw text. The text layer collapses
  ``25-05-2026 16:48`` to ``25-05-2026 1`` — the time is lost. The ruled table
  is intact.
* Timestamps are IST (UTC+05:30, no DST) and are converted to UTC here, once,
  so no downstream module has to think about it.
* Blank vessel rows (CB01, BMCT-05, LB-02 ...) are NOT noise. They are vacant
  berths, and an occupancy calculation that drops them loses its denominator.
  They are emitted with ``occupied=False``.
* A stay crossing midnight or month-end is normal. A "completion" earlier than
  "berthed on" is not, and is rejected with a reason.

USAGE
-----
    pip install pdfplumber
    python run.py dsr                          # writes data/reference/dsr_berth_stays.csv
    python run.py dsr --emit-berths data/reference/berths.json
    python run.py dsr --summary                # no files written
    python run.py dsr --limit 5 --verbose

Then simply re-run the models — they pick the CSV up automatically:

    python src/uc1_models/uc1_m4_berth_utilisation.py
    python src/uc1_models/uc1_m3_tat_predict.py
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import jnpa_paths

MODULE_ID: str = "dsr-extract"
MODULE_VERSION: str = "dsr-extract-v1.0.0"

# JNPA reports in Indian Standard Time. India has no daylight saving, so a
# fixed offset is exact rather than an approximation.
IST_OFFSET_HOURS: float = 5.5

DEFAULT_CORPUS = jnpa_paths.DSR_REPORTS_DIR
DEFAULT_OUT_CSV = jnpa_paths.DSR_BERTH_STAYS_CSV

# The seven columns of section (H), normalised for matching.
EXPECTED_HEADER = (
    "terminal", "berth no", "via no", "vessel name",
    "cargo-commodity", "berthed on", "expected completion",
)
HEADER_MIN_MATCHES = 5          # tolerate minor OCR/spacing drift in two cells

MAX_PLAUSIBLE_STAY_H = 240.0    # 10 days alongside is a data-entry error
TS_FORMATS = ("%d-%m-%Y %H:%M", "%d/%m/%Y %H:%M", "%d-%m-%Y %H:%M:%S")

CSV_COLUMNS = (
    "report_date", "terminal", "berth_id", "berth_id_raw", "sub_berth",
    "via_no", "vessel_name", "cargo",
    "berthed_on_ist", "berthed_on_utc", "expected_completion_ist",
    "expected_completion_utc", "berth_stay_hours", "occupied",
    "completion_is_forecast", "source_pdf",
)


@dataclass(frozen=True)
class BerthStayRow:
    """One row of section (H): a berth, occupied or vacant."""

    report_date: str
    terminal: str
    berth_id: str                # canonical, after normalise_berth_id()
    berth_id_raw: str            # exactly as printed, so the mapping is auditable
    sub_berth: str               # NORTH / SOUTH / '' when the berth was split
    via_no: str
    vessel_name: str
    cargo: str
    berthed_on_ist: Optional[str]
    berthed_on_utc: Optional[str]
    expected_completion_ist: Optional[str]
    expected_completion_utc: Optional[str]
    berth_stay_hours: Optional[float]
    occupied: bool
    completion_is_forecast: bool
    source_pdf: str

    def as_csv_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["berth_stay_hours"] = (
            "" if self.berth_stay_hours is None else f"{self.berth_stay_hours:.4f}"
        )
        for k in ("berthed_on_ist", "berthed_on_utc",
                  "expected_completion_ist", "expected_completion_utc"):
            d[k] = d[k] or ""
        return d


@dataclass(frozen=True)
class ExtractionReport:
    """What the run found, and what it refused."""

    pdfs_scanned: int
    pdfs_with_section_h: int
    rows_emitted: int
    occupied_rows: int
    vacant_rows: int
    rows_rejected: int
    reject_reasons: Dict[str, int]
    berths_seen: List[str]
    terminals_seen: List[str]
    date_range: Tuple[Optional[str], Optional[str]]
    stay_hours_p10: Optional[float]
    stay_hours_p50: Optional[float]
    stay_hours_p90: Optional[float]
    stay_hours_mean: Optional[float]
    failures: List[Dict[str, str]]

    def as_dict(self) -> Dict[str, Any]:
        return {
            "module": MODULE_VERSION,
            "pdfs_scanned": self.pdfs_scanned,
            "pdfs_with_section_h": self.pdfs_with_section_h,
            "rows_emitted": self.rows_emitted,
            "occupied_rows": self.occupied_rows,
            "vacant_rows": self.vacant_rows,
            "rows_rejected": self.rows_rejected,
            "reject_reasons": dict(self.reject_reasons),
            "berth_count": len(self.berths_seen),
            "berths_seen": self.berths_seen,
            "terminals_seen": self.terminals_seen,
            "date_range": list(self.date_range),
            "berth_stay_hours": {
                "p10": self.stay_hours_p10,
                "p50": self.stay_hours_p50,
                "p90": self.stay_hours_p90,
                "mean": self.stay_hours_mean,
            },
            "failures": self.failures,
            "caveats": [
                "Berth stay is ATB -> expected ATD. This source has no ATA, so waiting "
                "time and full TAT are NOT derivable from it.",
                "'Expected Completion' is the terminal's forecast at publication time, "
                "not a recorded departure — see completion_is_forecast.",
                "Vacant berth rows are retained (occupied=False); an occupancy "
                "denominator needs them.",
            ],
        }


# --------------------------------------------------------------------------
# Optional dependency, guarded the same way the model modules guard theirs.
# --------------------------------------------------------------------------
_HAS_PDFPLUMBER = False
_PDFPLUMBER_ERROR = ""
try:
    import pdfplumber  # noqa: E402

    _HAS_PDFPLUMBER = True
except Exception as _exc:  # pragma: no cover
    pdfplumber = None  # type: ignore
    _PDFPLUMBER_ERROR = repr(_exc)[:200]


def _percentile(values: Sequence[float], q: float) -> Optional[float]:
    """Linear-interpolation percentile; None on an empty sample."""
    if not values:
        return None
    xs = sorted(values)
    if len(xs) == 1:
        return xs[0]
    pos = max(0.0, min(1.0, q)) * (len(xs) - 1)
    lo, hi = int(pos), min(int(pos) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def _norm(s: Optional[str]) -> str:
    """Collapse whitespace and lowercase, for header matching."""
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


def _clean(s: Optional[str]) -> str:
    """Tidy a cell: collapse internal whitespace, strip."""
    return re.sub(r"\s+", " ", (s or "").replace("\n", " ")).strip()


def _parse_ist(raw: Optional[str]) -> Optional[datetime]:
    """
    Parse an IST timestamp from the report and return it as tz-aware UTC.

    The corpus uses ``DD-MM-YYYY HH:MM``; the slash variant and a seconds
    variant are accepted defensively because sibling JNPA exports use them.
    """
    text = _clean(raw)
    if not text:
        return None
    for fmt in TS_FORMATS:
        try:
            naive = datetime.strptime(text, fmt)
        except ValueError:
            continue
        ist = naive.replace(tzinfo=timezone(timedelta(hours=IST_OFFSET_HOURS)))
        return ist.astimezone(timezone.utc)
    return None


def _iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# Berth-id normalisation.
#
# The 54 reports do NOT name berths consistently. Observed in the raw corpus:
#
#     BMCT-01  and  BMCT01            same physical berth, hyphen dropped
#     BMCT-03 (NORTH) / (SOUTH)       one berth worked as two sub-berths
#     LB-01 [NORTH]  / [SOUTH]        same, square brackets
#     "0.0"                            a stray numeric cell, not a berth
#
# Left alone this inflates the roster from ~20 physical berths to 32 and halves
# the apparent occupancy of every affected berth, because M4 keys on berth_id.
# Both the raw string and the canonical id are emitted so the normalisation is
# auditable rather than silent.
# --------------------------------------------------------------------------

_SUBBERTH_RE = re.compile(r"\s*[\(\[]\s*(NORTH|SOUTH|EAST|WEST|N|S|E|W)\s*[\)\]]\s*$", re.I)
_TERMINAL_PREFIX_RE = re.compile(r"^([A-Z]{2,6})[-\s]?(\d{1,2})$", re.I)


def normalise_berth_id(raw: str) -> Tuple[str, str, bool]:
    """
    Canonicalise a berth id.

    Returns ``(canonical_id, sub_berth, is_valid)``:

        "BMCT01"          -> ("BMCT-01", "",      True)
        "BMCT-03 (NORTH)" -> ("BMCT-03", "NORTH", True)
        "LB-01 [SOUTH]"   -> ("LB-01",   "SOUTH", True)
        "CB-06"           -> ("CB-06",   "",      True)
        "0.0"             -> ("0.0",     "",      False)

    ``is_valid`` is False for cells that are not berth identifiers at all; those
    rows are rejected with a reason rather than polluting the roster.
    """
    text = _clean(raw).upper()
    if not text:
        return "", "", False

    # A bare number, or anything with no letters, is not a berth id.
    if not re.search(r"[A-Z]", text):
        return text, "", False

    sub = ""
    m = _SUBBERTH_RE.search(text)
    if m:
        sub = m.group(1).upper()
        sub = {"N": "NORTH", "S": "SOUTH", "E": "EAST", "W": "WEST"}.get(sub, sub)
        text = _SUBBERTH_RE.sub("", text).strip()

    # Insert the hyphen the corpus sometimes omits: BMCT01 -> BMCT-01.
    m = _TERMINAL_PREFIX_RE.match(text)
    if m:
        prefix, number = m.group(1).upper(), m.group(2)
        text = f"{prefix}-{int(number):02d}"

    # CCB-N / CCB-S are genuinely distinct berths, not sub-berths; leave them.
    return text, sub, True


def _report_date_from_name(path: str) -> str:
    """
    Recover the report date from the filename.

    Two naming conventions exist in the corpus:
        Daily_Status_Report_26-05-2026.pdf
        Daily Status Report 01.02.2026.pdf
    """
    name = os.path.basename(path)
    m = re.search(r"(\d{2})[-._](\d{2})[-._](\d{4})", name)
    if m:
        d, mo, y = m.groups()
        return f"{y}-{mo}-{d}"
    return ""


def _is_section_h_header(row: Sequence[Optional[str]]) -> bool:
    """Does this row look like the section (H) header?"""
    cells = [_norm(c) for c in row]
    return sum(1 for want in EXPECTED_HEADER if want in cells) >= HEADER_MIN_MATCHES


def find_section_h_table(pdf: Any) -> Optional[List[List[Optional[str]]]]:
    """
    Locate section (H) anywhere in the document.

    It is on page 3 in every report seen so far, but the search is over all
    pages so a re-paginated report does not silently yield nothing.
    """
    for page in pdf.pages:
        try:
            tables = page.extract_tables()
        except Exception:      # a malformed page must not kill the run
            continue
        for table in tables:
            if table and _is_section_h_header(table[0]):
                return table
    return None


def parse_pdf(path: str) -> Tuple[List[BerthStayRow], List[Dict[str, str]]]:
    """
    Extract section (H) from one report.

    Returns ``(rows, rejects)``. Rejects carry a reason so a data-quality
    report can show what was refused rather than silently shrinking n.
    """
    if not _HAS_PDFPLUMBER:
        raise RuntimeError(
            f"pdfplumber is required. Install with: pip install pdfplumber "
            f"({_PDFPLUMBER_ERROR or 'not installed'})"
        )

    rows: List[BerthStayRow] = []
    rejects: List[Dict[str, str]] = []
    report_date = _report_date_from_name(path)
    src = os.path.basename(path)

    with pdfplumber.open(path) as pdf:
        table = find_section_h_table(pdf)
        if table is None:
            rejects.append({"source_pdf": src, "reason": "section_h_table_not_found"})
            return rows, rejects

        for raw in table[1:]:
            cells = [_clean(c) for c in raw] + [""] * (7 - len(raw))
            terminal, berth, via, vessel, cargo, berthed_raw, completion_raw = cells[:7]

            if not terminal and not berth:
                continue                       # spacer row
            if _norm(terminal) == "terminal":
                continue                       # repeated header on a page break

            canonical, sub_berth, berth_ok = normalise_berth_id(berth)
            if not berth_ok:
                rejects.append({
                    "source_pdf": src, "berth_id": berth, "vessel_name": vessel,
                    "reason": "not_a_berth_identifier", "raw": berth,
                })
                continue

            occupied = bool(via or vessel or berthed_raw)
            if not occupied:
                # A vacant berth. Retained deliberately: occupancy needs the
                # denominator, and a berth that appears only when busy would
                # bias utilisation upward.
                rows.append(
                    BerthStayRow(
                        report_date=report_date, terminal=terminal,
                        berth_id=canonical, berth_id_raw=berth, sub_berth=sub_berth,
                        via_no="", vessel_name="", cargo="",
                        berthed_on_ist=None, berthed_on_utc=None,
                        expected_completion_ist=None, expected_completion_utc=None,
                        berth_stay_hours=None, occupied=False,
                        completion_is_forecast=False, source_pdf=src,
                    )
                )
                continue

            berthed = _parse_ist(berthed_raw)
            completion = _parse_ist(completion_raw)

            if berthed is None:
                rejects.append({
                    "source_pdf": src, "berth_id": berth, "vessel_name": vessel,
                    "reason": "unparseable_berthed_on", "raw": berthed_raw,
                })
                continue

            stay: Optional[float] = None
            if completion is not None:
                stay = (completion - berthed).total_seconds() / 3600.0
                if stay <= 0.0:
                    rejects.append({
                        "source_pdf": src, "berth_id": berth, "vessel_name": vessel,
                        "reason": "completion_not_after_berthing",
                        "raw": f"{berthed_raw} -> {completion_raw}",
                    })
                    continue
                if stay > MAX_PLAUSIBLE_STAY_H:
                    rejects.append({
                        "source_pdf": src, "berth_id": berth, "vessel_name": vessel,
                        "reason": "stay_exceeds_plausible_limit",
                        "raw": f"{stay:.1f} h",
                    })
                    continue

            rows.append(
                BerthStayRow(
                    report_date=report_date,
                    terminal=terminal,
                    berth_id=canonical,
                    berth_id_raw=berth,
                    sub_berth=sub_berth,
                    via_no=via,
                    vessel_name=vessel,
                    cargo=cargo,
                    berthed_on_ist=_clean(berthed_raw),
                    berthed_on_utc=_iso(berthed),
                    expected_completion_ist=_clean(completion_raw) or None,
                    expected_completion_utc=_iso(completion),
                    berth_stay_hours=stay,
                    occupied=True,
                    completion_is_forecast=completion is not None,
                    source_pdf=src,
                )
            )

    return rows, rejects


def discover_pdfs(corpus_dir: str = DEFAULT_CORPUS) -> List[str]:
    """All Daily Status Report PDFs, deduplicated and sorted."""
    if not os.path.isdir(corpus_dir):
        return []
    found = set(glob.glob(os.path.join(corpus_dir, "**", "*.pdf"), recursive=True))
    # The corpus carries a __MACOSX resource-fork mirror; exclude it.
    return sorted(
        p for p in found
        if "__MACOSX" not in p and not os.path.basename(p).startswith("._")
    )


def extract_all(
    corpus_dir: str = DEFAULT_CORPUS,
    limit: Optional[int] = None,
    verbose: bool = False,
) -> Tuple[List[BerthStayRow], ExtractionReport]:
    """Run the extractor across the corpus and build the data-quality report."""
    pdfs = discover_pdfs(corpus_dir)
    if limit:
        pdfs = pdfs[:limit]

    all_rows: List[BerthStayRow] = []
    all_rejects: List[Dict[str, str]] = []
    failures: List[Dict[str, str]] = []
    with_section = 0

    for i, path in enumerate(pdfs, 1):
        try:
            rows, rejects = parse_pdf(path)
        except Exception as exc:            # one bad PDF must not stop the run
            failures.append({"source_pdf": os.path.basename(path), "error": repr(exc)[:200]})
            if verbose:
                print(f"  [{i:3d}/{len(pdfs)}] FAILED {os.path.basename(path)}: {exc}")
            continue
        if rows or not any(r.get("reason") == "section_h_table_not_found" for r in rejects):
            with_section += 1
        all_rows.extend(rows)
        all_rejects.extend(rejects)
        if verbose:
            occ = sum(1 for r in rows if r.occupied)
            print(
                f"  [{i:3d}/{len(pdfs)}] {os.path.basename(path):<45} "
                f"{len(rows):3d} rows ({occ} occupied), {len(rejects)} rejected"
            )

    stays = [r.berth_stay_hours for r in all_rows if r.berth_stay_hours is not None]
    dates = sorted({r.report_date for r in all_rows if r.report_date})

    report = ExtractionReport(
        pdfs_scanned=len(pdfs),
        pdfs_with_section_h=with_section,
        rows_emitted=len(all_rows),
        occupied_rows=sum(1 for r in all_rows if r.occupied),
        vacant_rows=sum(1 for r in all_rows if not r.occupied),
        rows_rejected=len(all_rejects),
        reject_reasons=dict(Counter(r.get("reason", "unknown") for r in all_rejects)),
        berths_seen=sorted({r.berth_id for r in all_rows if r.berth_id}),
        terminals_seen=sorted({r.terminal for r in all_rows if r.terminal}),
        date_range=(dates[0] if dates else None, dates[-1] if dates else None),
        stay_hours_p10=_percentile(stays, 0.10),
        stay_hours_p50=_percentile(stays, 0.50),
        stay_hours_p90=_percentile(stays, 0.90),
        stay_hours_mean=(sum(stays) / len(stays)) if stays else None,
        failures=failures,
    )
    return all_rows, report


def write_csv(rows: Sequence[BerthStayRow], path: str = DEFAULT_OUT_CSV) -> None:
    """Write the tidy CSV the model modules read."""
    with open(path, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=list(CSV_COLUMNS))
        w.writeheader()
        for r in rows:
            w.writerow(r.as_csv_dict())


def berth_roster(rows: Sequence[BerthStayRow]) -> List[Dict[str, Any]]:
    """
    Derive the real JNPA berth roster from the reports.

    Every berth that ever appears in section (H) is a real berth, whether or not
    it was occupied on a given day. Length and depth are NOT in this source and
    are left null — UC1-M4 and UC1-M5 carry operational planning figures.
    """
    seen: Dict[str, Dict[str, Any]] = {}
    for r in rows:
        if not r.berth_id:
            continue
        entry = seen.setdefault(r.berth_id, {
            "berth_id": r.berth_id,
            "terminal": r.terminal,
            "length_m": None,
            "max_draft_m": None,
            "appearances": 0,
            "occupied_appearances": 0,
            "cargo_types": set(),
            "raw_spellings": set(),
            "sub_berths": set(),
            "source": "JNPA Daily Status Report section (H)",
        })
        entry["appearances"] += 1
        entry["raw_spellings"].add(r.berth_id_raw)
        if r.sub_berth:
            entry["sub_berths"].add(r.sub_berth)
        if r.occupied:
            entry["occupied_appearances"] += 1
            if r.cargo:
                entry["cargo_types"].add(r.cargo)
    out = []
    for e in seen.values():
        e["cargo_types"] = sorted(e["cargo_types"])
        e["raw_spellings"] = sorted(e["raw_spellings"])
        e["sub_berths"] = sorted(e["sub_berths"])
        e["utilisation_rate_pct"] = round(
            e["occupied_appearances"] / e["appearances"] * 100.0, 2
        ) if e["appearances"] else 0.0
        out.append(e)
    return sorted(out, key=lambda e: (e["terminal"], e["berth_id"]))


def _fmt_table(headers: Sequence[str], rows: Sequence[Sequence[Any]], indent: str = "  ") -> str:
    cols = [str(h) for h in headers]
    body = [[("" if c is None else str(c)) for c in r] for r in rows]
    widths = [len(c) for c in cols]
    for r in body:
        for i, c in enumerate(r):
            if i < len(widths):
                widths[i] = max(widths[i], len(c))
    line = indent + "  ".join(c.ljust(widths[i]) for i, c in enumerate(cols))
    rule = indent + "  ".join("-" * w for w in widths)
    return "\n".join([line, rule] + [
        indent + "  ".join(str(c).ljust(widths[i]) for i, c in enumerate(r)) for r in body
    ])


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Extract section (H) berth stays from JNPA Daily Status Reports."
    )
    parser.add_argument("--corpus", default=DEFAULT_CORPUS, help="Reports directory.")
    parser.add_argument("--out", default=DEFAULT_OUT_CSV, help="Output CSV path.")
    parser.add_argument("--emit-berths", help="Also write the derived berth roster as JSON.")
    parser.add_argument("--limit", type=int, help="Process only the first N PDFs.")
    parser.add_argument("--summary", action="store_true", help="Report only; write nothing.")
    parser.add_argument("--json", action="store_true", help="Emit the report as JSON.")
    parser.add_argument("--verbose", action="store_true", help="Per-file progress.")
    args = parser.parse_args(argv)

    print("=" * 78)
    print(f"{MODULE_ID} — JNPA Daily Status Report, section (H)   ({MODULE_VERSION})")
    print("=" * 78)

    if not _HAS_PDFPLUMBER:
        print(f"\nERROR: pdfplumber is not installed ({_PDFPLUMBER_ERROR}).")
        print("Install with:  pip install pdfplumber")
        return 2

    pdfs = discover_pdfs(args.corpus)
    if not pdfs:
        print(f"\nERROR: no PDFs found under {args.corpus!r}.")
        print("Check the path — note the corpus is DOUBLE-nested:")
        print(f"  {DEFAULT_CORPUS}")
        return 2

    print(f"\nCorpus: {args.corpus}")
    print(f"Found {len(pdfs)} PDF(s){f', processing first {args.limit}' if args.limit else ''}.\n")

    rows, report = extract_all(args.corpus, args.limit, args.verbose)

    if args.json:
        print(json.dumps(report.as_dict(), indent=2))
    else:
        print("\nEXTRACTION SUMMARY")
        print(_fmt_table(
            ["metric", "value"],
            [
                ["PDFs scanned", report.pdfs_scanned],
                ["PDFs with section (H)", report.pdfs_with_section_h],
                ["rows emitted", report.rows_emitted],
                ["  occupied", report.occupied_rows],
                ["  vacant (retained)", report.vacant_rows],
                ["rows rejected", report.rows_rejected],
                ["distinct berths", len(report.berths_seen)],
                ["distinct terminals", len(report.terminals_seen)],
                ["date range", " .. ".join(d or "?" for d in report.date_range)],
                ["read failures", len(report.failures)],
            ],
            indent="  ",
        ))

        if report.reject_reasons:
            print("\nREJECTED ROWS  (reported, not silently dropped)")
            print(_fmt_table(
                ["reason", "count"],
                sorted(report.reject_reasons.items(), key=lambda kv: -kv[1]),
                indent="  ",
            ))

        if report.stay_hours_p50 is not None:
            print("\nBERTH STAY DISTRIBUTION  (ATB -> expected completion)")
            print(_fmt_table(
                ["p10 h", "p50 h", "p90 h", "mean h", "n"],
                [[
                    f"{report.stay_hours_p10:.2f}", f"{report.stay_hours_p50:.2f}",
                    f"{report.stay_hours_p90:.2f}", f"{report.stay_hours_mean:.2f}",
                    sum(1 for r in rows if r.berth_stay_hours is not None),
                ]],
                indent="  ",
            ))
            print(
                f"  JNPA published reference for mean berth stay is 0.97 d = 23.28 h; "
                f"this corpus gives {report.stay_hours_mean:.2f} h."
            )

        roster = berth_roster(rows)
        merged = [b for b in roster if len(b["raw_spellings"]) > 1 or b["sub_berths"]]
        print(f"\nDERIVED BERTH ROSTER  ({len(roster)} berths after normalisation)")
        print(_fmt_table(
            ["berth", "terminal", "appear", "occupied", "util %", "raw spellings", "cargo"],
            [[
                b["berth_id"], b["terminal"], b["appearances"],
                b["occupied_appearances"], f"{b['utilisation_rate_pct']:.1f}",
                ", ".join(b["raw_spellings"]) if len(b["raw_spellings"]) > 1 else "-",
                ", ".join(b["cargo_types"][:2]) or "-",
            ] for b in roster],
            indent="  ",
        ))
        if merged:
            print(
                f"\n  NORMALISATION: {len(merged)} berth(s) had inconsistent spellings or "
                f"were worked as sub-berths in the source reports. Without merging them, "
                f"a berth would be double-counted and its occupancy halved:"
            )
            for b in merged:
                bits = ", ".join(b["raw_spellings"])
                subs = f" (sub-berths: {', '.join(b['sub_berths'])})" if b["sub_berths"] else ""
                print(f"    {b['berth_id']:<10} <- {bits}{subs}")

        print("\nCAVEATS")
        for c in report.as_dict()["caveats"]:
            print(f"  * {c}")

        if report.failures:
            print("\nREAD FAILURES")
            for f in report.failures[:10]:
                print(f"  {f['source_pdf']}: {f['error']}")

    if not args.summary:
        write_csv(rows, args.out)
        print(f"\nWROTE  {args.out}  ({len(rows)} rows)")
        if args.emit_berths:
            with open(args.emit_berths, "w", encoding="utf-8") as fh:
                json.dump(berth_roster(rows), fh, indent=2)
            print(f"WROTE  {args.emit_berths}  ({len(berth_roster(rows))} berths)")
        print(
            "\nThe models pick this up automatically. Re-run:\n"
            "  python src/uc1_models/uc1_m4_berth_utilisation.py\n"
            "  python src/uc1_models/uc1_m3_tat_predict.py"
        )

    ok = report.rows_emitted > 0 and not report.failures
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
