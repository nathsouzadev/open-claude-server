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

`./scripts/start-host.sh` does the full setup on top of Mode B:

1. Bootstraps templates.
2. Generates `CLAUDE_WORKER_TOKEN` in `.env` if blank.
3. Installs `@anthropic-ai/claude-code` globally if `claude` is missing on host.
4. Builds the image if missing.
5. Starts `scripts/host-claude-worker.mjs` in the background (pid `.host-claude-worker.pid`, log `.host-claude-worker.log`).
6. Brings up only the `server` service. Sets `CLAUDE_BIN=/workspace/scripts/claude-bridge.mjs`, which proxies all in-container spawns to the host worker at `host.docker.internal:3011`.

- `host.docker.internal` is mapped via `extra_hosts` so it works on Linux too.
- Stop: `docker compose down && kill $(cat .host-claude-worker.pid) && rm .host-claude-worker.pid`

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

To test the Slack integration after logging in, jump to [Slack bots](#slack-bots).

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

## Troubleshooting

### `error while loading shared libraries: libatomic.so.1: cannot open shared object file`

Node's prebuilt binary depends on `libatomic1`, which is missing from minimal Linux installs and slim container bases. Install it with the matching package manager:

```bash
# Debian / Ubuntu
apt-get update && apt-get install -y libatomic1

# Alpine
apk add --no-cache libatomic

# RHEL / Fedora / Rocky
dnf install -y libatomic
```

Then re-run the failing command (e.g. `npm install -g @anthropic-ai/claude-code` or `./scripts/start-host.sh`).

## License

MIT. See `LICENSE`.
