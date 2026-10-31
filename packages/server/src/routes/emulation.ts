import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { EMULATORS, PLATFORMS } from "@lootden/shared";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";
import { browserPlayable, playPage } from "../emulation/browser-play.js";

/** The Emulation section: systems in the library, the emulators for them, and shared BIOS files. */
export function emulationRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get("/api/emulation", async (req) => {
    const kid = requireUser(req).kidMode;
    return { platforms: PLATFORMS, emulators: EMULATORS, library: ctx.library.platforms(kid), bios: ctx.bios.list() };
  });

  // In-browser play: a standalone EmulatorJS page the web app shows in a frame.
  app.get<{ Params: { id: string } }>("/api/games/:id/play", async (req, reply) => {
    const user = requireUser(req);
    const game = ctx.library.get(req.params.id);
    if (!game || (user.kidMode && game.kidSafe !== true)) throw new HttpProblem(404, "Game not found");
    // Play time limits and bedtime count here too, not just in the desktop app.
    if (user.user) {
      const today = ctx.family.allowance(user.user.id);
      if (today.limited && !today.canPlay) throw new HttpProblem(403, today.reason ?? "No play time left today");
    }
    if (!browserPlayable(game)) throw new HttpProblem(400, "This game can't be played in the browser");
    reply.header("Content-Type", "text/html; charset=utf-8").header("Cache-Control", "no-store");
    return reply.send(playPage(game, ctx.bios.list()));
  });

  app.get("/api/emulation/bios", async (req) => {
    requireUser(req);
    return ctx.bios.list();
  });

  app.get<{ Params: { name: string } }>("/api/emulation/bios/:name", async (req, reply) => {
    requireUser(req);
    const file = ctx.bios.path(req.params.name);
    const s = file ? await stat(file).catch(() => null) : null;
    if (!file || !s) throw new HttpProblem(404, "No such BIOS file");
    reply.header("Content-Type", "application/octet-stream").header("Content-Length", s.size);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(req.params.name)}`);
    return reply.send(createReadStream(file));
  });

  // Body: the file itself (application/octet-stream). ?emulator= when the name doesn't say.
  app.put<{ Params: { name: string }; Querystring: { emulator?: string } }>("/api/emulation/bios/:name", async (req) => {
    requireAdmin(req);
    if (!req.body || typeof (req.body as Readable).pipe !== "function") throw new HttpProblem(400, "Send the file as application/octet-stream");
    try {
      return await ctx.bios.add(req.params.name, req.body as Readable, req.query.emulator);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.delete<{ Params: { name: string } }>("/api/emulation/bios/:name", async (req) => {
    requireAdmin(req);
    if (!(await ctx.bios.remove(req.params.name))) throw new HttpProblem(404, "No such BIOS file");
    return { ok: true };
  });
}
