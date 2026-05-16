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

# 3. Host claude CLI + claude-mem.
c_blue "==> [3/6] host claude CLI + claude-mem"
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
if worker_running; then
  c_yellow "    already running (pid $(cat "$WORKER_PID_FILE"))"
else
  CLAUDE_WORKER_PORT="$CLAUDE_WORKER_PORT" \
  CLAUDE_WORKER_TOKEN="$CLAUDE_WORKER_TOKEN" \
  CLAUDE_BIN="${HOST_CLAUDE_BIN:-claude}" \
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
fi

# 6. Bring up server only (claude-workspace container is not used in Mode B).
c_blue "==> [6/6] docker compose up -d server"
export CLAUDE_BIN=/workspace/scripts/claude-bridge.mjs
export CLAUDE_WORKER_URL="http://host.docker.internal:${CLAUDE_WORKER_PORT}"
docker compose up -d server

c_green "==> Mode B ready"
echo
echo "  server:   curl -s http://127.0.0.1:${SERVER_PORT:-3010}/health | jq"
echo "  worker:   curl -s http://127.0.0.1:${CLAUDE_WORKER_PORT}/health"
echo "  claude:   run 'claude' on the host directly"
echo "  stop:     docker compose down && kill \$(cat .host-claude-worker.pid) && rm .host-claude-worker.pid"
