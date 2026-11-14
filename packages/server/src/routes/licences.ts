import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { LICENCE_PLATFORMS, RAP_BYTES } from "@lootden/shared";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";

/** PS3 licence files (.rap) per game: admins upload them, every device's emulator gets them on install. */
export function licenceRoutes(app: FastifyInstance, ctx: AppContext) {
  const visible = (req: FastifyRequest, id: string) => {
    const game = ctx.library.get(id);
    if (!game || (requireUser(req).kidMode && game.kidSafe !== true)) throw new HttpProblem(404, "Game not found");
    return game;
  };

  app.get<{ Params: { id: string } }>("/api/games/:id/licences", async (req) => {
    const game = visible(req, req.params.id);
    if (!LICENCE_PLATFORMS.includes(game.platform)) return [];
    return ctx.licences.list(game.id);
  });

  app.get<{ Params: { id: string; name: string } }>("/api/games/:id/licences/:name", async (req, reply) => {
    const game = visible(req, req.params.id);
    const data = await ctx.licences.read(game.id, req.params.name);
    if (!data) throw new HttpProblem(404, "No such licence");
    reply.header("Content-Type", "application/octet-stream").header("Cache-Control", "no-store");
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(req.params.name)}`);
    return reply.send(data);
  });

  // Body: the .rap itself (application/octet-stream), under the name it was saved as.
  app.put<{ Params: { id: string; name: string } }>("/api/games/:id/licences/:name", async (req) => {
    requireAdmin(req);
    const game = ctx.library.get(req.params.id);
    if (!game) throw new HttpProblem(404, "Game not found");
    const body = req.body as Readable | Buffer | undefined;
    let data: Buffer;
    if (Buffer.isBuffer(body)) data = body;
    else if (body && typeof body.pipe === "function") {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const c of body) {
        size += (c as Buffer).length;
        if (size > RAP_BYTES * 64) throw new HttpProblem(413, `A .rap file is ${RAP_BYTES} bytes; that's far bigger`);
        parts.push(c as Buffer);
      }
      data = Buffer.concat(parts);
    } else throw new HttpProblem(400, "Send the file as application/octet-stream");
    try {
      return await ctx.licences.add(game, req.params.name, data);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.delete<{ Params: { id: string; name: string } }>("/api/games/:id/licences/:name", async (req) => {
    requireAdmin(req);
    if (!ctx.library.get(req.params.id)) throw new HttpProblem(404, "Game not found");
    if (!(await ctx.licences.remove(req.params.id, req.params.name))) throw new HttpProblem(404, "No such licence");
    return { ok: true };
  });
}
