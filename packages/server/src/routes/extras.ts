import type { FastifyInstance, FastifyRequest } from "fastify";
import { PC_PLATFORM, platformFor, type GameSummary } from "@lootden/shared";
import { HttpProblem, requireAdmin, requirePerson, requireUser, type AppContext } from "../context.js";
import { BACKLOG_STATUSES } from "../users/journal.js";

/** Alerts, virus scans, the wanted list, update checks, the backlog and journal, mods and stats. */
export function extraRoutes(app: FastifyInstance, ctx: AppContext) {
  const fail = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw new HttpProblem(400, (err as Error).message);
    }
  };
  const visible = (req: FastifyRequest, id: string) => {
    const g = ctx.library.get(id);
    if (!g || (requireUser(req).kidMode && g.kidSafe !== true)) throw new HttpProblem(404, "No such game");
    return g;
  };

  // ---- Alerts -------------------------------------------------------------------
  app.get("/api/alerts", async (req) => {
    requireAdmin(req);
    return ctx.notifier.list();
  });
  app.post("/api/alerts/read", async (req) => {
    requireAdmin(req);
    ctx.notifier.markRead();
    return { ok: true };
  });
  app.post("/api/alerts/test", async (req) => {
    requireAdmin(req);
    await fail(() => ctx.notifier.apprise("Test alert", "If you can read this, LootDen alerts work.", null));
    return { ok: true, message: "Sent through Apprise" };
  });

  // ---- Virus scans ----------------------------------------------------------------
  app.get("/api/scans", async (req) => {
    requireAdmin(req);
    return ctx.scanner.list();
  });
  app.post<{ Params: { id: string }; Body: { action?: "release" | "delete" } }>("/api/scans/:id", async (req) => {
    requireAdmin(req);
    const action = req.body?.action;
    if (action !== "release" && action !== "delete") throw new HttpProblem(400, "release or delete");
    await fail(() => ctx.scanner.decide(Number(req.params.id), action));
    if (action === "release") await ctx.library.rescan();
    return ctx.scanner.list();
  });
  app.post("/api/scans/test", async (req) => {
    requireAdmin(req);
    return { ok: true, message: await fail(() => ctx.scanner.test()) };
  });
  app.post("/api/wanted/run", async (req) => {
    requireAdmin(req);
    void ctx.wanted.run().catch(() => {});
    return { ok: true };
  });

  const wishState = () => ({ items: ctx.wishlist.list(), steam: ctx.wishlist.steam(), feeds: ctx.wishlist.feeds() });

  // ---- Wanted list ----------------------------------------------------------------
  app.put<{ Params: { id: string }; Body: { monitored?: boolean } }>("/api/wishlist/:id", async (req) => {
    requireAdmin(req);
    ctx.wanted.setMonitored(Number(req.params.id), req.body?.monitored !== false);
    return wishState();
  });
  app.post<{ Params: { id: string } }>("/api/wishlist/:id/search", async (req) => {
    requireAdmin(req);
    const found = await fail(() => ctx.wanted.search(Number(req.params.id)));
    return { ...wishState(), found };
  });
  app.post<{ Params: { id: string } }>("/api/wishlist/:id/grab", async (req) => {
    requireAdmin(req);
    await fail(() => ctx.wanted.grab(Number(req.params.id)));
    return wishState();
  });
  app.put<{ Body: { autoSync?: boolean } }>("/api/wishlist/steam/auto", async (req) => {
    requireAdmin(req);
    ctx.wishlist.setAutoSync(req.body?.autoSync !== false);
    return wishState();
  });

  // ---- Update checks ----------------------------------------------------------------
  app.get("/api/updates", async (req) => {
    requireAdmin(req);
    return ctx.versions.behind().map((c) => ({ ...c, title: ctx.library.get(c.gameId)?.title ?? c.gameId }));
  });
  app.get<{ Params: { id: string } }>("/api/games/:id/version", async (req) => {
    visible(req, req.params.id);
    return ctx.versions.get(req.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/games/:id/version", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.versions.check(req.params.id));
  });

  // ---- Backlog and journal ----------------------------------------------------------------
  /** Journals are for library games, and for other stores' games as store:<addon>:<id> (the person's own). */
  const journalGame = (req: FastifyRequest, id: string) => {
    if (/^store:[a-z0-9-]{1,40}:[^/]{1,200}$/i.test(id)) return;
    visible(req, id);
  };
  app.get<{ Params: { id: string } }>("/api/games/:id/journal", async (req) => {
    const user = requirePerson(req);
    journalGame(req, req.params.id);
    return ctx.journal.get(user.id, req.params.id);
  });
  app.put<{ Params: { id: string }; Body: { status?: string | null; rating?: number | null; notes?: string } }>("/api/games/:id/journal", async (req) => {
    const user = requirePerson(req);
    journalGame(req, req.params.id);
    return fail(() => ctx.journal.set(user.id, req.params.id, req.body ?? {}));
  });
  app.post<{ Params: { id: string }; Body: { text?: string } }>("/api/games/:id/journal/entries", async (req) => {
    const user = requirePerson(req);
    journalGame(req, req.params.id);
    return fail(() => ctx.journal.addEntry(user.id, req.params.id, String(req.body?.text ?? "")));
  });
  app.delete<{ Params: { id: string } }>("/api/journal/entries/:id", async (req) => {
    const user = requirePerson(req);
    ctx.journal.deleteEntry(user.id, Number(req.params.id));
    return { ok: true };
  });

  /** The profile's games grouped by status, with play time. */
  app.get("/api/backlog", async (req) => {
    const p = requireUser(req);
    const user = requirePerson(req);
    const games = new Map(ctx.library.list({ kidSafe: p.kidMode }).map((g) => [g.id, g]));
    const played = new Map<string, number>();
    for (const s of ctx.users.gameStates(user.id)) played.set(s.gameId, (played.get(s.gameId) ?? 0) + (s.playtimeSeconds ?? 0));
    const items = ctx.journal
      .statuses(user.id)
      .filter((s) => games.has(s.gameId))
      .map((s) => ({ ...s, game: games.get(s.gameId)!, playtimeSeconds: played.get(s.gameId) ?? 0 }));
    const counts = Object.fromEntries(BACKLOG_STATUSES.map((st) => [st, items.filter((i) => i.status === st).length]));
    const unsorted = [...games.values()].filter((g) => g.platform === PC_PLATFORM && !items.some((i) => i.gameId === g.id) && !played.has(g.id)).length;
    return { items, counts, unsorted };
  });

  /** "Pick something for me": a random game from the backlog (or never-played games when it's empty). */
  app.get<{ Querystring: { status?: string; controller?: string } }>("/api/backlog/roulette", async (req) => {
    const p = requireUser(req);
    const user = requirePerson(req);
    const games = ctx.library.list({ kidSafe: p.kidMode });
    const status = req.query.status || "backlog";
    const marked = new Set(ctx.journal.statuses(user.id).filter((s) => s.status === status).map((s) => s.gameId));
    const played = new Set(ctx.users.gameStates(user.id).filter((s) => s.lastPlayedAt).map((s) => s.gameId));
    const sorted = new Set(ctx.journal.statuses(user.id).map((s) => s.gameId));
    let pool: GameSummary[] = games.filter((g) => marked.has(g.id));
    let from = status;
    if (!pool.length && status === "backlog") {
      pool = games.filter((g) => !played.has(g.id) && !sorted.has(g.id));
      from = "unplayed";
    }
    if (req.query.controller === "1") pool = pool.filter((g) => g.controllerSupport === "full" || g.controllerSupport === "partial");
    if (!pool.length) throw new HttpProblem(404, "Nothing to pick from yet; mark a few games as Backlog");
    return { game: pool[Math.floor(Math.random() * pool.length)], from, poolSize: pool.length };
  });

  /** How long to beat, in hours: HowLongToBeat, else IGDB (with IGDB keys). */
  app.get<{ Params: { id: string } }>("/api/games/:id/time-to-beat", async (req) => {
    const g = visible(req, req.params.id);
    return fail(async () => ctx.timeToBeat(g.metadata?.provider === "igdb" ? g.metadata.providerId : null, g.title));
  });

  // ---- Mods ----------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/games/:id/mods", async (req) => {
    const g = visible(req, req.params.id);
    if (requireUser(req).kidMode) return { configured: false, domain: null, mods: [] };
    if (!ctx.nexus.enabled) return { configured: false, domain: null, mods: [] };
    return { configured: true, ...(await fail(() => ctx.nexus.forTitle(g.title))) };
  });
  app.post("/api/mods/test", async (req) => {
    requireAdmin(req);
    return { ok: true, message: await fail(() => ctx.nexus.test()) };
  });

  // ---- Library stats ----------------------------------------------------------------
  app.get("/api/stats/library", async (req) => {
    const p = requireUser(req);
    const games = ctx.library.list({ kidSafe: p.kidMode });
    const sum = (xs: GameSummary[]) => xs.reduce((n, g) => n + g.sizeBytes, 0);
    const group = <K extends string | number>(key: (g: GameSummary) => K[] | K | null) => {
      const m = new Map<K, GameSummary[]>();
      for (const g of games) {
        const k = key(g);
        for (const x of Array.isArray(k) ? k : k == null ? [] : [k]) m.set(x, [...(m.get(x) ?? []), g]);
      }
      return m;
    };
    const platforms = [...group((g) => g.platform).entries()]
      .map(([id, gs]) => ({ id, name: platformFor(id).name, count: gs.length, bytes: sum(gs) }))
      .sort((a, b) => b.count - a.count);
    const genres = [...group((g) => g.genres).entries()].map(([name, gs]) => ({ name, count: gs.length })).sort((a, b) => b.count - a.count).slice(0, 12);
    const decades = [...group((g) => (g.releaseYear ? Math.floor(g.releaseYear / 5) * 5 : null)).entries()].map(([from, gs]) => ({ from, count: gs.length })).sort((a, b) => a.from - b.from);
    const months: Array<{ month: string; count: number }> = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - i);
      const month = d.toISOString().slice(0, 7);
      months.push({ month, count: games.filter((g) => g.addedAt.startsWith(month)).length });
    }
    // Play time across everyone (admins) or just this profile.
    const people = p.role === "admin" ? ctx.users.list() : p.user ? [p.user] : [];
    const playtime = new Map<string, number>();
    const perPerson = people.map((u) => {
      let total = 0;
      for (const s of ctx.users.gameStates(u.id)) {
        total += s.playtimeSeconds ?? 0;
        playtime.set(s.gameId, (playtime.get(s.gameId) ?? 0) + (s.playtimeSeconds ?? 0));
      }
      return { name: u.displayName, seconds: total };
    });
    const byId = new Map(games.map((g) => [g.id, g]));
    const mostPlayed = [...playtime.entries()]
      .filter(([id, s]) => byId.has(id) && s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, seconds]) => ({ id, title: byId.get(id)!.title, seconds }));
    const biggest = [...games].sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, 10).map((g) => ({ id: g.id, title: g.title, bytes: g.sizeBytes }));
    const rated = games.filter((g) => g.rating != null);
    return {
      gameCount: games.length,
      totalBytes: sum(games),
      averageRating: rated.length ? Math.round(rated.reduce((n, g) => n + g.rating!, 0) / rated.length) : null,
      controller: { full: games.filter((g) => g.controllerSupport === "full").length, partial: games.filter((g) => g.controllerSupport === "partial").length },
      kidSafe: games.filter((g) => g.kidSafe === true).length,
      platforms,
      genres,
      releaseYears: decades,
      addedByMonth: months,
      playtime: perPerson.sort((a, b) => b.seconds - a.seconds),
      mostPlayed,
      biggest,
      backlog: p.user ? Object.fromEntries(BACKLOG_STATUSES.map((s) => [s, ctx.journal.statuses(p.user!.id).filter((x) => x.status === s).length])) : null,
    };
  });
}
