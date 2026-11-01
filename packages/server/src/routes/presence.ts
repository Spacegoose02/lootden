import type { FastifyInstance } from "fastify";
import type { PresenceReport } from "@lootden/shared";
import { HttpProblem, requireAdmin, requirePerson, requireUser, type AppContext } from "../context.js";

/** Now Playing, parents' controls for games running on the household's PCs, and the PCs page (Wake-on-LAN). */
export function presenceRoutes(app: FastifyInstance, ctx: AppContext) {
  const fail = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw new HttpProblem(400, (err as Error).message);
    }
  };

  /** The desktop app's heartbeat: what runs on this PC; the answer carries parents' messages for it. */
  app.post<{ Body: PresenceReport }>("/api/me/presence", async (req) => {
    const me = requirePerson(req);
    return fail(() => ctx.presence.report(me.id, req.body ?? ({} as PresenceReport)));
  });

  /** Who is playing what right now. */
  app.get("/api/family/now-playing", async (req) => {
    const p = requireUser(req);
    return ctx.presence.nowPlaying({ id: p.user?.id ?? null, admin: p.role === "admin", kid: !!p.kidMode });
  });

  /** A parent's message on a PC ("Dinner in 5 minutes!"). */
  app.post<{ Params: { device: string }; Body: { text?: string } }>("/api/pcs/:device/message", async (req) => {
    const p = requireAdmin(req);
    return fail(() => ctx.presence.send(req.params.device, p.user?.displayName ?? "A grown-up", { kind: "message", text: req.body?.text }));
  });

  /** Close a game on a PC, with an optional note. The app warns first, then closes it a minute later. */
  app.post<{ Params: { device: string }; Body: { gameId?: string; text?: string } }>("/api/pcs/:device/close", async (req) => {
    const p = requireAdmin(req);
    return fail(() => ctx.presence.send(req.params.device, p.user?.displayName ?? "A grown-up", { kind: "close", gameId: req.body?.gameId, text: req.body?.text }));
  });

  /** Bonus time from the Now Playing board, with a note on the PC the person plays on. */
  app.post<{ Params: { id: string }; Body: { minutes?: number } }>("/api/family/now-playing/:id/bonus", async (req) => {
    const p = requireAdmin(req);
    const user = ctx.users.byId(Number(req.params.id));
    if (!user) throw new HttpProblem(404, "No such user");
    const granted = await fail(() => ctx.family.giveTime(user.id, Number(req.body?.minutes)));
    const from = p.user?.displayName ?? "A grown-up";
    for (const np of ctx.presence.nowPlaying({ id: null, admin: true, kid: false })) {
      if (np.userId === user.id) ctx.presence.send(np.device, from, { kind: "message", text: `${from} gave you ${granted.minutes} more minutes!` });
    }
    ctx.live.publish("playing");
    return { allowance: ctx.family.allowance(user.id) };
  });

  // ---- PCs -----------------------------------------------------------------------------------
  app.get("/api/pcs", async (req) => {
    requireAdmin(req);
    return ctx.presence.pcs();
  });
  app.post<{ Params: { device: string } }>("/api/pcs/:device/wake", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.presence.wakePc(req.params.device));
  });
  app.put<{ Params: { device: string }; Body: { mac?: string } }>("/api/pcs/:device/mac", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.presence.setMac(req.params.device, req.body?.mac));
  });
  app.delete<{ Params: { device: string } }>("/api/pcs/:device", async (req) => {
    requireAdmin(req);
    if (!ctx.presence.forgetPc(req.params.device)) throw new HttpProblem(404, "No such PC");
    return { ok: true };
  });
}
