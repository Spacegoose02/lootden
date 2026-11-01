import type { FastifyInstance, FastifyRequest } from "fastify";
import { platformFor, type GameAchievements } from "@lootden/shared";
import { HttpProblem, requirePerson, requireUser, type AppContext } from "../context.js";

interface SessionRow {
  game_id: string;
  device: string | null;
  seconds: number;
  started_at: string;
  ended_at: string;
}

/** Game achievements (Steam, RetroAchievements, Xbox) and each person's play session history. */
export function achievementRoutes(app: FastifyInstance, ctx: AppContext) {
  const visibleGame = (req: FastifyRequest, id: string) => {
    const game = ctx.library.get(id);
    if (!game || (requireUser(req).kidMode && game.kidSafe !== true)) throw new HttpProblem(404, "Game not found");
    return game;
  };
  const refresh = (q: { refresh?: string }) => q.refresh === "1" || q.refresh === "true";
  /** A source's error is shown on the page instead of failing it. */
  const attempt = async (load: () => Promise<GameAchievements | null>) => {
    try {
      return { achievements: await load(), error: null as string | null };
    } catch (err) {
      return { achievements: null, error: (err as Error).message };
    }
  };

  // ---- Achievements --------------------------------------------------------------------

  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>("/api/games/:id/achievements", async (req) => {
    const user = requirePerson(req);
    const game = visibleGame(req, req.params.id);
    const connected = ctx.achievements.connected(user.id);
    const link = `/games/${game.id}`;
    const emulated = game.platform !== "pc";
    const appId = game.metadata?.steamAppId ?? null;
    const out = emulated
      ? connected.includes("retroachievements")
        ? await attempt(() => ctx.achievements.retro(user.id, game.metadata?.name ?? game.title, link, refresh(req.query)))
        : { achievements: null, error: null }
      : appId && connected.includes("steam")
        ? await attempt(() => ctx.achievements.steam(user.id, appId, link, refresh(req.query)))
        : { achievements: null, error: null };
    // Which account would show them, when none is connected yet.
    const wants = emulated ? (platformFor(game.platform).name ? "retroachievements" : null) : appId ? "steam" : null;
    return { ...out, connected, wants: wants && !connected.includes(wants) ? wants : null };
  });

  app.get<{ Params: { addon: string; id: string }; Querystring: { refresh?: string } }>("/api/store-games/:addon/:id/achievements", async (req) => {
    const user = requirePerson(req);
    const { addon, id } = req.params;
    const connected = ctx.achievements.connected(user.id);
    const link = `/store/${encodeURIComponent(addon)}/${encodeURIComponent(id)}`;
    if (addon === "steam") {
      const out = connected.includes("steam") ? await attempt(() => ctx.achievements.steam(user.id, id, link, refresh(req.query))) : { achievements: null, error: null };
      return { ...out, connected, wants: connected.includes("steam") ? null : "steam" };
    }
    if (addon === "xbox") {
      const out = connected.includes("xbox") ? await attempt(() => ctx.achievements.xbox(user.id, id, link, refresh(req.query))) : { achievements: null, error: null };
      return { ...out, connected, wants: connected.includes("xbox") ? null : "xbox" };
    }
    return { achievements: null, error: null, connected, wants: null };
  });

  app.get("/api/me/achievements", async (req) => ctx.achievements.summary(requirePerson(req).id));

  /** Everyone's unlocked achievements, for the family board. */
  app.get("/api/family/achievements", async (req) => {
    requireUser(req);
    const totals = ctx.achievements.totals();
    return ctx.users
      .list()
      .map((u) => ({ userId: u.id, name: u.displayName, avatar: u.avatar ?? null, unlocked: totals.get(u.id)?.unlocked ?? 0, perfect: totals.get(u.id)?.perfect ?? 0 }))
      .filter((r) => r.unlocked > 0)
      .sort((a, b) => b.unlocked - a.unlocked);
  });

  // ---- Play session history --------------------------------------------------------------

  app.get<{ Params: { id: string } }>("/api/games/:id/sessions", async (req) => {
    const user = requirePerson(req);
    visibleGame(req, req.params.id);
    const rows = ctx.db
      .prepare("SELECT game_id, device, seconds, started_at, ended_at FROM play_sessions WHERE user_id = ? AND game_id = ? ORDER BY ended_at DESC")
      .all(user.id, req.params.id) as unknown as SessionRow[];
    const total = rows.reduce((n, r) => n + r.seconds, 0);
    return {
      sessions: rows.slice(0, 50).map((r) => ({ device: r.device, seconds: r.seconds, startedAt: r.started_at, endedAt: r.ended_at })),
      count: rows.length,
      totalSeconds: total,
      averageSeconds: rows.length ? Math.round(total / rows.length) : 0,
      longestSeconds: rows.reduce((n, r) => Math.max(n, r.seconds), 0),
      firstPlayedAt: rows.at(-1)?.started_at ?? null,
    };
  });

  /**
   * This person's play over the last `days` days (or everyone's for admins with ?everyone=1):
   * per day, weekday and hour, per genre and per PC, and the latest sessions.
   */
  app.get<{ Querystring: { days?: string; everyone?: string; tz?: string } }>("/api/me/play-history", async (req) => {
    const p = requireUser(req);
    const user = requirePerson(req);
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
    const everyone = p.role === "admin" && req.query.everyone === "1";
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = (everyone
      ? ctx.db.prepare("SELECT game_id, device, seconds, started_at, ended_at FROM play_sessions WHERE ended_at >= ? ORDER BY ended_at DESC").all(since)
      : ctx.db.prepare("SELECT game_id, device, seconds, started_at, ended_at FROM play_sessions WHERE user_id = ? AND ended_at >= ? ORDER BY ended_at DESC").all(user.id, since)) as unknown as SessionRow[];
    // Days follow the browser's time zone when it says, so evening play lands on the right day.
    const tz = typeof req.query.tz === "string" && /^[A-Za-z_]+(\/[A-Za-z_+-]+){0,2}$/.test(req.query.tz) ? req.query.tz : undefined;
    const parts = (iso: string) => {
      const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", weekday: "short" });
      const o = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
      return { day: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour) % 24, weekday: o.weekday as string };
    };
    const perDay = new Map<string, number>();
    for (let i = days - 1; i >= 0; i--) perDay.set(parts(new Date(Date.now() - i * 86400_000).toISOString()).day, 0);
    const WEEK = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const perWeekday = new Map(WEEK.map((d) => [d, 0]));
    const perHour = Array.from({ length: 24 }, () => 0);
    const perGenre = new Map<string, number>();
    const perDevice = new Map<string, number>();
    const perGame = new Map<string, number>();
    const titles = new Map<string, string>();
    for (const r of rows) {
      const at = parts(r.started_at);
      if (perDay.has(at.day)) perDay.set(at.day, perDay.get(at.day)! + r.seconds);
      perWeekday.set(at.weekday, (perWeekday.get(at.weekday) ?? 0) + r.seconds);
      perHour[at.hour]! += r.seconds;
      perDevice.set(r.device || "Unknown PC", (perDevice.get(r.device || "Unknown PC") ?? 0) + r.seconds);
      perGame.set(r.game_id, (perGame.get(r.game_id) ?? 0) + r.seconds);
      const g = ctx.library.get(r.game_id);
      if (g && !(p.kidMode && g.kidSafe !== true)) {
        titles.set(r.game_id, g.title);
        for (const genre of g.metadata?.genres ?? []) perGenre.set(genre, (perGenre.get(genre) ?? 0) + r.seconds);
      }
    }
    const top = (m: Map<string, number>, n: number) => [...m.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
    return {
      days,
      totalSeconds: rows.reduce((n, r) => n + r.seconds, 0),
      sessionCount: rows.length,
      perDay: [...perDay.entries()].map(([day, seconds]) => ({ day, seconds })),
      perWeekday: WEEK.map((d) => ({ day: d, seconds: perWeekday.get(d) ?? 0 })),
      perHour: perHour.map((seconds, hour) => ({ hour, seconds })),
      genres: top(perGenre, 10).map(([name, seconds]) => ({ name, seconds })),
      devices: top(perDevice, 10).map(([name, seconds]) => ({ name, seconds })),
      games: top(perGame, 10)
        .filter(([id]) => titles.has(id) || /^(roblox|store):/.test(id))
        .map(([id, seconds]) => ({ id, title: titles.get(id) ?? id.replace(/^roblox:.*/, "Roblox"), seconds })),
      recent: rows
        .slice(0, 20)
        .map((r) => ({ gameId: r.game_id, title: titles.get(r.game_id) ?? (r.game_id.startsWith("roblox:") ? "Roblox" : null), device: r.device, seconds: r.seconds, startedAt: r.started_at }))
        .filter((r) => r.title),
    };
  });
}
