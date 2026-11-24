import { z, type ZodType } from "zod";
import { BridgeError } from "./errors.js";
import { withTimeout } from "./resilience.js";
import type { ToolSpec } from "./models.js";
import type { Logger } from "./logger.js";

export interface ToolContext { signal: AbortSignal; sessionId?: string; callerId?: string; logger: Logger }

export interface ToolDefinition<I = unknown> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  /** Tags for grouping/permissions (Phase 2: authz can allow/deny by tag). */
  tags?: string[];
  timeoutMs?: number;
  execute(input: I, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<I>(t: ToolDefinition<I>): ToolDefinition<I> { return t; }

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition<never>>();

  register<I>(tool: ToolDefinition<I>): this {
    if (this.tools.has(tool.name)) throw new BridgeError("validation", `Tool "${tool.name}" already registered`);
    this.tools.set(tool.name, tool as unknown as ToolDefinition<never>);
    return this;
  }
  has(name: string): boolean { return this.tools.has(name); }
  list(): { name: string; description: string; tags: string[]; inputSchema: Record<string, unknown> }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, tags: t.tags ?? [], inputSchema: toJsonSchema(t.inputSchema) }));
  }
  specs(names?: string[]): ToolSpec[] {
    const sel = names ? names.map((n) => this.mustGet(n)) : [...this.tools.values()];
    return sel.map((t) => ({ name: t.name, description: t.description, parameters: toJsonSchema(t.inputSchema) }));
  }
  private mustGet(name: string) {
    const t = this.tools.get(name);
    if (!t) throw new BridgeError("not_found", `Unknown tool "${name}". Available: ${[...this.tools.keys()].join(", ")}`);
    return t;
  }
  async call(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.mustGet(name);
    const parsed = (tool.inputSchema as ZodType).safeParse(args ?? {});
    if (!parsed.success)
      throw new BridgeError("validation", `Invalid arguments for tool "${name}": ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
    const t = withTimeout(ctx.signal, tool.timeoutMs ?? 15_000);
    try {
      const result = await Promise.race([
        tool.execute(parsed.data as never, { ...ctx, signal: t.signal }),
        new Promise<never>((_, rej) => t.signal.addEventListener("abort", () =>
          rej(new BridgeError(ctx.signal.aborted ? "cancelled" : "timeout", ctx.signal.aborted ? "tool cancelled" : `tool "${name}" timed out`)), { once: true })),
      ]);
      return result;
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw new BridgeError("tool", `Tool "${name}" failed: ${e instanceof Error ? e.message : String(e)}`, false, e);
    } finally { t.done(); }
  }
}

export function toJsonSchema(schema: ZodType): Record<string, unknown> {
  const out = { ...(z.toJSONSchema(schema) as Record<string, unknown>) };
  delete out["$schema"];
  return out;
}
