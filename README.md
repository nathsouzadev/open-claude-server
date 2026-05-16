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

```bash
cp env.example .env                      # fill GH_TOKEN, point WORKSPACE_DIR at your workspace
docker compose build
docker compose up -d server
curl -s http://127.0.0.1:3010/health | jq
```

## Pointing at your private workspace

The default `WORKSPACE_DIR=./workspace/claude-workspace.example` uses the example template shipped here. To use your own:

```bash
git clone <your-private-workspace-repo> ../my-workspace
echo "WORKSPACE_DIR=../my-workspace" >> .env
docker compose up -d server
```

Anything `WORKSPACE_DIR` points at must follow the layout in `workspace/claude-workspace.example/` — `claude-config/`, `projects/`, `skills/` with a compatible `settings.json`.

## Endpoints

- `POST /chat` — synchronous single-shot Claude run, returns `{response, requestId, model, usage}`
- `POST /agents/:name/run` — run as a named agent (resolves agent file + per-agent env)
- `GET /usage` — JSONL telemetry aggregation (per-agent tokens, cost, Slack user attribution)
- `GET /agents` — list agents from the mounted workspace
- `POST /jobs` — create persistent cron job (catch-up firing, Slack delivery)
- `GET /health`

Full env-var reference: `env.example`. Auth and rate limiting are **off by default** — turn them on before exposing the port.

## Slack bots

Multi-bot Bolt app (Socket Mode). Each bot maps to an agent via `slack.bots` entry in the agent file. Per-thread context, cancel commands, thinking indicator, and per-Slack-user usage attribution are built in. See `server/src/slack/`.

## Privacy split rationale

| Lives here (open) | Lives in workspace repo (private) |
|---|---|
| HTTP API, scheduler, Slack glue | Agent prompts, skills, project clones |
| Docker image build | `settings.json`, hooks, MCP config |
| `env.example`, schema, types | `projects.yml`, credentials, memory |

The example workspace is a working stub — `docker compose up` works out of the box without ever cloning the private repo.

## License

MIT. See `LICENSE`.
