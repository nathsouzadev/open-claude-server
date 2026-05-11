#!/usr/bin/env bash
# claude-workspace bootstrap.
# Idempotent: safe to re-run. Won't overwrite existing files without asking.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
PROJECTS_DIR="${PROJECTS_DIR:-$REPO_ROOT/projects}"

c_red()   { printf "\033[31m%s\033[0m\n" "$*"; }
c_green() { printf "\033[32m%s\033[0m\n" "$*"; }
c_yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }
c_blue()  { printf "\033[34m%s\033[0m\n" "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { c_red "ERRO: dependência ausente: $1"; exit 1; }
}

ask_yes() {
  local prompt="$1"; local reply
  read -r -p "$prompt [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

require git
require yq
require jq

c_blue "==> claude-workspace setup"
c_blue "    REPO_ROOT=$REPO_ROOT"
c_blue "    CLAUDE_HOME=$CLAUDE_HOME"

# ---------- 1. claude-config -> ~/.claude ----------
mkdir -p "$CLAUDE_HOME"

copy_with_prompt() {
  local src="$1"; local dst="$2"
  if [[ -e "$dst" && ! -L "$dst" ]]; then
    if ! ask_yes "Arquivo já existe em $dst — sobrescrever?"; then
      c_yellow "    pulado: $dst"
      return 0
    fi
    cp -a "$dst" "$dst.bak.$(date +%s)"
    c_yellow "    backup criado: $dst.bak.*"
  fi
  cp -a "$src" "$dst"
  c_green "    copiado: $dst"
}

c_blue "==> Copiando claude-config para $CLAUDE_HOME"
for f in CLAUDE.md RTK.md nestjs-CLAUDE.md nextjs-CLAUDE.md; do
  [[ -f "$REPO_ROOT/claude-config/$f" ]] && copy_with_prompt "$REPO_ROOT/claude-config/$f" "$CLAUDE_HOME/$f"
done

# settings.json: substituir __HOME__ pelo $HOME real
SETTINGS_SRC="$REPO_ROOT/claude-config/settings.example.json"
SETTINGS_DST="$CLAUDE_HOME/settings.json"
if [[ -f "$SETTINGS_SRC" ]]; then
  if [[ -e "$SETTINGS_DST" ]] && ! ask_yes "$SETTINGS_DST já existe — sobrescrever?"; then
    c_yellow "    pulado: $SETTINGS_DST"
  else
    [[ -e "$SETTINGS_DST" ]] && cp -a "$SETTINGS_DST" "$SETTINGS_DST.bak.$(date +%s)"
    sed "s|__HOME__|$HOME|g" "$SETTINGS_SRC" > "$SETTINGS_DST"
    c_green "    gerado (com \$HOME=$HOME): $SETTINGS_DST"
  fi
fi

# Hooks
mkdir -p "$CLAUDE_HOME/hooks"
for h in "$REPO_ROOT/claude-config/hooks/"*; do
  [[ -f "$h" ]] || continue
  copy_with_prompt "$h" "$CLAUDE_HOME/hooks/$(basename "$h")"
  chmod +x "$CLAUDE_HOME/hooks/$(basename "$h")"
done

# Commands & agents (se existirem)
for sub in commands agents; do
  if [[ -d "$REPO_ROOT/claude-config/$sub" ]] && [[ -n "$(ls -A "$REPO_ROOT/claude-config/$sub" 2>/dev/null)" ]]; then
    mkdir -p "$CLAUDE_HOME/$sub"
    cp -a "$REPO_ROOT/claude-config/$sub/." "$CLAUDE_HOME/$sub/"
    c_green "    copiado: $CLAUDE_HOME/$sub/"
  fi
done

# mcp.json (só se o usuário preencheu)
if [[ -f "$REPO_ROOT/claude-config/mcp.json" ]]; then
  copy_with_prompt "$REPO_ROOT/claude-config/mcp.json" "$CLAUDE_HOME/mcp.json"
fi

# ---------- 2. skills/user -> ~/.claude/skills/user ----------
if [[ -d "$REPO_ROOT/skills/user" ]] && [[ -n "$(ls -A "$REPO_ROOT/skills/user" 2>/dev/null)" ]]; then
  c_blue "==> Linkando skills do usuário"
  mkdir -p "$CLAUDE_HOME/skills"
  if [[ -e "$CLAUDE_HOME/skills/user" ]] && ! ask_yes "$CLAUDE_HOME/skills/user já existe — substituir?"; then
    c_yellow "    pulado"
  else
    rm -rf "$CLAUDE_HOME/skills/user"
    cp -a "$REPO_ROOT/skills/user" "$CLAUDE_HOME/skills/user"
    c_green "    copiado: $CLAUDE_HOME/skills/user"
  fi
else
  c_yellow "==> skills/user vazio — nada a linkar"
fi

# ---------- 3. clonar projetos ----------
c_blue "==> Clonando projetos em $PROJECTS_DIR"
mkdir -p "$PROJECTS_DIR"

if [[ ! -f "$REPO_ROOT/projects.yml" ]]; then
  c_yellow "    projects.yml ausente — copie projects.yml.example pra projects.yml e edite"
  c_yellow "    pulando clone de projetos"
  count_projects=0
else
  count_projects=$(yq '.projects | length' "$REPO_ROOT/projects.yml")
fi
for ((i=0; i<count_projects; i++)); do
  name=$(yq -r ".projects[$i].name" "$REPO_ROOT/projects.yml")
  repo=$(yq -r ".projects[$i].repo" "$REPO_ROOT/projects.yml")
  branch=$(yq -r ".projects[$i].branch // \"main\"" "$REPO_ROOT/projects.yml")
  target="$PROJECTS_DIR/$name"
  if [[ -d "$target/.git" ]]; then
    c_yellow "    já existe: $name (pulado)"
    continue
  fi
  c_green "    clonando $name ($branch) -> $target"
  git clone --branch "$branch" "$repo" "$target" || c_red "    FALHA ao clonar $name"
done

# ---------- 4. *.example -> versão sem .example (quando não existe) ----------
c_blue "==> Materializando *.example onde aplicável"
while IFS= read -r -d '' ex; do
  dst="${ex%.example}"
  if [[ ! -e "$dst" ]]; then
    cp -a "$ex" "$dst"
    c_green "    criado: $dst (a partir de $(basename "$ex"))"
  fi
done < <(find "$REPO_ROOT" -name "*.example" -not -path "*/projects/*" -not -path "*/.git/*" -not -path "*/node_modules/*" -print0)

# server/.env from .env.example (handled above by the *.example loop, but
# ensure the file is loose-readable so docker compose env_file picks it up).
[[ -f "$REPO_ROOT/server/.env" ]] && chmod 600 "$REPO_ROOT/server/.env" 2>/dev/null || true

# ---------- 5. avisos finais ----------
c_blue "==> Plugins do Claude Code"
cat <<'PLUG'
   Os plugins abaixo já estão declarados no settings.json. Dentro do Claude Code,
   rode (apenas se ainda não estiverem instalados):

     /plugin marketplace add anthropics/claude-plugins-official
     /plugin marketplace add tirth8205/code-review-graph
     /plugin marketplace add obra/superpowers-marketplace
     /plugin marketplace add mksglu/context-mode
     /plugin marketplace add thedotmack/claude-mem

     /plugin install code-review-graph@code-review-graph
     /plugin install context-mode@context-mode
     /plugin install superpowers@superpowers-marketplace
     /plugin install claude-mem@thedotmack
PLUG

c_blue "==> .env files que precisam ser preenchidos manualmente:"
found_env=0
while IFS= read -r -d '' envfile; do
  echo "    - $envfile"
  found_env=1
done < <(find "$PROJECTS_DIR" -maxdepth 3 \( -name ".env.example" -o -name ".env.sample" -o -name ".env.template" \) -print0 2>/dev/null)
[[ $found_env -eq 0 ]] && c_yellow "    (nenhum .env.example encontrado nos projetos clonados)"

c_blue "==> Dependências externas a instalar manualmente:"
echo "    - rtk (https://github.com/rtk-ai/rtk) — usado pelo PreToolUse hook"
echo "    - jq — necessário para o rtk-rewrite hook"
echo "    - python3 — usado pelo project-lines-metric hook"
echo "    - node — usado pelo context-mode-cache-heal hook"
echo "    - (opcional) OTel collector em http://localhost:4318 para receber métricas"

# ---------- 6. Docker (opcional) ----------
c_blue "==> Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  c_green "    Docker $(docker --version | awk '{print $3}' | tr -d ',') + Compose $(docker compose version --short) detectados"
  if ask_yes "Buildar a imagem do claude-workspace agora?"; then
    (cd "$REPO_ROOT" && docker compose -f docker/docker-compose.yml build) \
      && c_green "    imagem buildada: claude-workspace:latest" \
      || c_red   "    falha no build (veja o output acima)"
  else
    c_yellow "    pulado — rode depois: make build"
  fi
  cat <<'DOCKER'

   Comandos úteis:
     make build    # builda a imagem
     make up       # sobe o container em background
     make shell    # abre bash dentro do container
     make down     # para o container
     make clean    # para e remove volumes
DOCKER
else
  c_yellow "    Docker e/ou docker compose não instalados — pulando."
  c_yellow "    Instale Docker Desktop pra usar o ambiente containerizado."
fi

c_green "==> Setup concluído."
