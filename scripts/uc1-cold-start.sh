#!/usr/bin/env bash
# =============================================================================
# UC1-001 — one-command cold-start for the UC-1 demo stack
#
# Brings up, from a cold laptop:
#   1. Postgres 16  → database jnpa_v3_local
#   2. Redis        → gateway session/cache dependency
#   3. UC-3 gateway → uvicorn on :8000 (marine DDL self-applies on boot)
#   4. UC-1 dashboard (this repo) → Vite on :5173
#
# Done criteria (tender UC1-001):
#   • Login screen reachable at http://localhost:5173  (admin / admin)
#   • GET /healthz → 200
#   • GET /api/marine/calls/stats returns JSON (real AVG_TAT once corpus is loaded)
#
# Usage:
#   ./scripts/uc1-cold-start.sh
#   UC3_ROOT=/path/to/jnpa-uc3-poc ./scripts/uc1-cold-start.sh
#   ./scripts/uc1-cold-stop.sh          # teardown
#
# Override knobs (all optional):
#   UC3_ROOT, POC1_ROOT, PG_PORT, PG_PASSWORD, PG_DB, GW_PORT, VITE_PORT,
#   STATE_DIR, SKIP_DASHBOARD=1, SKIP_SEED=1
# =============================================================================
set -euo pipefail

ROOT_POC1="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
POC1_ROOT="${POC1_ROOT:-$ROOT_POC1}"
# Sibling checkout is the default; tender paths under Downloads also work if set.
UC3_ROOT="${UC3_ROOT:-$(cd "$POC1_ROOT/../jnpa-uc3-poc" 2>/dev/null && pwd || true)}"

PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PG_CONTAINER="${PG_CONTAINER:-jnpa-uc1-postgres}"
REDIS_CONTAINER="${REDIS_CONTAINER:-jnpa-uc1-redis}"
PG_PORT="${PG_PORT:-5433}"
PG_USER="${PG_USER:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-jnpa_pw}"
PG_DB="${PG_DB:-jnpa_v3_local}"
GW_PORT="${GW_PORT:-8000}"
VITE_PORT="${VITE_PORT:-5173}"
STATE_DIR="${STATE_DIR:-$HOME/.jnpa-uc1}"
ADMIN_USER="${ADMIN_USER:-admin}"
# Gateway enforces MIN_PASSWORD_LENGTH=8 — tender text says admin/admin, but
# seed_auth_users rejects passwords shorter than 8. Use adminadmin (same spirit).
ADMIN_PASS="${ADMIN_PASS:-adminadmin}"

LIBPQ_DSN="postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}"
ASYNCPG_DSN="postgresql+asyncpg://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DB}"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }

wait_http() {
  local url="$1" label="$2" tries="${3:-60}" loghint="${4:-$STATE_DIR/logs/gateway.log}"
  local i code
  for ((i = 1; i <= tries; i++)); do
    code="$(curl -sS -m 2 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
    if [[ "$code" =~ ^(200|204)$ ]]; then
      ok "$label ready ($url → $code)"
      return 0
    fi
    sleep 1
  done
  die "$label did not become ready at $url (last HTTP $code). See $loghint"
}

# Start a long-lived daemon that survives this script (and the Cursor/CI parent
# shell) exiting. macOS has no `setsid(1)`; Python's os.setsid + double-fork is
# the portable detach used on demo laptops.
daemonize() {
  local pidfile="$1" logfile="$2"
  shift 2
  rm -f "$pidfile"
  python3 - "$pidfile" "$logfile" "$@" <<'PY'
import os, sys, time, subprocess
pidfile, logfile, *cmd = sys.argv[1:]

def _daemon():
    # Double-fork so we are not a session leader's child of the caller.
    if os.fork() > 0:
        return
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    os.chdir("/")
    out = os.open(logfile, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(out, 1)
    os.dup2(out, 2)
    if out > 2:
        os.close(out)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    if devnull > 2:
        os.close(devnull)
    # start_new_session=True is belt-and-braces on top of setsid above.
    proc = subprocess.Popen(cmd, start_new_session=True)
    with open(pidfile, "w", encoding="utf-8") as fh:
        fh.write(str(proc.pid))
    os._exit(0)

_daemon()
# Parent waits until the grandchild has written the pidfile.
for _ in range(50):
    if os.path.isfile(pidfile) and os.path.getsize(pidfile) > 0:
        sys.exit(0)
    time.sleep(0.1)
sys.stderr.write(f"daemonize: pidfile not written for {cmd!r}\n")
sys.exit(1)
PY
}

wait_pg() {
  local i
  for ((i = 1; i <= 60; i++)); do
    if docker exec "$PG_CONTAINER" pg_isready -U "$PG_USER" >/dev/null 2>&1; then
      ok "Postgres ready in container $PG_CONTAINER"
      return 0
    fi
    sleep 1
  done
  die "Postgres container $PG_CONTAINER never became ready"
}

psql_db() {
  # Prefer host psql; fall back to exec inside the container.
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$1" -v ON_ERROR_STOP=1 "${@:2}"
  else
    docker exec -i -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
      psql -U "$PG_USER" -d "$1" -v ON_ERROR_STOP=1 "${@:2}"
  fi
}

apply_sql() {
  local file="$1"
  local tag
  tag="$(basename "$file")"
  [[ -f "$file" ]] || die "migration not found: $file"
  # Skip if already recorded in our cold-start ledger.
  if psql_db "$PG_DB" -tAc "SELECT 1 FROM core.uc1_cold_start_migrations WHERE name = '$tag'" 2>/dev/null | grep -q 1; then
    ok "skip $tag (already applied)"
    return 0
  fi
  log "Apply $tag"
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$PG_PASSWORD" psql -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" \
      -v ON_ERROR_STOP=1 -f "$file"
  else
    docker exec -i -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
      psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 <"$file"
  fi
  psql_db "$PG_DB" -c "INSERT INTO core.uc1_cold_start_migrations(name) VALUES ('$tag') ON CONFLICT DO NOTHING;"
  ok "applied $tag"
}

# -----------------------------------------------------------------------------
log "UC1 cold-start — preflight"
need docker
need curl
need npm
need node
docker info >/dev/null 2>&1 || die "Docker daemon is not running — start Docker Desktop first"

[[ -n "$UC3_ROOT" && -d "$UC3_ROOT" ]] || die "UC3_ROOT not found. Set UC3_ROOT to your jnpa-uc3-poc checkout."
[[ -d "$POC1_ROOT" ]] || die "POC1_ROOT not found: $POC1_ROOT"
[[ -x "$UC3_ROOT/.venv/bin/python" ]] || die "UC3 venv missing. In $UC3_ROOT run: make venv"
[[ -x "$UC3_ROOT/.venv/bin/uvicorn" ]] || die "uvicorn missing in UC3 venv. In $UC3_ROOT run: make venv"

mkdir -p "$STATE_DIR/logs"
echo "$UC3_ROOT" >"$STATE_DIR/uc3_root"
echo "$POC1_ROOT" >"$STATE_DIR/poc1_root"
ok "UC3_ROOT=$UC3_ROOT"
ok "POC1_ROOT=$POC1_ROOT"
ok "STATE_DIR=$STATE_DIR"

# -----------------------------------------------------------------------------
log "1/6  Postgres 16 → database $PG_DB (host port $PG_PORT)"
if docker ps -a --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
  if docker ps --format '{{.Names}}' | grep -qx "$PG_CONTAINER"; then
    ok "container $PG_CONTAINER already running"
  else
    docker start "$PG_CONTAINER" >/dev/null
    ok "started existing container $PG_CONTAINER"
  fi
else
  # If the host port is busy, fail with a clear message rather than silently remapping.
  if lsof -nP -iTCP:"$PG_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    die "host port $PG_PORT is already in use. Free it or set PG_PORT=… and re-run."
  fi
  docker run -d \
    --name "$PG_CONTAINER" \
    --restart unless-stopped \
    -e POSTGRES_USER="$PG_USER" \
    -e POSTGRES_PASSWORD="$PG_PASSWORD" \
    -e POSTGRES_DB=postgres \
    -e TZ=Etc/UTC \
    -p "${PG_PORT}:5432" \
    -v jnpa-uc1-pgdata:/var/lib/postgresql/data \
    "$PG_IMAGE" >/dev/null
  ok "created $PG_CONTAINER ($PG_IMAGE)"
fi
wait_pg

# Create demo database (idempotent).
exists="$(docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
  psql -U "$PG_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$PG_DB'" | tr -d '[:space:]')"
if [[ "$exists" != "1" ]]; then
  docker exec -e PGPASSWORD="$PG_PASSWORD" "$PG_CONTAINER" \
    psql -U "$PG_USER" -d postgres -c "CREATE DATABASE ${PG_DB};" >/dev/null
  ok "created database $PG_DB"
else
  ok "database $PG_DB already exists"
fi

# Boot schemas + cold-start ledger.
psql_db "$PG_DB" <<'SQL' >/dev/null
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS staging;
CREATE SCHEMA IF NOT EXISTS mart;
CREATE SCHEMA IF NOT EXISTS jnpa;
CREATE TABLE IF NOT EXISTS core.uc1_cold_start_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL
ok "schemas core/staging/mart/jnpa ready"

# -----------------------------------------------------------------------------
log "2/6  Manual migrations (0036 / 0037 / 0101) + auth/marine extras"
MIG="$UC3_ROOT/infra/postgres/migrations"
V3="$UC3_ROOT/infra/postgres/v3"

# Tender-required three:
apply_sql "$MIG/0036_berthing_reports.sql"
apply_sql "$MIG/0037_berthing_report_documents.sql"
apply_sql "$V3/0101_core_operational_ext.sql"

# LIVE/DEMO provenance (0120 ledgers + 0121 domain). Without these, SPA
# X-Data-Mode filters 500 on berthing/marine list endpoints (missing data_origin).
apply_sql "$V3/0120_data_origin_provenance.sql"
apply_sql "$V3/0121_data_origin_domain.sql"

# Required for admin/admin login (not in the three, but Done criteria needs it):
apply_sql "$V3/0123_auth_users.sql"

# Marine 0038–0051 self-apply via gateway marine_ext on boot.
# 0052/0053 are NOT in marine_ext._DDL — apply explicitly.
apply_sql "$MIG/0052_marine_manual_pilot_assignment.sql"
apply_sql "$MIG/0053_marine_manual_craft_assignment.sql"

# -----------------------------------------------------------------------------
log "3/6  Redis (gateway dependency)"
if docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_CONTAINER"; then
  docker start "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  ok "redis container $REDIS_CONTAINER"
else
  docker run -d \
    --name "$REDIS_CONTAINER" \
    --restart unless-stopped \
    -p 6379:6379 \
    redis:7-alpine >/dev/null
  ok "created $REDIS_CONTAINER"
fi
# Soft wait
for ((i = 1; i <= 20; i++)); do
  if docker exec "$REDIS_CONTAINER" redis-cli ping 2>/dev/null | grep -q PONG; then
    ok "redis PONG"
    break
  fi
  sleep 0.5
done

# -----------------------------------------------------------------------------
log "4/6  UC-3 gateway on :$GW_PORT"
# Kill a previous cold-start gateway if still running.
if [[ -f "$STATE_DIR/gateway.pid" ]]; then
  old="$(cat "$STATE_DIR/gateway.pid" 2>/dev/null || true)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
    sleep 1
  fi
  rm -f "$STATE_DIR/gateway.pid"
fi
# Also clear anything else already bound to the gateway port.
if lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  warn "port $GW_PORT busy — attempting to free it"
  lsof -tiTCP:"$GW_PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
  sleep 1
fi

# Stable demo JWT secret (persisted so restarts don't invalidate tokens mid-demo).
if [[ ! -f "$STATE_DIR/jwt_secret" ]]; then
  openssl rand -hex 32 >"$STATE_DIR/jwt_secret"
fi
JWT_SECRET="$(cat "$STATE_DIR/jwt_secret")"

# Env file the gateway process loads (.env.local walk from CWD).
cat >"$STATE_DIR/gateway.env" <<EOF
APP_ENV=development
HOST=0.0.0.0
PORT=${GW_PORT}
AUTH_ENABLED=true
AUTH_JWT_SECRET=${JWT_SECRET}
AUTH_DEV_TOKENS=true
AUTH_PBKDF2_ITERATIONS=100000
JNPA_RUNTIME_DDL=1
DATA_MODE=mock
POSTGRES_DSN=${ASYNCPG_DSN}
RFID_POSTGRES_DSN=${ASYNCPG_DSN}
TRUCK_POSTGRES_DSN=${ASYNCPG_DSN}
CONGESTION_POSTGRES_DSN=${ASYNCPG_DSN}
ANOMALY_POSTGRES_DSN=${ASYNCPG_DSN}
REDIS_URL=redis://127.0.0.1:6379/0
KAFKA_BROKERS=127.0.0.1:29092
MQTT_BROKER=127.0.0.1:1883
MINIO_ENDPOINT=127.0.0.1:9000
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
# Required by gateway env-check (compose $${VAR:?}); demo placeholders only.
PWA_PAIRING_SECRET=uc1-demo-pairing-secret-not-for-prod
GRAFANA_ADMIN_PASSWORD=${ADMIN_PASS}
GRAFANA_PG_HOST=127.0.0.1:${PG_PORT}
GRAFANA_PG_DB=${PG_DB}
POSTGRES_PASSWORD=${PG_PASSWORD}
EOF

# Write a small launcher so setsid can exec a stable command line.
cat >"$STATE_DIR/run-gateway.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$UC3_ROOT"
set -a
# shellcheck disable=SC1091
source "$STATE_DIR/gateway.env"
set +a
export PYTHONPATH="${UC3_ROOT}\${PYTHONPATH:+:\$PYTHONPATH}"
if [[ -x "$UC3_ROOT/.venv/bin/jnpa-gateway" ]]; then
  exec "$UC3_ROOT/.venv/bin/jnpa-gateway"
fi
exec "$UC3_ROOT/.venv/bin/uvicorn" gateway.main:app --host 0.0.0.0 --port "$GW_PORT"
EOF
chmod +x "$STATE_DIR/run-gateway.sh"

daemonize "$STATE_DIR/gateway.pid" "$STATE_DIR/logs/gateway.log" "$STATE_DIR/run-gateway.sh"
ok "gateway pid $(cat "$STATE_DIR/gateway.pid") — log $STATE_DIR/logs/gateway.log"

wait_http "http://127.0.0.1:${GW_PORT}/healthz" "gateway /healthz" 90 "$STATE_DIR/logs/gateway.log"

# -----------------------------------------------------------------------------
if [[ "${SKIP_SEED:-0}" != "1" ]]; then
  log "5/6  Seed demo accounts (${ADMIN_USER}/${ADMIN_PASS})"
  (
    cd "$UC3_ROOT"
    set -a
    # shellcheck disable=SC1091
    source "$STATE_DIR/gateway.env"
    set +a
    export SEED_ADMIN_PASSWORD="$ADMIN_PASS"
    export SEED_OPERATOR_PASSWORD="$ADMIN_PASS"
    export SEED_GATE_PASSWORD="$ADMIN_PASS"
    export SEED_TRANSPORT_PASSWORD="$ADMIN_PASS"
    export SEED_MUST_CHANGE_PASSWORD=false
    "$UC3_ROOT/.venv/bin/python" scripts/seed_auth_users.py --reset-existing --no-force-password-change
  ) >>"$STATE_DIR/logs/seed.log" 2>&1 || {
    warn "seed_auth_users.py reported an error — see $STATE_DIR/logs/seed.log"
  }
  # Prove login works.
  login_code="$(curl -sS -m 10 -o "$STATE_DIR/login.json" -w '%{http_code}' \
    -X POST "http://127.0.0.1:${GW_PORT}/api/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}" || echo 000)"
  if [[ "$login_code" == "200" ]]; then
    ok "login ${ADMIN_USER}/${ADMIN_PASS} → HTTP 200"
  else
    warn "login returned HTTP $login_code — check $STATE_DIR/login.json and seed log"
  fi
else
  log "5/6  Skipping auth seed (SKIP_SEED=1)"
fi

# -----------------------------------------------------------------------------
log "Smoke — marine KPIs / call stats"
TOKEN=""
if [[ -f "$STATE_DIR/login.json" ]]; then
  TOKEN="$(python3 -c "import json; print(json.load(open('$STATE_DIR/login.json')).get('access_token',''))" 2>/dev/null || true)"
fi

# Tender text says /api/marine/kpis; the live route for AVG_TAT is /api/marine/calls/stats.
# Operational projection KPIs live at /api/marine/state/kpis.
for path in /api/marine/calls/stats /api/marine/state/kpis /api/marine/kpis; do
  if [[ -n "$TOKEN" ]]; then
    code="$(curl -sS -m 10 -o "$STATE_DIR/kpi_${path////_}.json" -w '%{http_code}' \
      -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:${GW_PORT}${path}" 2>/dev/null || echo 000)"
  else
    code="$(curl -sS -m 10 -o "$STATE_DIR/kpi_${path////_}.json" -w '%{http_code}' \
      "http://127.0.0.1:${GW_PORT}${path}" 2>/dev/null || echo 000)"
  fi
  if [[ "$code" == "200" ]]; then
    ok "$path → 200"
  else
    warn "$path → HTTP $code"
  fi
done

# Summarise call-stats if present (AVG_TAT lives here).
STATS_JSON="$STATE_DIR/kpi__api_marine_calls_stats.json"
if [[ -f "$STATS_JSON" ]]; then
  STATE_DIR="$STATE_DIR" STATS_JSON="$STATS_JSON" python3 - <<'PY' 2>/dev/null || true
import json, os, pathlib
p = pathlib.Path(os.environ["STATS_JSON"])
try:
    d = json.loads(p.read_text())
except Exception as e:
    print(f"    ! could not parse call stats: {e}")
    raise SystemExit(0)
tat = d.get("avg_turnaround_hours")
n = d.get("total") or d.get("calls") or d.get("n")
print(f"    · avg_turnaround_hours={tat}  total/calls={n}")
if tat is None and (n in (None, 0, "0")):
    print("    ! No vessel-call rows yet — load the JNPA marine corpus via Data Upload")
    print("      (or POST /api/marine/upload) to get real AVG_TAT numbers for the demo.")
PY
fi

# -----------------------------------------------------------------------------
if [[ "${SKIP_DASHBOARD:-0}" != "1" ]]; then
  log "6/6  UC-1 dashboard on :$VITE_PORT"
  if [[ -f "$STATE_DIR/vite.pid" ]]; then
    old="$(cat "$STATE_DIR/vite.pid" 2>/dev/null || true)"
    if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
      kill "$old" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$STATE_DIR/vite.pid"
  fi
  if lsof -nP -iTCP:"$VITE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "port $VITE_PORT busy — attempting to free it"
    lsof -tiTCP:"$VITE_PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
    sleep 1
  fi

  if [[ ! -d "$POC1_ROOT/node_modules" ]]; then
    log "npm install (first run)"
    (cd "$POC1_ROOT" && npm install) >>"$STATE_DIR/logs/npm.log" 2>&1
  fi

  cat >"$STATE_DIR/run-vite.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$POC1_ROOT"
export VITE_GATEWAY_URL="http://127.0.0.1:${GW_PORT}"
export VITE_UC3_ENABLED=true
export VITE_UC3_API_BASE=/api
export VITE_UC3_USERNAME="$ADMIN_USER"
export VITE_UC3_PASSWORD="$ADMIN_PASS"
export VITE_DATA_MODE=mock
# Bind IPv4 explicitly — wait_http curls 127.0.0.1 (macOS localhost can be ::1-only).
exec npm run dev -- --host 127.0.0.1 --port "$VITE_PORT" --strictPort
EOF
  chmod +x "$STATE_DIR/run-vite.sh"

  daemonize "$STATE_DIR/vite.pid" "$STATE_DIR/logs/vite.log" "$STATE_DIR/run-vite.sh"
  ok "vite pid $(cat "$STATE_DIR/vite.pid") — log $STATE_DIR/logs/vite.log"
  wait_http "http://127.0.0.1:${VITE_PORT}/" "dashboard" 90 "$STATE_DIR/logs/vite.log"
else
  log "6/6  Skipping dashboard (SKIP_DASHBOARD=1)"
fi

# -----------------------------------------------------------------------------
cat <<EOF

\033[1;32mUC1 cold-start complete.\033[0m

  Dashboard   http://localhost:${VITE_PORT}/
  Gateway     http://localhost:${GW_PORT}/healthz
  Login       ${ADMIN_USER} / ${ADMIN_PASS}
  Database    ${PG_DB} @ localhost:${PG_PORT}
  Logs        ${STATE_DIR}/logs/
  Stop        ${POC1_ROOT}/scripts/uc1-cold-stop.sh

KPI note: AVG_TAT comes from GET /api/marine/calls/stats (not /api/marine/kpis).
After corpus upload you should see avg_turnaround_hours populated from core.vessel_call.

EOF
