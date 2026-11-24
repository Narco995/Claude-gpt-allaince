import { BridgeError } from "./errors.js";
import type { Logger } from "./logger.js";
import type { AdapterRegistry, ChatMessage, ModelResponse } from "./models.js";
import type { ToolRegistry } from "./tools.js";
import type { MessageType } from "./protocol.js";

export interface AgentRunOptions {
  adapterId: string; adapters: AdapterRegistry; tools: ToolRegistry;
  system: string; messages: ChatMessage[];
  toolNames?: string[]; maxToolRounds: number;
  model?: string; temperature?: number; maxTokens?: number; json?: boolean;
  signal: AbortSignal; sessionId?: string; logger: Logger;
  record?: (type: MessageType, content: string, structured?: Record<string, unknown>) => Promise<void>;
}
export interface AgentRunResult { content: string; toolRounds: number; usage: { inputTokens: number; outputTokens: number }; model: string; transcript: ChatMessage[] }

/** Generic model <-> tool loop. Works with any ModelAdapter; knows nothing about providers. */
export async function runAgent(o: AgentRunOptions): Promise<AgentRunResult> {
  const adapter = o.adapters.get(o.adapterId);
  const transcript: ChatMessage[] = [...o.messages];
  const usage = { inputTokens: 0, outputTokens: 0 };
  const specs = o.toolNames?.length ? o.tools.specs(o.toolNames) : undefined;
  let rounds = 0; let last: ModelResponse | undefined;

  for (;;) {
    const allowTools = !!specs && rounds < o.maxToolRounds;
    last = await adapter.complete({
      system: o.system, messages: transcript, tools: allowTools ? specs : undefined,
      model: o.model, temperature: o.temperature, maxTokens: o.maxTokens, json: o.json,
    }, { signal: o.signal });
    usage.inputTokens += last.usage?.inputTokens ?? 0; usage.outputTokens += last.usage?.outputTokens ?? 0;
    if (!allowTools || last.toolCalls.length === 0) break;

    rounds++;
    transcript.push({ role: "assistant", content: last.content, toolCalls: last.toolCalls });
    for (const call of last.toolCalls) {
      await o.record?.("tool_call", `${call.name}(${JSON.stringify(call.arguments)})`, { tool: call.name, arguments: call.arguments, callId: call.id });
      let payload: unknown; let isError = false;
      try {
        payload = await o.tools.call(call.name, call.arguments, { signal: o.signal, sessionId: o.sessionId, callerId: o.adapterId, logger: o.logger });
      } catch (e) {
        if (e instanceof BridgeError && (e.code === "cancelled")) throw e;
        isError = true; payload = { error: e instanceof Error ? e.message : String(e) };
        o.logger.warn("tool error returned to model", { tool: call.name, error: (payload as { error: string }).error });
      }
      const text = JSON.stringify(payload);
      await o.record?.("tool_result", text, { tool: call.name, callId: call.id, isError });
      transcript.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: text });
    }
  }
  if (!last.content.trim()) throw new BridgeError("provider", `Model "${o.adapterId}" returned an empty response`, true);
  return { content: last.content, toolRounds: rounds, usage, model: last.model, transcript };
}
