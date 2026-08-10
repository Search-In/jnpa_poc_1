# `data/corpus/` — the raw JNPA document corpus (NOT in this repository)

This folder is intentionally empty. The UC-I source corpus is **44 MB of
read-only JNPA Daily Status Report PDFs**, and it does not belong in a frontend
repository that people clone to run a web app.

Only one module reads it: [`src/pipeline/dsr_extract.py`](../../src/pipeline/dsr_extract.py),
which parses section (H) *"Vessels Under Operation"* out of all 54 reports.

## Nothing is lost by its absence

**The corpus was already reduced to the file the models actually read.**
`data/reference/dsr_berth_stays.csv` (345 records, 171 KB) **is tracked**, so:

- M4 still reports the real **21-berth, 56% occupancy** figure — not a synthetic one.
- The eight UC-I models run, and their `--selftest` gates pass.
- `POST /uc1/webapp/predictions` — the Predictions column in Vessels ▸ Live AIS
  Feed — runs end to end.
- `pytest -q` passes in full. **No test needs the corpus.**

The PDFs are only needed to *re-derive* that CSV.

## Restoring it

Copy the sub-tree in from the WS2 model delivery, then re-run the extractor:

```bash
cp -R "<JNPA ML Models>/data/corpus/UC-I_Vessel_Traffic" ml/data/corpus/
cd ml && python run.py dsr --emit-berths data/reference/berths.json
```

Expect `54 PDFs -> 1,113 rows (744 occupied, 369 vacant), 0 rejected`. It needs
`pdfplumber`, which is in `requirements.txt` but deliberately not in
`requirements-service.txt` — the running service never parses a PDF.

`.gitignore` keeps the contents out of version control, so restoring it locally
will not add 44 MB to a commit.

## What is *not* here at all

The **UC-II cargo-handling** and **UC-III traffic-decongestion** corpora. This is
the UC-1 vessel-traffic PoC; their models are not part of it and nothing in this
tree reads them.
