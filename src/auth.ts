import { timingSafeEqual, createHash } from "node:crypto";
import type { AuthProvider, Principal } from "./extensions/index.js";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Static bearer-token auth (constant-time compare). Replace with JWT/OAuth by implementing AuthProvider. */
export class StaticTokenAuth implements AuthProvider {
  private expected: Buffer;
  constructor(token: string) { this.expected = digest(token); }
  async authenticate(headers: Record<string, string | string[] | undefined>): Promise<Principal | null> {
    const h = headers["authorization"]; const v = Array.isArray(h) ? h[0] : h;
    const m = v?.match(/^Bearer\s+(.+)$/i);
    if (!m?.[1]) return null;
    return timingSafeEqual(digest(m[1]), this.expected) ? { id: "api-key", scopes: ["*"] } : null;
  }
}
/** Development only: no auth configured. */
export class AllowAllAuth implements AuthProvider {
  async authenticate(): Promise<Principal> { return { id: "anonymous", scopes: ["*"] }; }
}
