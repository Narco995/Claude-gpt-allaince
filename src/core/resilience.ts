import { BridgeError, isAbort, toBridgeError } from "./errors.js";

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  if (signal?.aborted) return rej(new BridgeError("cancelled", "cancelled"));
  const onAbort = () => { clearTimeout(t); rej(new BridgeError("cancelled", "cancelled")); };
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); res(); }, ms);
  signal?.addEventListener("abort", onAbort, { once: true });
});

/** Combine caller signal with a timeout. */
export function withTimeout(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; done: () => void; timedOut: () => boolean } {
  const ctl = new AbortController();
  let to = false;
  const t = setTimeout(() => { to = true; ctl.abort(); }, ms);
  const onParent = () => ctl.abort();
  if (parent?.aborted) ctl.abort(); else parent?.addEventListener("abort", onParent, { once: true });
  return { signal: ctl.signal, timedOut: () => to, done: () => { clearTimeout(t); parent?.removeEventListener("abort", onParent); } };
}

export interface RetryOptions {
  retries: number; baseDelayMs: number; timeoutMs: number; signal?: AbortSignal;
  onRetry?: (attempt: number, err: BridgeError, delayMs: number) => void;
}

/** Retries retryable errors with exponential backoff + jitter; per-attempt timeout; honors cancellation. */
export async function retrying<T>(fn: (signal: AbortSignal) => Promise<T>, o: RetryOptions): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const t = withTimeout(o.signal, o.timeoutMs);
    try {
      return await fn(t.signal);
    } catch (e) {
      let err: BridgeError;
      if (o.signal?.aborted) err = new BridgeError("cancelled", "operation cancelled", false, e);
      else if (t.timedOut()) err = new BridgeError("timeout", `timed out after ${o.timeoutMs}ms`, true, e);
      else if (isAbort(e)) err = new BridgeError("cancelled", "operation aborted", false, e);
      else err = toBridgeError(e);
      if (!err.retryable || attempt >= o.retries) throw err;
      const delay = Math.round(o.baseDelayMs * 2 ** attempt * (0.5 + Math.random() * 0.5));
      o.onRetry?.(attempt + 1, err, delay);
      await sleep(delay, o.signal);
    } finally { t.done(); }
  }
}
