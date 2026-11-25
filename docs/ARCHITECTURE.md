# Architecture

```
 Claude (MCP client)                         REST clients / dashboards
        │  MCP (streamable HTTP / stdio)             │  HTTP+JSON
        ▼                                            ▼
 ┌───────────────── interfaces/ (thin shells) ───────────────────┐
 │  mcp.ts  (primary)                 rest.ts (auth, origin, errors)│
 └───────────────────────────────┬────────────────────────────────┘
                                 ▼
                        service.ts  BridgeService (facade)
                                 │
   ┌─────────────┬───────────────┼────────────────┬───────────────┐
   ▼             ▼               ▼                ▼               ▼
WorkflowEngine  ToolRegistry  SessionStore   AdapterRegistry   Logger/trace
(state machine) (zod tools)   (interface)    (ModelAdapter)    (AsyncLocalStorage)
   │  runAgent(): model ⇄ tool loop            │
   └───────────────────────────────────────────┤
                                 ResilientAdapter (timeout + retry + cancel)
                                               │
                              AnthropicAdapter │ OpenAIAdapter │ (Gemini/OpenRouter/local…)
```

## Layering rules
* `src/core` depends on **nothing provider-specific**: only the `ModelAdapter`, `ToolDefinition`, `SessionStore` interfaces.
* Providers live in `src/adapters` and translate the neutral `ModelRequest/ModelResponse` (messages, tool calls, usage) to each wire format.
* `ResilientAdapter` is a decorator, so timeouts/retries/cancellation behave identically for every provider.
* `src/bootstrap.ts` is the only composition root; everything is injectable (tests inject fake-upstream adapters, deployments inject persistent stores/plugins).
* `src/extensions` holds Phase 2 contracts (memory/RAG, artifacts, authz, image, research, coding, browser, Gemini, dashboard). Nothing in core imports it except the auth `Principal` type used by interfaces.

## Agent-to-agent protocol (`core/protocol.ts`)
Every exchange is an `AgentMessage` (`id, sessionId, workflowId, from, to, type, content, structured, parentId, createdAt, metadata`) with
`type ∈ directive | result | critique | revision | tool_call | tool_result | info | error`. Agent ids are open strings, so new models need no schema change.

## Mandatory workflow state machine (`core/workflow.ts`)

```
created → delegating → critiquing ──────────→ revising → completed
                    └→ awaiting_critique ──↗      │  └→ critiquing/awaiting_critique (extra rounds, ≤3)
 any non-terminal state → failed | cancelled
```
1. **Directive** – Claude (the MCP caller, `director`) sends a detailed directive → recorded as `claude>gpt:directive`.
2. **Delegation** – worker (`gpt`) runs through `runAgent` (optionally with bridge tools) → `result`.
3. **Critique** – either the critic model (`critiqueMode: "auto"` (legacy alias `adapter`), default Claude, JSON-schema validated, one repair retry, graceful fallback) or the caller itself (`critiqueMode: "manual"` (legacy alias `external`) pauses in `awaiting_critique`; resume via `bridge_submit_critique`).
4. **Revision** – worker receives the full thread (directive → its draft → critique) → `revision`. Repeat for `revisionRounds`.

Illegal transitions throw; every transition is logged and emitted to listeners (`engine.onEvent`) for dashboards.

## Resilience
* Per-attempt timeout (`REQUEST_TIMEOUT_MS`), exponential backoff + jitter for 429/5xx/network errors (`MAX_RETRIES`), no retry for 4xx.
* Overall `WORKFLOW_TIMEOUT_MS` deadline; `cancel` aborts the in-flight upstream HTTP request via `AbortSignal`; HTTP client disconnects abort delegated work.
* Tool errors are returned to the model (so it can recover); tool timeouts/cancellation are enforced per tool.
* Failures end in `failed` with `{code, message}` and an `error` message in the session transcript.

## Security
* Constant-time bearer-token authentication on `/mcp` and `/api/*`; multi-principal identities can be supplied through `BRIDGE_AUTH_TOKENS_JSON`. Production requires `BRIDGE_API_KEY` or a configured token set. `ScopeAuthorizer` enforces action scopes at the REST/MCP service boundary.
* Per-principal resource ownership prevents cross-user session/workflow reads, writes, critique and cancellation. `admin` scope is required for cross-owner access.
* Model workers receive separate `agent:<model>` identities and cannot inherit human scopes; risky tool tags require `tool:call:write` or a tool-specific scope.
* Origin allow-list (`ALLOWED_ORIGINS`) against DNS-rebinding/CSRF; stateless MCP transport; 2 MB body limit.
* Secrets only via environment; structured logs redact `*key*, *token*, authorization, secret, password`.
* Workflow creation supports per-principal idempotency keys and a configurable active-run limit (`MAX_CONCURRENT_WORKFLOWS`). Manual critique/cancel control operations are serialized per workflow to prevent concurrent state races.
* Sessions and workflow checkpoints use atomic JSON snapshots in `BRIDGE_STATE_DIR`; mount durable storage and run one replica. In-flight workflow snapshots are marked `failed/interrupted` after restart; paused manual-review workflows remain resumable.
* The calculator is a hand-written parser (no `eval`).

## Extending
| Need | How |
|---|---|
| New model | implement `ModelAdapter`, `adapters.register(new ResilientAdapter(...))` (or pass via `createBridge(config, { adapters })`). OpenRouter/Ollama/vLLM: `createOpenRouterAdapter` / `createLocalModelAdapter` already work (OpenAI-compatible). |
| New tool | `defineTool({ name, description, inputSchema: zod, execute })`, register via a `BridgePlugin`. Appears in MCP, REST and model tool-calling automatically. |
| Persistence | implement `SessionStore` (and `MemoryStore`/`ArtifactStore`), pass in `createBridge`. |
| Auth/permissions | implement `AuthProvider` (JWT/OAuth); `Authorizer` + `Principal.scopes` are ready to be enforced in `BridgeService`. |
| Dashboards | `/api/dashboard/summary` + `engine.onEvent` stream. |
