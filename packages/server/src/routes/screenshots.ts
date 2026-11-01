import { createReadStream } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { playedFor, type FamilyWall } from "@lootden/shared";
import { HttpProblem, requirePerson, requireUser, type AppContext } from "../context.js";
import type { Viewer } from "../users/screenshots.js";

const TYPES: Record<string, string> = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

/** The family screenshot wall, and the summary the Den Duty family wall shows. */
export function screenshotRoutes(app: FastifyInstance, ctx: AppContext) {
  const viewer = (req: FastifyRequest): Viewer => {
    const p = requireUser(req);
    return { id: p.user?.id ?? null, admin: p.role === "admin", kid: !!p.kidMode };
  };

  /** The picture as the body (image/png, image/jpeg or image/webp); the game and caption in the query. */
  app.post<{ Querystring: { gameId?: string; title?: string; caption?: string; width?: string; height?: string } }>("/api/screenshots", async (req) => {
    const me = requirePerson(req);
    try {
      const shot = await ctx.screenshots.add(me.id, req.body as Buffer, { ...req.query, width: Number(req.query.width), height: Number(req.query.height) });
      ctx.live.publish("screenshots");
      return shot;
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.get<{ Querystring: { before?: string; limit?: string; userId?: string; gameId?: string } }>("/api/screenshots", async (req) =>
    ctx.screenshots.list(viewer(req), { before: Number(req.query.before) || undefined, limit: Number(req.query.limit) || undefined, userId: Number(req.query.userId) || undefined, gameId: req.query.gameId }),
  );

  app.get<{ Params: { id: string } }>("/api/screenshots/:id/image", async (req, reply) => {
    const file = ctx.screenshots.file(Number(req.params.id), viewer(req));
    if (!file) throw new HttpProblem(404, "No such screenshot");
    return reply
      .header("content-type", TYPES[path.extname(file)] ?? "application/octet-stream")
      .header("cache-control", "private, max-age=604800, immutable")
      .send(createReadStream(file));
  });

  app.post<{ Params: { id: string }; Body: { emoji?: string } }>("/api/screenshots/:id/react", async (req) => {
    try {
      const shot = ctx.screenshots.react(Number(req.params.id), viewer(req), String(req.body?.emoji ?? ""));
      ctx.live.publish("screenshots");
      return shot;
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/screenshots/:id", async (req) => {
    if (!(await ctx.screenshots.remove(Number(req.params.id), viewer(req)))) throw new HttpProblem(404, "No such screenshot");
    ctx.live.publish("screenshots");
    return { ok: true };
  });

  /**
   * For the Den Duty family wall (with a LootDen token, ideally a kid profile's so only kid-safe
   * things show): who plays what now, the next game night and the newest screenshots.
   */
  app.get("/api/family/wall", async (req): Promise<FamilyWall> => {
    const v = viewer(req);
    const night = ctx.gameNights.next();
    const hideGame = v.kid && night?.game && ctx.library.get(night.game.id, false)?.kidSafe !== true;
    return {
      nowPlaying: ctx.presence.nowPlaying(v).map((n) => ({ name: n.name, avatar: n.avatar, title: n.title, device: n.device, startedAt: n.startedAt, playedFor: playedFor(n.startedAt) })),
      nextGameNight: night && hideGame ? { ...night, game: { id: "", title: "A grown-up game", coverUrl: null } } : night,
      screenshots: ctx.screenshots.list(v, { limit: 12 }).map((s) => ({ id: s.id, imageUrl: s.imageUrl, by: s.by.name, game: s.game?.title ?? null, caption: s.caption, createdAt: s.createdAt })),
    };
  });
}
