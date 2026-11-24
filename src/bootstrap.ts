import { AnthropicAdapter } from "./adapters/anthropic.js";
import { OpenAIAdapter } from "./adapters/openai.js";
import { AllowAllAuth, StaticTokenAuth } from "./auth.js";
import type { Config } from "./config.js";
import { createLogger, type Logger } from "./core/logger.js";
import { AdapterRegistry, ResilientAdapter, type ModelAdapter } from "./core/models.js";
import { InMemorySessionStore, type SessionStore } from "./core/session.js";
import { ToolRegistry } from "./core/tools.js";
import { WorkflowEngine } from "./core/workflow.js";
import type { AuthProvider, BridgePlugin } from "./extensions/index.js";
import { createApp } from "./interfaces/rest.js";
import { BridgeService } from "./service.js";
import { registerBuiltinTools } from "./tools/builtin.js";

export interface BridgeOverrides { adapters?: ModelAdapter[]; sessions?: SessionStore; auth?: AuthProvider; plugins?: BridgePlugin[]; logger?: Logger }

/** Composition root. Everything is injectable so tests and future deployments swap parts without touching the core. */
export function createBridge(config: Config, ov: BridgeOverrides = {}) {
  const logger = ov.logger ?? createLogger(config.logLevel);
  const adapters = new AdapterRegistry();
  const wrap = (a: ModelAdapter) => new ResilientAdapter(a, { timeoutMs: config.resilience.timeoutMs, retries: config.resilience.retries, baseDelayMs: config.resilience.baseDelayMs }, logger);

  if (ov.adapters) for (const a of ov.adapters) adapters.register(wrap(a));
  else {
    if (config.anthropic.apiKey) adapters.register(wrap(new AnthropicAdapter({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseURL, model: config.anthropic.model })), ["claude"]);
    else logger.warn("ANTHROPIC_API_KEY not set: the 'anthropic'/'claude' adapter is unavailable");
    if (config.openai.apiKey) adapters.register(wrap(new OpenAIAdapter({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL, model: config.openai.model })), ["gpt", "chatgpt"]);
    else logger.warn("OPENAI_API_KEY not set: the 'openai'/'gpt' adapter is unavailable");
  }
  // Aliases for injected adapters
  if (ov.adapters) for (const a of ov.adapters) { if (a.id === "anthropic") adapters.register(adapters.get("anthropic"), ["claude"]); if (a.id === "openai") adapters.register(adapters.get("openai"), ["gpt"]); }

  const tools = registerBuiltinTools(new ToolRegistry());
  for (const p of ov.plugins ?? []) {
    for (const t of p.tools ?? []) tools.register(t);
    for (const a of p.adapters ?? []) adapters.register(wrap(a));
  }
  const sessions = ov.sessions ?? new InMemorySessionStore(config.sessions.ttlMs, config.sessions.max);
  const engine = new WorkflowEngine(adapters, tools, sessions, logger, { maxToolRounds: config.resilience.maxToolRounds, workflowTimeoutMs: config.resilience.workflowTimeoutMs });
  const service = new BridgeService({ config, adapters, tools, sessions, engine, logger });
  const auth = ov.auth ?? (config.apiKey ? new StaticTokenAuth(config.apiKey) : new AllowAllAuth());
  if (!config.apiKey) logger.warn("BRIDGE_API_KEY not set: HTTP interfaces are UNAUTHENTICATED (development only)");
  const app = createApp(service, auth, { allowedOrigins: config.allowedOrigins, logger });
  return { app, service, adapters, tools, sessions, engine, logger };
}
