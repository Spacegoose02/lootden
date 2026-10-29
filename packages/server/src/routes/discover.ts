import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GameListing } from "@lootden/shared";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";
import { titleKey } from "../metadata/calendar.js";
import { kidSafeFromRatings } from "../metadata/ratings.js";

/**
 * Release calendar, Discover and YouTube rows. Kid profiles browse Discover and the calendar to
 * ask for games (an admin approves every request), but a game page whose ratings say it isn't
 * for kids stays closed to them, and they don't get the YouTube rows or add calendar dates.
 */
export function discoverRoutes(app: FastifyInstance, ctx: AppContext) {
  const grownUp = (req: FastifyRequest) => {
    if (requireUser(req).kidMode) throw new HttpProblem(403, "Not available on kid profiles");
  };
  const upstream = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      throw new HttpProblem(502, (err as Error).message);
    }
  };

  app.get<{ Querystring: { days?: string; platform?: string; past?: string } }>("/api/calendar", async (req) => {
    const p = requireUser(req);
    const days = Math.min(Math.max(Number(req.query.days) || 120, 7), 365);
    const past = Math.min(Math.max(Number(req.query.past) || 0, 0), 365);
    const from = new Date(Date.now() - past * 86400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
    // The stores being down shouldn't hide the household's own dates.
    let listed: { items: GameListing[]; source: string; error?: string };
    try {
      listed = await ctx.calendar.upcoming(days, req.query.platform === "all" ? "all" : "pc", past);
    } catch (err) {
      listed = { items: [], source: "", error: (err as Error).message };
    }
    const wished = ctx.wishlist.keys();
    const items: GameListing[] = listed.items.map((i) => ({ ...i, wishlisted: wished.has(titleKey(i.name)) }));
    const known = new Set(items.map((i) => titleKey(i.name)));
    // Wishlist games with a date in range that the release lists missed.
    for (const w of ctx.wishlist.list()) {
      if (!w.releaseDate || w.releaseDate < from || w.releaseDate > to || known.has(titleKey(w.title))) continue;
      items.push({ provider: "wishlist", providerId: String(w.id), name: w.title, releaseDate: w.releaseDate, dateText: null, coverUrl: null, imageUrl: w.image, platforms: [], genres: [], url: w.url, libraryId: w.libraryId, wishlisted: true });
    }
    const custom = ctx.db.prepare("SELECT * FROM calendar_entries WHERE date >= ? AND date <= ? ORDER BY date").all(from, to) as Array<{ id: number; title: string; date: string; note: string | null; url: string | null; created_by: number | null }>;
    for (const c of custom) {
      items.push({ provider: "custom", providerId: String(c.id), name: c.title, releaseDate: c.date, dateText: null, coverUrl: null, imageUrl: null, platforms: [], genres: [], url: c.url, libraryId: null, note: c.note, canDelete: p.role === "admin" || (p.user?.id ?? -1) === c.created_by });
    }
    items.sort((a, b) => (a.releaseDate ?? "9999").localeCompare(b.releaseDate ?? "9999"));
    return { ...listed, items: ctx.calendar.markLibrary(items).map((i, n) => ({ ...i, libraryId: i.libraryId ?? items[n]!.libraryId })) };
  });

  // Dates added by people in the household: a launch party, a beta weekend, a sale.
  app.post<{ Body: { title?: string; date?: string; note?: string; url?: string } }>("/api/calendar/entries", async (req) => {
    const p = requireUser(req);
    grownUp(req);
    const title = String(req.body?.title ?? "").trim();
    const date = String(req.body?.date ?? "");
    if (!title) throw new HttpProblem(400, "Give the entry a title");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpProblem(400, "Pick a date");
    const url = String(req.body?.url ?? "").trim();
    if (url && !/^https?:\/\//i.test(url)) throw new HttpProblem(400, "Links need to start with http:// or https://");
    const r = ctx.db
      .prepare("INSERT INTO calendar_entries (title, date, note, url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id")
      .get(title.slice(0, 200), date, String(req.body?.note ?? "").trim().slice(0, 500) || null, url || null, p.user?.id ?? null, new Date().toISOString()) as { id: number };
    return { id: r.id };
  });
  app.delete<{ Params: { id: string } }>("/api/calendar/entries/:id", async (req) => {
    const p = requireUser(req);
    const row = ctx.db.prepare("SELECT created_by FROM calendar_entries WHERE id = ?").get(Number(req.params.id)) as { created_by: number | null } | undefined;
    if (!row) throw new HttpProblem(404, "No such entry");
    if (p.role !== "admin" && (p.user?.id ?? -1) !== row.created_by) throw new HttpProblem(403, "Only the person who added it (or an admin) can remove it");
    ctx.db.prepare("DELETE FROM calendar_entries WHERE id = ?").run(Number(req.params.id));
    return { ok: true };
  });

  // Free games to claim this week, from each store's own listings.
  app.get("/api/discover/free", async () => {
    return ctx.freeGames.list();
  });
  // Admin: download a free itch.io game straight into the library.
  app.post<{ Body: { url?: string } }>("/api/discover/free/itch", async (req) => {
    requireAdmin(req);
    if (!req.body?.url) throw new HttpProblem(400, "Which game?");
    try {
      const folder = await ctx.freeGames.addItchGame(req.body.url, ctx.config.gamesDir);
      await ctx.library.rescan();
      return { folder };
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.get("/api/discover", async () => {
    return { recent: await upstream(() => ctx.calendar.recent()) };
  });

  /** One game's page in Discover: details, screenshots and trailer from the service that listed it. */
  app.get<{ Params: { provider: string; id: string } }>("/api/discover/game/:provider/:id", async (req) => {
    if (!["igdb", "rawg", "steam"].includes(req.params.provider)) throw new HttpProblem(404, "Unknown source");
    const info = await upstream(() => ctx.calendar.info(req.params.provider, req.params.id));
    if (!info) throw new HttpProblem(404, "Game not found");
    if (requireUser(req).kidMode && kidSafeFromRatings(info.ageRatings) === false) throw new HttpProblem(403, "This game is rated for older players");
    return info;
  });

  /** Any game the metadata services know, not just the library. */
  app.get<{ Querystring: { q?: string } }>("/api/discover/search", async (req) => {
    const q = req.query.q?.trim();
    if (!q) return [];
    const candidates = await upstream(() => ctx.metadata.search(q));
    const listings: GameListing[] = candidates.map((c) => ({
      provider: c.provider,
      providerId: c.providerId,
      name: c.name,
      releaseDate: null,
      dateText: c.year ? String(c.year) : null,
      coverUrl: c.coverUrl,
      imageUrl: null,
      platforms: [],
      genres: [],
      url: c.provider === "steam" ? `https://store.steampowered.com/app/${c.providerId}/` : null,
      // Discover search results open the in-app page, which loads the rest.
      libraryId: null,
    }));
    return ctx.calendar.markLibrary(listings);
  });

  app.get("/api/videos", async (req) => {
    grownUp(req);
    return ctx.videos.rows();
  });

  app.get("/api/videos/groups", async () => ctx.videos.groups());

  app.put<{ Body: { groups?: Array<{ id?: string; title: string; intervalMinutes?: number; channels: string[] }> } }>("/api/videos/groups", async (req) => {
    requireAdmin(req);
    try {
      return await ctx.videos.save(req.body?.groups ?? []);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });
}
