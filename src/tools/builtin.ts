import { createHash } from "node:crypto";
import { z } from "zod";
import { defineTool, ToolRegistry } from "../core/tools.js";

/** Safe arithmetic evaluator (no eval). Supports + - * / % ^, parentheses, unary minus, common functions. */
export function evaluateExpression(src: string): number {
  const tokens = src.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z_]+|[()+\-*/%^,]|\S/gi) ?? [];
  let i = 0;
  const FN: Record<string, (...a: number[]) => number> = {
    sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, ln: Math.log, log10: Math.log10, min: Math.min, max: Math.max,
  };
  const CONST: Record<string, number> = { pi: Math.PI, e: Math.E };
  const peek = () => tokens[i];
  const eat = (t?: string) => { const x = tokens[i++]; if (t && x !== t) throw new Error(`Expected "${t}" but found "${x ?? "end"}"`); return x; };
  function expr(): number { let v = term(); while (peek() === "+" || peek() === "-") v = eat() === "+" ? v + term() : v - term(); return v; }
  function term(): number {
    let v = unary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = eat(); const r = unary();
      if (op === "*") v *= r; else if (op === "/") { if (r === 0) throw new Error("Division by zero"); v /= r; } else v %= r;
    }
    return v;
  }
  function unary(): number { if (peek() === "-") { eat(); return -unary(); } if (peek() === "+") { eat(); return unary(); } return power(); }
  function power(): number { const b = atom(); if (peek() === "^") { eat(); return Math.pow(b, unary()); } return b; }
  function atom(): number {
    const t = eat();
    if (t === undefined) throw new Error("Unexpected end of expression");
    if (t === "(") { const v = expr(); eat(")"); return v; }
    if (/^[\d.]/.test(t)) { const n = Number(t); if (Number.isNaN(n)) throw new Error(`Bad number "${t}"`); return n; }
    const lower = t.toLowerCase();
    if (lower in CONST) return CONST[lower]!;
    if (lower in FN) {
      eat("("); const args: number[] = [];
      if (peek() !== ")") { args.push(expr()); while (peek() === ",") { eat(); args.push(expr()); } }
      eat(")"); return FN[lower]!(...args);
    }
    throw new Error(`Unexpected token "${t}"`);
  }
  const v = expr();
  if (i < tokens.length) throw new Error(`Unexpected token "${tokens[i]}"`);
  if (!Number.isFinite(v)) throw new Error("Result is not a finite number");
  return v;
}

export const calculator = defineTool({
  name: "calculator",
  description: "Evaluate an arithmetic expression exactly (supports + - * / % ^, parentheses, sqrt, abs, round, min, max, sin, cos, ln, pi, e).",
  tags: ["math", "safe"],
  inputSchema: z.object({ expression: z.string().min(1).max(500) }),
  async execute({ expression }) { return { expression, result: evaluateExpression(expression) }; },
});

export const currentTime = defineTool({
  name: "current_time",
  description: "Get the current date/time, optionally in an IANA time zone (e.g. 'Asia/Dubai').",
  tags: ["utility", "safe"],
  inputSchema: z.object({ timeZone: z.string().default("UTC") }),
  async execute({ timeZone }) {
    const now = new Date();
    let local: string;
    try { local = new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "long", timeZone }).format(now); }
    catch { throw new Error(`Invalid time zone "${timeZone}"`); }
    return { iso: now.toISOString(), epochMs: now.getTime(), timeZone, local };
  },
});

export const textStats = defineTool({
  name: "text_stats",
  description: "Compute character, word, sentence, line counts and the most frequent words of a text.",
  tags: ["text", "safe"],
  inputSchema: z.object({ text: z.string().max(200_000), topN: z.number().int().min(1).max(50).default(5) }),
  async execute({ text, topN }) {
    const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
    const freq = new Map<string, number>();
    for (const w of words) if (w.length > 2) freq.set(w, (freq.get(w) ?? 0) + 1);
    return {
      characters: text.length, words: words.length,
      sentences: (text.match(/[^.!?]+[.!?]+/g) ?? (text.trim() ? [text] : [])).length,
      lines: text === "" ? 0 : text.split(/\r?\n/).length,
      topWords: [...freq].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN).map(([word, count]) => ({ word, count })),
    };
  },
});

export const jsonFormat = defineTool({
  name: "json_format",
  description: "Validate a JSON string and return it pretty-printed with top-level shape information.",
  tags: ["data", "safe"],
  inputSchema: z.object({ json: z.string().max(500_000), indent: z.number().int().min(0).max(8).default(2) }),
  async execute({ json, indent }) {
    let v: unknown;
    try { v = JSON.parse(json); } catch (e) { return { valid: false, error: (e as Error).message }; }
    const shape = Array.isArray(v) ? { type: "array", length: v.length }
      : v && typeof v === "object" ? { type: "object", keys: Object.keys(v) } : { type: typeof v };
    return { valid: true, shape, formatted: JSON.stringify(v, null, indent) };
  },
});

export const hashText = defineTool({
  name: "hash_text",
  description: "Compute a cryptographic hash (sha256, sha512, sha1, md5) of a text, hex encoded.",
  tags: ["utility", "safe"],
  inputSchema: z.object({ text: z.string().max(1_000_000), algorithm: z.enum(["sha256", "sha512", "sha1", "md5"]).default("sha256") }),
  async execute({ text, algorithm }) { return { algorithm, digest: createHash(algorithm).update(text, "utf8").digest("hex") }; },
});

export function registerBuiltinTools(reg: ToolRegistry): ToolRegistry {
  return reg.register(calculator).register(currentTime).register(textStats).register(jsonFormat).register(hashText);
}
