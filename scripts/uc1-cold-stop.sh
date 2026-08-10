#!/usr/bin/env bash
# =============================================================================
# UC1-001 — stop the cold-start stack (gateway, Vite, optional containers)
#
# Usage:
#   ./scripts/uc1-cold-stop.sh           # stop processes; leave Postgres/Redis
#   ./scripts/uc1-cold-stop.sh --all     # also stop + remove demo containers
#   ./scripts/uc1-cold-stop.sh --wipe    # --all + delete the Postgres volume
# =============================================================================
set -euo pipefail

STATE_DIR="${STATE_DIR:-$HOME/.jnpa-uc1}"
PG_CONTAINER="${PG_CONTAINER:-jnpa-uc1-postgres}"
REDIS_CONTAINER="${REDIS_CONTAINER:-jnpa-uc1-redis}"
MODE="${1:-}"

log()  { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[1;33m!\033[0m %s\n' "$*"; }

kill_pidfile() {
  local file="$1" label="$2"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      ok "stopped $label (pid $pid)"
    else
      warn "$label pidfile present but process not running"
    fi
    rm -f "$file"
  else
    warn "no $label pidfile"
  fi
}

log "Stopping UC1 demo processes"
kill_pidfile "$STATE_DIR/vite.pid" "dashboard"
kill_pidfile "$STATE_DIR/gateway.pid" "gateway"

# Belt-and-braces: free common ports if something else grabbed them from this stack.
for port in 8000 5173; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    # Only kill if the command line looks like ours (best-effort).
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
    if [[ -n "$pids" ]]; then
      warn "port $port still listening (pids: $pids) — leaving alone (use --all to tear down containers)"
    fi
  fi
done

if [[ "$MODE" == "--all" || "$MODE" == "--wipe" ]]; then
  log "Stopping demo containers"
  for c in "$PG_CONTAINER" "$REDIS_CONTAINER"; do
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$c"; then
      docker stop "$c" >/dev/null 2>&1 || true
      docker rm "$c" >/dev/null 2>&1 || true
      ok "removed $c"
    fi
  done
fi

if [[ "$MODE" == "--wipe" ]]; then
  log "Wiping Postgres volume jnpa-uc1-pgdata"
  docker volume rm jnpa-uc1-pgdata >/dev/null 2>&1 && ok "volume removed" || warn "volume already gone"
  rm -f "$STATE_DIR/jwt_secret"
  # Keep migration ledger gone with the volume; clear local kpi/login artefacts.
  rm -f "$STATE_DIR"/kpi_*.json "$STATE_DIR"/login.json
fi

cat <<EOF

\033[1;32mUC1 stack stopped.\033[0m
  Re-start:  ./scripts/uc1-cold-start.sh
  Full wipe: ./scripts/uc1-cold-stop.sh --wipe

EOF
