import { z } from "zod";
import { BridgeError } from "./core/errors.js";

const num = (d: number) => z.coerce.number().int().nonnegative().default(d);
const optStr = z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: num(8787), HOST: z.string().default("0.0.0.0"),
  BRIDGE_API_KEY: optStr,
  BRIDGE_API_PRINCIPAL_ID: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.:-]+$/).default("human:operator"),
  BRIDGE_API_SCOPES: optStr,
  BRIDGE_AUTH_TOKENS_JSON: optStr,
  BRIDGE_STATE_DIR: optStr,
  ALLOWED_ORIGINS: optStr,
  ANTHROPIC_API_KEY: optStr, ANTHROPIC_BASE_URL: optStr, ANTHROPIC_MODEL: z.string().default("claude-sonnet-5-5"),
  OPENAI_API_KEY: optStr, OPENAI_BASE_URL: optStr, OPENAI_MODEL: z.string().default("gpt-4.1"),
  REQUEST_TIMEOUT_MS: num(60_000), MAX_RETRIES: num(3), RETRY_BASE_DELAY_MS: num(500),
  MAX_TOOL_ROUNDS: num(6), WORKFLOW_TIMEOUT_MS: num(300_000), MAX_CONCURRENT_WORKFLOWS: num(10),
  SESSION_TTL_MS: num(3_600_000), MAX_SESSIONS: num(1000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number; host: string; apiKey?: string; allowedOrigins: string[];
  anthropic: { apiKey?: string; baseURL?: string; model: string };
  openai: { apiKey?: string; baseURL?: string; model: string };
  resilience: { timeoutMs: number; retries: number; baseDelayMs: number; maxToolRounds: number; workflowTimeoutMs: number; maxConcurrentRuns: number };
  sessions: { ttlMs: number; max: number };
  auth: { principalId: string; scopes: string[]; tokens: { id: string; token: string; scopes: string[]; metadata?: Record<string, unknown> }[] };
  persistence: { directory?: string };
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) throw new BridgeError("config", `Invalid configuration: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = r.data;
  const tokenSchema = z.array(z.object({ id: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.:-]+$/), token: z.string().min(16), scopes: z.array(z.string().min(1)).min(1), metadata: z.record(z.string(), z.unknown()).optional() })).max(50);
  let tokens: z.output<typeof tokenSchema> = [];
  if (e.BRIDGE_AUTH_TOKENS_JSON) {
    try {
      const parsed = tokenSchema.safeParse(JSON.parse(e.BRIDGE_AUTH_TOKENS_JSON));
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
      tokens = parsed.data;
    } catch (error) { throw new BridgeError("config", `Invalid BRIDGE_AUTH_TOKENS_JSON: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (e.NODE_ENV === "production" && !e.BRIDGE_API_KEY && !tokens.length)
    throw new BridgeError("config", "BRIDGE_API_KEY or BRIDGE_AUTH_TOKENS_JSON is required when NODE_ENV=production");
  return {
    env: e.NODE_ENV, port: e.PORT, host: e.HOST, apiKey: e.BRIDGE_API_KEY,
    allowedOrigins: (e.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    anthropic: { apiKey: e.ANTHROPIC_API_KEY, baseURL: e.ANTHROPIC_BASE_URL, model: e.ANTHROPIC_MODEL },
    openai: { apiKey: e.OPENAI_API_KEY, baseURL: e.OPENAI_BASE_URL, model: e.OPENAI_MODEL },
    resilience: { timeoutMs: e.REQUEST_TIMEOUT_MS, retries: e.MAX_RETRIES, baseDelayMs: e.RETRY_BASE_DELAY_MS, maxToolRounds: e.MAX_TOOL_ROUNDS, workflowTimeoutMs: e.WORKFLOW_TIMEOUT_MS, maxConcurrentRuns: e.MAX_CONCURRENT_WORKFLOWS },
    sessions: { ttlMs: e.SESSION_TTL_MS, max: e.MAX_SESSIONS },
    auth: { principalId: e.BRIDGE_API_PRINCIPAL_ID, scopes: (e.BRIDGE_API_SCOPES ?? "*").split(",").map((s) => s.trim()).filter(Boolean), tokens },
    persistence: { directory: e.NODE_ENV === "test" ? undefined : e.BRIDGE_STATE_DIR ?? "./data" },
    logLevel: e.LOG_LEVEL,
  };
}
