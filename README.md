# claude-server

REST + Slack wrapper around the Claude Code CLI. Runs the CLI inside a sandboxed Linux container with bind-mounted credentials, per-agent env, JSONL usage telemetry, persistent cron jobs, and a multi-bot Slack integration.

This repo contains **only the runtime** (HTTP API + container + scripts). Your private agents, skills, projects, and memory live in a separate workspace repo that gets bind-mounted at run time. See `workspace/claude-workspace.example/` for the contract.

## Layout

```
.
├── server/                              # TypeScript HTTP server (Express + tsx)
│   └── src/                             # routes, claudeClient, scheduler, slack, usage telemetry
├── docker/                              # Dockerfile + entrypoint
├── scripts/                             # claude-bridge, host-claude-worker, setup-host-claude
├── docker-compose.yml                   # parameterised by ${WORKSPACE_DIR}
├── env.example                          # copy to .env, fill secrets, point WORKSPACE_DIR
└── workspace/
    └── claude-workspace.example/        # template — replace via WORKSPACE_DIR env var
```

## Quick start

Each mode is a single command. Both are idempotent — re-running picks up where you left off.

```bash
./scripts/start-container.sh   # Mode A: claude + server in containers
# OR
./scripts/start-host.sh        # Mode B: claude on host, server in container
```

Each script: bootstraps templates (`.env`, `workspace/claude-workspace/`, `projects.yml`), builds the image if missing, starts everything. Then:

```bash
curl -s http://127.0.0.1:3010/health | jq
```

## Run modes

Two ways to wire the `claude` CLI to the server. Pick one — they are mutually exclusive.

### Mode A — claude + server in containers (default)

`./scripts/start-container.sh` brings up both services (`claude-workspace` + `claude-server`). The server spawns `claude` from the image's PATH (installed by `docker/Dockerfile`).

- Use claude interactively: `docker exec -it claude-workspace claude`
- Shell into the workspace: `docker exec -it claude-workspace bash`
- Stop: `docker compose down`

#### Authenticate claude (Mode A — required before testing anything)

The `claude-server` container spawns `claude` on every Slack message, cron tick, and `/chat` request. Without credentials, **every spawn fails**. You must log in **inside the workspace container** because the credentials file lives in the container-mounted `claude-config/` dir.

1. Open an interactive Claude session inside the workspace container:
   ```bash
   docker exec -it claude-workspace claude
   ```
2. In the Claude TUI, run `/login` and follow the flow (Anthropic Console API key, Claude.ai subscription, or AWS Bedrock). For browser-based flows, copy the printed URL into your host browser and paste the returned code back into the prompt.
3. Confirm it stuck without leaving the TUI:
   ```
   /status
   ```
   Should report `Logged in as <you>` with a non-empty model. Exit with `Ctrl+C` twice or `/quit`.
4. Verify the credentials file persisted to the host:
   ```bash
   ls workspace/claude-workspace/claude-config/.credentials.json
   ```

> `claude-workspace` and `claude-server` share the same `claude-config/` bind mount, so a single login covers both containers. You do **not** need to re-login on `claude-server`.

To test the Slack integration after logging in, jump to [Slack bots](#slack-bots).

### Mode B — claude on host, server in container

**Host prerequisites** (the script installs the ones it can):

- Node.js + `npm` (required by `@anthropic-ai/claude-code` and `claude-mem`). Install manually before running the script.
- `docker` / `docker compose` (required by step 6).
- `sudo` access to a package manager (`apt-get` or `brew`) — needed to install `gh` automatically. Without it, install `gh` manually first: <https://github.com/cli/cli#installation>.
- Auto-installed by the script if missing: `gh`, `claude` (`@anthropic-ai/claude-code`), `claude-mem`.

`./scripts/start-host.sh` does the full setup on top of Mode B:

1. Bootstraps templates.
2. Generates `CLAUDE_WORKER_TOKEN` in `.env` if blank.
3. Installs host CLIs if missing: `gh` (apt/brew), `@anthropic-ai/claude-code`, `claude-mem`. **`gh` is required** because agents shell out to it to read GitHub issues/PRs/projects from the host — in Mode B that runs on the host, not in the container.
4. (3b) Creates host overlay symlinks so the host `claude` sees the same config the container does:
   - `/workspace/projects` → `workspace/claude-workspace/projects` (same cwd as the container, so `claude-mem`'s encoded memory dir matches).
   - `~/.claude/{agents,hooks,skills,*.md}` → `workspace/claude-workspace/{claude-config,skills}/...`.
   - `~/.claude/plugins` and `~/.claude/settings.json` are **never** touched (they hold host state and `claude-mem` hooks).
5. Builds the image if missing.
6. Starts `scripts/host-claude-worker.mjs` in the background (pid `.host-claude-worker.pid`, log `.host-claude-worker.log`).
7. Brings up only the `server` service. Sets `CLAUDE_BIN=/workspace/scripts/claude-bridge.mjs`, which proxies all in-container spawns to the host worker at `host.docker.internal:3011`.

- `host.docker.internal` is mapped via `extra_hosts` so it works on Linux too.
- Stop: `docker compose down && kill $(cat .host-claude-worker.pid) && rm .host-claude-worker.pid`

#### GitHub access (Mode B)

See [GitHub tokens (Mode A and Mode B)](#github-tokens-mode-a-and-mode-b) — configuration is shared across both modes.

#### Authenticate claude (Mode B — required before testing anything)

In this mode the actual `claude` process runs on the **host**, spawned by `host-claude-worker.mjs`. Credentials live in your host's `~/.claude/.credentials.json` (not inside the workspace dir). Log in there:

1. Run, on the host shell (not inside any container):
   ```bash
   claude
   ```
2. In the TUI, run `/login` and complete the flow.
3. Verify:
   ```bash
   claude /status                          # should say "Logged in as ..."
   ls ~/.claude/.credentials.json          # should exist
   ```
4. Sanity-check that the bridge can reach the worker:
   ```bash
   curl -s http://127.0.0.1:3011/health    # {"ok":true,"inflight":0,...}
   ```

> Restarting the worker (`./scripts/start-host.sh` again) does **not** invalidate the login — credentials are reused from `~/.claude/`.

#### Restart after editing `.env` (Mode B)

Env vars from the root `.env` are read **once at startup** in two places: the server container (via `docker-compose.yml`) and the host worker (via `start-host.sh`'s `set -a; . ./.env`). After editing values like `GH_TOKEN`, `API_TOKEN`, or `SLACK_*`, both processes need to be restarted to pick them up.

Full restart (covers both):

```bash
cd <repo>
# 1. Kill the host worker (free :3011 and drop the stale env).
kill "$(cat .host-claude-worker.pid)" 2>/dev/null && rm -f .host-claude-worker.pid

# 2. Recreate the server container so it re-reads the env.
docker compose up -d --force-recreate server

# 3. Re-run the bootstrap script: it re-exports .env, restarts the worker, and
#    re-checks the symlinks. Idempotent — login is preserved.
./scripts/start-host.sh
```

Verify the new value propagated:

```bash
# Container:
docker exec claude-server printenv GH_TOKEN | head -c 8 ; echo
# Host worker:
tr '\0' '\n' < /proc/$(cat .host-claude-worker.pid)/environ | grep ^GH_TOKEN= | head -c 18 ; echo
```

> Just `docker compose restart server` is **not** enough — it keeps the old environment. Use `--force-recreate` so the container is recreated with the updated `.env` values. Likewise, the host worker must be killed and re-spawned; sending `SIGHUP` does not reload env.

To test the Slack integration after logging in, jump to [Slack bots](#slack-bots).

## GitHub tokens (Mode A and Mode B)

Agents that hit GitHub need a token. The token can be a **single global value** shared by every agent, or **per-agent overrides** layered on top. Both modes read the same variables from the **root `.env`** file — there is no per-mode config.

### Variables

| Variable | Purpose |
|---|---|
| `GH_TOKEN` | Global fallback. Used by every spawn that has no per-agent override. Also used by the host `gh` CLI when invoked manually. |
| `GITHUB_TOKEN` | Alias of `GH_TOKEN`. Recognized by `gh` and most GitHub SDKs. Mirrored automatically from `GH_TOKEN` in `docker-compose.yml`. |
| `GH_TOKEN_<AGENT_SLUG>` | Per-agent override. Overrides `GH_TOKEN` only for that agent. Slug is the agent name in UPPER_SNAKE_CASE (`my-agent` → `MY_AGENT`, `hello-agent` → `HELLO_AGENT`). |
| `GITHUB_TOKEN_<AGENT_SLUG>` | Alias of the above. Use either; both are checked. |

### Minimal setup (global token only)

```bash
# .env
GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxx
```

Required scopes:
- `repo` — issues, PRs, commits, contents.
- `read:project` — only if your agents read Projects v2 boards.

Validate:
```bash
GH_TOKEN=$(grep ^GH_TOKEN= .env | cut -d= -f2-) gh api user --jq .login
```

### Per-agent overrides (optional)

Use this when different agents should authenticate as different bots/users — e.g. a planner agent creates issues as the tech-lead account, a monitor agent reads from a read-only account, a developer agent commits as a CI bot, a reviewer agent uses a separate reviewer identity.

```bash
# .env
GH_TOKEN=ghp_globalFallback...           # used by any agent without an override

GH_TOKEN_PLANNER=ghp_plannerToken...     # agent slug: planner
GH_TOKEN_MONITOR=ghp_monitorToken...     # agent slug: monitor
GH_TOKEN_DEVELOPER=ghp_devToken...       # agent slug: developer
GH_TOKEN_REVIEWER=ghp_reviewerToken...   # agent slug: reviewer
```

Resolution rules (`server/src/services/agentEnv.ts`):

1. If `GH_TOKEN_<AGENT>` (or `GITHUB_TOKEN_<AGENT>`) is set → that agent's spawn gets it as both `GH_TOKEN` and `GITHUB_TOKEN`.
2. Otherwise → falls back to the global `GH_TOKEN`.

### Where the variables travel

| Path | Mode A | Mode B |
|---|---|---|
| Server-spawned (Slack DM/mention, cron job, `POST /api/agents/:name/run`) | server reads `GH_TOKEN_<AGENT>` → spawns `claude` in same container with resolved env | server reads `GH_TOKEN_<AGENT>` → spawns `claude-bridge.mjs` → bridge forwards `GH_TOKEN`/`GITHUB_TOKEN` to host worker → host `claude` runs with resolved env |
| Interactive `claude` TUI | `claude-workspace` container loads root `.env` via `env_file`; subagents inherit the env | host shell loads root `.env` via `start-host.sh` (`set -a`); subagents inherit the env |

Subagents share `process.env` with the parent `claude`, so per-agent **isolation at the process level** is not possible from env alone. The workaround is to have each agent prefix every `gh` call with its own variable explicitly, falling back to the global when undefined:

```bash
GH_TOKEN="${GH_TOKEN_MY_AGENT:-$GH_TOKEN}" gh issue list ...
```

The `${VAR:-fallback}` syntax picks the agent token when defined, falls back to the global otherwise. For any agent that talks to GitHub, add an instruction to its `.md` definition telling it to prefix `gh` invocations this way, replacing `MY_AGENT` with that agent's UPPER_SNAKE_CASE slug.

### Applying changes

Both `claude-workspace` and `claude-server` containers, plus the host worker, read `.env` **at startup**. After editing any `GH_TOKEN_*`, restart per [Restart after editing `.env` (Mode B)](#restart-after-editing-env-mode-b). In Mode A, replace the worker steps with just `docker compose up -d --force-recreate`.

Verify the per-agent value landed where you expect (replace `MY_AGENT` with your agent's slug):
```bash
# server container
docker exec claude-server printenv GH_TOKEN_MY_AGENT | head -c 8 ; echo
# claude-workspace container (Mode A only)
docker exec claude-workspace printenv GH_TOKEN_MY_AGENT | head -c 8 ; echo
# host worker (Mode B only)
tr '\0' '\n' < /proc/$(cat .host-claude-worker.pid)/environ | grep ^GH_TOKEN_MY_AGENT= | head -c 22 ; echo
```

## Slack bots

Works the same in **both Mode A and Mode B** — once `claude` is logged in (see the per-mode auth subsection above), the server is what talks to Slack. Multi-bot Bolt app over Socket Mode; each bot maps to one agent.

### 1. Create the Slack app

Follow Slack's wizard to create a Socket Mode app and grab two tokens. The required scopes and the exact click-path are kept in their docs (they change occasionally):

- Create app: <https://api.slack.com/apps> → **Create New App** → **From scratch**.
- Socket Mode + App-Level token (`xapp-...`): <https://api.slack.com/apis/socket-mode>.
- Bot user + OAuth Bot Token (`xoxb-...`): <https://api.slack.com/authentication/token-types#bot>.
- Required bot scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `im:history`, `im:read`, `im:write`, `users:read` — reference at <https://api.slack.com/scopes>.
- App-level token scope: `connections:write` — required by Socket Mode.

Install the app to your workspace at the end of the wizard. Copy the **Bot User OAuth Token** and the **App-Level Token**.

### 2. Wire the tokens into `.env`

Single-bot setup (simplest):

```bash
cat >> .env <<'EOF'
SLACK_ENABLED=true
SLACK_BOT_NAME=hello
SLACK_AGENT=hello-agent
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
EOF
```

Multi-bot setup (one socket connection per bot, each pinned to its own agent) — set `SLACK_BOTS` to a JSON array instead of the single-bot vars:

```bash
SLACK_BOTS='[{"name":"hello","agent":"hello-agent","botToken":"xoxb-A","appToken":"xapp-A"},{"name":"scheduler","agent":"scheduler","botToken":"xoxb-B","appToken":"xapp-B"}]'
```

`SLACK_AGENT` / `agent` must match a file at `workspace/claude-workspace/claude-config/agents/<name>.md`. The example workspace ships `scheduler.md`. To use a different name, drop a new agent file there first.

### 3. Reload the server

```bash
docker compose up -d server     # picks up the new env
docker compose logs -f server | grep -E 'slack bot connected|invalid_auth|account_inactive'
```

You want a line like `slack bot connected (socket mode) bot=hello agent=hello-agent`. `invalid_auth` / `account_inactive` mean the tokens are wrong, copy-pasted with whitespace, or the app was uninstalled from the workspace.

### 4. Test from Slack

- **DM the bot**: send any message → bot reads, server spawns `claude` (Mode A: inside container; Mode B: on host via bridge), reply lands in-thread.
- **In a channel**: invite the bot, then `@hello ping`.
- **Cancel mid-run**: reply with `#cancel` in the same thread.

If the bot connects but replies are errors like `Invalid API key`, claude isn't logged in. Re-run the auth step for your mode above.

Built-in: per-thread context (last 10 messages), cancel commands, thinking indicator, per-Slack-user usage attribution. Source: `server/src/slack/`.

## Pointing at your private workspace

By default, `WORKSPACE_DIR=./workspace/claude-workspace` (created by `init.sh` from the example template). To use your own:

```bash
git clone <your-private-workspace-repo> ../my-workspace
echo "WORKSPACE_DIR=../my-workspace" >> .env
./scripts/start-container.sh
```

Anything `WORKSPACE_DIR` points at must follow the layout in `workspace/claude-workspace-example/` — `claude-config/`, `projects/`, `skills/` with a compatible `settings.json`.

## Endpoints

- `POST /chat` — synchronous single-shot Claude run, returns `{response, requestId, model, usage}`
- `POST /agents/:name/run` — run as a named agent (resolves agent file + per-agent env)
- `GET /usage` — JSONL telemetry aggregation (per-agent tokens, cost, Slack user attribution)
- `GET /agents` — list agents from the mounted workspace
- `POST /jobs` — create persistent cron job (catch-up firing, Slack delivery)
- `GET /health`

Full env-var reference: `env.example`. Auth and rate limiting are **off by default** — turn them on before exposing the port.

## Privacy split rationale

| Lives here (open) | Lives in workspace repo (private) |
|---|---|
| HTTP API, scheduler, Slack glue | Agent prompts, skills, project clones |
| Docker image build | `settings.json`, hooks, MCP config |
| `env.example`, schema, types | `projects.yml`, credentials, memory |

The example workspace is a working stub — `docker compose up` works out of the box without ever cloning the private repo.

## License

MIT. See `LICENSE`.
