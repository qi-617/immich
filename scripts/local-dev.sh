#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_DEV_DIR="$ROOT_DIR/.local-dev"
RUN_DIR="$LOCAL_DEV_DIR/run"
LOG_DIR="$LOCAL_DEV_DIR/logs"
MODEL_CACHE_DIR="$LOCAL_DEV_DIR/model-cache"
MEDIA_DIR="$ROOT_DIR/.local-media"
BUILD_DIR="$ROOT_DIR/.immich-build"

NODE_VERSION="24.13.1"
PNPM_VERSION="10.30.3"
IMMICH_IMAGE="${IMMICH_LOCAL_DEV_IMAGE:-ghcr.io/immich-app/immich-server:v2}"

WEB_PORT="${IMMICH_WEB_PORT:-3000}"
API_PORT="${IMMICH_API_PORT:-2283}"
ML_PORT="${IMMICH_ML_PORT:-3003}"

WEB_URL="http://127.0.0.1:${WEB_PORT}"
API_URL="http://127.0.0.1:${API_PORT}"
ML_URL="http://127.0.0.1:${ML_PORT}"

ML_PROFILE="${IMMICH_ML_PROFILE:-cpu}"
RESTART_SERVICES="${LOCAL_DEV_RESTART:-1}"
UV_BIN="${UV_BIN:-$HOME/.local/bin/uv}"
SYSTEM_PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

log() {
  printf '[local-dev] %s\n' "$*"
}

die() {
  printf '[local-dev] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

node_arch() {
  case "$(uname -m)" in
    x86_64)
      echo 'x64'
      ;;
    aarch64 | arm64)
      echo 'arm64'
      ;;
    *)
      die "Unsupported architecture: $(uname -m)"
      ;;
  esac
}

NODE_DIR="$HOME/.local/node-v${NODE_VERSION}-linux-$(node_arch)"

ensure_dirs() {
  mkdir -p "$RUN_DIR" "$LOG_DIR" "$MODEL_CACHE_DIR" "$MEDIA_DIR"
}

run_as_root() {
  if [[ ${EUID} -eq 0 ]]; then
    "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  die 'Root privileges are required for this step.'
}

run_as_postgres() {
  if [[ ${EUID} -eq 0 ]]; then
    runuser -u postgres -- "$@"
    return
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo -u postgres "$@"
    return
  fi

  die 'Unable to run a command as the postgres user.'
}

listener_pids() {
  local port="$1"
  local output=''

  output="$(ss -H -ltnp "( sport = :${port} )" 2>/dev/null || true)"
  if [[ -z "$output" ]]; then
    output="$(ss -H -ltnp 2>/dev/null | awk -v p="$port" '$4 ~ ":" p "$"')"
  fi

  printf '%s\n' "$output" | grep -o 'pid=[0-9]\+' | cut -d= -f2 | sort -u
}

stop_pidfile() {
  local name="$1"
  local pidfile="$RUN_DIR/${name}.pid"

  if [[ ! -f "$pidfile" ]]; then
    return
  fi

  local pid
  pid="$(<"$pidfile")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    log "Stopping ${name} (pid ${pid})"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$pidfile"
}

stop_matching() {
  local pattern="$1"
  if command -v pkill >/dev/null 2>&1; then
    pkill -f "$pattern" 2>/dev/null || true
  fi
}

stop_port() {
  local port="$1"
  local pids

  pids="$(listener_pids "$port" || true)"
  if [[ -z "$pids" ]]; then
    return
  fi

  log "Stopping listeners on port ${port}: ${pids//$'\n'/, }"
  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    kill "$pid" 2>/dev/null || true
  done <<<"$pids"

  sleep 1

  pids="$(listener_pids "$port" || true)"
  if [[ -n "$pids" ]]; then
    while IFS= read -r pid; do
      [[ -z "$pid" ]] && continue
      kill -9 "$pid" 2>/dev/null || true
    done <<<"$pids"
  fi
}

stop_local_processes() {
  stop_pidfile 'web'
  stop_pidfile 'api'
  stop_pidfile 'ml'

  if [[ "$RESTART_SERVICES" != '1' ]]; then
    return
  fi

  stop_matching "$ROOT_DIR/machine-learning/.venv/bin/python -m immich_ml"
  stop_matching 'gunicorn immich_ml.main:app'
  stop_matching 'immich_ml.config.CustomUvicornWorker'
  stop_matching 'pnpm --filter immich-web run dev'
  stop_matching 'pnpm --filter immich run start:dev'
  stop_matching 'vite dev --host 0.0.0.0 --port 3000'
  stop_matching 'nest start --watch --'
  stop_matching '/@nestjs/cli/bin/nest.js start --watch --'

  stop_port "$ML_PORT"
  stop_port "$WEB_PORT"
  stop_port "$API_PORT"
}

wait_for_http() {
  local name="$1"
  local url="$2"
  local expected="$3"
  local attempts="${4:-120}"
  local logfile="${5:-}"
  local response=''

  for ((i = 1; i <= attempts; i++)); do
    response="$(curl -fsS --max-time 5 "$url" 2>/dev/null || true)"
    if [[ -n "$response" && ( -z "$expected" || "$response" == *"$expected"* ) ]]; then
      log "${name} is ready at ${url}"
      return 0
    fi

    sleep 1
  done

  if [[ -n "$logfile" && -f "$logfile" ]]; then
    log "Last lines from ${logfile}:"
    tail -n 40 "$logfile" | sed 's/^/[local-dev]   /' >&2 || true
  fi

  die "${name} did not become ready. Check logs in ${LOG_DIR}."
}

ensure_node() {
  require_command curl
  require_command tar

  if [[ ! -x "$NODE_DIR/bin/node" ]]; then
    log "Installing Node.js ${NODE_VERSION} locally"
    mkdir -p "$HOME/.local"
    local tarball="/tmp/node-v${NODE_VERSION}.tar.xz"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-$(node_arch).tar.xz" -o "$tarball"
    tar -xJf "$tarball" -C "$HOME/.local"
  fi

  export PATH="$NODE_DIR/bin:$HOME/.local/bin:$PATH"
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

  require_command corepack
  corepack enable >/dev/null 2>&1 || true
  corepack install -g "pnpm@${PNPM_VERSION}" >/dev/null 2>&1 || true

  require_command pnpm
}

ensure_js_workspace() {
  if [[ ! -f "$ROOT_DIR/node_modules/.modules.yaml" ]]; then
    log 'Installing JavaScript workspace dependencies'
    (
      cd "$ROOT_DIR"
      pnpm install --frozen-lockfile --child-concurrency=1 --network-concurrency=4 --reporter=append-only
    )
  fi

  if [[ ! -f "$ROOT_DIR/open-api/typescript-sdk/build/index.js" ]]; then
    log 'Building the TypeScript SDK'
    (
      cd "$ROOT_DIR"
      pnpm --filter @immich/sdk run build
    )
  fi
}

ensure_build_assets() {
  if [[ -f "$BUILD_DIR/geodata/geodata-date.txt" && -f "$BUILD_DIR/corePlugin/manifest.json" && -f "$BUILD_DIR/www/index.html" ]]; then
    return
  fi

  require_command docker

  if ! docker image inspect "$IMMICH_IMAGE" >/dev/null 2>&1; then
    log "Pulling ${IMMICH_IMAGE}"
    docker pull "$IMMICH_IMAGE" >/dev/null
  fi

  log 'Extracting build assets from the Immich server image'
  local cid
  cid="$(docker create "$IMMICH_IMAGE")"

  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR"
  docker cp "$cid:/build/." "$BUILD_DIR/"
  docker rm -f "$cid" >/dev/null
}

ensure_data_services() {
  require_command systemctl
  log 'Starting PostgreSQL and Redis'
  run_as_root systemctl start postgresql redis-server
}

ensure_database() {
  require_command psql

  log 'Preparing the local PostgreSQL database'
  run_as_postgres psql -v ON_ERROR_STOP=1 <<'SQL'
ALTER USER postgres WITH PASSWORD 'postgres';
SELECT 'CREATE DATABASE immich OWNER postgres' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'immich')\gexec
SQL

  run_as_postgres psql -d immich -v ON_ERROR_STOP=1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
SQL
}

ensure_uv() {
  require_command curl

  if [[ ! -x "$UV_BIN" ]]; then
    log 'Installing uv locally'
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi

  export PATH="$HOME/.local/bin:$PATH"
}

ensure_ml_environment() {
  ensure_uv

  log 'Installing Python 3.11 for the machine-learning service'
  "$UV_BIN" python install 3.11

  log "Syncing the machine-learning environment (${ML_PROFILE})"
  (
    cd "$ROOT_DIR/machine-learning"
    "$UV_BIN" sync --locked --extra "$ML_PROFILE" --python 3.11
  )

  [[ -x "$ROOT_DIR/machine-learning/.venv/bin/python" ]] || die 'The machine-learning virtual environment was not created successfully.'
}

start_background() {
  local name="$1"
  local logfile="$2"
  local command="$3"
  local pidfile="$RUN_DIR/${name}.pid"

  : >"$logfile"

  nohup bash -lc "$command" >"$logfile" 2>&1 &
  local pid=$!
  echo "$pid" >"$pidfile"
  disown "$pid" 2>/dev/null || true

  log "Started ${name}; log: ${logfile}"
}

start_ml() {
  start_background 'ml' "$LOG_DIR/ml.log" "
set -Eeuo pipefail
cd '$ROOT_DIR/machine-learning'
export PATH='$ROOT_DIR/machine-learning/.venv/bin:$HOME/.local/bin:$SYSTEM_PATH'
export IMMICH_HOST='127.0.0.1'
export IMMICH_PORT='$ML_PORT'
export IMMICH_LOG_LEVEL='info'
export MACHINE_LEARNING_CACHE_FOLDER='$MODEL_CACHE_DIR'
exec '$ROOT_DIR/machine-learning/.venv/bin/python' -m immich_ml
"

  wait_for_http 'Machine-learning service' "$ML_URL/ping" 'pong' 120 "$LOG_DIR/ml.log"
}

start_api() {
  start_background 'api' "$LOG_DIR/api.log" "
set -Eeuo pipefail
cd '$ROOT_DIR'
export PATH='$NODE_DIR/bin:$HOME/.local/bin:$SYSTEM_PATH'
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export IMMICH_ENV=development
export IMMICH_HOST=127.0.0.1
export IMMICH_PORT='$API_PORT'
export DB_HOSTNAME=127.0.0.1
export DB_PORT=5432
export DB_USERNAME=postgres
export DB_PASSWORD=postgres
export DB_DATABASE_NAME=immich
export REDIS_HOSTNAME=127.0.0.1
export REDIS_PORT=6379
export IMMICH_MEDIA_LOCATION='$MEDIA_DIR'
export IMMICH_BUILD_DATA='$BUILD_DIR'
export IMMICH_MACHINE_LEARNING_ENABLED=true
export IMMICH_MACHINE_LEARNING_URL='$ML_URL'
exec pnpm --filter immich run start:dev
"

  wait_for_http 'API server' "$API_URL/api/server/ping" 'pong' 180 "$LOG_DIR/api.log"
}

start_web() {
  start_background 'web' "$LOG_DIR/web.log" "
set -Eeuo pipefail
cd '$ROOT_DIR'
export PATH='$NODE_DIR/bin:$HOME/.local/bin:$SYSTEM_PATH'
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export IMMICH_SERVER_URL='$API_URL/'
exec pnpm --filter immich-web run dev
"

  wait_for_http 'Web frontend' "$WEB_URL/api/server/ping" 'pong' 90 "$LOG_DIR/web.log"
}

status() {
  local api_ok='down'
  local web_ok='down'
  local ml_ok='down'
  local features='unavailable'

  if curl -fsS --max-time 5 "$API_URL/api/server/ping" >/dev/null 2>&1; then
    api_ok='up'
  fi

  if curl -fsS --max-time 5 "$WEB_URL/api/server/ping" >/dev/null 2>&1; then
    web_ok='up'
  fi

  if curl -fsS --max-time 5 "$ML_URL/ping" >/dev/null 2>&1; then
    ml_ok='up'
  fi

  if [[ "$api_ok" == 'up' ]]; then
    features="$(curl -fsS --max-time 5 "$API_URL/api/server/features" 2>/dev/null || echo 'unavailable')"
  fi

  log "Web: ${web_ok} (${WEB_URL})"
  log "API: ${api_ok} (${API_URL})"
  log "ML: ${ml_ok} (${ML_URL})"
  log "Features: ${features}"
  log "Logs: ${LOG_DIR}"
}

up() {
  ensure_dirs
  ensure_node
  ensure_js_workspace
  ensure_build_assets
  ensure_data_services
  ensure_database
  ensure_ml_environment

  stop_local_processes
  start_ml
  start_api
  start_web
  status
}

down() {
  stop_local_processes
  log 'Stopped local web, API, and machine-learning processes.'
  log 'PostgreSQL and Redis were left running.'
}

usage() {
  cat <<'EOF'
Usage: ./scripts/local-dev.sh [up|down|restart|status]

Commands:
  up       Start PostgreSQL, Redis, machine learning, API, and web locally.
  down     Stop the local web, API, and machine-learning processes.
  restart  Restart the local web, API, and machine-learning processes.
  status   Show current endpoint status.

Environment overrides:
  IMMICH_ML_PROFILE     Machine-learning dependency profile (default: cpu)
  IMMICH_WEB_PORT       Web frontend port (default: 3000)
  IMMICH_API_PORT       API port (default: 2283)
  IMMICH_ML_PORT        Machine-learning port (default: 3003)
  IMMICH_LOCAL_DEV_IMAGE  Image used to extract build assets (default: ghcr.io/immich-app/immich-server:v2)
  LOCAL_DEV_RESTART     Restart existing listeners on known ports (default: 1)
EOF
}

case "${1:-up}" in
  up)
    up
    ;;
  down)
    down
    ;;
  restart)
    down
    up
    ;;
  status)
    status
    ;;
  -h | --help | help)
    usage
    ;;
  *)
    usage
    exit 1
    ;;
esac