/**
 * PHASE 2 EXTENSION POINTS — interfaces and scaffolding only.
 * Nothing in src/core imports from here; each capability plugs in via these contracts
 * (tools register in ToolRegistry, models register in AdapterRegistry, stores replace the in-memory defaults).
 */
import { BridgeError } from "../core/errors.js";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../core/models.js";
import { OpenAIAdapter } from "../adapters/openai.js";
import type { ToolDefinition } from "../core/tools.js";

// ---- Persistent memory / RAG ----------------------------------------------------------------
export interface MemoryRecord { id: string; namespace: string; text: string; metadata?: Record<string, unknown>; createdAt: string }
export interface MemoryStore {
  upsert(namespace: string, records: { id?: string; text: string; metadata?: Record<string, unknown> }[]): Promise<MemoryRecord[]>;
  search(namespace: string, query: string, opts?: { limit?: number; filter?: Record<string, unknown> }): Promise<(MemoryRecord & { score: number })[]>;
  delete(namespace: string, ids: string[]): Promise<void>;
}
export interface Embedder { embed(texts: string[], opts: { signal: AbortSignal }): Promise<number[][]> }

// ---- Artifact / reference system ------------------------------------------------------------
export interface ArtifactRef { id: string; uri: string; mediaType: string; sizeBytes: number; sha256: string; sessionId?: string; createdAt: string }
export interface ArtifactStore {
  put(data: Uint8Array | string, meta: { mediaType: string; sessionId?: string; name?: string }): Promise<ArtifactRef>;
  get(id: string): Promise<{ ref: ArtifactRef; data: Uint8Array }>;
  list(sessionId?: string): Promise<ArtifactRef[]>;
}

// ---- Authentication + permissions -----------------------------------------------------------
export interface Principal { id: string; scopes: string[]; metadata?: Record<string, unknown> }
export interface AuthProvider { authenticate(headers: Record<string, string | string[] | undefined>): Promise<Principal | null> }
export type Action = "workflow:run" | "workflow:read" | "workflow:critique" | "workflow:cancel" | "workflow:approve" | "session:read" | "session:write" | "tool:call" | "model:list" | "admin";
export interface Authorizer { can(principal: Principal, action: Action, resource?: { type: string; id?: string; tags?: string[] }): boolean }
/** Default policy: "*" scope or an exact "action" / "prefix:*" scope. Replace with RBAC/ABAC later. */
export class ScopeAuthorizer implements Authorizer {
  can(p: Principal, action: Action, resource?: { type: string; id?: string; tags?: string[] }): boolean {
    const scopes = p.scopes ?? [];
    if (scopes.includes("*") || scopes.includes("admin")) return true;
    if (action === "tool:call" && resource?.type === "tool") {
      const tags = resource.tags ?? [];
      // Agent identities fail closed: only explicitly safe/read-only tools may be invoked.
      if (p.id.startsWith("agent:") && !tags.some((tag) => /^(safe|read[-_]only)$/i.test(tag))) return false;
      const risky = tags.some((tag) => /(write|external|destructive|sensitive|financial|send|delete|mutat|admin)/i.test(tag));
      if (risky) return scopes.some((s) => s === "tool:call:write" || s === `tool:${resource.id}:call`);
    }
    return scopes.some((s) => s === action || (s.endsWith(":*") && action.startsWith(s.slice(0, -1))));
  }
}

// ---- Media / research / coding / browser capabilities (all deliver as ToolDefinitions) -------
export interface ImageProvider {
  generate(req: { prompt: string; size?: string; n?: number }, opts: { signal: AbortSignal }): Promise<ArtifactRef[]>;
  analyze(req: { image: ArtifactRef | { url: string }; question: string }, opts: { signal: AbortSignal }): Promise<string>;
}
export interface ResearchProvider {
  search(q: string, opts: { limit?: number; signal: AbortSignal }): Promise<{ title: string; url: string; snippet: string }[]>;
  fetchPage(url: string, opts: { signal: AbortSignal }): Promise<{ url: string; title?: string; text: string }>;
}
export interface CodingProvider {
  runSandboxed(req: { language: "python" | "javascript" | "bash"; code: string; timeoutMs?: number }, opts: { signal: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  applyPatch(req: { repo: string; patch: string }, opts: { signal: AbortSignal }): Promise<{ applied: boolean; detail: string }>;
}
export interface BrowserAutomation {
  open(url: string, opts: { signal: AbortSignal }): Promise<{ pageId: string }>;
  act(pageId: string, action: { type: "click" | "type" | "extract" | "screenshot"; selector?: string; text?: string }, opts: { signal: AbortSignal }): Promise<unknown>;
  close(pageId: string): Promise<void>;
}
/** A capability plugin contributes tools (and optionally adapters) at startup. */
export interface BridgePlugin { name: string; tools?: ToolDefinition<never>[]; adapters?: ModelAdapter[] }

// ---- Additional model providers --------------------------------------------------------------
/** OpenRouter speaks the OpenAI wire protocol — usable today. */
export const createOpenRouterAdapter = (o: { apiKey: string; model: string }) =>
  new OpenAIAdapter({ id: "openrouter", apiKey: o.apiKey, model: o.model, baseURL: "https://openrouter.ai/api/v1" });
/** Ollama / vLLM / LM Studio / llama.cpp server expose OpenAI-compatible endpoints — usable today. */
export const createLocalModelAdapter = (o: { baseURL: string; model: string; apiKey?: string; id?: string }) =>
  new OpenAIAdapter({ id: o.id ?? "local", apiKey: o.apiKey ?? "not-needed", model: o.model, baseURL: o.baseURL });
/** Gemini: scaffold. Implement `complete` against the Gemini API and register in AdapterRegistry. */
export class GeminiAdapter implements ModelAdapter {
  readonly id = "gemini"; readonly provider = "google";
  constructor(public readonly defaultModel = "gemini-2.5-pro") {}
  complete(_req: ModelRequest, _o: { signal: AbortSignal }): Promise<ModelResponse> {
    return Promise.reject(new BridgeError("config", "GeminiAdapter is a Phase 2 scaffold and is not implemented yet"));
  }
}

// ---- Dashboard -------------------------------------------------------------------------------
export interface DashboardProvider { summary(): Promise<Record<string, unknown>> }
