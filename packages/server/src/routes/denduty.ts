import type { FastifyInstance } from "fastify";
import { HttpProblem, requireAdmin, type AppContext } from "../context.js";
import type { DenDutySettings } from "../users/denduty.js";

/** Settings, Den Duty: the link to the family's chore tracker. */
export function denDutyRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/denduty", async (req) => {
    requireAdmin(req);
    return ctx.denDuty.view();
  });
  app.put<{ Body: Partial<DenDutySettings> & { token?: string | null } }>("/api/denduty", async (req) => {
    requireAdmin(req);
    try {
      return await ctx.denDuty.save(req.body ?? {});
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });
  /** Check now instead of waiting for the next minute. */
  app.post("/api/denduty/sync", async (req) => {
    requireAdmin(req);
    await ctx.denDuty.sync();
    return ctx.denDuty.view();
  });
}
