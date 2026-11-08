import type { FastifyInstance } from "fastify";
import type { PushSub } from "../alerts/webpush.js";
import { HttpProblem, requirePerson, type AppContext } from "../context.js";

/** Web Push: the installed app (or a browser) turns notifications on for this person. */
export function pushRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/push", async (req) => {
    const me = requirePerson(req);
    return { publicKey: ctx.push.vapid.publicKey, devices: ctx.push.count(me.id) };
  });

  app.post<{ Body: { subscription?: PushSub } }>("/api/push/subscribe", async (req) => {
    const me = requirePerson(req);
    try {
      ctx.push.subscribe(me.id, req.body?.subscription as PushSub, req.headers["user-agent"]);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
    return { devices: ctx.push.count(me.id) };
  });

  app.post<{ Body: { endpoint?: string } }>("/api/push/unsubscribe", async (req) => {
    const me = requirePerson(req);
    ctx.push.unsubscribe(me.id, String(req.body?.endpoint ?? ""));
    return { devices: ctx.push.count(me.id) };
  });

  app.post("/api/push/test", async (req) => {
    const me = requirePerson(req);
    const sent = await ctx.push.toUser(me.id, { title: "LootDen notifications work", body: "You'll hear about the things you turned on here.", link: "/profile", tag: "test" });
    if (!sent) throw new HttpProblem(400, "No device took the notification; turn notifications on again on this device");
    return { sent };
  });
}
