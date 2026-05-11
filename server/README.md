# claude-workspace server

HTTP wrapper around the Claude Code CLI. Runs **inside the workspace container** so it inherits the host's OAuth credential mount, MCP servers, plugins, hooks and skills.

Default bind: `127.0.0.1:3010` (localhost-only). Auth and rate-limit are off by default — turn on before exposing publicly.

## Quick start

```bash
make server-up           # builds and starts the server service
curl -s http://127.0.0.1:3010/health | jq

curl -s -X POST http://127.0.0.1:3010/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Responda apenas com a palavra PONG"}' | jq
```

## Endpoints

### `GET /health`

```json
{ "status": "ok", "uptime": 42, "claude": true }
```

`claude: true` means `claude --version` returned 0 within 2s. Cached for 30s.

### `POST /chat`

**Request:**

```json
{
  "message": "string (1..CLAUDE_MAX_INPUT_CHARS)",
  "sessionId": "optional-uuid-to-resume"
}
```

**Response (200):**

```json
{
  "response": "string",
  "sessionId": "uuid",
  "durationMs": 1530,
  "costUsd": 0.013,
  "usage": {
    "inputTokens": 5,
    "outputTokens": 7,
    "cacheReadInputTokens": 24920,
    "cacheCreationInputTokens": 0
  }
}
```

**Multi-turn:** call once without `sessionId`, capture `sessionId` from response, send it on follow-ups.

```bash
SID=$(curl -s -X POST http://127.0.0.1:3010/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Meu nome é Nathally. Lembre disso."}' | jq -r .sessionId)

curl -s -X POST http://127.0.0.1:3010/chat \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Qual meu nome?\",\"sessionId\":\"$SID\"}" | jq
```

**Error responses:**

| Status | `error`                                  | Cause                                      |
| ------ | ---------------------------------------- | ------------------------------------------ |
| 400    | `invalid_payload`                        | Body failed Zod validation                 |
| 401    | `unauthorized`                           | Auth on, missing/wrong bearer token        |
| 499    | `client_aborted`                         | Client closed the connection mid-call      |
| 502    | `claude_failed`                          | CLI exited non-zero or returned `is_error` |
| 504    | `claude_timeout`                         | CLI exceeded `CLAUDE_TIMEOUT_MS`           |
| 500    | `internal_error` / `claude_spawn_failed` | Server bug or spawn failure                |

## Scheduled jobs (cron)

Persistent cron scheduler embedded in the server. Each job invokes a configured agent on a cron expression and posts the result to a Slack channel/DM via the wrapper. Jobs survive restarts (stored in `JOBS_FILE`, default `/home/claude/.claude/scheduled_jobs.json`).

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/jobs` | Create job |
| `GET` | `/api/jobs` | List jobs (in-memory state, includes `running` flag) |
| `GET` | `/api/jobs/:id` | Get one job |
| `DELETE` | `/api/jobs/:id` | Remove job (stops cron task, in-flight Claude process keeps running until completion or timeout) |
| `POST` | `/api/jobs/:id/run` | Trigger an immediate, ad-hoc run (returns 202; lock-respecting) |

### Create payload

```json
{
  "expr": "0 10 * * 1-5",
  "agent": "nanisca",
  "message": "Gere um relatório... Retorne apenas o texto.",
  "name": "relatorio-diario-epicos",
  "destination": { "type": "slack", "channel": "D0B26HJ6XG8", "bot": "nanisca" },
  "catchUp": true,
  "catchUpWindowMs": 43200000
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `expr` | yes | 5-field cron (min hour dom mon dow). Validated via `node-cron`. |
| `agent` | yes | Subagent name (`name` in `agents/*.md` frontmatter) |
| `message` | yes | Prompt content. Describe content only; the wrapper handles Slack delivery — do not include "envie via DM/Slack" or similar. |
| `name` | no | Friendly label |
| `destination.type` | yes if `destination` | `"slack"` only for now |
| `destination.channel` | yes if `destination` | **Prefer D-prefix** (DM channel ID) or C-prefix (channel). User IDs (`U…`) may return `ok:true` from postMessage but deliver silently — avoid. |
| `destination.bot` | no | Slack bot name. Defaults to the bot whose name matches `agent`; falls back to the first registered bot. |
| `catchUp` | no | If `true`, on server startup the scheduler runs the most recent missed firing within `catchUpWindowMs`. Multiple missed firings collapse into one. |
| `catchUpWindowMs` | no | Catch-up window in ms. Default 12h (43_200_000), max 7 days. |

### Behavior

- **In-memory lock per job** — if a job is already running and the cron (or `/run`) tries to fire again, the new firing is skipped with a `warn` log instead of being queued. Prevents pile-ups (e.g. when several manual triggers happen during a long run).
- **Empty response detection** — if Claude returns an empty string (commonly because the agent tried to deliver via HTTP itself), `lastRun.ok` is set to `false`, a warning is posted to Slack, and no blank DM is sent.
- **Prompt guard rail** — every cron prompt carries a "CRITICAL DELIVERY RULE" instructing the agent to never call delivery APIs (curl/fetch/Slack) and to return only the content text. The wrapper handles delivery.
- **Catch-up firing logs** — on startup you'll see `"catch-up firing for missed scheduled run"` with `jobId` and `missedAt` for any job recovered.
- **Slack post logs** — every successful Slack post emits `"slack message posted"` with `{botName, channel, ts, ok}`; failures emit `"slack postMessage failed"` with the full error.

### Examples

Create a job that runs weekdays at 10:00 and DMs Nanisca's bot to a known DM channel:

```bash
curl -sS -X POST http://127.0.0.1:3010/api/jobs \
  -H 'content-type: application/json' \
  -d '{
    "name": "relatorio-diario",
    "expr": "0 10 * * 1-5",
    "agent": "nanisca",
    "message": "Gere o relatório diário. Retorne apenas o texto em Markdown.",
    "destination": { "type": "slack", "channel": "D0B26HJ6XG8", "bot": "nanisca" },
    "catchUp": true
  }'
```

List, inspect, run manually, delete:

```bash
curl -sS http://127.0.0.1:3010/api/jobs | jq
curl -sS http://127.0.0.1:3010/api/jobs/<id> | jq
curl -sS -X POST http://127.0.0.1:3010/api/jobs/<id>/run
curl -sS -X DELETE http://127.0.0.1:3010/api/jobs/<id>
```

The `-X DELETE` flag is required — without it curl falls back to GET.

### UI

`http://127.0.0.1:3010/ui` lists jobs alongside agents, with a "+ novo" button that opens a dialog (name, cron, agent, message, Slack channel, catch-up checkbox). Clicking a job opens a detail dialog with delete.

## Environment variables

| Var                      | Default             | Notes                                                           |
| ------------------------ | ------------------- | --------------------------------------------------------------- |
| `PORT`                   | `3010`              | Bound inside container                                          |
| `HOST`                   | `0.0.0.0`           | Container only listens on the published port (`127.0.0.1:3010`) |
| `NODE_ENV`               | `development`       |                                                                 |
| `LOG_LEVEL`              | `info`              | pino levels: trace, debug, info, warn, error                    |
| `AUTH_ENABLED`           | `false`             | Set to `true` + define `API_TOKEN` before exposing              |
| `API_TOKEN`              | _empty_             | Bearer token expected in `Authorization` header                 |
| `RATE_LIMIT_ENABLED`     | `false`             |                                                                 |
| `RATE_LIMIT_WINDOW_MS`   | `60000`             |                                                                 |
| `RATE_LIMIT_MAX`         | `30`                |                                                                 |
| `CORS_ORIGIN`            | `*`                 | Comma-separated origins. Restrict before exposing.              |
| `CLAUDE_BIN`             | `claude`            |                                                                 |
| `CLAUDE_CWD`             | `/workspace/server` | Working dir for each spawned `claude`                           |
| `CLAUDE_TIMEOUT_MS`      | `120000`            | Per-request hard limit                                          |
| `CLAUDE_MAX_INPUT_CHARS` | `50000`             | Validates `message` length                                      |
| `CLAUDE_MAX_CONCURRENCY` | `3`                 | Max parallel `claude` spawns. Excess go to a queue.             |
| `CLAUDE_QUEUE_MAX_WAIT_MS` | `30000`           | How long queued requests wait before rejecting with `claude queue wait timeout`. |
| `JOBS_FILE`              | `/home/claude/.claude/scheduled_jobs.json` | Persistence path for cron jobs.            |

## Turning auth on (before exposing)

```bash
# server/.env
AUTH_ENABLED=true
API_TOKEN=<random-256-bit-hex>
```

Generate a token: `openssl rand -hex 32`.

```bash
make server-restart

# Test
curl -X POST http://127.0.0.1:3010/chat \
  -H "Authorization: Bearer <API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"message":"oi"}'
```

## Turning rate-limit on

```bash
# server/.env
RATE_LIMIT_ENABLED=true
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=30
```

`make server-restart`. Headers `RateLimit-*` are returned per response.

## Plan to expose publicly

Don't change the compose `ports:` (keep `127.0.0.1:3010:3010`). Put a reverse proxy (nginx, caddy, traefik) in front, terminating TLS and forwarding to `127.0.0.1:3010`. Recommended:

1. `AUTH_ENABLED=true`, strong `API_TOKEN`.
2. `RATE_LIMIT_ENABLED=true`.
3. Restrict `CORS_ORIGIN` to known domains.
4. Reverse proxy with HTTPS (Let's Encrypt via caddy is the lowest-friction option).
5. Drop server logs into your existing observability stack (`LOG_LEVEL=info`, JSON to stdout).
6. Consider isolating into its own host or namespace — the underlying Claude session has full filesystem access to mounted volumes.

Streaming (SSE / `--output-format stream-json`) is NOT implemented yet — single result only.

## Running locally without Docker

```bash
cd server
cp .env.example .env
npm install
npm start
```

Requires `claude` CLI on `$PATH` and a logged-in OAuth credential.
