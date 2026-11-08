import type { FastifyInstance } from "fastify";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";
import type { ChatSettings } from "../integrations/chat.js";

const fail = async <T>(fn: () => T | Promise<T>, status = 400): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw new HttpProblem(status, (err as Error).message);
  }
};

/** Dendrop, the family chat: settings for admins, Share to chat and Looking for a group for everyone. */
export function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/chat", async (req) => {
    requireAdmin(req);
    return ctx.chat.view();
  });
  app.put<{ Body: Partial<ChatSettings> }>("/api/chat", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.chat.save(req.body ?? {}));
  });
  app.get("/api/chat/channels", async (req) => {
    requireAdmin(req);
    return fail(() => ctx.chat.channels(), 502);
  });
  app.post("/api/chat/test", async (req) => {
    requireAdmin(req);
    return { posted: await fail(() => ctx.chat.test(), 502) };
  });

  /** Whether the Share to chat and Looking for a group buttons show. */
  app.get("/api/chat/status", async (req) => {
    requireUser(req);
    return { ready: ctx.chat.ready(), buttons: ctx.chat.view().hasBot };
  });

  /** The family channel in the in-game menu: read it, and send a line. Kid profiles read only, so Dendrop's kid rules can't be sidestepped. */
  app.get("/api/chat/family", async (req) => {
    requireUser(req);
    return fail(() => ctx.chat.familyMessages(), 502);
  });
  app.post<{ Body: { text?: string } }>("/api/chat/family", async (req) => {
    const p = requireUser(req);
    if (!p.user) throw new HttpProblem(400, "The service token has no name to post under");
    if (p.kidMode) throw new HttpProblem(403, "Kid profiles can read the family chat here; send messages from Dendrop");
    await fail(() => ctx.chat.sayInFamily(p.user!.displayName || p.user!.username, String(req.body?.text ?? "")), 502);
    return { ok: true };
  });

  const gameFor = (req: Parameters<typeof requireUser>[0], id: unknown) => {
    const p = requireUser(req);
    const game = ctx.library.get(String(id ?? ""), false);
    if (!game || (p.kidMode && game.kidSafe !== true)) throw new HttpProblem(404, "No such game");
    if (!ctx.chat.ready()) throw new HttpProblem(400, "Chat isn't linked; an admin links Dendrop under Settings, Chat");
    return { p, game, name: p.user?.displayName ?? "Someone" };
  };

  app.post<{ Body: { gameId?: string; note?: string } }>("/api/chat/share", async (req) => {
    const { game, name } = gameFor(req, req.body?.gameId);
    const r = await ctx.chat.share(name, game, req.body?.note ?? null);
    if (!r.ok) throw new HttpProblem(502, r.error ?? "Couldn't post to chat");
    return { ok: true };
  });

  app.post<{ Body: { gameId?: string; note?: string } }>("/api/chat/lfg", async (req) => {
    const { game, name } = gameFor(req, req.body?.gameId);
    const users = new Map(ctx.users.list().map((u) => [u.id, u.displayName]));
    const installedOn = ctx.presence
      .copiesByPc()
      .filter((pc) => pc.copies.some((c) => c.gameId === game.id))
      .map((pc) => {
        const who = users.get(ctx.presence.lastUserOf(pc.device) ?? -1);
        return who ? `${pc.device} (${who})` : pc.device;
      });
    const r = await ctx.chat.lookingForGroup(name, game, installedOn, req.body?.note ?? null);
    if (!r.ok) throw new HttpProblem(502, r.error ?? "Couldn't post to chat");
    return { ok: true };
  });
}
