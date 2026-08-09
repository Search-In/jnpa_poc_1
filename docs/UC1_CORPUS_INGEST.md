# UC1-002 — Corpus ingest (idempotent)

Loads the full UC-I marine corpus into Postgres and proves a second pass is
100% `SKIPPED_DUPLICATE`.

## Prerequisites

1. UC1-001 stack up (`./scripts/uc1-cold-start.sh`) **or** any reachable DSN
2. Real corpus on disk (not in this repo):
   - `Digital Twin Data Corpus - Updated/Data/…`, or
   - `Data_by_UseCase/UC-I_Vessel_Traffic_Management/…`

Expected folders under `--base`:

```text
1-NLP Marine/
3- Port Craft & Pilot/
2-JNPA_Sea_Channels_Bathymetry/
7-Berthing Reports/
```

## Run (twice)

```bash
cd "../jnpa-uc3-poc"   # sibling of jnpa_poc_1

export POSTGRES_DSN='postgresql+asyncpg://postgres:jnpa_pw@127.0.0.1:5433/jnpa_v3_local'
BASE="/path/to/Digital Twin Data Corpus - Updated/Data"

# Pass 1 — load
.venv/bin/python scripts/ingest_uc1_corpus.py --base "$BASE"

# Pass 2 — must be 100% SKIPPED_DUPLICATE
.venv/bin/python scripts/ingest_uc1_corpus.py --base "$BASE" --expect-all-duplicate
```

## Done criteria (printed by the script)

| Table / metric | Target |
|---|---|
| `core.vessel_call` | 660 (all with IMO) |
| `core.vessel` | ≥ 651 |
| `core.pilotage` | 336 |
| `core.berthing_record` | 185 across 5 terminals |
| Tide panel rows (`TIDE_TABLE`/`TIME_TABLE`) | 253 |
| `core.sea_channel` | 50 |

Script path: `jnpa-uc3-poc/scripts/ingest_uc1_corpus.py`
