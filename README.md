# open-claude-server

Public boilerplate for running **Claude Code in Docker** with an HTTP wrapper, web UI, and optional Slack bot. Clone it, import your personal config, and get the same Claude Code environment (skills, hooks, agents, plugins) on any machine — without leaking secrets into the repo.

> This is the "empty" version of `claude-server`. No projects, agents or credentials shipped — only the scaffolding. You fill it with what's yours.

## Structure

```
open-claude-server/
├── docker/                       # Dockerfile + entrypoint
├── server/                       # HTTP wrapper for the claude CLI + web UI + Slack bot
│   ├── src/
│   ├── public/                   # vanilla JS UI at /ui
│   ├── package.json
│   └── env.example               # → rename to .env and fill in
├── workspace/claude-workspace/
│   ├── claude-config/            # ← EMPTY; fill with your config (~/.claude/)
│   ├── skills/user/              # ← EMPTY; your personal skills
│   ├── projects/                 # ← cloned by setup.sh (gitignored)
│   ├── projects.example.yml      # → rename to projects.yml and edit
│   ├── Makefile
│   └── setup.sh
├── docker-compose.yml
└── README.md
```

Two services in `docker-compose.yml`:

- **`claude`** — interactive shell (`docker compose run --rm claude`)
- **`server`** — HTTP wrapper exposing `claude` on `127.0.0.1:3010`, UI at `/ui`, optional Slack bot

## Requirements

- Docker + Docker Compose
- (Optional) Claude CLI on the host for local testing

## Setup on a new machine

```bash
git clone <this-repo> open-claude-server
cd open-claude-server

# 1. Materialize example files
cp server/env.example server/.env
cp workspace/claude-workspace/projects.example.yml workspace/claude-workspace/projects.yml

# 2. (Optional) Import your config — see section below
./scripts/import-config.sh        # or copy manually; instructions below

# 3. Run bootstrap (copies config into host ~/.claude if you want, and clones projects)
./workspace/claude-workspace/setup.sh

# 4. Bring it up
docker compose up -d --build

# 5. Interactive shell
docker compose run --rm claude

# 6. Inside the container, authenticate (once per machine)
claude login
# Credentials land in workspace/claude-workspace/claude-config/.credentials.json (gitignored)
```

## Importing your own config

`workspace/claude-workspace/claude-config/` is the equivalent of `~/.claude/` and gets mounted at `/home/claude/.claude/` inside the container. In the boilerplate it ships **empty** — you populate it with your own config.

### Option A — Import from your existing `~/.claude/`

If you already use Claude Code on the host, copy only what's portable and safe:

```bash
DEST=workspace/claude-workspace/claude-config

# Top-level instruction files (CLAUDE.md, RTK.md, etc.)
cp -a ~/.claude/CLAUDE.md       $DEST/ 2>/dev/null || true
cp -a ~/.claude/RTK.md          $DEST/ 2>/dev/null || true

# settings.json — REVIEW before committing; remove host-absolute paths
cp -a ~/.claude/settings.json   $DEST/settings.example.json
# (setup.sh replaces __HOME__ with the real $HOME when copying back)

# Hooks, agents, commands
cp -a ~/.claude/hooks    $DEST/ 2>/dev/null || true
cp -a ~/.claude/agents   $DEST/ 2>/dev/null || true
cp -a ~/.claude/commands $DEST/ 2>/dev/null || true

# Installed plugins (manifests, NOT the runtime cache)
mkdir -p $DEST/plugins
cp -a ~/.claude/plugins/known_marketplaces.json $DEST/plugins/ 2>/dev/null || true
cp -a ~/.claude/plugins/installed_plugins.json  $DEST/plugins/ 2>/dev/null || true

# MCP servers (review — may contain tokens)
cp -a ~/.claude/mcp.json $DEST/ 2>/dev/null || true
```

> ⚠️ **Before committing**, review `settings.json` and `mcp.json` for:
> - Host-absolute paths (`/Users/<you>/...`) → use `$HOME` or `__HOME__`
> - Tokens, API keys, OAuth secrets → move them to `server/.env` or shell env vars
> - References to private projects that don't exist on the target machine
>
> `.gitignore` already blocks `.credentials.json`, `sessions/`, `statsig/`, `cache/`,
> `backups/`, `history.jsonl`, `plugins/cache/` and `plugins/data/` — but read the diff
> before `git add .` anyway.

### Option B — Start from scratch

You don't have to import anything. Bring the container up, run `claude login`, and configure via the UI / Claude Code's own commands:

```bash
docker compose up -d --build
docker compose run --rm claude
# inside the container:
claude login
/plugin marketplace add ...
/plugin install ...
```

The generated config lands in `claude-config/` automatically (mounted volume), so it gets versioned in your private fork.

## Importing your projects

Edit `workspace/claude-workspace/projects.yml`:

```yaml
projects:
  - name: my-app
    repo: git@github.com:my-user/my-app.git
    branch: main
  - name: my-monorepo
    repo: https://github.com/my-org/my-monorepo.git
    branch: develop
```

Run `./workspace/claude-workspace/setup.sh` (or `make` from the Makefile) — it clones into `workspace/claude-workspace/projects/`, which is gitignored.

`projects.yml` itself is **also gitignored** — every fork user keeps their own private list. The only thing in the repo is `projects.example.yml`.

## Portable vs local

| Layer             | Where it lives                                             | Versioned?      |
| ----------------- | ---------------------------------------------------------- | --------------- |
| Config + skills   | `workspace/claude-workspace/claude-config/`                | ✅ in your fork |
| Project list      | `workspace/claude-workspace/projects.yml`                  | ❌ gitignored   |
| OAuth credentials | `claude-config/.credentials.json` (created by `claude login` in container) | ❌ gitignored |
| Server `.env`     | `server/.env`                                              | ❌ gitignored   |
| Cloned projects   | `workspace/claude-workspace/projects/`                     | ❌ gitignored   |
| SSH/gitconfig     | `~/.ssh`, `~/.gitconfig` (host, mounted read-only)         | ❌ never        |

Every machine/fork has its own credentials. The public boilerplate ships only structure and examples.

## HTTP server

Default bind: `127.0.0.1:3010` (localhost-only). Auth and rate-limit are **off** by default — turn them on before exposing publicly.

```bash
curl http://127.0.0.1:3010/health
```

```bash
curl -X POST http://127.0.0.1:3010/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Reply only with PONG"}'
```

Web UI: open `http://127.0.0.1:3010/ui` — list / create / edit / remove agents, with a "Run" button.

Full endpoint, session and env var docs: [`server/README.md`](server/README.md).

### Turning auth on before exposing

```bash
# server/.env
AUTH_ENABLED=true
API_TOKEN=<openssl rand -hex 32>
```

Restart `server`. Include `Authorization: Bearer <token>` on every request.

## Creating an agent

Agents live in `workspace/claude-workspace/claude-config/agents/` (global scope, mounted at `/home/claude/.claude/agents/`). Each agent is a `.md` file with YAML frontmatter.

Create `workspace/claude-workspace/claude-config/agents/my-agent.md`:

```markdown
---
name: my-agent
description: Short description — when this agent should be used
tools: Read, Bash, Edit
model: sonnet
---

Agent system prompt. Defines personality, constraints, response format.
```

Three ways to create one:

- **File**: drop the `.md` directly under `claude-config/agents/` as above.
- **UI**: open `/ui`, click "New agent", fill the form.
- **API**:
  ```bash
  curl -X POST http://127.0.0.1:3010/api/agents \
    -H "Content-Type: application/json" \
    -d '{
      "name": "my-agent",
      "description": "Short description",
      "tools": ["Read", "Bash", "Edit"],
      "model": "sonnet",
      "prompt": "Agent system prompt here."
    }'
  ```

Run an agent via `POST /api/agents/:name/run` with `{"message":"..."}`, via the UI's **Run** button, or by `@mentioning` it from another agent. Endpoint details in [`server/README.md`](server/README.md).

## Scheduling recurring jobs (crons)

The server has a built-in cron scheduler — agents fire on a schedule, optionally posting the response to Slack. Jobs are persisted to `claude-config/scheduled_jobs.json` and survive container restarts.

### Create a job

```bash
curl -X POST http://127.0.0.1:3010/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "name": "daily-standup",
    "expr": "0 9 * * 1-5",
    "agent": "my-agent",
    "message": "Summarize what changed in the repo since yesterday",
    "destination": { "type": "slack", "channel": "#standup" },
    "catchUp": true
  }'
```

Fields:

| Field          | Required | Notes                                                                   |
| -------------- | -------- | ----------------------------------------------------------------------- |
| `expr`         | yes      | Standard cron expression (5 fields). Container timezone is UTC by default. |
| `agent`        | yes      | Agent name (must exist under `claude-config/agents/`).                  |
| `message`      | yes      | Prompt sent to the agent on each firing.                                |
| `name`         | no       | Friendly label; falls back to a generated id.                           |
| `destination`  | no       | `{type:"slack", channel:"#channel"}` to post the response to Slack.     |
| `catchUp`      | no       | If `true`, runs missed firings on container startup (within `catchUpWindowMs`). |

### Manage jobs

```bash
curl http://127.0.0.1:3010/api/jobs                  # list
curl http://127.0.0.1:3010/api/jobs/<id>             # detail
curl -X POST http://127.0.0.1:3010/api/jobs/<id>/run # fire now
curl -X DELETE http://127.0.0.1:3010/api/jobs/<id>   # remove
```

## Syncing Claude memory from host to container

When `auto-memory` is on, Claude Code writes per-project `MEMORY.md` files into `~/.claude/projects/<encoded-project-path>/memory/`. The path is derived from your project dir on the **host** — so memory written on the host won't show up inside the container (and vice-versa) unless you bind-mount it.

`docker-compose.yml` already wires this up:

```yaml
- ${PROJECT_MEMORY_HOST_DIR:-${HOME}/.claude/projects/-Users-<you>-Documents-Projects-open-claude-server/memory}:/home/claude/.claude/projects/-workspace-projects/memory
```

The container always reads/writes memory from the **`-workspace-projects`** encoding (because `CLAUDE_CWD=/workspace/projects` inside). The host side defaults to the encoding of *this* clone path, which only matches if your clone lives at `~/Documents/Projects/open-claude-server` for user `<you>`.

### When you need to override

If your clone lives somewhere else, or you want to reuse memory written by Claude Code running directly on the host against a different project, set `PROJECT_MEMORY_HOST_DIR` in `server/.env`:

```bash
# server/.env
PROJECT_MEMORY_HOST_DIR=/Users/me/.claude/projects/-Users-me-code-my-project/memory
```

Find the right encoding by listing `~/.claude/projects/` on the host — directory names there mirror the absolute path with `/` replaced by `-`.

### One-shot copy (instead of a live mount)

If you'd rather seed the container's memory once without keeping it in sync:

```bash
# from the host
SRC=~/.claude/projects/-Users-me-code-my-project/memory
DST=workspace/claude-workspace/claude-config/projects/-workspace-projects/memory
mkdir -p "$DST"
cp -a "$SRC"/. "$DST"/
```

Then remove (or leave) the `PROJECT_MEMORY_HOST_DIR` bind line — the files now live under `claude-config/`, which is already mounted.

## Connecting to Slack (optional)

`server` ships a Slack bot (Socket Mode) that routes messages to an agent.

### 1. Create a Slack App

1. https://api.slack.com/apps → **Create New App** → **From scratch**
2. **Socket Mode** → enable + generate an **App-Level Token** with scope `connections:write` → save as `SLACK_APP_TOKEN` (`xapp-...`)
3. **OAuth & Permissions** → Bot Token Scopes:
   - `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`
4. **Event Subscriptions** → enable → subscribe to `app_mention` and `message.im`
5. **App Home** → enable **Messages Tab** + check "Allow users to send Slash commands and messages from the messages tab"
6. **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`) as `SLACK_BOT_TOKEN`

### 2. Configure `server/.env`

```
SLACK_ENABLED=true
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_AGENT=my-agent
```

### 3. Restart

```bash
docker compose up -d --build server
docker compose logs -f server   # look for "slack bot connected"
```

Mention the bot in a channel (`@bot ...`) or DM it from the Messages Tab.

## Security

- `claude login` runs **inside the container** — credentials land in `claude-config/.credentials.json` (gitignored)
- macOS stores credentials in Keychain by default; running `claude login` in the Linux container creates a standalone file with no Keychain dependency
- `.gitignore` blocks `.env`, `sessions/`, `statsig/`, `cache/`, `backups/`, `history`, plugin runtime data
- Container runs as the `claude` user (UID 501), not root
- SSH keys: copied by the entrypoint into `$HOME/.ssh` with `0600` perms
- **Before committing imported config**: review `settings.json`, `mcp.json` and any hooks for absolute paths, tokens or private references

## Forking

The intent is for you to **fork** this repo, import your config, and keep your fork **private** (since `claude-config/` will have things you'd rather not publish — agents, hooks, personal prompts).

```bash
gh repo fork <this-repo> --clone --remote=upstream
git remote set-url origin git@github.com:<you>/open-claude-server.git
# make it private on GitHub (Settings → Danger Zone → Change visibility)
```

To pull updates from the boilerplate:

```bash
git fetch upstream
git merge upstream/main
```

## License

MIT.
