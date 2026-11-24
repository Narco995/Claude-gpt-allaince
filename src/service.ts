import { z } from "zod";
import { BridgeError } from "./core/errors.js";
import { runAgent } from "./core/agent-loop.js";
import type { AdapterRegistry } from "./core/models.js";
import type { SessionStore } from "./core/session.js";
import type { ToolRegistry } from "./core/tools.js";
import type { Logger } from "./core/logger.js";
import { WorkflowEngine, type WorkflowInput } from "./core/workflow.js";
import { AgentIdSchema } from "./core/protocol.js";
import type { Config } from "./config.js";

export const DelegateInputSchema = z.object({
  to: AgentIdSchema.default("gpt"),
  from: AgentIdSchema.default("claude"),
  directive: z.string().min(1).max(100_000),
  sessionId: z.string().uuid().optional(),
  tools: z.array(z.string()).max(32).optional(),
  model: z.string().optional(),
  system: z.string().max(20_000).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(16).max(64_000).optional(),
});
export type DelegateInput = z.input<typeof DelegateInputSchema>;

/** Single application facade; MCP and REST are thin shells over this. */
export class BridgeService {
  constructor(readonly deps: {
    config: Config; adapters: AdapterRegistry; tools: ToolRegistry; sessions: SessionStore; engine: WorkflowEngine; logger: Logger;
  }) {}

  listModels() { return this.deps.adapters.list(); }
  listTools() { return this.deps.tools.list(); }

  async callTool(name: string, args: unknown, o: { signal?: AbortSignal; sessionId?: string; caller?: string } = {}) {
    return this.deps.tools.call(name, args, { signal: o.signal ?? new AbortController().signal, sessionId: o.sessionId, callerId: o.caller, logger: this.deps.logger });
  }

  createSession(init: { title?: string; owner?: string; metadata?: Record<string, unknown> } = {}) { return this.deps.sessions.create(init); }
  getSession(id: string) { return this.deps.sessions.get(id); }
  listSessions(owner?: string) { return this.deps.sessions.list(owner); }
  closeSession(id: string) { return this.deps.sessions.close(id); }

  /** One-shot delegation: director -> worker model, recorded in a session. */
  async delegate(raw: DelegateInput, o: { signal?: AbortSignal; owner?: string } = {}) {
    const p = DelegateInputSchema.safeParse(raw);
    if (!p.success) throw new BridgeError("validation", `Invalid delegate input: ${p.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const i = p.data;
    this.deps.adapters.get(i.to);
    const session = i.sessionId ? await this.deps.sessions.get(i.sessionId) : await this.deps.sessions.create({ title: i.directive.slice(0, 80), owner: o.owner });
    const directive = await this.deps.sessions.appendMessage(session.id, { from: i.from, to: i.to, type: "directive", content: i.directive });
    const r = await runAgent({
      adapterId: i.to, adapters: this.deps.adapters, tools: this.deps.tools,
      system: i.system ?? `You are "${i.to}", receiving delegated work from "${i.from}". Complete it fully and return the deliverable only.`,
      messages: [{ role: "user", content: i.directive }], toolNames: i.tools, maxToolRounds: this.deps.config.resilience.maxToolRounds,
      model: i.model, temperature: i.temperature, maxTokens: i.maxTokens, signal: o.signal ?? new AbortController().signal,
      sessionId: session.id, logger: this.deps.logger.child({ agent: i.to }),
      record: async (type, content, structured) => { await this.deps.sessions.appendMessage(session.id, { from: i.to, to: "bridge", type, content, structured }); },
    });
    const result = await this.deps.sessions.appendMessage(session.id, { from: i.to, to: i.from, type: "result", content: r.content, parentId: directive.id, structured: { model: r.model, toolRounds: r.toolRounds } });
    return { sessionId: session.id, messageId: result.id, model: r.model, toolRounds: r.toolRounds, usage: r.usage, result: r.content };
  }

  async runWorkflow(input: WorkflowInput, o: { wait?: boolean; owner?: string } = {}) {
    const run = await this.deps.engine.start(input, o.owner);
    return (o.wait ?? true) ? this.deps.engine.done(run.id) : run;
  }
  getWorkflow(id: string) { return this.deps.engine.get(id); }
  listWorkflows(sessionId?: string) { return this.deps.engine.list(sessionId); }
  submitCritique(id: string, critique: unknown) { return this.deps.engine.submitCritique(id, critique); }
  cancelWorkflow(id: string) { return this.deps.engine.cancel(id); }

  async dashboardSummary() {
    const runs = this.deps.engine.list();
    const byState: Record<string, number> = {};
    for (const r of runs) byState[r.state] = (byState[r.state] ?? 0) + 1;
    return {
      sessions: await this.deps.sessions.count(), workflows: { total: runs.length, byState },
      models: this.listModels().map((m) => m.id), tools: this.listTools().map((t) => t.name),
      tokens: runs.reduce((a, r) => ({ input: a.input + r.usage.inputTokens, output: a.output + r.usage.outputTokens }), { input: 0, output: 0 }),
    };
  }
}
