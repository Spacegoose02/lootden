import type { FastifyInstance, FastifyRequest } from "fastify";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";

/**
 * The household wishlist. Everyone sees it (kid profiles too, to request games from it); everyone
 * but kid profiles can add and remove games; admins pick the sources.
 */
export function wishlistRoutes(app: FastifyInstance, ctx: AppContext) {
  const grownUp = (req: FastifyRequest) => {
    if (requireUser(req).kidMode) throw new HttpProblem(403, "Not available on kid profiles");
  };
  const fail = async <T>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  };
  const state = () => ({ items: ctx.wishlist.list(), steam: ctx.wishlist.steam(), feeds: ctx.wishlist.feeds() });

  app.get("/api/wishlist", async (req) => {
    requireUser(req);
    return state();
  });
  app.post<{ Body: { title?: string; url?: string } }>("/api/wishlist", async (req) => {
    grownUp(req);
    const url = String(req.body?.url ?? "").trim() || null;
    if (url && !/^https?:\/\//i.test(url)) throw new HttpProblem(400, "Links need to start with http:// or https://");
    await fail(async () => ctx.wishlist.addManual(String(req.body?.title ?? ""), url));
    return state();
  });
  app.delete<{ Params: { id: string } }>("/api/wishlist/:id", async (req) => {
    grownUp(req);
    ctx.wishlist.remove(Number(req.params.id));
    return state();
  });
  app.post("/api/wishlist/sync", async (req) => {
    grownUp(req);
    await ctx.wishlist.syncAll();
    return state();
  });

  app.put<{ Body: { profile?: string; autoSync?: boolean } }>("/api/wishlist/steam", async (req) => {
    requireAdmin(req);
    await fail(() => ctx.wishlist.linkSteam(String(req.body?.profile ?? ""), req.body?.autoSync));
    return state();
  });
  app.post<{ Body: { url?: string; name?: string } }>("/api/wishlist/feeds", async (req) => {
    requireAdmin(req);
    await fail(() => ctx.wishlist.addFeed(String(req.body?.url ?? ""), req.body?.name));
    return state();
  });
  app.delete<{ Params: { id: string } }>("/api/wishlist/feeds/:id", async (req) => {
    requireAdmin(req);
    ctx.wishlist.removeFeed(Number(req.params.id));
    return state();
  });
}
