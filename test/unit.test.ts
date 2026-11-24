import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { evaluateExpression, calculator, textStats, jsonFormat, hashText, currentTime } from "../src/tools/builtin.js";
import { ToolRegistry, defineTool } from "../src/core/tools.js";
import { retrying } from "../src/core/resilience.js";
import { BridgeError, toBridgeError } from "../src/core/errors.js";
import { loadConfig } from "../src/config.js";
import { InMemorySessionStore } from "../src/core/session.js";
import { createLogger } from "../src/core/logger.js";
import { parseCritique } from "../src/core/workflow.js";
import { AgentMessageSchema } from "../src/core/protocol.js";
import { StaticTokenAuth } from "../src/auth.js";
import { ScopeAuthorizer } from "../src/extensions/index.js";
import { AdapterRegistry } from "../src/core/models.js";

const ctx = () => ({ signal: new AbortController().signal, logger: createLogger("error") });

describe("calculator", () => {
  it.each([["1+2*3", 7], ["(1+2)*3", 9], ["2^3^2", 512], ["-4+10%4", -2], ["sqrt(16)+max(1,5)", 9], ["2*pi", 2 * Math.PI]])("%s", (e, v) => expect(evaluateExpression(e)).toBeCloseTo(v as number));
  it("rejects bad input", () => {
    expect(() => evaluateExpression("1/0")).toThrow(/zero/);
    expect(() => evaluateExpression("process.exit()")).toThrow();
    expect(() => evaluateExpression("1+")).toThrow();
    expect(() => evaluateExpression("(1")).toThrow();
  });
});

describe("builtin tools", () => {
  it("work", async () => {
    expect(await calculator.execute({ expression: "6*7" }, ctx())).toEqual({ expression: "6*7", result: 42 });
    expect(await textStats.execute({ text: "Hello world. Hello again!", topN: 1 }, ctx())).toMatchObject({ words: 4, sentences: 2, topWords: [{ word: "hello", count: 2 }] });
    expect(await jsonFormat.execute({ json: '{"a":1}', indent: 2 }, ctx())).toMatchObject({ valid: true, shape: { type: "object", keys: ["a"] } });
    expect(await jsonFormat.execute({ json: "{bad", indent: 2 }, ctx())).toMatchObject({ valid: false });
    expect(await hashText.execute({ text: "abc", algorithm: "sha256" }, ctx())).toMatchObject({ digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    expect(await currentTime.execute({ timeZone: "Asia/Dubai" }, ctx())).toMatchObject({ timeZone: "Asia/Dubai" });
    await expect(currentTime.execute({ timeZone: "Nope/Zone" }, ctx())).rejects.toThrow(/Invalid time zone/);
  });
});

describe("ToolRegistry", () => {
  const reg = new ToolRegistry().register(calculator)
    .register(defineTool({ name: "slow", description: "slow", inputSchema: z.object({}), timeoutMs: 30, execute: () => new Promise(() => undefined) }))
    .register(defineTool({ name: "boom", description: "b", inputSchema: z.object({}), execute: async () => { throw new Error("kaboom"); } }));
  it("validates args", async () => { await expect(reg.call("calculator", { expression: 5 }, ctx())).rejects.toMatchObject({ code: "validation" }); });
  it("unknown tool", async () => { await expect(reg.call("nope", {}, ctx())).rejects.toMatchObject({ code: "not_found" }); });
  it("times out", async () => { await expect(reg.call("slow", {}, ctx())).rejects.toMatchObject({ code: "timeout" }); });
  it("wraps failures", async () => { await expect(reg.call("boom", {}, ctx())).rejects.toMatchObject({ code: "tool", message: expect.stringContaining("kaboom") }); });
  it("cancels", async () => { const c = new AbortController(); const p = reg.call("slow", {}, { ...ctx(), signal: c.signal }); c.abort(); await expect(p).rejects.toMatchObject({ code: "cancelled" }); });
  it("rejects duplicates + exposes JSON schema", () => {
    expect(() => reg.register(calculator)).toThrow(/already/);
    expect(reg.specs(["calculator"])[0]?.parameters).toMatchObject({ type: "object", required: ["expression"] });
  });
});

describe("retrying", () => {
  it("retries retryable errors then succeeds", async () => {
    let n = 0;
    const r = await retrying(async () => { if (++n < 3) throw new BridgeError("provider", "x", true); return "ok"; }, { retries: 3, baseDelayMs: 1, timeoutMs: 1000 });
    expect([r, n]).toEqual(["ok", 3]);
  });
  it("does not retry non-retryable", async () => {
    const fn = vi.fn(async () => { throw new BridgeError("provider", "bad", false); });
    await expect(retrying(fn, { retries: 3, baseDelayMs: 1, timeoutMs: 1000 })).rejects.toThrow("bad");
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it("gives up after max retries", async () => {
    const fn = vi.fn(async () => { throw Object.assign(new Error("503"), { status: 503 }); });
    await expect(retrying(fn, { retries: 2, baseDelayMs: 1, timeoutMs: 1000 })).rejects.toMatchObject({ code: "provider" });
    expect(fn).toHaveBeenCalledTimes(3);
  });
  it("times out", async () => {
    await expect(retrying((s) => new Promise((_, rej) => s.addEventListener("abort", () => rej(new Error("aborted")))), { retries: 0, baseDelayMs: 1, timeoutMs: 20 })).rejects.toMatchObject({ code: "timeout" });
  });
  it("honors cancellation during backoff", async () => {
    const c = new AbortController();
    const p = retrying(async () => { throw new BridgeError("provider", "x", true); }, { retries: 5, baseDelayMs: 1000, timeoutMs: 1000, signal: c.signal });
    setTimeout(() => c.abort(), 20);
    await expect(p).rejects.toMatchObject({ code: "cancelled" });
  });
  it("classifies provider status codes", () => {
    expect(toBridgeError({ status: 429, message: "m" })).toMatchObject({ code: "rate_limited", retryable: true });
    expect(toBridgeError({ status: 400, message: "m" })).toMatchObject({ code: "provider", retryable: false });
  });
});

describe("config", () => {
  it("applies defaults and coerces", () => { expect(loadConfig({ PORT: "9000" } as never)).toMatchObject({ port: 9000, openai: { model: "gpt-4.1" } }); });
  it("treats blank keys as unset", () => { expect(loadConfig({ OPENAI_API_KEY: "  " } as never).openai.apiKey).toBeUndefined(); });
  it("requires BRIDGE_API_KEY in production", () => { expect(() => loadConfig({ NODE_ENV: "production" } as never)).toThrow(/BRIDGE_API_KEY/); });
  it("rejects invalid values", () => { expect(() => loadConfig({ PORT: "abc" } as never)).toThrow(/Invalid configuration/); });
});

describe("InMemorySessionStore", () => {
  it("records ordered messages", async () => {
    const s = new InMemorySessionStore(); const sess = await s.create({ title: "t" });
    const m = await s.appendMessage(sess.id, { from: "claude", to: "gpt", type: "directive", content: "hi" });
    expect(AgentMessageSchema.safeParse(m).success).toBe(true);
    expect((await s.get(sess.id)).messages).toHaveLength(1);
  });
  it("expires by TTL and evicts at capacity", async () => {
    let now = 0; const s = new InMemorySessionStore(1000, 2, () => now);
    const a = await s.create(); now = 10; await s.create(); now = 20; await s.create();
    await expect(s.get(a.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await s.count()).toBe(2);
    now = 5000; await s.create(); expect(await s.count()).toBe(1);
  });
  it("blocks writes to closed sessions", async () => {
    const s = new InMemorySessionStore(); const x = await s.create(); await s.close(x.id);
    await expect(s.appendMessage(x.id, { from: "a", to: "b", type: "info", content: "" })).rejects.toMatchObject({ code: "invalid_state" });
  });
});

describe("misc", () => {
  it("logger redacts secrets and carries bindings", () => {
    const lines: string[] = []; const l = createLogger("info", (x) => lines.push(x), { app: "t" });
    l.info("hi", { apiKey: "sk-123", nested: { Authorization: "Bearer z", ok: 1 } });
    l.debug("hidden");
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(/sk-123|Bearer z/); expect(JSON.parse(lines[0]!)).toMatchObject({ app: "t", nested: { ok: 1 } });
  });
  it("parseCritique tolerates fences / prose and rejects junk", () => {
    expect(parseCritique('```json\n{"verdict":"approve","summary":"ok"}\n```')).toMatchObject({ verdict: "approve", issues: [] });
    expect(parseCritique("no json")).toBeUndefined();
    expect(parseCritique('{"verdict":"maybe","summary":"x"}')).toBeUndefined();
  });
  it("StaticTokenAuth", async () => {
    const a = new StaticTokenAuth("secret");
    expect(await a.authenticate({ authorization: "Bearer secret" })).toMatchObject({ id: "api-key" });
    expect(await a.authenticate({ authorization: "Bearer nope" })).toBeNull();
    expect(await a.authenticate({})).toBeNull();
  });
  it("ScopeAuthorizer", () => {
    const z = new ScopeAuthorizer();
    expect(z.can({ id: "a", scopes: ["*"] }, "admin")).toBe(true);
    expect(z.can({ id: "a", scopes: ["workflow:*"] }, "workflow:run")).toBe(true);
    expect(z.can({ id: "a", scopes: ["workflow:*"] }, "tool:call")).toBe(false);
  });
  it("AdapterRegistry aliases + errors", () => {
    const r = new AdapterRegistry().register({ id: "openai", provider: "openai", defaultModel: "m", complete: async () => { throw new Error("x"); } }, ["gpt"]);
    expect(r.get("gpt").id).toBe("openai"); expect(() => r.get("zzz")).toThrow(/Unknown/);
  });
});
