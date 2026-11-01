import type { FastifyInstance, FastifyRequest } from "fastify";
import { isTruckGame, type TrackedTruckModInput, type TruckGame } from "@lootden/shared";
import { HttpProblem, requireUser, type AppContext } from "../context.js";

/**
 * The household's truck mod list (ATS, ETS2) and the load orders kept for every PC. The desktop
 * app does the page checks (in a real browser) and reads the PCs' folders; the server keeps the
 * results and asks Steam about Workshop items.
 */
export function truckModListRoutes(app: FastifyInstance, ctx: AppContext) {
  const person = (req: FastifyRequest) => {
    const p = requireUser(req);
    if (p.user?.kidMode) throw new HttpProblem(403, "Not available on kid profiles");
    return p;
  };
  const gameOf = (input: unknown): TruckGame => {
    if (!isTruckGame(input)) throw new HttpProblem(400, "Pick ats or ets2");
    return input;
  };
  const id = (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new HttpProblem(404, "Not found");
    return n;
  };
  const bad = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw new HttpProblem(400, (err as Error).message);
    }
  };
  /** Asks Steam about the Workshop items and records what it said on the list. */
  const checkWorkshop = async (game: TruckGame, ids: string[]) => {
    const clean = [...new Set(ids.filter((x) => /^\d{4,20}$/.test(x)))];
    const items = [];
    try {
      for (let i = 0; i < clean.length; i += 50) items.push(...(await ctx.workshop.details(clean.slice(i, i + 50))));
    } catch (err) {
      const message = (err as Error).message;
      throw new HttpProblem(502, /fetch failed|ENOTFOUND|ECONN|timed? ?out/i.test(message) ? "Couldn't reach Steam right now; try again in a moment" : message);
    }
    return { items, mods: ctx.truckModList.applyWorkshopDetails(game, clean, items) };
  };

  app.get<{ Querystring: { game?: string } }>("/api/truck-mod-list", async (req) => {
    person(req);
    return ctx.truckModList.list(gameOf(req.query.game));
  });

  // Body: { game, mods: [{ name, sourceUrl?, category?, ... }] }; merged into the list.
  app.post<{ Body: { game?: string; mods?: TrackedTruckModInput[] } }>("/api/truck-mod-list/import", async (req) => {
    person(req);
    const game = gameOf(req.body?.game);
    if (!Array.isArray(req.body?.mods)) throw new HttpProblem(400, "Send the mods to add");
    return bad(() => ctx.truckModList.import(game, req.body.mods!));
  });

  // Body: { game, ids }: Workshop items (the subscriptions on a PC), added with Steam's titles and checked.
  app.post<{ Body: { game?: string; ids?: string[] } }>("/api/truck-mod-list/workshop", async (req) => {
    person(req);
    const game = gameOf(req.body?.game);
    const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter((x) => /^\d{4,20}$/.test(x)).slice(0, 1000);
    if (!ids.length) throw new HttpProblem(400, "No Workshop items to add");
    const { items } = await checkWorkshop(game, ids);
    const titles = new Map(items.map((i) => [i.id, i.title]));
    const result = ctx.truckModList.import(
      game,
      ids.map((wid) => ({ name: titles.get(wid) ?? `Workshop item ${wid}`, workshopId: wid })),
    );
    return { ...result, mods: (await checkWorkshop(game, ids)).mods };
  });

  // Every Workshop mod on the list, checked with Steam.
  app.post<{ Body: { game?: string } }>("/api/truck-mod-list/check-workshop", async (req) => {
    person(req);
    const game = gameOf(req.body?.game);
    const ids = ctx.truckModList.list(game).flatMap((m) => (m.workshopId ? [m.workshopId] : []));
    if (!ids.length) return ctx.truckModList.list(game);
    return (await checkWorkshop(game, ids)).mods;
  });

  app.patch<{ Params: { id: string }; Body: Partial<TrackedTruckModInput> & { check?: unknown } }>("/api/truck-mod-list/:id", async (req) => {
    person(req);
    const mod = bad(() => ctx.truckModList.update(id(req.params.id), req.body ?? {}));
    if (!mod) throw new HttpProblem(404, "That mod isn't on the list");
    return mod;
  });

  app.delete<{ Params: { id: string } }>("/api/truck-mod-list/:id", async (req) => {
    person(req);
    if (!ctx.truckModList.remove(id(req.params.id))) throw new HttpProblem(404, "That mod isn't on the list");
    return { ok: true };
  });

  app.get<{ Querystring: { game?: string } }>("/api/truck-load-orders", async (req) => {
    person(req);
    return ctx.truckModList.loadOrders(gameOf(req.query.game));
  });

  // Body: { game, name, mods: [{ package, name }] } (top of the Mod Manager first); replaces one with that name.
  app.put<{ Body: { game?: string; name?: string; mods?: unknown } }>("/api/truck-load-orders", async (req) => {
    const p = person(req);
    const game = gameOf(req.body?.game);
    return bad(() => ctx.truckModList.saveLoadOrder(game, String(req.body?.name ?? ""), req.body?.mods, p.user?.id ?? null));
  });

  app.delete<{ Params: { id: string } }>("/api/truck-load-orders/:id", async (req) => {
    person(req);
    if (!ctx.truckModList.removeLoadOrder(id(req.params.id))) throw new HttpProblem(404, "That load order isn't there");
    return { ok: true };
  });
}
