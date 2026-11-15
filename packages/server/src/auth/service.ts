import { isIP } from "node:net";
import type { Role } from "@lootden/shared";
import type { ServerConfig } from "../config.js";
import { now, type Db } from "../db/database.js";
import type { UserRecord, UserRepo } from "../users/repo.js";
import { newSecret, safeEqual, sha256 } from "./crypto.js";

export const SESSION_COOKIE = "gm_session";
const SESSION_DAYS = 30;

export interface Principal {
  /** null for the GM_API_TOKEN service token. */
  user: UserRecord | null;
  role: Role;
  kidMode: boolean;
  via: "session" | "token" | "service" | "header";
}

/** Matches an address against "10.0.0.5", "172.18.0.0/16" style entries (IPv4 CIDR, exact IPv6). */
export function ipAllowed(ip: string, allowed: string[]): boolean {
  const addr = ip.replace(/^::ffff:/, "");
  for (const entry of allowed) {
    const [net, bitsText] = entry.split("/");
    if (!bitsText) {
      if (net === addr) return true;
      continue;
    }
    if (isIP(addr) !== 4 || isIP(net!) !== 4) continue;
    const bits = Number(bitsText);
    const toInt = (s: string) => s.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((toInt(addr) & mask) === (toInt(net!) & mask)) return true;
  }
  return false;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly users: UserRepo,
    private readonly config: ServerConfig,
  ) {}

  // ---- Sessions (browser) -------------------------------------------------

  createSession(userId: number, userAgent?: string): { token: string; maxAgeSeconds: number } {
    const token = newSecret("gms");
    const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
    this.db
      .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)")
      .run(sha256(token), userId, now(), expires, userAgent?.slice(0, 200) ?? null);
    return { token, maxAgeSeconds: SESSION_DAYS * 86400 };
  }

  endSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }

  /** Signs a person out everywhere (but the session in `keep`), after their password changes. */
  endUserSessions(userId: number, keep?: string): void {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, keep ? sha256(keep) : "");
  }

  private userFromSession(token: string): UserRecord | undefined {
    const row = this.db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(sha256(token)) as
      | { user_id: number; expires_at: string }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < now()) {
      this.endSession(token);
      return undefined;
    }
    return this.users.byId(row.user_id);
  }

  pruneSessions(): void {
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
  }

  // ---- API tokens (clients, scripts) ------------------------------------

  createApiToken(userId: number, name: string): { id: number; token: string } {
    const token = newSecret("gmt");
    const r = this.db
      .prepare("INSERT INTO api_tokens (user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, name.trim().slice(0, 100) || "token", sha256(token), now());
    return { id: Number(r.lastInsertRowid), token };
  }

  revokeApiToken(userId: number, id: number): boolean {
    return Number(this.db.prepare("DELETE FROM api_tokens WHERE id = ? AND user_id = ?").run(id, userId).changes) > 0;
  }

  private userFromApiToken(token: string): UserRecord | undefined {
    const hash = sha256(token);
    const row = this.db.prepare("SELECT id, user_id FROM api_tokens WHERE token_hash = ?").get(hash) as { id: number; user_id: number } | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(now(), row.id);
    return this.users.byId(row.user_id);
  }

  // ---- Resolution -----------------------------------------------------------

  fromUser(user: UserRecord, via: Principal["via"]): Principal {
    return { user, role: user.role, kidMode: user.kidMode, via };
  }

  /** Bearer token: the service token or a personal API token. */
  fromBearer(token: string): Principal | null {
    if (this.config.apiToken && safeEqual(this.config.apiToken, token)) {
      return { user: null, role: "admin", kidMode: false, via: "service" };
    }
    const user = this.userFromApiToken(token);
    return user ? this.fromUser(user, "token") : null;
  }

  fromSession(token: string): Principal | null {
    const user = this.userFromSession(token);
    return user ? this.fromUser(user, "session") : null;
  }

  /** The forward-auth identity a trusted proxy sent with this request, if header login is on. */
  headerIdentity(ip: string, headers: Record<string, string | string[] | undefined>): { username: string; email: string | null; name: string; groups: string[] } | null {
    const h = this.config.headerAuth;
    if (!h.userHeader || h.trustedProxies.length === 0 || !ipAllowed(ip, h.trustedProxies)) return null;
    const first = (name: string) => {
      const v = headers[name];
      return (Array.isArray(v) ? v[0] : v)?.trim() || "";
    };
    const username = first(h.userHeader);
    if (!username) return null;
    return { username, email: first(h.emailHeader) || null, name: first(h.nameHeader), groups: first(h.groupsHeader).split(/[,\s]+/).filter(Boolean) };
  }

  /**
   * Trusted-header login for forward-auth proxies such as TinyAuth. Off unless
   * GM_AUTH_HEADER_USER is set, and only honoured from GM_TRUSTED_PROXIES.
   *
   * The account linked to the TinyAuth username wins. Without a link, an account with the
   * same username or email is used and linked, unless it's already linked to someone else.
   */
  async fromHeaders(ip: string, headers: Record<string, string | string[] | undefined>): Promise<Principal | null> {
    const id = this.headerIdentity(ip, headers);
    if (!id) return null;
    const { username, email } = id;
    const isAdmin = !!this.config.headerAuth.adminGroup && id.groups.includes(this.config.headerAuth.adminGroup);
    const unlinked = (u: UserRecord | undefined) => (u && !u.ssoUsername ? u : undefined);
    let user = this.users.bySsoUsername(username);
    if (!user) {
      const match = unlinked(this.users.byUsername(username)) ?? (email ? unlinked(this.users.byEmail(email)) : undefined);
      if (match) user = await this.users.update(match.id, { ssoUsername: username });
    }
    if (!user) {
      user = await this.users.create({
        username: this.freeUsername(username.replace(/[^\w.@-]/g, "_")),
        displayName: id.name || username,
        // The email may belong to an account linked to someone else; don't copy it onto a second one.
        email: email && !this.users.byEmail(email) ? email : null,
        role: isAdmin || this.users.count() === 0 ? "admin" : "user",
        ssoUsername: username,
      });
    } else if (isAdmin && user.role !== "admin") {
      user = await this.users.update(user.id, { role: "admin" });
    }
    return this.fromUser(user, "header");
  }

  /** "alex", or "alex-2" when a local account linked to someone else already has the name. */
  private freeUsername(base: string): string {
    const name = base.padEnd(2, "_").slice(0, 60);
    if (!this.users.byUsername(name)) return name;
    for (let n = 2; ; n++) if (!this.users.byUsername(`${name}-${n}`)) return `${name}-${n}`;
  }
}
