#!/usr/bin/env bash
# start-host.sh — Mode B end-to-end.
# Does everything: bootstrap, generate worker token, install host claude (if missing),
# build image if missing, start host worker, bring up the server.
# Idempotent: safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }

# 1. Bootstrap (.env, workspace/claude-workspace).
c_blue "==> [1/6] bootstrap"
"$REPO_ROOT/scripts/init.sh"

# 2. Load .env, generate CLAUDE_WORKER_TOKEN if blank.
c_blue "==> [2/6] worker token"
set -a; . ./.env; set +a
: "${CLAUDE_WORKER_PORT:=3011}"
if [ -z "${CLAUDE_WORKER_TOKEN:-}" ]; then
  CLAUDE_WORKER_TOKEN="$(openssl rand -hex 24)"
  # Replace or append in .env.
  if grep -q '^CLAUDE_WORKER_TOKEN=' .env; then
    # Portable in-place edit (BSD + GNU sed).
    sed -i.bak "s|^CLAUDE_WORKER_TOKEN=.*|CLAUDE_WORKER_TOKEN=${CLAUDE_WORKER_TOKEN}|" .env && rm -f .env.bak
  else
    echo "CLAUDE_WORKER_TOKEN=${CLAUDE_WORKER_TOKEN}" >> .env
  fi
  c_green "    generated and stored in .env"
else
  c_green "    using existing CLAUDE_WORKER_TOKEN from .env"
fi
export CLAUDE_WORKER_TOKEN CLAUDE_WORKER_PORT

# 3. Host claude CLI + claude-mem + gh CLI.
c_blue "==> [3/6] host claude CLI + claude-mem + gh CLI"

# gh: required because agents (nanisca, dorothy, ...) shell out to `gh` to read
# issues/PRs/projects from the host. In Mode B that runs on the host, not in the
# container. Idempotent: skip if already installed.
if ! command -v gh >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    c_yellow "    installing gh (apt + official GitHub CLI repo)..."
    sudo install -m 0755 -d /etc/apt/keyrings
    if [ ! -f /etc/apt/keyrings/githubcli-archive-keyring.gpg ]; then
      curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | sudo dd of=/etc/apt/keyrings/githubcli-archive-keyring.gpg status=none
      sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    fi
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    sudo apt-get update -qq
    sudo apt-get install -y -qq gh
  elif command -v brew >/dev/null 2>&1; then
    c_yellow "    installing gh (brew)..."
    brew install gh
  else
    c_red "    'gh' not installed and no apt/brew available. Install it manually: https://github.com/cli/cli#installation"
    exit 1
  fi
fi
c_green "    gh:         $(gh --version 2>&1 | head -1)"


if ! command -v npm >/dev/null 2>&1; then
  if ! command -v claude >/dev/null 2>&1 || ! command -v claude-mem >/dev/null 2>&1; then
    c_red "    'npm' not on PATH. Install Node + npm, then re-run."
    exit 1
  fi
fi
if ! command -v claude >/dev/null 2>&1; then
  c_yellow "    installing @anthropic-ai/claude-code globally..."
  npm install -g @anthropic-ai/claude-code
fi
if ! command -v claude-mem >/dev/null 2>&1; then
  c_yellow "    installing claude-mem globally..."
  npm install -g claude-mem
  # Register hooks in ~/.claude/settings.json (idempotent; safe to skip if it fails).
  claude-mem install 2>&1 || c_yellow "    (claude-mem install non-fatal failure; run manually after 'claude /login')"
fi
c_green "    claude:     $(claude --version 2>&1 | head -1)"
c_green "    claude-mem: $(claude-mem --version 2>&1 | head -1)"

# 3b. Mode B host overlay: make /workspace/projects and ~/.claude/{agents,skills,hooks,*.md}
# point at the repo's claude-workspace so the host `claude` sees the same config the
# container does. Idempotent: only writes symlinks that don't already point correctly,
# and never overwrites real files/dirs (plugins/, settings.json stay untouched on host).
c_blue "==> [3b/6] host overlay symlinks"
WS_DIR_ABS="$(cd "$REPO_ROOT/${WORKSPACE_DIR:-./workspace/claude-workspace}" && pwd)"
HOST_CLAUDE="${HOME}/.claude"

_link() {
  local src="$1" dst="$2"
  if [ -L "$dst" ]; then
    [ "$(readlink "$dst")" = "$src" ] && return 0
    rm "$dst"
  elif [ -e "$dst" ]; then
    c_yellow "    skip $dst (exists, not a symlink)"
    return 0
  fi
  ln -s "$src" "$dst"
  c_green "    link $dst -> $src"
}

# Mirror the container's /workspace/projects mount so claude on the host can chdir
# into the same canonical path (also matches claude-mem's encoded memory dir).
if [ ! -e /workspace/projects ] || [ "$(readlink /workspace/projects 2>/dev/null)" != "$WS_DIR_ABS/projects" ]; then
  sudo mkdir -p /workspace
  if [ -L /workspace/projects ]; then sudo rm /workspace/projects; fi
  if [ ! -e /workspace/projects ]; then
    sudo ln -s "$WS_DIR_ABS/projects" /workspace/projects
    c_green "    link /workspace/projects -> $WS_DIR_ABS/projects"
  fi
else
  c_green "    /workspace/projects already linked"
fi

mkdir -p "$HOST_CLAUDE"
_link "$WS_DIR_ABS/claude-config/agents" "$HOST_CLAUDE/agents"
_link "$WS_DIR_ABS/claude-config/hooks"  "$HOST_CLAUDE/hooks"
_link "$WS_DIR_ABS/skills"               "$HOST_CLAUDE/skills"
for md in CLAUDE.md RTK.md nestjs-CLAUDE.md nextjs-CLAUDE.md; do
  [ -f "$WS_DIR_ABS/claude-config/$md" ] && _link "$WS_DIR_ABS/claude-config/$md" "$HOST_CLAUDE/$md"
done

# 4. Build image if missing.
c_blue "==> [4/6] image"
if ! docker image inspect claude-server:latest >/dev/null 2>&1; then
  docker compose build
else
  c_green "    claude-server:latest already built"
fi

# 5. Host worker (background, idempotent).
c_blue "==> [5/6] host worker on :$CLAUDE_WORKER_PORT"
WORKER_PID_FILE="$REPO_ROOT/.host-claude-worker.pid"
WORKER_LOG="$REPO_ROOT/.host-claude-worker.log"
worker_running() { [ -f "$WORKER_PID_FILE" ] && kill -0 "$(cat "$WORKER_PID_FILE")" 2>/dev/null; }

# OTLP defaults so spawned `claude` children export to the local collector
# running in compose (otel-collector exposes 4317/4318 on 127.0.0.1). The
# existing claude-monitoring.json dashboard depends on these series.
: "${OTEL_OTLP_GRPC_PORT:=4317}"
: "${CLAUDE_CODE_ENABLE_TELEMETRY:=1}"
: "${OTEL_METRICS_EXPORTER:=otlp}"
: "${OTEL_LOGS_EXPORTER:=otlp}"
: "${OTEL_EXPORTER_OTLP_PROTOCOL:=grpc}"
: "${OTEL_EXPORTER_OTLP_ENDPOINT:=http://localhost:${OTEL_OTLP_GRPC_PORT}}"
: "${OTEL_LOG_USER_PROMPTS:=0}"
: "${OTEL_RESOURCE_ATTRIBUTES:=service.name=claude-code,host.name=$(hostname),deployment.environment=host}"

if worker_running; then
  c_yellow "    already running (pid $(cat "$WORKER_PID_FILE"))"
else
  CLAUDE_WORKER_PORT="$CLAUDE_WORKER_PORT" \
  CLAUDE_WORKER_TOKEN="$CLAUDE_WORKER_TOKEN" \
  CLAUDE_BIN="${HOST_CLAUDE_BIN:-claude}" \
  CLAUDE_CODE_ENABLE_TELEMETRY="$CLAUDE_CODE_ENABLE_TELEMETRY" \
  OTEL_METRICS_EXPORTER="$OTEL_METRICS_EXPORTER" \
  OTEL_LOGS_EXPORTER="$OTEL_LOGS_EXPORTER" \
  OTEL_EXPORTER_OTLP_PROTOCOL="$OTEL_EXPORTER_OTLP_PROTOCOL" \
  OTEL_EXPORTER_OTLP_ENDPOINT="$OTEL_EXPORTER_OTLP_ENDPOINT" \
  OTEL_LOG_USER_PROMPTS="$OTEL_LOG_USER_PROMPTS" \
  OTEL_RESOURCE_ATTRIBUTES="$OTEL_RESOURCE_ATTRIBUTES" \
  nohup node "$REPO_ROOT/scripts/host-claude-worker.mjs" >"$WORKER_LOG" 2>&1 &
  echo $! > "$WORKER_PID_FILE"
  sleep 1
  if ! worker_running; then
    c_red "    worker failed to start. tail $WORKER_LOG:"
    tail -20 "$WORKER_LOG" || true
    rm -f "$WORKER_PID_FILE"
    exit 1
  fi
  c_green "    pid $(cat "$WORKER_PID_FILE") (log: .host-claude-worker.log)"
  c_green "    OTLP -> $OTEL_EXPORTER_OTLP_ENDPOINT (telemetry=$CLAUDE_CODE_ENABLE_TELEMETRY)"
fi

# 6. Bring up server only (claude-workspace container is not used in Mode B).
c_blue "==> [6/6] docker compose up -d server"

# Persist Mode B vars to .env so future `docker compose up` calls (without
# going through this script) still pick the bridge instead of falling back to
# the in-container `claude` binary, which is unauthenticated under Mode B.
MODE_B_BIN="/workspace/scripts/claude-bridge.mjs"
MODE_B_URL="http://host.docker.internal:${CLAUDE_WORKER_PORT}"
_set_env() {
  local key="$1" val="$2"
  if grep -q "^${key}=" .env 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${val}|" .env && rm -f .env.bak
  else
    echo "${key}=${val}" >> .env
  fi
}
_set_env CLAUDE_BIN "$MODE_B_BIN"
_set_env CLAUDE_WORKER_URL "$MODE_B_URL"

export CLAUDE_BIN="$MODE_B_BIN"
export CLAUDE_WORKER_URL="$MODE_B_URL"
docker compose up -d server

c_green "==> Mode B ready"
echo
echo "  server:   curl -s http://127.0.0.1:${SERVER_PORT:-3010}/health | jq"
echo "  worker:   curl -s http://127.0.0.1:${CLAUDE_WORKER_PORT}/health"
echo "  metrics:  curl -s http://127.0.0.1:${SERVER_PORT:-3010}/metrics | head"
echo "  grafana:  http://127.0.0.1:${GRAFANA_PORT:-3000}  (admin/${GRAFANA_PASSWORD:-admin})"
echo "  claude:   run 'claude' on the host directly"
echo "  stop:     docker compose down && kill \$(cat .host-claude-worker.pid) && rm .host-claude-worker.pid"
