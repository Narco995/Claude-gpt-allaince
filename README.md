# Claude ↔ GPT Universal AI Bridge

[![CI](https://github.com/Narco995/Claude-gpt-allaince/actions/workflows/ci.yml/badge.svg)](https://github.com/Narco995/Claude-gpt-allaince/actions/workflows/ci.yml)

A standalone, provider-agnostic AI-to-AI orchestration bridge. **MCP is the primary interface** (stdio + streamable HTTP) with a thin REST API on top of the same service.

Mandatory workflow, fully implemented and integration-tested:

> **Claude → detailed directive → Bridge → GPT → result → Claude critique → GPT revision**

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start
```bash
npm install
cp .env.example .env     # set ANTHROPIC_API_KEY, OPENAI_API_KEY, BRIDGE_API_KEY
npm run build && npm start        # HTTP: http://localhost:8787  (MCP at /mcp, REST at /api)
npm run check                     # typecheck + lint + 50 tests
```

### Environment variables
| Var | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | – | An adapter is only registered when its key is set |
| `ANTHROPIC_MODEL` / `OPENAI_MODEL` | `claude-sonnet-4-5` / `gpt-4.1` | Override per workflow with `workerModel` / `criticModel` |
| `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` | – | Gateways / compatible servers |
| `BRIDGE_API_KEY` | – | Bearer token for `/mcp` and `/api/*`. **Required in production** |
| `ALLOWED_ORIGINS` | – | Comma-separated browser origins |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | |
| `REQUEST_TIMEOUT_MS`, `MAX_RETRIES`, `RETRY_BASE_DELAY_MS` | `60000`, `3`, `500` | Per model call |
| `WORKFLOW_TIMEOUT_MS`, `MAX_TOOL_ROUNDS` | `300000`, `6` | |
| `SESSION_TTL_MS`, `MAX_SESSIONS` | `3600000`, `1000` | In-memory store limits |
| `LOG_LEVEL` | `info` | JSON logs to stderr |

## Connect Claude (MCP)
**Claude Code (remote):**
```bash
claude mcp add --transport http claude-gpt-bridge https://YOUR_HOST/mcp --header "Authorization: Bearer $BRIDGE_API_KEY"
```
**Claude Desktop / local (stdio)** – `claude_desktop_config.json`:
```json
{ "mcpServers": { "claude-gpt-bridge": { "command": "node", "args": ["/path/to/Claude-gpt/dist/stdio.js"],
  "env": { "OPENAI_API_KEY": "sk-...", "ANTHROPIC_API_KEY": "sk-ant-..." } } } }
```
For claude.ai custom connectors, the hosted `/mcp` URL must be reachable over HTTPS and the connector must send the bearer token (or put the bridge behind an auth proxy).

### MCP tools
`bridge_run_workflow`, `bridge_submit_critique`, `bridge_get_workflow`, `bridge_cancel_workflow`, `bridge_delegate`, `bridge_list_models`, `bridge_list_tools`, `bridge_call_tool`, `bridge_get_session`, `bridge_list_sessions`.

**Claude does the critique itself** (best quality loop):
1. `bridge_run_workflow { directive, critiqueMode: "external" }` → returns `draft`, state `awaiting_critique`
2. Claude reviews → `bridge_submit_critique { workflowId, critique: { verdict, summary, issues[] } }` → GPT revises → `final`

**Bridge calls Claude for the critique** (default): `bridge_run_workflow { directive }` returns everything in one call.

## REST
```bash
curl -s localhost:8787/api/workflows -H "Authorization: Bearer $BRIDGE_API_KEY" -H 'content-type: application/json' \
  -d '{"directive":"Write a 3-step plan to migrate a cron job to a queue. Use the calculator tool to size 12*30 jobs.","tools":["calculator"]}'
```
`POST /api/workflows` (`"wait":false` → 202 + poll), `GET /api/workflows/:id`, `POST /api/workflows/:id/critique|cancel`, `POST /api/delegate`, `GET|POST /api/sessions`, `GET /api/sessions/:id`, `GET /api/models|tools`, `POST /api/tools/:name/call`, `GET /api/dashboard/summary`, `GET /healthz`.

Workflow options: `director`/`worker`/`critic` (default `claude`/`gpt`/`claude`; aliases `claude`→`anthropic`, `gpt`→`openai`), `critiqueMode`, `revisionRounds` (1–3), `tools`, `workerModel`, `criticModel`, `temperature`, `maxTokens`, `context`, `sessionId`.

## Built-in tools
`calculator`, `current_time`, `text_stats`, `json_format`, `hash_text` (workers can call them during a workflow; also callable directly).

## Deployment
```bash
docker build -t claude-gpt-bridge .
docker run -d --env-file .env -p 8787:8787 claude-gpt-bridge       # or: docker compose up -d
```
* Terminate TLS at your proxy (Caddy/nginx/Cloudflare/Railway/Fly/Render). Set `NODE_ENV=production` and a long random `BRIDGE_API_KEY` (`openssl rand -hex 32`).
* State is in-memory and per-instance: run **one replica** until a persistent `SessionStore` is plugged in (Phase 2).
* Health check: `GET /healthz`.

## Tests
`npm test` runs unit tests plus integration tests that exercise the **real** adapters and official SDKs against local fake OpenAI/Anthropic HTTP servers, including the full mandatory workflow over REST and through a real MCP client, external critique, tools, retries, timeouts, cancellation, auth and origin checks.

## Phase 2 (scaffolding in `src/extensions`)
Memory/RAG, artifacts, authz, image, research, coding, browser, Gemini (stub), OpenRouter & local models (working via OpenAI-compatible factories), dashboard.
