export type ErrorCode =
  | "validation" | "not_found" | "unauthorized" | "forbidden" | "timeout"
  | "cancelled" | "provider" | "rate_limited" | "invalid_state" | "tool" | "config";

export class BridgeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export const isAbort = (e: unknown): boolean =>
  e instanceof BridgeError ? e.code === "cancelled" || e.code === "timeout"
    : e instanceof Error && (e.name === "AbortError" || e.name === "APIUserAbortError");

export function toBridgeError(e: unknown): BridgeError {
  if (e instanceof BridgeError) return e;
  const err = e as { status?: number; message?: string };
  if (typeof err?.status === "number") {
    const s = err.status;
    if (s === 429) return new BridgeError("rate_limited", err.message ?? "rate limited", true, e);
    if (s >= 500 || s === 408 || s === 409) return new BridgeError("provider", err.message ?? `provider ${s}`, true, e);
    return new BridgeError("provider", err.message ?? `provider ${s}`, false, e);
  }
  if (e instanceof Error && /ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|ECONNREFUSED|Connection error/i.test(`${e.message} ${(e as { cause?: { code?: string } }).cause?.code ?? ""}`))
    return new BridgeError("provider", e.message, true, e);
  return new BridgeError("provider", e instanceof Error ? e.message : String(e), false, e);
}
