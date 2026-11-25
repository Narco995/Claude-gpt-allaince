import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { BridgeError } from "./errors.js";
import { InMemorySessionStore, type Session, type SessionStore } from "./session.js";
import type { WorkflowRun } from "./workflow.js";

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new BridgeError("config", `Cannot read persistent state at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await import("node:fs/promises").then(({ rm }) => rm(temp, { force: true })).catch(() => undefined);
    throw new BridgeError("config", `Cannot persist state at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Single-process, atomic JSON persistence. Use one bridge replica and a durable mounted volume. */
export class FileSessionStore implements SessionStore {
  private readonly memory: InMemorySessionStore;
  private readonly ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string, ttlMs = 3_600_000, max = 1000) {
    this.memory = new InMemorySessionStore(ttlMs, max);
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    const data = await readJson<{ version: number; sessions: Session[] }>(this.path, { version: 1, sessions: [] });
    if (data.version !== 1 || !Array.isArray(data.sessions)) throw new BridgeError("config", `Unsupported session store format at ${this.path}`);
    this.memory.restore(data.sessions);
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    await this.ready;
    const operation = this.writes.then(async () => {
      const result = await fn();
      await atomicWrite(this.path, { version: 1, sessions: this.memory.snapshot() });
      return result;
    });
    this.writes = operation.then(() => undefined, () => undefined);
    return operation;
  }
  private async read<T>(fn: () => Promise<T>): Promise<T> { await this.ready; await this.writes; return fn(); }

  create(init?: { title?: string; owner?: string; metadata?: Record<string, unknown> }): Promise<Session> { return this.mutate(() => this.memory.create(init)); }
  get(id: string): Promise<Session> { return this.read(() => this.memory.get(id)); }
  list(owner?: string): Promise<Session[]> { return this.read(() => this.memory.list(owner)); }
  appendMessage(sessionId: string, msg: Parameters<SessionStore["appendMessage"]>[1]) { return this.mutate(() => this.memory.appendMessage(sessionId, msg)); }
  attachWorkflow(sessionId: string, workflowId: string): Promise<void> { return this.mutate(() => this.memory.attachWorkflow(sessionId, workflowId)); }
  close(id: string): Promise<void> { return this.mutate(() => this.memory.close(id)); }
  count(): Promise<number> { return this.read(() => this.memory.count()); }
}

export interface WorkflowRunStore {
  load(): Promise<WorkflowRun[]>;
  save(run: WorkflowRun): Promise<void>;
}

/** Persists workflow snapshots and converts interrupted in-flight work to a recoverable failed state on restart. */
export class FileWorkflowRunStore implements WorkflowRunStore {
  private readonly ready: Promise<void>;
  private readonly runs = new Map<string, WorkflowRun>();
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) { this.ready = this.loadFromDisk(); }
  private async loadFromDisk(): Promise<void> {
    const data = await readJson<{ version: number; workflows: WorkflowRun[] }>(this.path, { version: 1, workflows: [] });
    if (data.version !== 1 || !Array.isArray(data.workflows)) throw new BridgeError("config", `Unsupported workflow store format at ${this.path}`);
    for (const run of data.workflows) this.runs.set(run.id, run);
  }
  async load(): Promise<WorkflowRun[]> { await this.ready; await this.writes; return [...this.runs.values()].map((r) => structuredClone(r)); }
  async save(run: WorkflowRun): Promise<void> {
    await this.ready;
    const operation = this.writes.then(async () => {
      this.runs.set(run.id, structuredClone(run));
      await atomicWrite(this.path, { version: 1, workflows: [...this.runs.values()] });
    });
    this.writes = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
