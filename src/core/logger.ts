import { AsyncLocalStorage } from "node:async_hooks";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET = /(api[-_]?key|authorization|token|secret|password)/i;

export interface TraceContext { traceId: string; sessionId?: string; workflowId?: string }
export const traceStore = new AsyncLocalStorage<TraceContext>();

function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) =>
      [k, SECRET.test(k) ? "[redacted]" : redact(val, depth + 1)]));
  }
  return v;
}

export interface Logger {
  debug(msg: string, f?: Record<string, unknown>): void;
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(level: Level = "info", sink: (line: string) => void = (l) => process.stderr.write(l + "\n"), bindings: Record<string, unknown> = {}): Logger {
  const emit = (lvl: Level, msg: string, f?: Record<string, unknown>) => {
    if (order[lvl] < order[level]) return;
    const ctx = traceStore.getStore();
    sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...bindings, ...(ctx ?? {}), ...(redact(f) as object | undefined) }));
  };
  return {
    debug: (m, f) => emit("debug", m, f), info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f), error: (m, f) => emit("error", m, f),
    child: (b) => createLogger(level, sink, { ...bindings, ...b }),
  };
}
