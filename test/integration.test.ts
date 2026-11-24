import type { AddressInfo } from "node:net";
import type http from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AnthropicAdapter } from "../src/adapters/anthropic.js";
import { anthropicText, anthropicToolUse, claudeScript, FakeProvider, gptScript, makeEnv, openaiText } from "./helpers.js";
import type { WorkflowRun } from "../src/core/workflow.js";

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of cleanup) await c(); cleanup = []; });
const env = async (...a: Parameters<typeof makeEnv>) => { const e = await makeEnv(...a); cleanup.push(e.stop); return e; };

describe("MANDATORY WORKFLOW: Claude directive → Bridge → GPT → result → Claude critique → GPT revision", () => {
  it("runs end-to-end over REST with the real adapters", async () => {
    const e = await env();
    const res = await request(e.app).post("/api/workflows").send({ directive: "Explain the speed of light with units.", context: "Audience: students" }).expect(200);
    const run = res.body as WorkflowRun;

    expect(run.state).toBe("completed");
    expect(run.history.map((h) => h.state)).toEqual(["created", "delegating", "critiquing", "revising", "completed"]);
    expect(run.draft).toBe("DRAFT v1");
    expect(run.rounds[0]?.critique).toMatchObject({ verdict: "revise", score: 6 });
    expect(run.rounds[0]?.critiqueSource).toBe("adapter");
    expect(run.final).toBe("REVISED (addressed: units)");
    expect(run.usage.modelCalls).toBe(3);
    expect(run.usage.inputTokens).toBe(10 + 20 + 10);

    // GPT got Claude's detailed directive (+ context)
    const g1 = e.gpt.requests[0]!.body;
    expect(e.gpt.requests[0]!.path).toBe("/v1/chat/completions");
    expect(g1.messages.at(-1).content).toContain("Explain the speed of light with units.");
    expect(g1.messages.at(-1).content).toContain("Audience: students");
    // Claude was asked to critique GPT's draft, against the directive
    expect(e.claude.requests).toHaveLength(1);
    expect(e.claude.requests[0]!.path).toBe("/v1/messages");
    const cMsg = e.claude.requests[0]!.body.messages[0].content as string;
    expect(cMsg).toContain("DRAFT v1"); expect(cMsg).toContain("Explain the speed of light");
    expect(e.claude.requests[0]!.body.system).toContain("JSON");
    // GPT's revision call carries the whole thread: directive → its draft → critique
    const g2 = e.gpt.requests[1]!.body.messages;
    expect(g2.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(g2[2].content).toBe("DRAFT v1");
    expect(g2[3].content).toContain("No units given");

    // Structured protocol: ordered messages in the session
    const sess = (await request(e.app).get(`/api/sessions/${run.sessionId}`).expect(200)).body;
    expect(sess.messages.map((m: { type: string; from: string; to: string }) => `${m.from}>${m.to}:${m.type}`)).toEqual([
      "claude>gpt:directive", "gpt>claude:result", "claude>gpt:critique", "gpt>claude:revision",
    ]);
    expect(sess.workflowIds).toEqual([run.id]);
  });

  it("runs end-to-end through a real MCP client over streamable HTTP", async () => {
    const e = await env({ env: { BRIDGE_API_KEY: "topsecret" } });
    const server: http.Server = await new Promise((r) => { const s = e.app.listen(0, "127.0.0.1", () => r(s)); });
    cleanup.push(() => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }));
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);

    // unauthenticated is rejected
    expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status).toBe(401);

    const client = new Client({ name: "claude-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: "Bearer topsecret" } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["bridge_run_workflow", "bridge_submit_critique", "bridge_delegate", "bridge_get_workflow", "bridge_cancel_workflow", "bridge_list_models", "bridge_list_tools", "bridge_call_tool", "bridge_get_session", "bridge_list_sessions"]));

    const out = await client.callTool({ name: "bridge_run_workflow", arguments: { directive: "Explain the speed of light with units." } });
    expect(out.isError).toBeFalsy();
    const run = out.structuredContent as unknown as WorkflowRun;
    expect(run.state).toBe("completed"); expect(run.final).toBe("REVISED (addressed: units)");

    const sess = await client.callTool({ name: "bridge_get_session", arguments: { sessionId: run.sessionId } });
    expect((sess.structuredContent as { messages: unknown[] }).messages).toHaveLength(4);

    const bad = await client.callTool({ name: "bridge_run_workflow", arguments: { directive: "x", worker: "unknown-model" } });
    expect(bad.isError).toBe(true); expect(JSON.stringify(bad.content)).toContain("not_found");

    const calc = await client.callTool({ name: "bridge_call_tool", arguments: { name: "calculator", arguments: { expression: "2^10" } } });
    expect(calc.structuredContent).toMatchObject({ result: 1024 });
    await client.close();
  });

  it("supports external critique: Claude (MCP caller) reviews GPT's draft, then GPT revises", async () => {
    const e = await env();
    const paused = (await request(e.app).post("/api/workflows").send({ directive: "Write a haiku about APIs", critiqueMode: "external" }).expect(200)).body as WorkflowRun;
    expect(paused.state).toBe("awaiting_critique"); expect(paused.draft).toBe("DRAFT v1");
    expect(e.claude.requests).toHaveLength(0);  // the bridge did not call the critic model

    await request(e.app).post(`/api/workflows/${paused.id}/critique`).send({ verdict: "maybe", summary: "x" }).expect(400);
    const done = (await request(e.app).post(`/api/workflows/${paused.id}/critique`).send({ verdict: "revise", summary: "Needs units.", issues: [{ severity: "high", description: "No units given" }] }).expect(200)).body as WorkflowRun;
    expect(done.state).toBe("completed"); expect(done.final).toContain("REVISED");
    expect(done.rounds[0]?.critiqueSource).toBe("external");
    expect(e.claude.requests).toHaveLength(0);
    await request(e.app).post(`/api/workflows/${paused.id}/critique`).send({ verdict: "approve", summary: "late" }).expect(409);
  });

  it("supports multiple revision rounds", async () => {
    const e = await env();
    const run = (await request(e.app).post("/api/workflows").send({ directive: "d", revisionRounds: 2 }).expect(200)).body as WorkflowRun;
    expect(run.state).toBe("completed"); expect(run.rounds).toHaveLength(2);
    expect(run.history.map((h) => h.state)).toEqual(["created", "delegating", "critiquing", "revising", "critiquing", "revising", "completed"]);
    expect(e.claude.requests).toHaveLength(2); expect(e.claude.requests[1]!.body.messages[0].content).toContain("REVISED");
  });

  it("lets GPT use bridge tools (OpenAI tool-calling loop) and records tool traffic", async () => {
    const e = await env();
    const run = (await request(e.app).post("/api/workflows").send({ directive: "USE_CALC what is 6*7?", tools: ["calculator"] }).expect(200)).body as WorkflowRun;
    expect(run.state).toBe("completed"); expect(run.draft).toContain('"result":42'); expect(run.usage.toolCalls).toBe(1);
    expect(e.gpt.requests[0]!.body.tools[0].function.name).toBe("calculator");
    const types = (await request(e.app).get(`/api/sessions/${run.sessionId}`)).body.messages.map((m: { type: string }) => m.type);
    expect(types).toEqual(["directive", "tool_call", "tool_result", "result", "critique", "revision"]);
  });
});

describe("failure handling", () => {
  it("retries transient provider errors (500, 429) transparently", async () => {
    const e = await env({ gpt: (b, n) => (n === 1 ? { status: 500, json: { error: { message: "boom" } } } : n === 2 ? { status: 429, json: { error: { message: "slow down" } } } : gptScript(b, n)) });
    const run = (await request(e.app).post("/api/workflows").send({ directive: "d" }).expect(200)).body as WorkflowRun;
    expect(run.state).toBe("completed"); expect(e.gpt.requests.length).toBe(4);
  });

  it("fails the workflow cleanly on a non-retryable error (400) and records it", async () => {
    const e = await env({ gpt: () => ({ status: 400, json: { error: { message: "bad request" } } }) });
    const run = (await request(e.app).post("/api/workflows").send({ directive: "d" }).expect(200)).body as WorkflowRun;
    expect(run.state).toBe("failed"); expect(run.error?.code).toBe("provider"); expect(e.gpt.requests).toHaveLength(1);
    const sess = (await request(e.app).get(`/api/sessions/${run.sessionId}`)).body;
    expect(sess.messages.at(-1)).toMatchObject({ type: "error", from: "bridge" });
  });

  it("times out hung providers", async () => {
    const e = await env({ gpt: () => ({ hang: true }), env: { REQUEST_TIMEOUT_MS: "150", MAX_RETRIES: "1" } });
    const run = (await request(e.app).post("/api/workflows").send({ directive: "d" }).expect(200)).body as WorkflowRun;
    expect(run.state).toBe("failed"); expect(run.error?.code).toBe("timeout"); expect(e.gpt.requests).toHaveLength(2);
  });

  it("enforces an overall workflow deadline", async () => {
    const e = await env({ gpt: () => ({ hang: true }), env: { WORKFLOW_TIMEOUT_MS: "100", REQUEST_TIMEOUT_MS: "5000" } });
    const run = (await request(e.app).post("/api/workflows").send({ directive: "d" }).expect(200)).body as WorkflowRun;
    expect(run.state).toBe("failed"); expect(run.error?.code).toBe("timeout");
  });

  it("cancels an in-flight workflow and aborts the upstream request", async () => {
    const e = await env({ gpt: () => ({ hang: true }) });
    const started = (await request(e.app).post("/api/workflows").send({ directive: "d", wait: false }).expect(202)).body as WorkflowRun;
    await new Promise((r) => setTimeout(r, 100));
    const c = (await request(e.app).post(`/api/workflows/${started.id}/cancel`).expect(200)).body as WorkflowRun;
    expect(c.state).toBe("cancelled");
    expect(e.gpt.requests).toHaveLength(1);   // no retry after cancellation
    expect((await request(e.app).get(`/api/workflows/${started.id}`)).body.state).toBe("cancelled");
  });

  it("cancels a workflow paused for external critique", async () => {
    const e = await env();
    const p = (await request(e.app).post("/api/workflows").send({ directive: "d", critiqueMode: "external" })).body as WorkflowRun;
    expect((await request(e.app).post(`/api/workflows/${p.id}/cancel`).expect(200)).body.state).toBe("cancelled");
  });

  it("falls back gracefully when the critic returns non-JSON (after one repair attempt)", async () => {
    const e = await env({ claude: () => anthropicText("Looks mostly fine but add units.") });
    const run = (await request(e.app).post("/api/workflows").send({ directive: "d" })).body as WorkflowRun;
    expect(run.state).toBe("completed"); expect(e.claude.requests).toHaveLength(2);
    expect(run.rounds[0]?.critique).toMatchObject({ verdict: "revise", summary: expect.stringContaining("add units") });
  });

  it("validates input and reports unknown models / tools before doing any work", async () => {
    const e = await env();
    await request(e.app).post("/api/workflows").send({}).expect(400);
    await request(e.app).post("/api/workflows").send({ directive: "d", worker: "nope" }).expect(404);
    await request(e.app).post("/api/workflows").send({ directive: "d", tools: ["nope"] }).expect(404);
    await request(e.app).post("/api/workflows").set("content-type", "application/json").send("{bad").expect(400);
    expect(e.gpt.requests).toHaveLength(0);
  });
});

describe("REST surface, security, delegate", () => {
  it("enforces bearer auth + origin allow-list; health is open", async () => {
    const e = await env({ env: { BRIDGE_API_KEY: "k1", ALLOWED_ORIGINS: "https://ok.example" } });
    await request(e.app).get("/healthz").expect(200);
    await request(e.app).get("/api/models").expect(401);
    await request(e.app).get("/api/models").set("Authorization", "Bearer wrong").expect(401);
    await request(e.app).get("/api/models").set("Authorization", "Bearer k1").set("Origin", "https://evil.example").expect(403);
    const ok = await request(e.app).get("/api/models").set("Authorization", "Bearer k1").set("Origin", "https://ok.example").expect(200);
    expect(ok.body.models.map((m: { id: string }) => m.id).sort()).toEqual(["anthropic", "openai"]);
  });

  it("delegates one-shot tasks into a session and exposes tools + dashboard", async () => {
    const e = await env({ gpt: () => openaiText("hello from gpt") });
    const d = (await request(e.app).post("/api/delegate").send({ directive: "say hi" }).expect(200)).body;
    expect(d.result).toBe("hello from gpt");
    const d2 = (await request(e.app).post("/api/delegate").send({ directive: "again", sessionId: d.sessionId })).body;
    expect(d2.sessionId).toBe(d.sessionId);
    expect((await request(e.app).get(`/api/sessions/${d.sessionId}`)).body.messages).toHaveLength(4);
    expect((await request(e.app).get("/api/tools")).body.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["calculator", "current_time", "text_stats", "json_format", "hash_text"]));
    expect((await request(e.app).post("/api/tools/calculator/call").send({ arguments: { expression: "1+1" } })).body.result.result).toBe(2);
    await request(e.app).post("/api/tools/calculator/call").send({ arguments: {} }).expect(400);
    expect((await request(e.app).get("/api/dashboard/summary").expect(200)).body).toMatchObject({ sessions: 1 });
    await request(e.app).delete(`/api/sessions/${d.sessionId}`).expect(204);
    await request(e.app).post("/api/delegate").send({ directive: "x", sessionId: d.sessionId }).expect(409);
    await request(e.app).get("/api/nope").expect(404);
  });

  it("works with only one provider configured (clear error for the other)", async () => {
    const e = await env({ env: { ANTHROPIC_API_KEY: "" } });
    expect(e.adapters.list().map((a) => a.id)).toEqual(["openai"]);
    const r = await request(e.app).post("/api/workflows").send({ directive: "d" }).expect(404);
    expect(r.body.error.message).toContain("claude");
  });
});

describe("AnthropicAdapter (real SDK against fake API)", () => {
  it("round-trips tool_use / tool_result and merges consecutive tool results", async () => {
    const api = await new FakeProvider(() => anthropicToolUse("calculator", { expression: "1+1" })).start(); cleanup.push(() => api.stop());
    const a = new AnthropicAdapter({ apiKey: "k", baseURL: api.url, model: "claude-x" });
    const res = await a.complete({ system: "s", messages: [{ role: "user", content: "q" }], tools: [{ name: "calculator", description: "d", parameters: { type: "object", properties: {} } }] }, { signal: new AbortController().signal });
    expect(res).toMatchObject({ stopReason: "tool_use", toolCalls: [{ id: "toolu_1", name: "calculator", arguments: { expression: "1+1" } }] });

    api.handler = () => anthropicText("done");
    await a.complete({ messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "calculator", arguments: {} }, { id: "t2", name: "calculator", arguments: {} }] },
      { role: "tool", toolCallId: "t1", content: "1" }, { role: "tool", toolCallId: "t2", content: "2" },
    ], json: true }, { signal: new AbortController().signal });
    const sent = api.requests.at(-1)!.body;
    expect(sent.messages).toHaveLength(3);
    expect(sent.messages[2].content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(["t1", "t2"]);
    expect(sent.system).toContain("JSON");
  });
});

describe("claudeScript sanity", () => { it("is valid", () => { expect(claudeScript({}, 1).json).toBeDefined(); }); });
