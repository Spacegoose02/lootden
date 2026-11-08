import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";

/** Family game night: the picker, planned nights and their calendar feed. */
export function gameNightRoutes(app: FastifyInstance, ctx: AppContext) {
  const fail = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw new HttpProblem(400, (err as Error).message);
    }
  };

  app.get("/api/game-nights", async (req) => {
    const p = requireUser(req);
    const list = ctx.gameNights.list();
    const admin = p.role === "admin";
    // Kids see what's planned, but not the names of games they couldn't open.
    const hide = <T extends { game: { id: string; title: string; coverUrl: string | null } | null }>(n: T): T =>
      p.kidMode && n.game && ctx.library.get(n.game.id, false)?.kidSafe !== true ? { ...n, game: { id: "", title: "A grown-up game", coverUrl: null } } : n;
    return {
      // The day and time of each night are in this zone (the household's).
      timeZone: ctx.family.timeZone(),
      upcoming: list.upcoming.map(hide),
      past: list.past.map(hide),
      goals: ctx.gameNights.goalsToCelebrate(),
      canPlan: admin,
      canShare: admin && !!ctx.notifier.canChat(),
      feed: admin ? `/api/game-nights/feed/${ctx.gameNights.feedKey()}/game-nights.ics` : null,
    };
  });

  /** Games for the players picked. */
  app.post<{ Body: { players?: number[] } }>("/api/game-nights/suggest", async (req) => {
    const p = requireUser(req);
    const picks = fail(() => ctx.gameNights.suggest(Array.isArray(req.body?.players) ? req.body.players.map(Number) : []));
    return p.kidMode ? picks.filter((g) => ctx.library.get(g.id, false)?.kidSafe === true) : picks;
  });

  app.post<{ Body: Record<string, unknown> }>("/api/game-nights", async (req) => {
    const p = requireAdmin(req);
    const night = fail(() => ctx.gameNights.create(p.user?.id ?? 0, req.body ?? {}));
    ctx.live.publish("playing");
    return night;
  });

  /** Shares a Surprise us pick into the family chat, through the chat webhook. */
  app.post<{ Body: { gameId?: unknown; players?: unknown } }>("/api/game-nights/share-pick", async (req) => {
    requireAdmin(req);
    const game = typeof req.body?.gameId === "string" ? ctx.library.get(req.body.gameId, false) : undefined;
    if (!game) throw new HttpProblem(404, "No such game");
    const ids = Array.isArray(req.body?.players) ? req.body.players.map(Number) : [];
    const names = ids.flatMap((id) => {
      const u = ctx.users.byId(id);
      return u ? [u.displayName || u.username] : [];
    });
    const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    const base = (ctx.config.publicUrl ?? "").replace(/\/+$/, "");
    const text = [`🎰 Surprise us picked ${game.title}${who ? ` for ${who}` : ""}!`, base ? `${base}/games/${encodeURIComponent(game.id)}` : ""].filter(Boolean).join("\n");
    try {
      await ctx.notifier.chat(text);
    } catch (err) {
      throw new HttpProblem(502, (err as Error).message);
    }
    return { ok: true };
  });

  /** Joining or leaving a night: an admin (or Dendrop's link, with an admin token) for anyone; anyone else for themselves. */
  app.put<{ Params: { id: string; userId: string }; Body: { going?: unknown } }>("/api/game-nights/:id/players/:userId", async (req) => {
    const p = requireUser(req);
    const userId = Number(req.params.userId);
    if (p.role !== "admin" && p.user?.id !== userId) throw new HttpProblem(403, "You can only change your own place");
    const night = fail(() => ctx.gameNights.setPlayer(Number(req.params.id), userId, req.body?.going !== false));
    ctx.live.publish("playing");
    return night;
  });

  app.delete<{ Params: { id: string } }>("/api/game-nights/:id", async (req) => {
    requireAdmin(req);
    if (!ctx.gameNights.remove(Number(req.params.id))) throw new HttpProblem(404, "No such game night");
    return { ok: true };
  });

  app.post("/api/game-nights/feed/reset", async (req) => {
    requireAdmin(req);
    return { feed: `/api/game-nights/feed/${ctx.gameNights.resetFeedKey()}/game-nights.ics` };
  });

  /** The calendar feed: public, with a secret in the address (Den Duty and calendar apps can't sign in). */
  app.get<{ Params: { key: string } }>("/api/game-nights/feed/:key/game-nights.ics", async (req, reply) => {
    const want = Buffer.from(ctx.gameNights.feedKey());
    const got = Buffer.from(String(req.params.key));
    if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpProblem(404, "Not found");
    return reply
      .header("content-type", "text/calendar; charset=utf-8")
      .header("cache-control", "no-cache")
      .send(ctx.gameNights.ics(ctx.config.publicUrl ?? ""));
  });
}
