#!/usr/bin/env bash
# setup-host-claude.sh
# Instala Claude CLI + worker HTTP no host (Ubuntu/Debian) e expõe pra
# o container `claude-server`. Idempotente: pode rodar várias vezes.
#
# Uso na VPS:
#   sudo CLAUDE_WORKER_TOKEN="<segredo>" ./setup-host-claude.sh
#
# Variáveis (todas opcionais menos CLAUDE_WORKER_TOKEN):
#   CLAUDE_WORKER_USER   usuário do host que vai rodar o worker (default: claude)
#   CLAUDE_WORKER_PORT   porta TCP do worker (default: 3011)
#   CLAUDE_WORKER_HOME   home do usuário (default: /home/$CLAUDE_WORKER_USER)
#   NODE_MAJOR           major do Node (default: 22)
#   CLAUDE_WORKER_TOKEN  segredo compartilhado entre worker e container (obrigatório)

set -euo pipefail

CLAUDE_WORKER_USER="${CLAUDE_WORKER_USER:-claude}"
CLAUDE_WORKER_PORT="${CLAUDE_WORKER_PORT:-3011}"
CLAUDE_WORKER_HOME="${CLAUDE_WORKER_HOME:-/home/${CLAUDE_WORKER_USER}}"
NODE_MAJOR="${NODE_MAJOR:-22}"
CLAUDE_WORKER_TOKEN="${CLAUDE_WORKER_TOKEN:?Defina CLAUDE_WORKER_TOKEN com um segredo forte}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_SRC="${REPO_DIR}/scripts/host-claude-worker.mjs"
WORKER_DST="${CLAUDE_WORKER_HOME}/claude-worker/worker.mjs"
SERVICE_FILE="/etc/systemd/system/claude-worker.service"

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "[setup] precisa rodar como root (use sudo)." >&2
    exit 1
  fi
}

log() { echo "[setup] $*"; }

ensure_user() {
  if ! id "$CLAUDE_WORKER_USER" >/dev/null 2>&1; then
    log "criando usuário ${CLAUDE_WORKER_USER}"
    useradd --create-home --shell /bin/bash "$CLAUDE_WORKER_USER"
  else
    log "usuário ${CLAUDE_WORKER_USER} já existe"
  fi
}

install_apt_deps() {
  log "atualizando apt e instalando dependências base"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg git jq
}

install_node() {
  if command -v node >/dev/null 2>&1 && node -v | grep -q "^v${NODE_MAJOR}"; then
    log "Node v${NODE_MAJOR} já instalado ($(node -v))"
    return
  fi
  log "instalando Node.js ${NODE_MAJOR}.x via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
}

install_claude_cli() {
  if sudo -u "$CLAUDE_WORKER_USER" bash -lc 'command -v claude' >/dev/null 2>&1; then
    log "Claude CLI já presente para ${CLAUDE_WORKER_USER}"
  else
    log "instalando @anthropic-ai/claude-code global"
    npm install -g @anthropic-ai/claude-code
  fi
  sudo -u "$CLAUDE_WORKER_USER" bash -lc 'claude --version' || {
    echo "[setup] Claude CLI não respondeu pra ${CLAUDE_WORKER_USER}" >&2
    exit 1
  }
}

deploy_worker() {
  install -d -o "$CLAUDE_WORKER_USER" -g "$CLAUDE_WORKER_USER" -m 0750 \
    "${CLAUDE_WORKER_HOME}/claude-worker"
  if [[ ! -f "$WORKER_SRC" ]]; then
    echo "[setup] worker source não encontrado em $WORKER_SRC" >&2
    exit 1
  fi
  install -o "$CLAUDE_WORKER_USER" -g "$CLAUDE_WORKER_USER" -m 0640 \
    "$WORKER_SRC" "$WORKER_DST"
  log "worker copiado para $WORKER_DST"
}

write_env_file() {
  local env_file="${CLAUDE_WORKER_HOME}/claude-worker/.env"
  umask 077
  cat >"$env_file" <<EOF
CLAUDE_WORKER_PORT=${CLAUDE_WORKER_PORT}
CLAUDE_WORKER_TOKEN=${CLAUDE_WORKER_TOKEN}
CLAUDE_BIN=$(sudo -u "$CLAUDE_WORKER_USER" bash -lc 'command -v claude')
CLAUDE_WORKER_CWD=${CLAUDE_WORKER_HOME}
EOF
  chown "$CLAUDE_WORKER_USER:$CLAUDE_WORKER_USER" "$env_file"
  chmod 0600 "$env_file"
  log "env file gravado em $env_file"
}

write_systemd_unit() {
  log "escrevendo unit systemd em $SERVICE_FILE"
  cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Claude Code host worker (HTTP bridge for containerized server)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${CLAUDE_WORKER_USER}
WorkingDirectory=${CLAUDE_WORKER_HOME}/claude-worker
EnvironmentFile=${CLAUDE_WORKER_HOME}/claude-worker/.env
ExecStart=/usr/bin/node ${WORKER_DST}
Restart=on-failure
RestartSec=3
# Isolamento básico
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only
ReadWritePaths=${CLAUDE_WORKER_HOME}
PrivateTmp=true
# Bind só na interface docker bridge / loopback — ajuste se quiser expor externo
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable claude-worker.service
  systemctl restart claude-worker.service
  sleep 1
  systemctl --no-pager --full status claude-worker.service | head -n 20 || true
}

open_firewall_hint() {
  cat <<EOF

[setup] worker escutando em 0.0.0.0:${CLAUDE_WORKER_PORT}
        - Container acessa via host.docker.internal:${CLAUDE_WORKER_PORT}
          (precisa de 'extra_hosts: ["host.docker.internal:host-gateway"]'
           no docker-compose.yml do serviço 'server')
        - Bloqueie a porta externamente:
            ufw deny ${CLAUDE_WORKER_PORT}/tcp
          OU bindе só na docker bridge ajustando CLAUDE_WORKER_BIND no .env.

Próximos passos:
  1. No docker-compose.yml, no serviço 'server', adicione:
       extra_hosts:
         - "host.docker.internal:host-gateway"
       environment:
         CLAUDE_BIN: /workspace/server/scripts/claude-bridge.mjs
         CLAUDE_WORKER_URL: http://host.docker.internal:${CLAUDE_WORKER_PORT}
         CLAUDE_WORKER_TOKEN: \${CLAUDE_WORKER_TOKEN}
  2. Copie scripts/claude-bridge.mjs pra dentro do projeto (já no repo).
  3. Garanta que .env do host (raiz do projeto) tem CLAUDE_WORKER_TOKEN igual.
  4. docker compose up -d server
EOF
}

main() {
  require_root
  ensure_user
  install_apt_deps
  install_node
  install_claude_cli
  deploy_worker
  write_env_file
  write_systemd_unit
  open_firewall_hint
  log "concluído."
}

main "$@"
