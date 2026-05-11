# open-claude-server

Boilerplate público para rodar o **Claude Code em Docker** com um wrapper HTTP, UI web e bot Slack opcional. Clone, importe sua config pessoal, e tenha o mesmo ambiente do Claude Code (skills, hooks, agents, plugins) em qualquer máquina, sem expor segredos no repo.

> Esta é a versão "vazia" do [`claude-server`](../). Não traz projetos, agents ou credenciais — só a estrutura. Você popula com o que for seu.

## Estrutura

```
open-claude-server/
├── docker/                       # Dockerfile + entrypoint
├── server/                       # HTTP wrapper do claude CLI + UI web + bot Slack
│   ├── src/
│   ├── public/                   # UI vanilla JS em /ui
│   ├── package.json
│   └── env.example               # → renomeie para .env e preencha
├── workspace/claude-workspace/
│   ├── claude-config/            # ← VAZIO; você popula com sua config (~/.claude/)
│   ├── skills/user/              # ← VAZIO; suas skills pessoais
│   ├── projects/                 # ← clonado pelo setup.sh (gitignored)
│   ├── projects.yml.example      # → renomeie para projects.yml e edite
│   ├── Makefile
│   └── setup.sh
├── docker-compose.yml
└── README.md
```

Dois serviços no `docker-compose.yml`:

- **`claude`** — shell interativo (`docker compose run --rm claude`)
- **`server`** — HTTP wrapper expondo `claude` em `127.0.0.1:3010`, UI em `/ui`, bot Slack opcional

## Pré-requisitos

- Docker + Docker Compose
- (Opcional) Claude CLI no host pra teste local

## Setup numa máquina nova

```bash
git clone <este-repo> open-claude-server
cd open-claude-server

# 1. Materializar arquivos de exemplo
cp server/env.example server/.env
cp workspace/claude-workspace/projects.yml.example workspace/claude-workspace/projects.yml

# 2. (Opcional) Importar sua config — ver seção abaixo
./scripts/import-config.sh        # ou copiar manualmente; instruções abaixo

# 3. Rodar bootstrap (copia config pro ~/.claude do host se quiser, e clona projetos)
./workspace/claude-workspace/setup.sh

# 4. Subir
docker compose up -d --build

# 5. Shell interativo
docker compose run --rm claude

# 6. Dentro do container, autenticar (uma vez por máquina)
claude login
# Credenciais ficam em workspace/claude-workspace/claude-config/.credentials.json (gitignored)
```

## Importando sua própria config

`workspace/claude-workspace/claude-config/` é o equivalente do `~/.claude/` que vai ser montado em `/home/claude/.claude/` dentro do container. No boilerplate ele vem **vazio** — você precisa popular com a sua config.

### Opção A — Importar do `~/.claude/` existente

Se você já usa Claude Code no host, copie só o que é portável e seguro:

```bash
DEST=workspace/claude-workspace/claude-config

# Arquivos top-level de instruções (CLAUDE.md, RTK.md, etc.)
cp -a ~/.claude/CLAUDE.md       $DEST/ 2>/dev/null || true
cp -a ~/.claude/RTK.md          $DEST/ 2>/dev/null || true

# settings.json — REVISE antes de commitar; remova caminhos absolutos do host
cp -a ~/.claude/settings.json   $DEST/settings.example.json
# (setup.sh substitui __HOME__ pelo $HOME real ao copiar de volta)

# Hooks, agents, commands
cp -a ~/.claude/hooks    $DEST/ 2>/dev/null || true
cp -a ~/.claude/agents   $DEST/ 2>/dev/null || true
cp -a ~/.claude/commands $DEST/ 2>/dev/null || true

# Plugins instalados (manifests, NÃO o cache de runtime)
mkdir -p $DEST/plugins
cp -a ~/.claude/plugins/known_marketplaces.json $DEST/plugins/ 2>/dev/null || true
cp -a ~/.claude/plugins/installed_plugins.json  $DEST/plugins/ 2>/dev/null || true

# MCP servers (revise — pode ter tokens)
cp -a ~/.claude/mcp.json $DEST/ 2>/dev/null || true
```

> ⚠️ **Antes de commitar**, revise `settings.json` e `mcp.json` por:
> - Caminhos absolutos do seu host (`/Users/<você>/...`) → use `$HOME` ou `__HOME__`
> - Tokens, API keys, OAuth secrets → mova pra `server/.env` ou variáveis do shell
> - Referências a projetos privados que não existem na máquina destino
>
> O `.gitignore` já bloqueia `.credentials.json`, `sessions/`, `statsig/`, `cache/`,
> `backups/`, `history.jsonl`, `plugins/cache/` e `plugins/data/` — mas leia o diff
> antes do `git add .` mesmo assim.

### Opção B — Começar do zero

Não precisa importar nada. Suba o container, rode `claude login`, e configure pela UI / pelos comandos do próprio Claude Code:

```bash
docker compose up -d --build
docker compose run --rm claude
# dentro do container:
claude login
/plugin marketplace add ...
/plugin install ...
```

A config gerada cai em `claude-config/` automaticamente (volume montado), então fica versionada no seu fork privado.

## Importando seus projetos

Edite `workspace/claude-workspace/projects.yml`:

```yaml
projects:
  - name: meu-app
    repo: git@github.com:meu-user/meu-app.git
    branch: main
  - name: meu-monorepo
    repo: https://github.com/meu-org/meu-monorepo.git
    branch: develop
```

Rode `./workspace/claude-workspace/setup.sh` (ou `make` no Makefile) — clona em `workspace/claude-workspace/projects/`, que está gitignored.

`projects.yml` em si **também está gitignored** — cada usuário do fork mantém sua própria lista privada. O que vai pro repo é só `projects.yml.example`.

## O que é portável vs local

| Camada            | Onde mora                                                  | Versionado?   |
| ----------------- | ---------------------------------------------------------- | ------------- |
| Config + skills   | `workspace/claude-workspace/claude-config/`                | ✅ no seu fork |
| Lista de projetos | `workspace/claude-workspace/projects.yml`                  | ❌ gitignored  |
| Credenciais OAuth | `claude-config/.credentials.json` (gerado por `claude login` no container) | ❌ gitignored  |
| `.env` do server  | `server/.env`                                              | ❌ gitignored  |
| Projetos clonados | `workspace/claude-workspace/projects/`                     | ❌ gitignored  |
| SSH/gitconfig     | `~/.ssh`, `~/.gitconfig` (host, montado read-only)         | ❌ nunca       |

Cada máquina/fork tem suas credenciais. O boilerplate público só carrega estrutura e exemplos.

## HTTP server

Bind padrão: `127.0.0.1:3010` (localhost-only). Auth e rate-limit **off** por padrão — ative antes de expor publicamente.

```bash
curl http://127.0.0.1:3010/health
```

```bash
curl -X POST http://127.0.0.1:3010/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Responda apenas com PONG"}'
```

UI web: abra `http://127.0.0.1:3010/ui` — lista/cria/edita/remove agents e tem botão "Run".

Documentação completa de endpoints, sessões e variáveis: [`server/README.md`](server/README.md).

### Ativando auth antes de expor

```bash
# server/.env
AUTH_ENABLED=true
API_TOKEN=<openssl rand -hex 32>
```

Reinicie o `server`. Inclua `Authorization: Bearer <token>` em todas as requisições.

## Configurando um agente

Agents ficam em `workspace/claude-workspace/claude-config/agents/` (escopo global, montado em `/home/claude/.claude/agents/`). Cada agent é um `.md` com frontmatter YAML.

Crie `workspace/claude-workspace/claude-config/agents/meu-agente.md`:

```markdown
---
name: meu-agente
description: Descrição curta — quando este agente deve ser usado
tools: Read, Bash, Edit
model: sonnet
---

System prompt do agente. Define personalidade, restrições, formato de resposta.
```

Ou via UI (`/ui`), ou via API (`POST /api/agents`). Detalhes em [`server/README.md`](server/README.md).

## Conectando ao Slack (opcional)

O `server` inclui um bot Slack (Socket Mode) que roteia mensagens pra um agent.

### 1. Criar Slack App

1. https://api.slack.com/apps → **Create New App** → **From scratch**
2. **Socket Mode** → habilite + gere **App-Level Token** com scope `connections:write` → guarda como `SLACK_APP_TOKEN` (`xapp-...`)
3. **OAuth & Permissions** → Bot Token Scopes:
   - `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`
4. **Event Subscriptions** → habilite → assine `app_mention` e `message.im`
5. **App Home** → habilite **Messages Tab** + marque "Allow users to send Slash commands and messages from the messages tab"
6. **Install to Workspace** → copia o **Bot User OAuth Token** (`xoxb-...`) como `SLACK_BOT_TOKEN`

### 2. Configurar `server/.env`

```
SLACK_ENABLED=true
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_AGENT=meu-agente
```

### 3. Reiniciar

```bash
docker compose up -d --build server
docker compose logs -f server   # confirma "slack bot connected"
```

Mention em canal (`@bot ...`) ou DM direto pelo Messages Tab.

## Segurança

- `claude login` roda **dentro do container** — credenciais ficam em `claude-config/.credentials.json` (gitignored)
- macOS guarda credenciais no Keychain por padrão; rodar `claude login` no container Linux gera arquivo separado, sem depender de Keychain
- `.gitignore` bloqueia `.env`, `sessions/`, `statsig/`, `cache/`, `backups/`, `history`, plugin runtime
- Container roda como user `claude` (UID 501), não root
- SSH keys: copiadas pelo entrypoint pra `$HOME/.ssh` com perms `0600`
- **Antes de commitar config importada**: revise `settings.json`, `mcp.json` e qualquer hook por caminhos absolutos, tokens ou referências privadas

## Forkando

A intenção é que você **forke** este repo, importe sua config, e mantenha seu fork **privado** (já que `claude-config/` vai ter coisas que você prefere não publicar — agents, hooks, prompts pessoais).

```bash
gh repo fork <este-repo> --clone --remote=upstream
git remote set-url origin git@github.com:<você>/open-claude-server.git
# torne privado no GitHub (Settings → Danger Zone → Change visibility)
```

Pra puxar updates do boilerplate:

```bash
git fetch upstream
git merge upstream/main
```

## Licença

MIT.
