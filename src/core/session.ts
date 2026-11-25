import { randomUUID } from "node:crypto";
import { BridgeError } from "./errors.js";
import type { AgentMessage } from "./protocol.js";

export interface Session {
  id: string; createdAt: string; updatedAt: string;
  status: "active" | "closed";
  owner?: string;
  title?: string;
  metadata: Record<string, unknown>;
  messages: AgentMessage[];
  workflowIds: string[];
}

/** Storage abstraction. Swap InMemorySessionStore for a persistent implementation (Phase 2) without touching the core. */
export interface SessionStore {
  create(init?: { title?: string; owner?: string; metadata?: Record<string, unknown> }): Promise<Session>;
  get(id: string): Promise<Session>;
  list(owner?: string): Promise<Session[]>;
  appendMessage(sessionId: string, msg: Omit<AgentMessage, "id" | "sessionId" | "createdAt" | "metadata"> & { metadata?: Record<string, unknown> }): Promise<AgentMessage>;
  attachWorkflow(sessionId: string, workflowId: string): Promise<void>;
  close(id: string): Promise<void>;
  count(): Promise<number>;
}

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();
  constructor(private ttlMs = 3_600_000, private max = 1000, private now: () => number = Date.now) {}

  private evict(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (t - Date.parse(s.updatedAt) > this.ttlMs) this.sessions.delete(id);
    while (this.sessions.size >= this.max) { // drop least-recently-updated
      let oldest: string | undefined; let ot = Infinity;
      for (const [id, s] of this.sessions) { const u = Date.parse(s.updatedAt); if (u < ot) { ot = u; oldest = id; } }
      if (!oldest) break; this.sessions.delete(oldest);
    }
  }
  private iso() { return new Date(this.now()).toISOString(); }

  async create(init: { title?: string; owner?: string; metadata?: Record<string, unknown> } = {}): Promise<Session> {
    this.evict();
    const s: Session = { id: randomUUID(), createdAt: this.iso(), updatedAt: this.iso(), status: "active", owner: init.owner, title: init.title, metadata: init.metadata ?? {}, messages: [], workflowIds: [] };
    this.sessions.set(s.id, s); return s;
  }
  async get(id: string): Promise<Session> {
    const s = this.sessions.get(id);
    if (!s) throw new BridgeError("not_found", `Session ${id} not found (it may have expired)`);
    return s;
  }
  async list(owner?: string): Promise<Session[]> {
    return [...this.sessions.values()].filter((s) => !owner || s.owner === owner).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async appendMessage(sessionId: string, m: Omit<AgentMessage, "id" | "sessionId" | "createdAt" | "metadata"> & { metadata?: Record<string, unknown> }): Promise<AgentMessage> {
    const s = await this.get(sessionId);
    if (s.status === "closed") throw new BridgeError("invalid_state", `Session ${sessionId} is closed`);
    const msg: AgentMessage = { ...m, id: randomUUID(), sessionId, createdAt: this.iso(), metadata: m.metadata ?? {} };
    s.messages.push(msg); s.updatedAt = msg.createdAt; return msg;
  }
  async attachWorkflow(sessionId: string, workflowId: string): Promise<void> { (await this.get(sessionId)).workflowIds.push(workflowId); }
  async close(id: string): Promise<void> { (await this.get(id)).status = "closed"; }
  async count(): Promise<number> { return this.sessions.size; }

  /** Internal recovery hooks used by the persistent store adapter. */
  restore(sessions: Session[]): void {
    this.sessions.clear();
    const cutoff = this.now() - this.ttlMs;
    for (const session of sessions) {
      if (Date.parse(session.updatedAt) >= cutoff) this.sessions.set(session.id, session);
    }
    // Recovery must not evict a valid session merely because the restored count equals capacity.
    while (this.sessions.size > this.max) {
      let oldest: string | undefined; let oldestAt = Infinity;
      for (const [id, session] of this.sessions) {
        const updatedAt = Date.parse(session.updatedAt);
        if (updatedAt < oldestAt) { oldestAt = updatedAt; oldest = id; }
      }
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
  }
  snapshot(): Session[] { return [...this.sessions.values()]; }
}
