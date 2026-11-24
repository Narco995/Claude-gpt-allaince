import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { BridgeError } from "../core/errors.js";
import { CritiqueSchema } from "../core/protocol.js";
import { WorkflowInputSchema } from "../core/workflow.js";
import { DelegateInputSchema, type BridgeService } from "../service.js";

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data as Record<string, unknown> } : {}),
});
const fail = (e: unknown) => {
  const be = e instanceof BridgeError ? e : new BridgeError("provider", e instanceof Error ? e.message : String(e));
  return { isError: true as const, content: [{ type: "text" as const, text: `[${be.code}] ${be.message}` }] };
};
const guard = <A>(fn: (a: A, extra: { signal: AbortSignal }) => Promise<unknown>) => async (a: A, extra: { signal: AbortSignal }) => {
  try { return ok(await fn(a, extra)); } catch (e) { return fail(e); }
};
const id = z.string().uuid();

/** MCP is the primary interface. Tool names are prefixed `bridge_` for discoverability. */
export function createMcpServer(svc: BridgeService, owner?: string): McpServer {
  const s = new McpServer({ name: "claude-gpt-bridge", version: "0.1.0" });

  s.registerTool("bridge_run_workflow", {
    title: "Run Claude→GPT workflow",
    description: "Run the full workflow: your detailed `directive` is delegated to the worker model (default GPT); the worker's result is critiqued (by the critic model, default Claude, or by you with critiqueMode='external'); the worker then revises. Returns draft, critique(s) and final revision. With critiqueMode='external' the workflow pauses in state 'awaiting_critique'; review `draft` and call bridge_submit_critique. Set wait=false to return immediately and poll bridge_get_workflow.",
    inputSchema: { ...WorkflowInputSchema.shape, wait: z.boolean().default(true).describe("Wait for completion (default true)") },
    annotations: { openWorldHint: true },
  }, guard(async ({ wait, ...input }) => svc.runWorkflow(input, { wait, owner })));

  s.registerTool("bridge_submit_critique", {
    title: "Submit critique (external critic)",
    description: "Provide your critique of a workflow's current output (workflow must be 'awaiting_critique'). The worker revises and the updated workflow is returned.",
    inputSchema: { workflowId: id, critique: CritiqueSchema },
    annotations: { openWorldHint: true },
  }, guard(async ({ workflowId, critique }) => svc.submitCritique(workflowId, critique)));

  s.registerTool("bridge_get_workflow", { title: "Get workflow", description: "Get a workflow run by id (state, rounds, final output, usage).", inputSchema: { workflowId: id }, annotations: { readOnlyHint: true } },
    guard(async ({ workflowId }) => svc.getWorkflow(workflowId)));

  s.registerTool("bridge_cancel_workflow", { title: "Cancel workflow", description: "Cancel a running or paused workflow.", inputSchema: { workflowId: id }, annotations: { destructiveHint: true, idempotentHint: true } },
    guard(async ({ workflowId }) => svc.cancelWorkflow(workflowId)));

  s.registerTool("bridge_delegate", {
    title: "Delegate a task",
    description: "One-shot delegation of a task to another model (default GPT) with optional bridge tools. Recorded in a session; pass sessionId to keep context together.",
    inputSchema: DelegateInputSchema.shape, annotations: { openWorldHint: true },
  }, guard(async (a, extra) => svc.delegate(a, { signal: extra.signal, owner })));

  s.registerTool("bridge_list_models", { title: "List models", description: "List configured model adapters and aliases.", inputSchema: {}, annotations: { readOnlyHint: true } },
    guard(async () => ({ models: svc.listModels() })));
  s.registerTool("bridge_list_tools", { title: "List bridge tools", description: "List tools GPT/Claude can use inside workflows, with JSON schemas.", inputSchema: {}, annotations: { readOnlyHint: true } },
    guard(async () => ({ tools: svc.listTools() })));
  s.registerTool("bridge_call_tool", {
    title: "Call a bridge tool", description: "Directly invoke a registered bridge tool.",
    inputSchema: { name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) },
  }, guard(async ({ name, arguments: args }, extra) => svc.callTool(name, args, { signal: extra.signal, caller: owner })));

  s.registerTool("bridge_get_session", { title: "Get session transcript", description: "Return a session with its full structured message log.", inputSchema: { sessionId: id }, annotations: { readOnlyHint: true } },
    guard(async ({ sessionId }) => svc.getSession(sessionId)));
  s.registerTool("bridge_list_sessions", { title: "List sessions", description: "List sessions (newest first) without message bodies.", inputSchema: {}, annotations: { readOnlyHint: true } },
    guard(async () => ({ sessions: (await svc.listSessions(owner)).map(({ messages, ...r }) => ({ ...r, messageCount: messages.length })) })));

  return s;
}
