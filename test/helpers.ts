import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createBridge } from "../src/bootstrap.js";
import { createLogger } from "../src/core/logger.js";

export interface Recorded { path: string; body: any }  // eslint-disable-line @typescript-eslint/no-explicit-any
export type Reply = { status?: number; json?: unknown; delayMs?: number; hang?: boolean };
export type Handler = (body: any, n: number) => Reply;  // eslint-disable-line @typescript-eslint/no-explicit-any

/** Real HTTP server speaking just enough of the OpenAI / Anthropic wire protocols to exercise the REAL adapters + SDKs. */
export class FakeProvider {
  requests: Recorded[] = []; handler: Handler; server: http.Server; url = "";
  constructor(handler: Handler) {
    this.handler = handler;
    this.server = http.createServer((req, res) => {
      let raw = ""; req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        this.requests.push({ path: req.url ?? "", body });
        const r = this.handler(body, this.requests.length);
        if (r.hang) return; // never respond; stop() force-closes sockets
        setTimeout(() => { res.writeHead(r.status ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(r.json)); }, r.delayMs ?? 0);
      });
    });
  }
  async start() { await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r)); this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`; return this; }
  async stop() { this.server.closeAllConnections(); await new Promise((r) => this.server.close(r)); }
}

export const openaiText = (content: string, extra: Record<string, unknown> = {}): Reply => ({ json: { id: "x", object: "chat.completion", created: 1, model: "gpt-fake", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, ...extra } });
export const openaiToolCall = (name: string, args: unknown): Reply => ({ json: { id: "x", object: "chat.completion", created: 1, model: "gpt-fake", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } } });
export const anthropicText = (text: string): Reply => ({ json: { id: "msg_1", type: "message", role: "assistant", model: "claude-fake", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 20, output_tokens: 30 } } });
export const anthropicToolUse = (name: string, input: unknown): Reply => ({ json: { id: "msg_2", type: "message", role: "assistant", model: "claude-fake", content: [{ type: "tool_use", id: "toolu_1", name, input }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 20, output_tokens: 30 } } });

export const CRITIQUE_JSON = JSON.stringify({ verdict: "revise", score: 6, summary: "Missing the units.", issues: [{ severity: "high", description: "No units given", suggestion: "State units explicitly" }] });

/** The scripted GPT behaviour used by the mandatory-workflow tests. */
export const gptScript: Handler = (body) => {
  const msgs: any[] = body.messages ?? [];  // eslint-disable-line @typescript-eslint/no-explicit-any
  const last = msgs[msgs.length - 1];
  const text = (m: any) => (typeof m?.content === "string" ? m.content : "");  // eslint-disable-line @typescript-eslint/no-explicit-any
  if (last?.role === "tool") return openaiText(`DRAFT using tool: ${last.content}`);
  if (text(last).includes("Your deliverable was reviewed")) return openaiText(`REVISED (addressed: ${text(last).includes("No units given") ? "units" : "none"})`);
  if (body.tools?.length && text(last).includes("USE_CALC")) return openaiToolCall("calculator", { expression: "6*7" });
  return openaiText("DRAFT v1");
};
export const claudeScript: Handler = () => anthropicText(CRITIQUE_JSON);

export async function makeEnv(opts: { gpt?: Handler; claude?: Handler; env?: Record<string, string> } = {}) {
  const gpt = await new FakeProvider(opts.gpt ?? gptScript).start();
  const claude = await new FakeProvider(opts.claude ?? claudeScript).start();
  const config = loadConfig({
    NODE_ENV: "test", LOG_LEVEL: "error", OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: `${gpt.url}/v1`,
    ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_BASE_URL: claude.url, MAX_RETRIES: "2", RETRY_BASE_DELAY_MS: "5", REQUEST_TIMEOUT_MS: "2000", ...opts.env,
  });
  const bridge = createBridge(config, { logger: createLogger("error") });
  return { ...bridge, gpt, claude, config, stop: async () => { await gpt.stop(); await claude.stop(); } };
}
