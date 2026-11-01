import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { EMULATORS, PLATFORMS, platformFor } from "@lootden/shared";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";
import { browserPlayable, playPage } from "../emulation/browser-play.js";
import { ps2BrowserStatus, ps2PlayUrl, saveEmulationSettings, type EmulationSettings } from "../emulation/ps2-web.js";

/** The Emulation section: systems in the library, the emulators for them, and shared BIOS files. */
export function emulationRoutes(app: FastifyInstance, ctx: AppContext, ps2Dir: string) {
  const ps2Status = () => ps2BrowserStatus(ctx.db, ctx.bios.list(), ps2Dir);

  app.get("/api/emulation", async (req) => {
    const kid = requireUser(req).kidMode;
    return { platforms: PLATFORMS, emulators: EMULATORS, library: ctx.library.platforms(kid), bios: ctx.bios.list(), ps2Browser: ps2Status() };
  });

  // Whether PS2 games play in the browser here (the game page asks before showing its button).
  app.get("/api/emulation/ps2-browser", async (req) => {
    requireUser(req);
    return ps2Status();
  });

  // The admin's switch for PS2 in the browser, for when it's too demanding for the PCs at home.
  app.put<{ Body: Partial<EmulationSettings> }>("/api/emulation/settings", async (req) => {
    requireAdmin(req);
    try {
      saveEmulationSettings(ctx.db, req.body ?? {});
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
    return ps2Status();
  });

  // In-browser play: a standalone EmulatorJS page the web app shows in a frame (TabStationToo for PS2).
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
    // PS2: TabStationToo's own page, which fetches the BIOS and streams the disc from here.
    if (platformFor(game.platform).browserPlayer) {
      const status = ps2Status();
      if (!status.available) throw new HttpProblem(status.enabled && status.installed ? 400 : 403, status.reason!);
      return reply.header("Cache-Control", "no-store").redirect(ps2PlayUrl(game, status.bios!));
    }
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
