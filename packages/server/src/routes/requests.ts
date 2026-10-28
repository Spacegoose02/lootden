import type { FastifyInstance } from "fastify";
import { HttpProblem, requireAdmin, requirePerson, requireUser, type AppContext } from "../context.js";
import type { RequestInput } from "../news/requests.js";

/** Game requests: everyone asks and sees their own; admins see all and approve or decline. */
export function requestRoutes(app: FastifyInstance, ctx: AppContext) {
  const fail = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  };
  app.get("/api/requests", async (req) => {
    const p = requireUser(req);
    if (p.role === "admin") return ctx.requests.list(null);
    return ctx.requests.list(requirePerson(req).id);
  });

  app.post<{ Body: RequestInput }>("/api/requests", async (req) => {
    const user = requirePerson(req);
    return fail(() => ctx.requests.create(user.id, user.displayName || user.username, req.body ?? { title: "" }));
  });

  app.post<{ Params: { id: string } }>("/api/requests/:id/approve", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.requests.approve(Number(req.params.id)));
  });

  app.post<{ Params: { id: string }; Body: { reason?: string } }>("/api/requests/:id/decline", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.requests.decline(Number(req.params.id), req.body?.reason ?? null));
  });

  app.delete<{ Params: { id: string } }>("/api/requests/:id", async (req) => {
    const p = requireUser(req);
    await fail(() => ctx.requests.remove(Number(req.params.id), p.user?.id ?? 0, p.role === "admin"));
    return { ok: true };
  });
}
