import type { FastifyInstance } from "fastify";
import { HttpProblem, requireAdmin, type AppContext } from "../context.js";

/**
 * Admins: the Roblox experiences on the server and who sees them. People see theirs with the
 * other stores' games (GET /api/store-games), so there's no per-person route here.
 */
export function robloxRoutes(app: FastifyInstance, ctx: AppContext) {
  const fail = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  };
  type Access = { everyone?: boolean; userIds?: number[] };
  const live = () => ctx.live.publish("library");

  app.get("/api/roblox", async (req) => {
    requireAdmin(req);
    return ctx.roblox.list();
  });

  /** Looks a game up without adding it, so the admin sees what the link is. */
  app.post<{ Body: { input?: string } }>("/api/roblox/lookup", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.roblox.lookup(String(req.body?.input ?? "")));
  });

  /** Adds a game from a Roblox link or place ID (refreshing it if it's already here), with who sees it. */
  app.post<{ Body: { input?: string } & Access }>("/api/roblox", async (req) => {
    requireAdmin(req);
    const g = await fail(() => ctx.roblox.add(String(req.body?.input ?? ""), { everyone: req.body?.everyone, userIds: req.body?.userIds }));
    live();
    return g;
  });

  app.put<{ Params: { id: string }; Body: Access }>("/api/roblox/:id", async (req) => {
    requireAdmin(req);
    const g = await fail(() => ctx.roblox.setAccess(req.params.id, req.body ?? {}));
    live();
    return g;
  });

  /** Admins: their own cover (body: the image, Content-Type image/*). DELETE goes back to LootDen's poster. */
  app.put<{ Params: { id: string } }>("/api/roblox/:id/cover", async (req) => {
    requireAdmin(req);
    if (!Buffer.isBuffer(req.body)) throw new HttpProblem(400, "Send the image itself");
    const g = await fail(() => ctx.roblox.setCover(req.params.id, req.body as Buffer, String(req.headers["content-type"]).split(";")[0]!.trim()));
    live();
    return g;
  });

  app.delete<{ Params: { id: string } }>("/api/roblox/:id/cover", async (req) => {
    requireAdmin(req);
    const g = await fail(() => ctx.roblox.clearCover(req.params.id));
    live();
    return g;
  });

  app.post<{ Params: { id: string } }>("/api/roblox/:id/refresh", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.roblox.refresh(req.params.id));
  });

  app.delete<{ Params: { id: string } }>("/api/roblox/:id", async (req) => {
    requireAdmin(req);
    ctx.roblox.remove(req.params.id);
    live();
    return ctx.roblox.list();
  });
}
