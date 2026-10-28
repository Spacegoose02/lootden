import type { FastifyInstance, FastifyRequest } from "fastify";
import { workshopModsPath, type WorkshopSettings } from "@lootden/shared";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";
import { workshopId } from "../workshop/steam.js";

/** The mods folder, or a 400 saying what's wrong with it. */
function cleanModsPath(input: unknown): string {
  try {
    return workshopModsPath(input);
  } catch (err) {
    throw new HttpProblem(400, (err as Error).message);
  }
}

/** Steam Workshop items for a game: its settings, browsing (with a Steam Web API key) and items by link. */
export function workshopRoutes(app: FastifyInstance, ctx: AppContext) {
  const game = (req: FastifyRequest<{ Params: { id: string } }>) => {
    const p = requireUser(req);
    if (p.user?.kidMode) throw new HttpProblem(403, "Not available on kid profiles");
    const g = ctx.library.get(req.params.id);
    if (!g) throw new HttpProblem(404, "Game not found");
    return { p, g };
  };
  const settings = (gameId: string, steamAppId: string | null, userId: number | null): WorkshopSettings => {
    const row = ctx.db.prepare("SELECT app_id, mods_path FROM workshop_settings WHERE game_id = ?").get(gameId) as { app_id: string | null; mods_path: string } | undefined;
    return { appId: row?.app_id || steamAppId || null, modsPath: row?.mods_path ?? "", canBrowse: !!ctx.addons.steamKey(userId) };
  };
  const fail = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      const message = (err as Error).message;
      throw new HttpProblem(502, /fetch failed|ENOTFOUND|ECONN|timed? ?out/i.test(message) ? "Couldn't reach Steam right now; try again in a moment" : message);
    }
  };

  app.get<{ Params: { id: string } }>("/api/games/:id/workshop", async (req) => {
    const { p, g } = game(req);
    return settings(g.id, g.metadata?.steamAppId ?? null, p.user?.id ?? null);
  });

  app.put<{ Params: { id: string }; Body: { appId?: string | null; modsPath?: string } }>("/api/games/:id/workshop", async (req) => {
    requireAdmin(req);
    const { p, g } = game(req);
    const appId = String(req.body?.appId ?? "").trim();
    if (appId && !/^\d{1,10}$/.test(appId)) throw new HttpProblem(400, "A Steam app id is a number, like 620");
    ctx.db
      .prepare("INSERT INTO workshop_settings (game_id, app_id, mods_path) VALUES (?, ?, ?) ON CONFLICT(game_id) DO UPDATE SET app_id = excluded.app_id, mods_path = excluded.mods_path")
      .run(g.id, appId || null, cleanModsPath(req.body?.modsPath));
    return settings(g.id, g.metadata?.steamAppId ?? null, p.user?.id ?? null);
  });

  /** Popular items, a search, or (with "ids") items from pasted links or ids. */
  app.get<{ Params: { id: string }; Querystring: { q?: string; page?: string; ids?: string } }>("/api/games/:id/workshop/items", async (req) => {
    const { p, g } = game(req);
    const s = settings(g.id, g.metadata?.steamAppId ?? null, p.user?.id ?? null);
    if (req.query.ids !== undefined) {
      const ids = String(req.query.ids).split(/[\s,]+/).map(workshopId).filter((x): x is string => !!x);
      if (!ids.length) throw new HttpProblem(400, "Paste a Workshop link, like steamcommunity.com/sharedfiles/filedetails/?id=123");
      const found = await fail(() => ctx.workshop.details(ids));
      // Items made for another game wouldn't download for this one.
      const items = s.appId ? found.filter((i) => !i.appId || i.appId === s.appId) : found;
      if (found.length && !items.length) throw new HttpProblem(400, "Those items are from a different game's Workshop");
      return { items, total: items.length };
    }
    if (!s.appId) throw new HttpProblem(400, "Set this game's Steam app id first");
    return fail(() => ctx.workshop.browse(s.appId!, ctx.addons.steamKey(p.user?.id ?? null), String(req.query.q ?? "").trim(), Number(req.query.page) || 1));
  });
}
