import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AgentIdSchema, CritiqueSchema, type Critique, type MessageType } from "./protocol.js";
import { BridgeError, isAbort, toBridgeError } from "./errors.js";
import { runAgent } from "./agent-loop.js";
import { traceStore, type Logger } from "./logger.js";
import { withTimeout } from "./resilience.js";
import type { AdapterRegistry, ChatMessage } from "./models.js";
import type { SessionStore } from "./session.js";
import type { ToolRegistry } from "./tools.js";

export const WorkflowInputSchema = z.object({
  /** The detailed directive written by the director (Claude). */
  directive: z.string().min(1).max(100_000),
  context: z.string().max(200_000).optional(),
  sessionId: z.string().uuid().optional(),
  director: AgentIdSchema.default("claude"),
  worker: AgentIdSchema.default("gpt"),
  critic: AgentIdSchema.default("claude"),
  /** adapter: the critic model is called by the bridge. external: workflow pauses until the caller (e.g. Claude via MCP) submits a critique. */
  critiqueMode: z.enum(["adapter", "external"]).default("adapter"),
  revisionRounds: z.number().int().min(1).max(3).default(1),
  tools: z.array(z.string()).max(32).optional(),
  workerModel: z.string().optional(),
  criticModel: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(16).max(64_000).optional(),
  title: z.string().max(200).optional(),
});
export type WorkflowInput = z.input<typeof WorkflowInputSchema>;
export type NormalizedWorkflowInput = z.output<typeof WorkflowInputSchema>;

export type WorkflowState = "created" | "delegating" | "awaiting_critique" | "critiquing" | "revising" | "completed" | "failed" | "cancelled";
const TERMINAL = new Set<WorkflowState>(["completed", "failed", "cancelled"]);
const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  created: ["delegating", "failed", "cancelled"],
  delegating: ["critiquing", "awaiting_critique", "failed", "cancelled"],
  critiquing: ["revising", "failed", "cancelled"],
  awaiting_critique: ["revising", "failed", "cancelled"],
  revising: ["completed", "critiquing", "awaiting_critique", "failed", "cancelled"],
  completed: [], failed: [], cancelled: [],
};

export interface WorkflowRound { index: number; output: string; critique?: Critique; critiqueSource?: "adapter" | "external"; revision?: string }
export interface WorkflowRun {
  id: string; sessionId: string; state: WorkflowState;
  input: NormalizedWorkflowInput;
  rounds: WorkflowRound[];
  draft?: string; final?: string;
  error?: { code: string; message: string };
  history: { state: WorkflowState; at: string; note?: string }[];
  usage: { inputTokens: number; outputTokens: number; modelCalls: number; toolCalls: number };
  models: { worker?: string; critic?: string };
  createdAt: string; updatedAt: string;
}
export type WorkflowEvent = { type: "state"; run: WorkflowRun } | { type: "message"; runId: string; messageType: MessageType };

interface Handle { run: WorkflowRun; cancel: AbortController; running: Promise<void> }
export interface WorkflowEngineOptions { maxToolRounds: number; workflowTimeoutMs: number; maxRuns?: number }

export class WorkflowEngine {
  private handles = new Map<string, Handle>();
  private listeners: ((e: WorkflowEvent) => void)[] = [];

  constructor(private adapters: AdapterRegistry, private tools: ToolRegistry, private sessions: SessionStore, private log: Logger, private opts: WorkflowEngineOptions) {}

  onEvent(fn: (e: WorkflowEvent) => void): () => void {
    this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }
  private emit(e: WorkflowEvent) { for (const l of this.listeners) { try { l(e); } catch { /* listener errors never break workflows */ } } }

  /** Validate + create the run and begin executing. Await `done(runId)` for completion/pause. */
  async start(raw: WorkflowInput, owner?: string): Promise<WorkflowRun> {
    const parsed = WorkflowInputSchema.safeParse(raw);
    if (!parsed.success) throw new BridgeError("validation", `Invalid workflow input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const input = parsed.data;
    // Fail fast on misconfiguration before any state is created.
    const worker = this.adapters.get(input.worker);
    const critic = input.critiqueMode === "adapter" ? this.adapters.get(input.critic) : undefined;
    if (input.tools?.length) this.tools.specs(input.tools);

    const session = input.sessionId ? await this.sessions.get(input.sessionId) : await this.sessions.create({ title: input.title ?? input.directive.slice(0, 80), owner });
    const now = new Date().toISOString();
    const run: WorkflowRun = {
      id: randomUUID(), sessionId: session.id, state: "created", input, rounds: [],
      history: [{ state: "created", at: now }], usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0, toolCalls: 0 },
      models: { worker: input.workerModel ?? worker.defaultModel, critic: input.criticModel ?? critic?.defaultModel },
      createdAt: now, updatedAt: now,
    };
    await this.sessions.attachWorkflow(session.id, run.id);
    const handle: Handle = { run, cancel: new AbortController(), running: Promise.resolve() };
    this.handles.set(run.id, handle);
    this.gc();
    await this.record(run, input.director, input.worker, "directive", input.directive, input.context ? { context: input.context } : undefined);
    this.launch(handle);
    return run;
  }

  /** Wait until the workflow reaches a terminal state or pauses for an external critique. */
  async done(runId: string): Promise<WorkflowRun> { const h = this.mustHandle(runId); await h.running; return h.run; }
  get(runId: string): WorkflowRun { return this.mustHandle(runId).run; }
  list(sessionId?: string): WorkflowRun[] { return [...this.handles.values()].map((h) => h.run).filter((r) => !sessionId || r.sessionId === sessionId); }

  async submitCritique(runId: string, critique: unknown): Promise<WorkflowRun> {
    const h = this.mustHandle(runId);
    if (h.run.state !== "awaiting_critique") throw new BridgeError("invalid_state", `Workflow ${runId} is "${h.run.state}", not awaiting a critique`);
    const c = CritiqueSchema.safeParse(critique);
    if (!c.success) throw new BridgeError("validation", `Invalid critique: ${c.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const round = this.currentRound(h.run);
    round.critique = c.data; round.critiqueSource = "external";
    await this.record(h.run, h.run.input.critic, h.run.input.worker, "critique", renderCritique(c.data), { critique: c.data, source: "external" });
    this.transition(h.run, "revising", "external critique received");
    this.launch(h);
    return this.done(runId);
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    const h = this.mustHandle(runId);
    if (TERMINAL.has(h.run.state)) return h.run;
    h.cancel.abort();
    await h.running;                      // an in-flight drive transitions to "cancelled" itself
    if (!TERMINAL.has(h.run.state)) this.transition(h.run, "cancelled", "cancelled while paused");
    return h.run;
  }

  // ---- internals ----
  private mustHandle(id: string): Handle {
    const h = this.handles.get(id);
    if (!h) throw new BridgeError("not_found", `Workflow ${id} not found`);
    return h;
  }
  private gc() {
    const max = this.opts.maxRuns ?? 2000;
    if (this.handles.size <= max) return;
    for (const [id, h] of this.handles) { if (TERMINAL.has(h.run.state)) { this.handles.delete(id); if (this.handles.size <= max) return; } }
  }
  private currentRound(run: WorkflowRun): WorkflowRound { const r = run.rounds[run.rounds.length - 1]; if (!r) throw new BridgeError("invalid_state", "no active round"); return r; }
  private transition(run: WorkflowRun, to: WorkflowState, note?: string) {
    if (!TRANSITIONS[run.state].includes(to)) throw new BridgeError("invalid_state", `Illegal workflow transition ${run.state} -> ${to}`);
    run.state = to; run.updatedAt = new Date().toISOString(); run.history.push({ state: to, at: run.updatedAt, note });
    this.log.info("workflow state", { workflowId: run.id, state: to, note });
    this.emit({ type: "state", run });
  }
  private async record(run: WorkflowRun, from: string, to: string, type: MessageType, content: string, structured?: Record<string, unknown>) {
    await this.sessions.appendMessage(run.sessionId, { workflowId: run.id, from, to, type, content, structured });
    this.emit({ type: "message", runId: run.id, messageType: type });
  }
  private launch(h: Handle) {
    h.running = traceStore.run({ traceId: randomUUID(), sessionId: h.run.sessionId, workflowId: h.run.id }, () => this.drive(h));
  }

  private async drive(h: Handle): Promise<void> {
    const run = h.run; const input = run.input;
    const t = withTimeout(h.cancel.signal, this.opts.workflowTimeoutMs);
    try {
      if (run.state === "created") {
        this.transition(run, "delegating", `delegating to ${input.worker}`);
        const out = await this.work(run, t.signal, [{ role: "user", content: workerPrompt(input.directive, input.context) }], "result");
        run.draft = out; run.final = out;
        run.rounds.push({ index: 0, output: out });
        this.transition(run, input.critiqueMode === "adapter" ? "critiquing" : "awaiting_critique");
      }
      for (;;) {
        if (run.state === "critiquing") {
          const round = this.currentRound(run);
          const critique = await this.critique(run, t.signal, round.output);
          round.critique = critique; round.critiqueSource = "adapter";
          this.transition(run, "revising", `critic verdict: ${critique.verdict}`);
        }
        if (run.state === "awaiting_critique") return;          // paused; submitCritique() resumes
        if (run.state === "revising") {
          const round = this.currentRound(run);
          const messages: ChatMessage[] = [
            { role: "user", content: workerPrompt(input.directive, input.context) },
            { role: "assistant", content: round.output },
            { role: "user", content: revisionPrompt(round.critique!) },
          ];
          const rev = await this.work(run, t.signal, messages, "revision");
          round.revision = rev; run.final = rev;
          if (run.rounds.length < input.revisionRounds) {
            run.rounds.push({ index: run.rounds.length, output: rev });
            this.transition(run, input.critiqueMode === "adapter" ? "critiquing" : "awaiting_critique", "next revision round");
            continue;
          }
          this.transition(run, "completed");
          return;
        }
        return;
      }
    } catch (e) {
      if (TERMINAL.has(run.state)) return;
      if (h.cancel.signal.aborted) { this.transition(run, "cancelled", "cancelled by caller"); return; }
      const err = t.timedOut() ? new BridgeError("timeout", `workflow exceeded ${this.opts.workflowTimeoutMs}ms`) : e instanceof BridgeError ? e : isAbort(e) ? new BridgeError("cancelled", "aborted") : toBridgeError(e);
      run.error = { code: err.code, message: err.message };
      this.log.error("workflow failed", { workflowId: run.id, code: err.code, error: err.message });
      await this.sessions.appendMessage(run.sessionId, { workflowId: run.id, from: "bridge", to: input.director, type: "error", content: err.message, structured: { code: err.code } }).catch(() => undefined);
      this.transition(run, "failed", err.message);
    } finally { t.done(); }
  }

  private async work(run: WorkflowRun, signal: AbortSignal, messages: ChatMessage[], type: "result" | "revision"): Promise<string> {
    const { input } = run;
    const r = await runAgent({
      adapterId: input.worker, adapters: this.adapters, tools: this.tools,
      system: `You are "${input.worker}", an expert agent receiving delegated work from "${input.director}" through an AI-to-AI bridge. Follow the directive exactly and completely. Use the provided tools when they improve accuracy. Reply with the finished deliverable only, with no preamble about the process.`,
      messages, toolNames: input.tools, maxToolRounds: this.opts.maxToolRounds,
      model: input.workerModel, temperature: input.temperature, maxTokens: input.maxTokens,
      signal, sessionId: run.sessionId, logger: this.log.child({ agent: input.worker }),
      record: async (mt, content, structured) => { if (mt === "tool_call") run.usage.toolCalls++; await this.record(run, input.worker, "bridge", mt, content, structured); },
    });
    this.addUsage(run, r.usage); run.models.worker = r.model;
    await this.record(run, input.worker, input.director, type, r.content, { model: r.model, toolRounds: r.toolRounds });
    return r.content;
  }

  private async critique(run: WorkflowRun, signal: AbortSignal, deliverable: string): Promise<Critique> {
    const { input } = run;
    const system = `You are "${input.critic}", a rigorous senior reviewer. Judge the deliverable against the directive: correctness, completeness, adherence to constraints, clarity. Respond with ONLY one JSON object: {"verdict":"approve"|"revise"|"reject","score":0-10,"summary":string,"issues":[{"severity":"low"|"medium"|"high","description":string,"suggestion":string}]}. Be specific and actionable; list real issues even for strong work.`;
    const base: ChatMessage[] = [{ role: "user", content: `## Directive\n${input.directive}\n\n## Deliverable to review\n${deliverable}` }];
    const call = async (messages: ChatMessage[]) => {
      const r = await runAgent({ adapterId: input.critic, adapters: this.adapters, tools: this.tools, system, messages, maxToolRounds: 0, model: input.criticModel, temperature: 0.2, json: true, signal, sessionId: run.sessionId, logger: this.log.child({ agent: input.critic }) });
      this.addUsage(run, r.usage); run.models.critic = r.model; return r.content;
    };
    let raw = await call(base);
    let critique = parseCritique(raw);
    if (!critique) {
      this.log.warn("critique not valid JSON, requesting repair", { workflowId: run.id });
      raw = await call([...base, { role: "assistant", content: raw }, { role: "user", content: "That was not a valid JSON object matching the schema. Reply again with ONLY the JSON object." }]);
      critique = parseCritique(raw);
    }
    if (!critique) critique = { verdict: "revise", summary: raw.trim().slice(0, 4000) || "Critic returned unparseable output.", issues: [] };
    await this.record(run, input.critic, input.worker, "critique", renderCritique(critique), { critique, source: "adapter", model: run.models.critic });
    return critique;
  }

  private addUsage(run: WorkflowRun, u: { inputTokens: number; outputTokens: number }) {
    run.usage.inputTokens += u.inputTokens; run.usage.outputTokens += u.outputTokens; run.usage.modelCalls++;
  }
}

export function parseCritique(raw: string): Critique | undefined {
  const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
  if (s < 0 || e <= s) return undefined;
  try { const r = CritiqueSchema.safeParse(JSON.parse(raw.slice(s, e + 1))); return r.success ? r.data : undefined; } catch { return undefined; }
}
export function renderCritique(c: Critique): string {
  const issues = c.issues.map((i, n) => `${n + 1}. [${i.severity}] ${i.description}${i.suggestion ? ` — Fix: ${i.suggestion}` : ""}`).join("\n");
  return `Verdict: ${c.verdict}${c.score !== undefined ? ` (score ${c.score}/10)` : ""}\n${c.summary}${issues ? `\n\nIssues:\n${issues}` : ""}`;
}
const workerPrompt = (directive: string, context?: string) => `## Directive\n${directive}${context ? `\n\n## Context\n${context}` : ""}`;
const revisionPrompt = (c: Critique) => `Your deliverable was reviewed.\n\n${renderCritique(c)}\n\nProduce the COMPLETE revised deliverable, addressing every issue above while preserving what was already correct. Output the full revised deliverable only.`;
