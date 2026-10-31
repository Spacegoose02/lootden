import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WeeklyRecap } from "@lootden/shared";
import { HttpProblem, requireAdmin, requirePerson, requireUser, type AppContext } from "../context.js";
import type { FamilySettings } from "../users/family.js";
import type { ShelfInput } from "../users/shelves.js";

/** Play time limits and bonus time, achievements, celebrations, the weekly recap and shelves. */
export function familyRoutes(app: FastifyInstance, ctx: AppContext) {
  const fail = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw new HttpProblem(400, (err as Error).message);
    }
  };
  const person = (id: string) => {
    const user = ctx.users.byId(Number(id));
    if (!user) throw new HttpProblem(404, "No such user");
    return user;
  };
  const isAdmin = (req: FastifyRequest) => requireUser(req).role === "admin";

  // ---- Household settings --------------------------------------------------------------
  app.get("/api/family/settings", async (req) => {
    requireAdmin(req);
    return { ...ctx.family.settings(), effectiveTimeZone: ctx.family.timeZone() };
  });
  app.put<{ Body: Partial<FamilySettings> }>("/api/family/settings", async (req) => {
    requireAdmin(req);
    await fail(() => ctx.family.saveSettings(req.body ?? {}));
    return { ...ctx.family.settings(), effectiveTimeZone: ctx.family.timeZone() };
  });
  /** What the desktop app needs before it starts a game: today's allowance and whether to keep saves apart. */
  app.get("/api/me/allowance", async (req) => {
    const me = requirePerson(req);
    return { ...ctx.family.allowance(me.id), limits: ctx.family.limits(me.id), separateSaves: ctx.family.settings().separateSaves, userId: me.id };
  });

  // ---- Limits and bonus time --------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/users/:id/limits", async (req) => {
    requireAdmin(req);
    const user = person(req.params.id);
    return { limits: ctx.family.limits(user.id), allowance: ctx.family.allowance(user.id) };
  });
  app.put<{ Params: { id: string }; Body: unknown }>("/api/users/:id/limits", async (req) => {
    requireAdmin(req);
    const user = person(req.params.id);
    const limits = ctx.family.setLimits(user.id, req.body);
    return { limits, allowance: ctx.family.allowance(user.id) };
  });
  app.post<{ Params: { id: string }; Body: { minutes?: number } }>("/api/users/:id/bonus", async (req) => {
    requireAdmin(req);
    const user = person(req.params.id);
    await fail(() => ctx.family.giveTime(user.id, Number(req.body?.minutes)));
    return { limits: ctx.family.limits(user.id), allowance: ctx.family.allowance(user.id) };
  });

  app.get("/api/time-requests", async (req) => (isAdmin(req) ? ctx.family.timeRequests(null) : ctx.family.timeRequests(requirePerson(req).id)));
  app.post<{ Body: { minutes?: number; note?: string } }>("/api/time-requests", async (req) => {
    const me = requirePerson(req);
    return fail(() => ctx.family.askForTime(me.id, me.displayName || me.username, Number(req.body?.minutes), req.body?.note ?? null));
  });
  app.post<{ Params: { id: string }; Body: { minutes?: number } }>("/api/time-requests/:id/approve", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.family.decideTime(Number(req.params.id), true, req.body?.minutes));
  });
  app.post<{ Params: { id: string } }>("/api/time-requests/:id/decline", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.family.decideTime(Number(req.params.id), false));
  });

  // ---- Achievements, levels and celebrations ------------------------------------------------
  app.get("/api/me/progress", async (req) => ctx.family.progress(requirePerson(req).id));
  /** Anyone in the household can look at someone's profile card: level and badges, no detailed stats. */
  app.get<{ Params: { id: string } }>("/api/users/:id/card", async (req) => {
    requireUser(req);
    const user = person(req.params.id);
    const { level, achievements } = ctx.family.progress(user.id);
    return { id: user.id, displayName: user.displayName, avatar: user.avatar, kid: user.kidMode, level, achievements: achievements.filter((a) => a.unlockedAt) };
  });
  app.get("/api/me/celebrations", async (req) => ctx.family.celebrations(requirePerson(req).id));
  app.post<{ Body: { achievements?: unknown; wishes?: unknown; bonus?: unknown } | undefined }>("/api/me/celebrations/seen", async (req) => {
    const b = req.body;
    // The ones the screen showed; nothing named (older apps) marks everything.
    ctx.family.celebrated(requirePerson(req).id, b && typeof b === "object" && ("achievements" in b || "wishes" in b || "bonus" in b) ? b : undefined);
    return { ok: true };
  });
  app.post("/api/me/roulette", async (req) => ({ spins: ctx.family.bump(requirePerson(req).id, "roulette") }));

  // ---- Weekly recap ------------------------------------------------------------------------
  app.get<{ Querystring: { weeksAgo?: string } }>("/api/family/recap", async (req) => {
    const p = requireUser(req);
    const recap = ctx.family.recap(Number(req.query.weeksAgo ?? 0) || 0);
    if (!p.kidMode) return recap;
    // Kid profiles see the leaderboard, but not the names of games they couldn't open themselves.
    const ok = (id: string) => ctx.library.get(id, false)?.kidSafe === true;
    const hide = <T extends { id: string; title: string } | null>(g: T): T => (g && !ok(g.id) ? ({ ...g, id: "", title: "A grown-up game" } as T) : g);
    return { ...recap, topGame: hide(recap.topGame), players: recap.players.map((pl) => ({ ...pl, topGame: hide(pl.topGame) })) } satisfies WeeklyRecap;
  });

  // ---- Shelves --------------------------------------------------------------------------------
  app.get("/api/shelves", async (req) => {
    const p = requireUser(req);
    return ctx.shelves.list(requirePerson(req).id, p.kidMode);
  });
  app.post<{ Body: ShelfInput }>("/api/shelves", async (req) => {
    const p = requireUser(req);
    const me = requirePerson(req);
    const id = await fail(() => ctx.shelves.create(me.id, p.role === "admin", req.body ?? {}));
    return ctx.shelves.get(id, me.id, p.kidMode);
  });
  app.patch<{ Params: { id: string }; Body: ShelfInput }>("/api/shelves/:id", async (req) => {
    const p = requireUser(req);
    const me = requirePerson(req);
    await fail(() => ctx.shelves.update(Number(req.params.id), me.id, p.role === "admin", req.body ?? {}));
    return ctx.shelves.get(Number(req.params.id), me.id, p.kidMode);
  });
  app.delete<{ Params: { id: string } }>("/api/shelves/:id", async (req) => {
    const p = requireUser(req);
    await fail(() => ctx.shelves.remove(Number(req.params.id), requirePerson(req).id, p.role === "admin"));
    return { ok: true };
  });
  app.put<{ Params: { id: string; gameId: string } }>("/api/shelves/:id/games/:gameId", async (req) => {
    const p = requireUser(req);
    const me = requirePerson(req);
    const game = ctx.library.get(req.params.gameId, false);
    if (!game || (p.kidMode && game.kidSafe !== true)) throw new HttpProblem(404, "No such game");
    await fail(() => ctx.shelves.addGame(Number(req.params.id), me.id, p.role === "admin", req.params.gameId));
    return ctx.shelves.get(Number(req.params.id), me.id, p.kidMode);
  });
  app.delete<{ Params: { id: string; gameId: string } }>("/api/shelves/:id/games/:gameId", async (req) => {
    const p = requireUser(req);
    const me = requirePerson(req);
    await fail(() => ctx.shelves.removeGame(Number(req.params.id), me.id, p.role === "admin", req.params.gameId));
    return ctx.shelves.get(Number(req.params.id), me.id, p.kidMode);
  });
  app.get<{ Params: { id: string } }>("/api/games/:id/shelves", async (req) => ctx.shelves.forGame(req.params.id, requirePerson(req).id));
}
