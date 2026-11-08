import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { EMULATORS, PLATFORMS, platformFor, recompInfo, RECOMPS, type RecompArch, type RecompOs } from "@lootden/shared";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";
import { browserPlayable, playPage } from "../emulation/browser-play.js";
import { MAX_DAT_BYTES } from "../emulation/romcheck.js";
import { addCustomRecomp, customRecomps, removeCustomRecomp } from "../emulation/recomps.js";
import { ps2BrowserStatus, ps2PlayUrl, saveEmulationSettings, type EmulationSettings } from "../emulation/ps2-web.js";

/** The Emulation section: systems in the library, the emulators for them, and shared BIOS files. */
export function emulationRoutes(app: FastifyInstance, ctx: AppContext, ps2Dir: string) {
  const ps2Status = () => ps2BrowserStatus(ctx.db, ctx.bios.list(), ps2Dir);

  app.get("/api/emulation", async (req) => {
    const kid = requireUser(req).kidMode;
    return { platforms: PLATFORMS, emulators: EMULATORS, library: ctx.library.platforms(kid), bios: ctx.bios.list(), ps2Browser: ps2Status() };
  });

  // Recomps: LootDen's own and the ones an admin added by GitHub link. The desktop apps download them.
  app.get("/api/recomps", async (req) => {
    requireUser(req);
    return { builtIn: RECOMPS, added: customRecomps(ctx.db) };
  });

  // Recomp downloads through the server: fetched from GitHub once, then every PC gets them from here.
  type Want = { Params: { id: string }; Querystring: { os?: string; arch?: string } };
  const want = (req: FastifyRequest<Want>) => {
    requireUser(req);
    const info = recompInfo(req.params.id, customRecomps(ctx.db));
    if (!info) throw new HttpProblem(404, "No such recomp");
    const os: RecompOs = req.query.os === "linux" ? "linux" : "win32";
    const arch: RecompArch = req.query.arch === "arm64" ? "arm64" : "x64";
    return { info, os, arch, qs: `os=${os}&arch=${arch}` };
  };

  app.get<Want>("/api/recomps/:id/release", async (req) => {
    const { info, os, arch, qs } = want(req);
    try {
      return { ...(await ctx.recompCache.release(info, os, arch)), download: `/api/recomps/${encodeURIComponent(info.id)}/file?${qs}` };
    } catch (err) {
      throw new HttpProblem(502, (err as Error).message);
    }
  });

  app.get<Want>("/api/recomps/:id/file", async (req, reply) => {
    const { info, os, arch } = want(req);
    let found: Awaited<ReturnType<typeof ctx.recompCache.file>>;
    try {
      found = await ctx.recompCache.file(info, os, arch);
    } catch (err) {
      throw new HttpProblem(502, (err as Error).message);
    }
    const s = await stat(found.path);
    reply.header("Content-Type", "application/octet-stream").header("Content-Length", s.size);
    reply.header("X-Recomp-Version", encodeURIComponent(found.release.version));
    reply.header("X-Recomp-Sha256", await ctx.recompCache.sha256Of(found.path));
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(found.release.fileName)}`);
    return reply.send(createReadStream(found.path));
  });

  app.post("/api/recomps", async (req) => {
    requireAdmin(req);
    try {
      return addCustomRecomp(ctx.db, req.body);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/recomps/:id", async (req) => {
    requireAdmin(req);
    if (!removeCustomRecomp(ctx.db, req.params.id)) throw new HttpProblem(404, "No such recomp");
    return { ok: true };
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
      const earn = ctx.family.gameLock(user.user.id, game.id);
      if (earn.reason) throw new HttpProblem(403, earn.reason);
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

  // ---- ROM checks: No-Intro and Redump DATs ------------------------------------------

  app.get("/api/emulation/dats", async (req) => {
    requireUser(req);
    return { dats: ctx.roms.dats(), progress: ctx.roms.status() };
  });

  // Body: the DAT's XML (text/xml or application/octet-stream).
  app.post("/api/emulation/dats", { bodyLimit: MAX_DAT_BYTES }, async (req) => {
    requireAdmin(req);
    const body = req.body;
    let xml: string;
    if (typeof body === "string") xml = body;
    else if (Buffer.isBuffer(body)) xml = body.toString("utf8");
    else if (body && typeof (body as Readable).pipe === "function") {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const c of body as Readable) {
        size += (c as Buffer).length;
        if (size > MAX_DAT_BYTES) throw new HttpProblem(413, "That DAT is too big");
        parts.push(c as Buffer);
      }
      xml = Buffer.concat(parts).toString("utf8");
    } else throw new HttpProblem(400, "Send the DAT file's XML");
    if (/^PK\x03\x04/.test(xml.slice(0, 4))) throw new HttpProblem(400, "Unzip the DAT first and upload the .dat file inside");
    try {
      return ctx.roms.addDat(xml);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/emulation/dats/:id", async (req) => {
    requireAdmin(req);
    if (!ctx.roms.removeDat(Number(req.params.id))) throw new HttpProblem(404, "No such DAT");
    return { ok: true };
  });

  /** Checks every emulated game in the background; GET /api/emulation/dats shows how far it got. */
  app.post("/api/emulation/rom-check", async (req) => {
    requireAdmin(req);
    if (!ctx.roms.dats().length) throw new HttpProblem(400, "Upload a No-Intro or Redump DAT first");
    const games = ctx.library.list({}).flatMap((g) => (g.platform === "pc" ? [] : [ctx.library.get(g.id, false)!].filter(Boolean)));
    return ctx.roms.checkAll(games);
  });

  app.get<{ Params: { id: string } }>("/api/games/:id/rom-check", async (req) => {
    const user = requireUser(req);
    const game = ctx.library.get(req.params.id, false);
    if (!game || (user.kidMode && game.kidSafe !== true)) throw new HttpProblem(404, "Game not found");
    return ctx.roms.result(game.id);
  });

  app.post<{ Params: { id: string } }>("/api/games/:id/rom-check", async (req) => {
    requireAdmin(req);
    const game = ctx.library.get(req.params.id, false);
    if (!game) throw new HttpProblem(404, "Game not found");
    if (game.platform === "pc") throw new HttpProblem(400, "ROM checks are for emulated games");
    if (!ctx.roms.dats().length) throw new HttpProblem(400, "Upload a No-Intro or Redump DAT first");
    try {
      return await ctx.roms.check(game, true);
    } catch (err) {
      throw new HttpProblem(400, `Couldn't read the game's files: ${(err as Error).message}`);
    }
  });
}
