import type { FastifyInstance } from "fastify";
import { HttpProblem, requireAdmin, requirePerson, type AppContext } from "../context.js";

/** Library add-ons: a person's store accounts on their profile, and the games those own. */
export function addonRoutes(app: FastifyInstance, ctx: AppContext) {
  const fail = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  };

  app.get("/api/addons", async (req) => ctx.addons.list(requirePerson(req).id));

  /** Connects (or updates) this person's account and syncs it straight away. */
  app.put<{ Params: { id: string }; Body: { config?: Record<string, unknown> } }>("/api/addons/:id/account", async (req) => {
    const user = requirePerson(req);
    const games = await fail(() => ctx.addons.connect(user.id, req.params.id, req.body?.config ?? {}, { allowPrivate: user.role === "admin" }));
    return { games, addons: ctx.addons.list(user.id) };
  });

  app.post<{ Params: { id: string } }>("/api/addons/:id/sync", async (req) => {
    const user = requirePerson(req);
    const games = await fail(() => ctx.addons.sync(user.id, req.params.id, { allowPrivate: user.role === "admin" }));
    return { games, addons: ctx.addons.list(user.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/addons/:id/account", async (req) => {
    const user = requirePerson(req);
    ctx.addons.disconnect(user.id, req.params.id);
    return ctx.addons.list(user.id);
  });

  /** Admins: switch an add-on off (or back on) for everyone. */
  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/addons/:id", async (req) => {
    requireAdmin(req);
    await fail(() => ctx.addons.setEnabled(req.params.id, req.body?.enabled !== false));
    return ctx.addons.list(requirePerson(req).id);
  });

  app.get<{ Querystring: { addon?: string } }>("/api/store-games", async (req) => {
    const user = requirePerson(req);
    return ctx.addons.games(user.id, req.query.addon || undefined);
  });
}
