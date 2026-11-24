import { z } from "zod";
import { BridgeError } from "./core/errors.js";

const num = (d: number) => z.coerce.number().int().nonnegative().default(d);
const optStr = z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: num(8787), HOST: z.string().default("0.0.0.0"),
  BRIDGE_API_KEY: optStr,
  ALLOWED_ORIGINS: optStr,
  ANTHROPIC_API_KEY: optStr, ANTHROPIC_BASE_URL: optStr, ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),
  OPENAI_API_KEY: optStr, OPENAI_BASE_URL: optStr, OPENAI_MODEL: z.string().default("gpt-4.1"),
  REQUEST_TIMEOUT_MS: num(60_000), MAX_RETRIES: num(3), RETRY_BASE_DELAY_MS: num(500),
  MAX_TOOL_ROUNDS: num(6), WORKFLOW_TIMEOUT_MS: num(300_000),
  SESSION_TTL_MS: num(3_600_000), MAX_SESSIONS: num(1000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number; host: string; apiKey?: string; allowedOrigins: string[];
  anthropic: { apiKey?: string; baseURL?: string; model: string };
  openai: { apiKey?: string; baseURL?: string; model: string };
  resilience: { timeoutMs: number; retries: number; baseDelayMs: number; maxToolRounds: number; workflowTimeoutMs: number };
  sessions: { ttlMs: number; max: number };
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = schema.safeParse(env);
  if (!r.success) throw new BridgeError("config", `Invalid configuration: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const e = r.data;
  if (e.NODE_ENV === "production" && !e.BRIDGE_API_KEY)
    throw new BridgeError("config", "BRIDGE_API_KEY is required when NODE_ENV=production");
  return {
    env: e.NODE_ENV, port: e.PORT, host: e.HOST, apiKey: e.BRIDGE_API_KEY,
    allowedOrigins: (e.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    anthropic: { apiKey: e.ANTHROPIC_API_KEY, baseURL: e.ANTHROPIC_BASE_URL, model: e.ANTHROPIC_MODEL },
    openai: { apiKey: e.OPENAI_API_KEY, baseURL: e.OPENAI_BASE_URL, model: e.OPENAI_MODEL },
    resilience: { timeoutMs: e.REQUEST_TIMEOUT_MS, retries: e.MAX_RETRIES, baseDelayMs: e.RETRY_BASE_DELAY_MS, maxToolRounds: e.MAX_TOOL_ROUNDS, workflowTimeoutMs: e.WORKFLOW_TIMEOUT_MS },
    sessions: { ttlMs: e.SESSION_TTL_MS, max: e.MAX_SESSIONS },
    logLevel: e.LOG_LEVEL,
  };
}
