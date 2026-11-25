import { timingSafeEqual, createHash } from "node:crypto";
import type { AuthProvider, Principal } from "./extensions/index.js";

export interface TokenIdentity { id: string; token: string; scopes: string[]; metadata?: Record<string, unknown> }
const digest = (s: string) => createHash("sha256").update(s).digest();
const matches = (token: string, expected: Buffer) => timingSafeEqual(digest(token), expected);

/** Static bearer-token authentication for a single explicitly configured principal. */
export class StaticTokenAuth implements AuthProvider {
  private expected: Buffer;
  constructor(token: string, private readonly principal: Principal = { id: "api-key", scopes: ["*"] }) { this.expected = digest(token); }
  async authenticate(headers: Record<string, string | string[] | undefined>): Promise<Principal | null> {
    const h = headers["authorization"]; const v = Array.isArray(h) ? h[0] : h;
    const m = v?.match(/^Bearer\s+(.+)$/i);
    if (!m?.[1] || !matches(m[1], this.expected)) return null;
    return { ...this.principal, scopes: [...this.principal.scopes] };
  }
}

/** Multi-principal bearer auth. Store only digests; tokens are supplied via environment at boot. */
export class TokenSetAuth implements AuthProvider {
  private readonly entries: { digest: Buffer; principal: Principal }[];
  constructor(tokens: TokenIdentity[]) {
    if (!tokens.length) throw new Error("At least one identity token is required");
    const ids = new Set<string>();
    this.entries = tokens.map((entry) => {
      if (ids.has(entry.id)) throw new Error(`Duplicate token identity "${entry.id}"`);
      ids.add(entry.id);
      return { digest: digest(entry.token), principal: { id: entry.id, scopes: [...entry.scopes], metadata: entry.metadata } };
    });
  }
  async authenticate(headers: Record<string, string | string[] | undefined>): Promise<Principal | null> {
    const h = headers["authorization"]; const v = Array.isArray(h) ? h[0] : h;
    const m = v?.match(/^Bearer\s+(.+)$/i);
    if (!m?.[1]) return null;
    // Compare every configured digest so the matching identity does not short-circuit the scan.
    let found: Principal | null = null;
    for (const entry of this.entries) if (matches(m[1], entry.digest)) found = entry.principal;
    return found ? { ...found, scopes: [...found.scopes] } : null;
  }
}

/** Development only: no auth configured. */
export class AllowAllAuth implements AuthProvider {
  async authenticate(): Promise<Principal> { return { id: "human:local-development", scopes: ["*"] }; }
}
