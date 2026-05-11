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
