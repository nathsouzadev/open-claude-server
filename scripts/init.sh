#!/usr/bin/env bash
# init.sh — one-time bootstrap for open-claude-server.
# Copies templates (./workspace/claude-workspace-example -> ./workspace/claude-workspace,
# env.example -> .env, projects.example.yml -> projects.yml) without overwriting.
# Idempotent: safe to re-run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE_DIR="$REPO_ROOT/workspace/claude-workspace-example"
WORKSPACE_DIR="$REPO_ROOT/workspace/claude-workspace"

c_blue()   { printf '\033[34m%s\033[0m\n' "$*"; }
c_green()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
c_red()    { printf '\033[31m%s\033[0m\n' "$*"; }

if [ ! -d "$TEMPLATE_DIR" ]; then
  c_red "template missing: $TEMPLATE_DIR"
  exit 1
fi

c_blue "==> bootstrapping $WORKSPACE_DIR from template"
if [ ! -d "$WORKSPACE_DIR" ]; then
  cp -R "$TEMPLATE_DIR" "$WORKSPACE_DIR"
  c_green "    created $WORKSPACE_DIR"
else
  c_yellow "    $WORKSPACE_DIR already exists (skipping copy)"
fi

# projects.example.yml -> projects.yml (in the copy)
PROJECTS_EXAMPLE="$WORKSPACE_DIR/projects.example.yml"
PROJECTS_YML="$WORKSPACE_DIR/projects.yml"
if [ -f "$PROJECTS_EXAMPLE" ] && [ ! -f "$PROJECTS_YML" ]; then
  mv "$PROJECTS_EXAMPLE" "$PROJECTS_YML"
  c_green "    renamed projects.example.yml -> projects.yml"
elif [ -f "$PROJECTS_YML" ]; then
  c_yellow "    projects.yml already exists (skipping rename)"
fi

# root .env from env.example
ENV_EXAMPLE="$REPO_ROOT/env.example"
ENV_FILE="$REPO_ROOT/.env"
if [ -f "$ENV_EXAMPLE" ] && [ ! -f "$ENV_FILE" ]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  c_green "    created .env from env.example"
elif [ -f "$ENV_FILE" ]; then
  c_yellow "    .env already exists (skipping copy)"
fi

# server/.env stub (env_file in compose is optional, but create empty so users can fill it)
SERVER_ENV="$REPO_ROOT/server/.env"
if [ ! -f "$SERVER_ENV" ]; then
  : > "$SERVER_ENV"
  c_green "    created empty server/.env"
fi

# claude-mem dir on host (mounted into both containers)
mkdir -p "$HOME/.claude-mem"

# Ensure ~/.gitconfig exists as a *file* on the host before compose starts.
# docker-compose.yml bind-mounts it read-only into the containers; if it's
# missing, Docker silently creates an empty *directory* in its place, which
# breaks `git` on the host (warning: "unable to access '~/.gitconfig': Is a
# directory"). Touching here is idempotent and safe.
[ -e "$HOME/.gitconfig" ] || touch "$HOME/.gitconfig"

# encoded project-memory dir
ENCODED_DIR="$HOME/.claude/projects/-workspace-projects/memory"
mkdir -p "$ENCODED_DIR"

c_green "==> init complete"
echo
c_blue "next steps:"
echo "  - edit .env (GH_TOKEN, API_TOKEN, etc.)"
echo "  - edit workspace/claude-workspace/projects.yml to list your repos"
echo "  - run one of:"
echo "      ./scripts/start-container.sh   # Mode A: claude + server in containers"
echo "      ./scripts/start-host.sh        # Mode B: claude on host, server in container"
