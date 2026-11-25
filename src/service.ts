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
import type { Action, Authorizer, Principal } from "./extensions/index.js";

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

/** Single application facade; all interfaces share identity, authorization and ownership rules. */
export class BridgeService {
  constructor(readonly deps: {
    config: Config; adapters: AdapterRegistry; tools: ToolRegistry; sessions: SessionStore; engine: WorkflowEngine; logger: Logger; authorizer: Authorizer;
  }) {}

  private require(principal: Principal, action: Action, resource?: { type: string; id?: string; tags?: string[] }): void {
    if (!this.deps.authorizer.can(principal, action, resource)) throw new BridgeError("forbidden", `Principal "${principal.id}" is not authorized for ${action}`);
  }
  private isAdmin(principal: Principal): boolean { return this.deps.authorizer.can(principal, "admin"); }
  private async ownedSession(id: string, principal: Principal) {
    const session = await this.deps.sessions.get(id);
    if (!this.isAdmin(principal) && session.owner !== principal.id) throw new BridgeError("not_found", `Session ${id} not found`);
    return session;
  }
  private async ownedWorkflow(id: string, principal: Principal) {
    const run = await this.deps.engine.get(id);
    await this.ownedSession(run.sessionId, principal);
    return run;
  }

  listModels(principal: Principal) { this.require(principal, "model:list"); return this.deps.adapters.list(); }
  listTools(principal: Principal) { this.require(principal, "tool:call"); return this.deps.tools.list(); }

  async callTool(name: string, args: unknown, o: { signal?: AbortSignal; sessionId?: string; principal: Principal }) {
    const tool = this.deps.tools.list().find((t) => t.name === name);
    if (!tool) throw new BridgeError("not_found", `Unknown tool "${name}"`);
    this.require(o.principal, "tool:call", { type: "tool", id: name, tags: tool.tags });
    if (o.sessionId) await this.ownedSession(o.sessionId, o.principal);
    return this.deps.tools.call(name, args, {
      signal: o.signal ?? new AbortController().signal, sessionId: o.sessionId,
      callerId: o.principal.id, logger: this.deps.logger,
      principal: o.principal, authorizer: this.deps.authorizer,
    });
  }

  createSession(init: { title?: string; metadata?: Record<string, unknown> } = {}, principal: Principal) {
    this.require(principal, "session:write");
    return this.deps.sessions.create({ ...init, owner: principal.id });
  }
  async getSession(id: string, principal: Principal) {
    this.require(principal, "session:read");
    return this.ownedSession(id, principal);
  }
  async listSessions(principal: Principal) {
    this.require(principal, "session:read");
    return this.deps.sessions.list(this.isAdmin(principal) ? undefined : principal.id);
  }
  async closeSession(id: string, principal: Principal) {
    this.require(principal, "session:write");
    await this.ownedSession(id, principal);
    return this.deps.sessions.close(id);
  }

  /** One-shot delegation; worker tools execute under a restricted agent identity, never the human token. */
  async delegate(raw: DelegateInput, o: { signal?: AbortSignal; principal: Principal }) {
    this.require(o.principal, "workflow:run");
    this.require(o.principal, "session:write");
    const p = DelegateInputSchema.safeParse(raw);
    if (!p.success) throw new BridgeError("validation", `Invalid delegate input: ${p.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const i = p.data;
    this.deps.adapters.get(i.to);
    if (i.system && !this.isAdmin(o.principal)) throw new BridgeError("forbidden", "Only an admin identity may override the worker system prompt");
    const session = i.sessionId
      ? await this.ownedSession(i.sessionId, o.principal)
      : await this.deps.sessions.create({ title: i.directive.slice(0, 80), owner: o.principal.id });
    const directive = await this.deps.sessions.appendMessage(session.id, { from: o.principal.id, to: i.to, type: "directive", content: i.directive, metadata: { claimedFrom: i.from, authenticatedPrincipal: o.principal.id } });
    const agentPrincipal: Principal = { id: `agent:${i.to}`, scopes: ["tool:call"] };
    const r = await runAgent({
      adapterId: i.to, adapters: this.deps.adapters, tools: this.deps.tools,
      system: i.system ?? `You are "${i.to}", receiving delegated work from authenticated principal "${o.principal.id}". Complete it fully and return the deliverable only.`,
      messages: [{ role: "user", content: i.directive }], toolNames: i.tools, maxToolRounds: this.deps.config.resilience.maxToolRounds,
      model: i.model, temperature: i.temperature, maxTokens: i.maxTokens, signal: o.signal ?? new AbortController().signal,
      sessionId: session.id, logger: this.deps.logger.child({ agent: i.to }),
      principal: agentPrincipal, authorizer: this.deps.authorizer,
      record: async (type, content, structured) => { await this.deps.sessions.appendMessage(session.id, { from: i.to, to: "bridge", type, content, structured }); },
    });
    const result = await this.deps.sessions.appendMessage(session.id, { from: i.to, to: o.principal.id, type: "result", content: r.content, parentId: directive.id, structured: { model: r.model, toolRounds: r.toolRounds } });
    return { sessionId: session.id, messageId: result.id, model: r.model, toolRounds: r.toolRounds, usage: r.usage, result: r.content };
  }

  async runWorkflow(input: WorkflowInput, o: { wait?: boolean; principal: Principal }) {
    this.require(o.principal, "workflow:run");
    this.require(o.principal, "session:write");
    if (input.sessionId) await this.ownedSession(input.sessionId, o.principal);
    const run = await this.deps.engine.start(input, o.principal);
    return (o.wait ?? true) ? this.deps.engine.done(run.id) : run;
  }
  async getWorkflow(id: string, principal: Principal) {
    this.require(principal, "workflow:read");
    return this.ownedWorkflow(id, principal);
  }
  async listWorkflows(principal: Principal, sessionId?: string) {
    this.require(principal, "workflow:read");
    if (sessionId) await this.ownedSession(sessionId, principal);
    const runs = await this.deps.engine.list(sessionId);
    if (this.isAdmin(principal)) return runs;
    const sessions = await this.deps.sessions.list(principal.id);
    const allowed = new Set(sessions.map((s) => s.id));
    return runs.filter((r) => allowed.has(r.sessionId));
  }
  async submitCritique(id: string, critique: unknown, principal: Principal) {
    this.require(principal, "workflow:critique");
    await this.ownedWorkflow(id, principal);
    return this.deps.engine.submitCritique(id, critique, principal.id);
  }
  async cancelWorkflow(id: string, principal: Principal) {
    this.require(principal, "workflow:cancel");
    await this.ownedWorkflow(id, principal);
    return this.deps.engine.cancel(id);
  }

  async dashboardSummary(principal: Principal) {
    this.require(principal, "workflow:read");
    const runs = await this.listWorkflows(principal);
    const byState: Record<string, number> = {};
    for (const r of runs) byState[r.state] = (byState[r.state] ?? 0) + 1;
    const sessions = await this.deps.sessions.list(this.isAdmin(principal) ? undefined : principal.id);
    return {
      sessions: sessions.length, workflows: { total: runs.length, byState },
      models: this.deps.adapters.list().map((m) => m.id), tools: this.deps.tools.list().map((t) => t.name),
      tokens: runs.reduce((a, r) => ({ input: a.input + r.usage.inputTokens, output: a.output + r.usage.outputTokens }), { input: 0, output: 0 }),
    };
  }
}
