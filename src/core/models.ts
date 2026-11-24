import { BridgeError } from "./errors.js";
import { retrying } from "./resilience.js";
import type { Logger } from "./logger.js";

export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];   // assistant messages
  toolCallId?: string;      // tool messages
  toolName?: string;
}

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }

export interface ModelRequest {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Hint that the reply must be a single JSON object. */
  json?: boolean;
}

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_use" | "length" | "other";
  usage?: { inputTokens: number; outputTokens: number };
  model: string;
  provider: string;
}

/** Provider-agnostic model interface. The core only ever talks to this. */
export interface ModelAdapter {
  readonly id: string;
  readonly provider: string;
  readonly defaultModel: string;
  complete(req: ModelRequest, opts: { signal: AbortSignal }): Promise<ModelResponse>;
}

export class AdapterRegistry {
  private adapters = new Map<string, ModelAdapter>();
  private aliases = new Map<string, string>();

  register(adapter: ModelAdapter, aliases: string[] = []): this {
    this.adapters.set(adapter.id, adapter);
    for (const a of aliases) this.aliases.set(a, adapter.id);
    return this;
  }
  get(idOrAlias: string): ModelAdapter {
    const a = this.adapters.get(this.aliases.get(idOrAlias) ?? idOrAlias);
    if (!a) throw new BridgeError("not_found", `Unknown or unconfigured model adapter "${idOrAlias}". Available: ${this.list().map((x) => x.id).join(", ") || "none"}`);
    return a;
  }
  has(idOrAlias: string): boolean { return this.adapters.has(this.aliases.get(idOrAlias) ?? idOrAlias); }
  list(): { id: string; provider: string; defaultModel: string; aliases: string[] }[] {
    return [...this.adapters.values()].map((a) => ({
      id: a.id, provider: a.provider, defaultModel: a.defaultModel,
      aliases: [...this.aliases].filter(([, v]) => v === a.id).map(([k]) => k),
    }));
  }
}

export interface ResilienceOptions { timeoutMs: number; retries: number; baseDelayMs: number }

/** Decorator adding timeout + retry + cancellation to any adapter. */
export class ResilientAdapter implements ModelAdapter {
  readonly id: string; readonly provider: string; readonly defaultModel: string;
  constructor(private inner: ModelAdapter, private opts: ResilienceOptions, private log: Logger) {
    this.id = inner.id; this.provider = inner.provider; this.defaultModel = inner.defaultModel;
  }
  complete(req: ModelRequest, o: { signal: AbortSignal }): Promise<ModelResponse> {
    return retrying((signal) => this.inner.complete(req, { signal }), {
      retries: this.opts.retries, baseDelayMs: this.opts.baseDelayMs, timeoutMs: this.opts.timeoutMs, signal: o.signal,
      onRetry: (attempt, err, delay) => this.log.warn("model call retry", { adapter: this.id, attempt, code: err.code, delayMs: delay, error: err.message }),
    });
  }
}
