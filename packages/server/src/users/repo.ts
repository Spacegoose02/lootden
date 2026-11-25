import type { ApiTokenInfo, Role, User, UserGameState } from "@lootden/shared";
import { hashPassword } from "../auth/crypto.js";
import { now, type Db } from "../db/database.js";
import { randomAvatarSeed } from "./avatars.js";

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  email: string | null;
  password_hash: string | null;
  role: Role;
  avatar: string;
  kid_mode: number;
  oidc_subject: string | null;
  sso_username: string | null;
  created_at: string;
}

export interface UserRecord extends User {
  passwordHash: string | null;
  oidcSubject: string | null;
  /** The TinyAuth username this account is linked to. */
  ssoUsername: string | null;
}

function toUser(r: UserRow): UserRecord {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    email: r.email,
    role: r.role,
    avatar: r.avatar,
    kidMode: r.kid_mode === 1,
    hasPassword: !!r.password_hash,
    createdAt: r.created_at,
    passwordHash: r.password_hash,
    oidcSubject: r.oidc_subject,
    ssoUsername: r.sso_username ?? null,
  };
}

/** Strips secrets before a user goes over the wire. */
export function publicUser(u: UserRecord): User {
  const { passwordHash: _p, oidcSubject: _o, ssoUsername, ...rest } = u;
  return { ...rest, sso: { username: ssoUsername, oidc: !!u.oidcSubject } };
}

export interface NewUser {
  username: string;
  displayName?: string;
  email?: string | null;
  password?: string | null;
  role?: Role;
  kidMode?: boolean;
  oidcSubject?: string | null;
  ssoUsername?: string | null;
}

export class UserRepo {
  constructor(private readonly db: Db) {}

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;
  }

  list(): UserRecord[] {
    return (this.db.prepare("SELECT * FROM users ORDER BY username").all() as unknown as UserRow[]).map(toUser);
  }

  byId(id: number): UserRecord | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
    return r && toUser(r);
  }

  byUsername(username: string): UserRecord | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
    return r && toUser(r);
  }

  byEmail(email: string): UserRecord | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
    return r && toUser(r);
  }

  /**
   * The profile linked to this TinyAuth username. TinyAuth names people who sign in with Google,
   * GitHub and the like after their email with the @ swapped for _ (alex@gmail.com signs in as
   * alex_gmail.com), so a profile linked by typing the email address still matches.
   */
  bySsoUsername(name: string): UserRecord | undefined {
    const n = name.trim();
    const exact = this.db.prepare("SELECT * FROM users WHERE sso_username = ?").get(n) as UserRow | undefined;
    if (exact) return toUser(exact);
    const r = this.db
      .prepare("SELECT * FROM users WHERE lower(replace(sso_username, '@', '_')) = lower(replace(?, '@', '_')) ORDER BY id LIMIT 1")
      .get(n) as UserRow | undefined;
    return r && toUser(r);
  }

  byOidcSubject(sub: string): UserRecord | undefined {
    const r = this.db.prepare("SELECT * FROM users WHERE oidc_subject = ?").get(sub) as UserRow | undefined;
    return r && toUser(r);
  }

  async create(u: NewUser): Promise<UserRecord> {
    const username = u.username.trim();
    if (!/^[\w.@-]{2,64}$/.test(username)) throw new Error("Usernames are 2-64 letters, digits, dots, dashes, underscores or @");
    if (this.byUsername(username)) throw new Error(`User "${username}" already exists`);
    if (u.password != null && u.password.length < 8) throw new Error("Passwords need at least 8 characters");
    const hash = u.password ? await hashPassword(u.password) : null;
    const result = this.db
      .prepare(
        "INSERT INTO users (username, display_name, email, password_hash, role, avatar, kid_mode, oidc_subject, sso_username, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(username, u.displayName?.trim() || username, u.email ?? null, hash, u.role ?? "user", randomAvatarSeed(), u.kidMode ? 1 : 0, u.oidcSubject ?? null, u.ssoUsername?.trim() || null, now());
    return this.byId(Number(result.lastInsertRowid))!;
  }

  async update(
    id: number,
    patch: { displayName?: string; email?: string | null; role?: Role; kidMode?: boolean; avatar?: string; password?: string | null; oidcSubject?: string | null; ssoUsername?: string | null },
  ): Promise<UserRecord> {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      values.push(v);
    };
    if (patch.displayName !== undefined) set("display_name", patch.displayName.trim() || this.byId(id)!.username);
    if (patch.email !== undefined) set("email", patch.email);
    if (patch.role !== undefined) set("role", patch.role);
    if (patch.kidMode !== undefined) set("kid_mode", patch.kidMode ? 1 : 0);
    if (patch.avatar !== undefined) set("avatar", patch.avatar);
    if (patch.oidcSubject !== undefined) set("oidc_subject", patch.oidcSubject);
    if (patch.ssoUsername !== undefined) set("sso_username", patch.ssoUsername?.trim() || null);
    if (patch.password !== undefined) {
      if (patch.password !== null && patch.password.length < 8) throw new Error("Passwords need at least 8 characters");
      set("password_hash", patch.password ? await hashPassword(patch.password) : null);
    }
    if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    return this.byId(id)!;
  }

  delete(id: number): void {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  adminCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
  }

  // ---- API tokens --------------------------------------------------------

  listTokens(userId: number): ApiTokenInfo[] {
    return (
      this.db.prepare("SELECT id, name, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id").all(userId) as Array<{
        id: number;
        name: string;
        created_at: string;
        last_used_at: string | null;
      }>
    ).map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
  }

  // ---- Game tracking ------------------------------------------------------

  recordActivity(
    userId: number,
    a: { gameId: string; device: string; event: "installed" | "uninstalled" | "played"; installPath?: string; seconds?: number },
  ): void {
    const ts = now();
    this.db
      .prepare("INSERT INTO user_games (user_id, game_id, device) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .run(userId, a.gameId, a.device);
    const where = "WHERE user_id = ? AND game_id = ? AND device = ?";
    if (a.event === "installed") {
      this.db.prepare(`UPDATE user_games SET installed_at = ?, uninstalled_at = NULL, install_path = ? ${where}`).run(ts, a.installPath ?? null, userId, a.gameId, a.device);
    } else if (a.event === "uninstalled") {
      this.db.prepare(`UPDATE user_games SET uninstalled_at = ? ${where}`).run(ts, userId, a.gameId, a.device);
    } else {
      const seconds = Math.max(0, Math.min(Math.round(a.seconds ?? 0), 24 * 3600));
      this.db.prepare(`UPDATE user_games SET playtime_seconds = playtime_seconds + ?, last_played_at = ? ${where}`).run(seconds, ts, userId, a.gameId, a.device);
    }
  }

  gameStates(userId: number): UserGameState[] {
    return (
      this.db.prepare("SELECT * FROM user_games WHERE user_id = ? ORDER BY COALESCE(last_played_at, installed_at) DESC").all(userId) as Array<{
        game_id: string;
        device: string;
        installed_at: string | null;
        uninstalled_at: string | null;
        install_path: string | null;
        playtime_seconds: number;
        last_played_at: string | null;
      }>
    ).map((r) => ({
      gameId: r.game_id,
      device: r.device,
      installedAt: r.installed_at,
      uninstalledAt: r.uninstalled_at,
      installPath: r.install_path,
      playtimeSeconds: r.playtime_seconds,
      lastPlayedAt: r.last_played_at,
    }));
  }
}
