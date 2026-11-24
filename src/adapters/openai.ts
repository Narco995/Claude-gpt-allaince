import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { BridgeError, toBridgeError } from "../core/errors.js";
import type { ModelAdapter, ModelRequest, ModelResponse, ToolCall } from "../core/models.js";

export interface OpenAIAdapterOptions { apiKey: string; baseURL?: string; model: string; id?: string; client?: OpenAI }

export class OpenAIAdapter implements ModelAdapter {
  readonly id: string; readonly provider = "openai"; readonly defaultModel: string;
  private client: OpenAI;

  constructor(o: OpenAIAdapterOptions) {
    this.id = o.id ?? "openai"; this.defaultModel = o.model;
    // maxRetries 0: retries/timeouts are owned by ResilientAdapter so behaviour is uniform across providers.
    this.client = o.client ?? new OpenAI({ apiKey: o.apiKey, baseURL: o.baseURL, maxRetries: 0 });
  }

  async complete(req: ModelRequest, { signal }: { signal: AbortSignal }): Promise<ModelResponse> {
    const messages: ChatCompletionMessageParam[] = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) {
      if (m.role === "user") messages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") {
        messages.push({
          role: "assistant", content: m.content || null,
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}),
        });
      } else messages.push({ role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content });
    }
    const tools: ChatCompletionTool[] | undefined = req.tools?.length
      ? req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined;
    try {
      const res = await this.client.chat.completions.create({
        model: req.model ?? this.defaultModel, messages, ...(tools ? { tools } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens ? { max_completion_tokens: req.maxTokens } : {}),
        ...(req.json && !tools ? { response_format: { type: "json_object" as const } } : {}),
      }, { signal });
      const choice = res.choices[0];
      if (!choice) throw new BridgeError("provider", "OpenAI returned no choices", true);
      const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).flatMap((c) => {
        if (c.type !== "function") return [];
        let args: Record<string, unknown>;
        try { args = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>; } catch { args = { __invalid_json: c.function.arguments }; }
        return [{ id: c.id, name: c.function.name, arguments: args }];
      });
      return {
        content: choice.message.content ?? "", toolCalls,
        stopReason: toolCalls.length ? "tool_use" : choice.finish_reason === "length" ? "length" : choice.finish_reason === "stop" ? "end" : "other",
        usage: res.usage ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens } : undefined,
        model: res.model, provider: this.provider,
      };
    } catch (e) { throw toBridgeError(e); }
  }
}
