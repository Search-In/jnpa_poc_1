# UC1-001 — One-command cold-start

Demo-ops script for a presenter laptop. Brings up Postgres 16, Redis, the UC-3
gateway, and this UC-1 dashboard from cold so the login screen is reachable in
minutes.

## Quick start

```bash
# From this repo (jnpa_poc_1). Expects sibling ../jnpa-uc3-poc with `make venv` done.
./scripts/uc1-cold-start.sh

# Open http://localhost:5173/  — login admin / adminadmin
# (gateway requires passwords ≥ 8 chars; tender's admin/admin is rejected)
# Stop:
./scripts/uc1-cold-stop.sh          # processes only
./scripts/uc1-cold-stop.sh --all    # + demo containers
./scripts/uc1-cold-stop.sh --wipe   # + wipe Postgres volume
```

Override the UC-3 path if it is not a sibling:

```bash
UC3_ROOT=~/Downloads/X/JNPA_PoCs/PoC/jnpa-uc3-poc ./scripts/uc1-cold-start.sh
```

## What it starts

| Piece | Detail |
|---|---|
| Postgres 16 | Docker `postgres:16-alpine`, DB **`jnpa_v3_local`**, host port **5433** |
| Manual SQL | `0036`, `0037`, `0101` (tender) + `0123` (auth) + `0052`/`0053` (marine gap) |
| Marine DDL | `0038–0051` self-apply when the gateway boots (`JNPA_RUNTIME_DDL=1`) |
| Redis | `redis:7-alpine` on **6379** |
| Gateway | `jnpa-gateway` / uvicorn on **:8000** |
| Dashboard | `npm run dev` on **:5173**, proxy → local gateway |

State / logs: `~/.jnpa-uc1/` (`gateway.log`, `vite.log`, pidfiles, JWT secret).

## Done checks (tender)

After the script finishes:

```bash
curl -s http://localhost:8000/healthz | jq .
curl -s -X POST http://localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminadmin"}' | jq .role

TOKEN=$(curl -s -X POST http://localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminadmin"}' | jq -r .access_token)

# AVG_TAT lives here (tender text said /api/marine/kpis — that path does not exist):
curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:8000/api/marine/calls/stats | jq .
```

A fresh DB has **no vessel calls**, so `avg_turnaround_hours` is null until you
upload the JNPA marine corpus (dashboard **Data Upload**, or
`POST /api/marine/upload`). After load you should see real TAT numbers (demo
target ~27 h on the briefing corpus).

## Prerequisites

- Docker Desktop running
- Node 20+ / npm
- `jnpa-uc3-poc` with `.venv` (`cd "$UC3_ROOT" && make venv`)
- Host ports **5433**, **6379**, **8000**, **5173** free

## Notes vs the full UC-3 compose stack

This script is **UC-1 demo minimal**: it does **not** start Kafka, MinIO,
Grafana, or the UC-3 web console. Kafka pumps fail soft in `APP_ENV=development`.
For the full traffic stack use `make up` inside `jnpa-uc3-poc` against RDS.
