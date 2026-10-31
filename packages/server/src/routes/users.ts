import type { FastifyInstance } from "fastify";
import { cleanPolicy, cleanSites, lockedPart, parseRaccoonSeed, type ActivityEvent, type BrowserPolicy, type Role } from "@lootden/shared";
import { verifyPassword } from "../auth/crypto.js";
import { SESSION_COOKIE } from "../auth/service.js";
import { HttpProblem, requireAdmin, requirePerson, type AppContext } from "../context.js";
import { avatarSvg, randomAvatarSeed } from "../users/avatars.js";
import { publicUser } from "../users/repo.js";

export function userRoutes(app: FastifyInstance, ctx: AppContext) {
  /** What the person may open in the desktop app's browser; kid profiles are kid-safe unless an admin says otherwise. */
  const browserPolicy = (userId: number, kidMode: boolean): BrowserPolicy => {
    const row = ctx.db.prepare("SELECT mode, allowed, blocked FROM browser_policy WHERE user_id = ?").get(userId) as { mode: string | null; allowed: string; blocked: string } | undefined;
    const parse = (t: string | undefined) => {
      try {
        return JSON.parse(t ?? "[]") as unknown;
      } catch {
        return [];
      }
    };
    return cleanPolicy({ mode: row?.mode ?? undefined, allowed: parse(row?.allowed), blocked: parse(row?.blocked) }, kidMode);
  };

  app.get<{ Params: { seed: string } }>("/api/avatars/:seed", async (req, reply) => {
    const seed = req.params.seed.replace(/\.svg$/, "").slice(0, 64);
    reply.header("Content-Type", "image/svg+xml").header("Cache-Control", "public, max-age=31536000, immutable");
    return avatarSvg(seed);
  });

  // ---- Me ---------------------------------------------------------------------

  app.get("/api/me", async (req) => {
    const p = req.principal;
    if (!p) throw new HttpProblem(401, "Sign in first");
    if (!p.user) return { user: null, role: p.role, via: p.via };
    return { user: publicUser(p.user), role: p.role, via: p.via };
  });

  app.patch<{ Body: { displayName?: string; avatar?: string } }>("/api/me", async (req) => {
    const me = requirePerson(req);
    const avatar = req.body?.avatar === "random" ? randomAvatarSeed() : req.body?.avatar?.replace(/[^\w-]/g, "").slice(0, 64);
    // Built raccoons: parts past the starter set unlock with levels.
    const built = avatar ? parseRaccoonSeed(avatar) : null;
    if (avatar?.startsWith("b-") && !built) throw new HttpProblem(400, "That raccoon has parts that don't exist");
    const locked = built ? lockedPart(built, ctx.family.level(me.id).level) : null;
    if (locked) throw new HttpProblem(403, `The ${locked.name} unlocks at level ${locked.level}`);
    return publicUser(await ctx.users.update(me.id, { displayName: req.body?.displayName, avatar: avatar || undefined }));
  });

  app.post<{ Body: { currentPassword?: string; newPassword: string } }>("/api/me/password", async (req) => {
    const me = requirePerson(req);
    if (me.passwordHash && !(await verifyPassword(req.body?.currentPassword ?? "", me.passwordHash))) {
      throw new HttpProblem(403, "Current password is wrong");
    }
    await ctx.users.update(me.id, { password: req.body?.newPassword ?? "" });
    // Other browsers signed in with the old password are signed out; this one stays.
    ctx.auth.endUserSessions(me.id, req.cookies[SESSION_COOKIE]);
    return { ok: true };
  });

  /** The desktop app asks before opening its browser. */
  app.get("/api/me/browser", async (req) => {
    const me = requirePerson(req);
    return browserPolicy(me.id, me.kidMode);
  });

  app.get("/api/me/tokens", async (req) => ctx.users.listTokens(requirePerson(req).id));

  app.post<{ Body: { name: string } }>("/api/me/tokens", async (req) => {
    const me = requirePerson(req);
    return ctx.auth.createApiToken(me.id, req.body?.name ?? "token");
  });

  app.delete<{ Params: { id: string } }>("/api/me/tokens/:id", async (req) => {
    if (!ctx.auth.revokeApiToken(requirePerson(req).id, Number(req.params.id))) throw new HttpProblem(404, "No such token");
    return { ok: true };
  });

  /** Installs, uninstalls and playtime reported by clients. */
  app.post<{ Body: { gameId: string; device: string; event: ActivityEvent; installPath?: string; seconds?: number; endedAt?: string } }>(
    "/api/me/activity",
    async (req) => {
      const me = requirePerson(req);
      const b = req.body ?? ({} as never);
      if (!b.gameId || !b.device || !["installed", "uninstalled", "played"].includes(b.event)) {
        throw new HttpProblem(400, "gameId, device and event (installed, uninstalled, played) are required");
      }
      ctx.users.recordActivity(me.id, { ...b, device: b.device.slice(0, 100) });
      if (b.event === "played") ctx.family.recordSession(me.id, b.gameId, b.device, Number(b.seconds) || 0, typeof b.endedAt === "string" ? b.endedAt : undefined);
      return { ok: true };
    },
  );

  app.get("/api/me/games", async (req) => ctx.users.gameStates(requirePerson(req).id));

  // Yamtrack has no write API; it imports its own CSV format (Import > Yamtrack CSV).
  app.get("/api/me/export/yamtrack.csv", async (req, reply) => {
    const me = requirePerson(req);
    const csv = yamtrackCsv(ctx, me.id);
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="yamtrack-${me.username}.csv"`)
      .send(csv);
  });

  // ---- Admin: users ------------------------------------------------------------

  app.get("/api/users", async (req) => {
    requireAdmin(req);
    return ctx.users.list().map(publicUser);
  });

  app.post<{ Body: { username: string; password?: string; displayName?: string; email?: string; role?: Role; kidMode?: boolean } }>(
    "/api/users",
    async (req) => {
      requireAdmin(req);
      return publicUser(await ctx.users.create(req.body ?? ({} as never)));
    },
  );

  app.patch<{ Params: { id: string }; Body: { displayName?: string; email?: string | null; role?: Role; kidMode?: boolean; password?: string | null; avatar?: string } }>(
    "/api/users/:id",
    async (req) => {
      requireAdmin(req);
      const id = Number(req.params.id);
      const user = ctx.users.byId(id);
      if (!user) throw new HttpProblem(404, "No such user");
      const b = req.body ?? {};
      if (b.role && !["admin", "user"].includes(b.role)) throw new HttpProblem(400, "role is admin or user");
      if (user.role === "admin" && b.role === "user" && ctx.users.adminCount() === 1) throw new HttpProblem(409, "Keep at least one admin");
      const updated = await ctx.users.update(id, { ...b, avatar: b.avatar === "random" ? randomAvatarSeed() : b.avatar });
      if (b.password !== undefined) ctx.auth.endUserSessions(id);
      return publicUser(updated);
    },
  );

  /** Admin: a person's web browser in the desktop app, kid-safe or open, and the sites they may or may not open. */
  app.get<{ Params: { id: string } }>("/api/users/:id/browser", async (req) => {
    requireAdmin(req);
    const user = ctx.users.byId(Number(req.params.id));
    if (!user) throw new HttpProblem(404, "No such user");
    return browserPolicy(user.id, user.kidMode);
  });

  app.put<{ Params: { id: string }; Body: Partial<BrowserPolicy> }>("/api/users/:id/browser", async (req) => {
    requireAdmin(req);
    const user = ctx.users.byId(Number(req.params.id));
    if (!user) throw new HttpProblem(404, "No such user");
    const b = req.body ?? {};
    if (b.mode !== undefined && b.mode !== "open" && b.mode !== "kids") throw new HttpProblem(400, "The browser is kids or open");
    const bad = [...(Array.isArray(b.allowed) ? b.allowed : []), ...(Array.isArray(b.blocked) ? b.blocked : [])].filter((x) => String(x ?? "").trim() && !cleanSites([x]).length);
    if (bad.length) throw new HttpProblem(400, `${String(bad[0])} isn't a site name, like youtube.com`);
    const cur = browserPolicy(user.id, user.kidMode);
    const next = cleanPolicy({ mode: b.mode ?? cur.mode, allowed: b.allowed ?? cur.allowed, blocked: b.blocked ?? cur.blocked }, user.kidMode);
    ctx.db
      .prepare("INSERT INTO browser_policy (user_id, mode, allowed, blocked) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, allowed = excluded.allowed, blocked = excluded.blocked")
      .run(user.id, next.mode, JSON.stringify(next.allowed), JSON.stringify(next.blocked));
    return next;
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (req) => {
    const p = requireAdmin(req);
    const id = Number(req.params.id);
    const user = ctx.users.byId(id);
    if (!user) throw new HttpProblem(404, "No such user");
    if (p.user?.id === id) throw new HttpProblem(409, "You cannot delete your own account");
    if (user.role === "admin" && ctx.users.adminCount() === 1) throw new HttpProblem(409, "Keep at least one admin");
    ctx.users.delete(id);
    return { ok: true };
  });
}

const YAMTRACK_COLUMNS = ["media_id", "source", "media_type", "title", "image", "season_number", "episode_number", "score", "status", "notes", "start_date", "end_date", "progress"];

function csvCell(v: string | number | null): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per game the person has installed or played, matched to IGDB where possible. */
export function yamtrackCsv(ctx: AppContext, userId: number): string {
  const byGame = new Map<string, { seconds: number; first: string | null; last: string | null }>();
  for (const s of ctx.users.gameStates(userId)) {
    const e = byGame.get(s.gameId) ?? { seconds: 0, first: null, last: null };
    e.seconds += s.playtimeSeconds;
    for (const d of [s.installedAt, s.lastPlayedAt]) {
      if (!d) continue;
      if (!e.first || d < e.first) e.first = d;
      if (!e.last || d > e.last) e.last = d;
    }
    byGame.set(s.gameId, e);
  }
  const rows = [YAMTRACK_COLUMNS.join(",")];
  for (const [gameId, e] of byGame) {
    const game = ctx.library.get(gameId);
    if (!game) continue;
    const igdb = game.metadata?.provider === "igdb" ? game.metadata.providerId : null;
    rows.push(
      [
        igdb ?? "",
        igdb ? "igdb" : "manual",
        "game",
        game.title,
        "",
        "",
        "",
        "",
        e.seconds > 0 ? "In progress" : "Planning",
        "Exported from LootDen",
        e.first?.slice(0, 10) ?? "",
        "",
        Math.round(e.seconds / 60),
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return rows.join("\n") + "\n";
}
