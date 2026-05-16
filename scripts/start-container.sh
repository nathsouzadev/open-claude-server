#!/usr/bin/env bash
# start-container.sh — Mode A end-to-end.
# Does everything: bootstrap templates, build image if needed, bring up both services.
# Idempotent: safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

c_blue()  { printf '\033[34m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }

# 1. Bootstrap templates (.env, workspace/claude-workspace, projects.yml).
c_blue "==> [1/3] bootstrap"
"$REPO_ROOT/scripts/init.sh"

# 2. Build image only if missing.
c_blue "==> [2/3] image"
if ! docker image inspect claude-server:latest >/dev/null 2>&1; then
  docker compose build
else
  c_green "    claude-server:latest already built"
fi

# 3. Force CLAUDE_BIN=claude (in-container PATH) and bring up both services.
export CLAUDE_BIN=claude
c_blue "==> [3/3] docker compose up -d"
docker compose up -d

c_green "==> Mode A ready"
echo
echo "  health:   curl -s http://127.0.0.1:${SERVER_PORT:-3010}/health | jq"
echo "  claude:   docker exec -it claude-workspace claude"
echo "  shell:    docker exec -it claude-workspace bash"
echo "  logs:     docker compose logs -f server"
echo "  stop:     docker compose down"
