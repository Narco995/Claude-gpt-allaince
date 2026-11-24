import Anthropic from "@anthropic-ai/sdk";
import { toBridgeError } from "../core/errors.js";
import type { ModelAdapter, ModelRequest, ModelResponse, ToolCall } from "../core/models.js";

export interface AnthropicAdapterOptions { apiKey: string; baseURL?: string; model: string; id?: string; client?: Anthropic; defaultMaxTokens?: number }

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } | { type: "tool_result"; tool_use_id: string; content: string };
type Msg = { role: "user" | "assistant"; content: string | Block[] };

export class AnthropicAdapter implements ModelAdapter {
  readonly id: string; readonly provider = "anthropic"; readonly defaultModel: string;
  private client: Anthropic; private defaultMaxTokens: number;

  constructor(o: AnthropicAdapterOptions) {
    this.id = o.id ?? "anthropic"; this.defaultModel = o.model; this.defaultMaxTokens = o.defaultMaxTokens ?? 4096;
    this.client = o.client ?? new Anthropic({ apiKey: o.apiKey, baseURL: o.baseURL, maxRetries: 0 });
  }

  async complete(req: ModelRequest, { signal }: { signal: AbortSignal }): Promise<ModelResponse> {
    const messages: Msg[] = [];
    for (const m of req.messages) {
      if (m.role === "user") messages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        const blocks: Block[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
        messages.push({ role: "assistant", content: blocks.length ? blocks : "(no content)" });
      } else {
        // Consecutive tool results must live in ONE user message.
        const block: Block = { type: "tool_result", tool_use_id: m.toolCallId ?? "", content: m.content };
        const last = messages[messages.length - 1];
        if (last?.role === "user" && Array.isArray(last.content) && last.content.every((b) => b.type === "tool_result")) last.content.push(block);
        else messages.push({ role: "user", content: [block] });
      }
    }
    const system = [req.system, req.json ? "Respond with a single valid JSON object only, no prose, no code fences." : undefined].filter(Boolean).join("\n\n") || undefined;
    try {
      const res = await this.client.messages.create({
        model: req.model ?? this.defaultModel, max_tokens: req.maxTokens ?? this.defaultMaxTokens,
        ...(system ? { system } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        messages: messages as Anthropic.MessageParam[],
        ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })) } : {}),
      }, { signal });
      const toolCalls: ToolCall[] = [];
      let content = "";
      for (const b of res.content) {
        if (b.type === "text") content += b.text;
        else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, arguments: (b.input ?? {}) as Record<string, unknown> });
      }
      return {
        content, toolCalls,
        stopReason: res.stop_reason === "tool_use" ? "tool_use" : res.stop_reason === "max_tokens" ? "length" : res.stop_reason === "end_turn" || res.stop_reason === "stop_sequence" ? "end" : "other",
        usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens },
        model: res.model, provider: this.provider,
      };
    } catch (e) { throw toBridgeError(e); }
  }
}
