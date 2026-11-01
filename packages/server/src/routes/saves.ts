import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { HttpProblem, requireAdmin, requirePerson, requireUser, type AppContext } from "../context.js";
import { cleanGameKey } from "../users/marks.js";

/** Store add-on ids as Ludusavi names the stores in its "when" conditions. */
const LUDUSAVI_STORES: Record<string, string> = { steam: "steam", gog: "gog", epic: "epic", xbox: "microsoft", ea: "ea", ubisoft: "uplay", amazon: "prime" };

/** Save sync: each player uploads and restores their own save backups per game. */
export function saveRoutes(app: FastifyInstance, ctx: AppContext) {
  const game = (req: FastifyRequest, id: string) => {
    const g = ctx.library.get(id);
    if (!g || (requireUser(req).kidMode && g.kidSafe !== true)) throw new HttpProblem(404, "Game not found");
    return g;
  };

  app.get("/api/saves", async (req) => ctx.saves.latestPerGame(requirePerson(req).id));

  app.get<{ Params: { id: string } }>("/api/games/:id/saves", async (req) => {
    game(req, req.params.id);
    return ctx.saves.list(requirePerson(req).id, req.params.id);
  });

  // Body: the zipped save folder (application/octet-stream). ?device= names the computer.
  app.post<{ Params: { id: string }; Querystring: { device?: string } }>("/api/games/:id/saves", async (req) => {
    const user = requirePerson(req);
    game(req, req.params.id);
    if (!req.body || typeof (req.body as Readable).pipe !== "function") throw new HttpProblem(400, "Send the zip as application/octet-stream");
    try {
      return await ctx.saves.add(user.id, req.params.id, req.body as Readable, req.query.device ?? null);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.get<{ Params: { id: string; saveId: string } }>("/api/games/:id/saves/:saveId", async (req, reply) => {
    const found = ctx.saves.file(requirePerson(req).id, Number(req.params.saveId));
    if (!found || found.backup.gameId !== req.params.id) throw new HttpProblem(404, "Save not found");
    const s = await stat(found.path).catch(() => null);
    if (!s) throw new HttpProblem(404, "Save file is gone from the server");
    const title = game(req, req.params.id).title.replace(/[^\w .-]+/g, "");
    const name = `${title} save ${found.backup.createdAt.slice(0, 10)}.zip`;
    reply.header("Content-Type", "application/zip").header("Content-Length", s.size);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(createReadStream(found.path));
  });

  app.delete<{ Params: { id: string; saveId: string } }>("/api/games/:id/saves/:saveId", async (req) => {
    if (!(await ctx.saves.remove(requirePerson(req).id, Number(req.params.saveId)))) throw new HttpProblem(404, "Save not found");
    return { ok: true };
  });

  // Where the game keeps its saves. Admins set it once for everyone.
  app.put<{ Params: { id: string }; Body: { path?: string | null } }>("/api/games/:id/save-path", async (req) => {
    requireAdmin(req);
    game(req, req.params.id);
    const p = req.body?.path?.trim() || null;
    if (p && !/^(\{game\}|%[A-Z]+%|~|\/|[A-Za-z]:)/.test(p)) {
      throw new HttpProblem(400, "Start the save path with %APPDATA%, %LOCALAPPDATA%, %USERPROFILE%, %DOCUMENTS%, {game} or a full path");
    }
    ctx.library.setSavePath(req.params.id, p);
    return ctx.library.get(req.params.id);
  });

  /** Save locations PCGamingWiki lists for this game. */
  app.get<{ Params: { id: string } }>("/api/games/:id/save-path/suggest", async (req) => {
    const g = game(req, req.params.id);
    try {
      return { paths: await ctx.metadata.pcgw.savePaths(g.metadata?.steamAppId ?? null, g.metadata?.name ?? g.title) };
    } catch (err) {
      throw new HttpProblem(502, `PCGamingWiki lookup failed: ${(err as Error).message}`);
    }
  });

  // ---- Other stores' games: saves found through Ludusavi's manifest ----------------------------

  const storeKey = (addon: string, id: string) => {
    try {
      return cleanGameKey(`store:${addon}:${id}`);
    } catch {
      throw new HttpProblem(400, "Not a store game");
    }
  };

  /** Where a store game keeps its saves, from Ludusavi's manifest. */
  app.get<{ Params: { addon: string; id: string }; Querystring: { title?: string } }>("/api/store-games/:addon/:id/save-paths", async (req) => {
    requirePerson(req);
    const { addon, id } = req.params;
    storeKey(addon, id);
    const title = String(req.query.title ?? "").slice(0, 200);
    try {
      await ctx.ludusavi.ensure();
    } catch (err) {
      throw new HttpProblem(502, (err as Error).message);
    }
    const found = ctx.ludusavi.find({ title: title || id, steamAppId: addon === "steam" ? id : null, gogId: addon === "gog" ? id : null, store: LUDUSAVI_STORES[addon] ?? null });
    return { name: found?.name ?? null, locations: found?.locations ?? [] };
  });

  app.get<{ Params: { addon: string; id: string } }>("/api/store-games/:addon/:id/saves", async (req) => ctx.saves.list(requirePerson(req).id, storeKey(req.params.addon, req.params.id)));

  app.post<{ Params: { addon: string; id: string }; Querystring: { device?: string } }>("/api/store-games/:addon/:id/saves", async (req) => {
    const user = requirePerson(req);
    const key = storeKey(req.params.addon, req.params.id);
    if (!req.body || typeof (req.body as Readable).pipe !== "function") throw new HttpProblem(400, "Send the zip as application/octet-stream");
    try {
      return await ctx.saves.add(user.id, key, req.body as Readable, req.query.device ?? null);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.get<{ Params: { addon: string; id: string; saveId: string }; Querystring: { title?: string } }>("/api/store-games/:addon/:id/saves/:saveId", async (req, reply) => {
    const key = storeKey(req.params.addon, req.params.id);
    const found = ctx.saves.file(requirePerson(req).id, Number(req.params.saveId));
    if (!found || found.backup.gameId !== key) throw new HttpProblem(404, "Save not found");
    const s = await stat(found.path).catch(() => null);
    if (!s) throw new HttpProblem(404, "Save file is gone from the server");
    const title = String(req.query.title ?? req.params.id).replace(/[^\w .-]+/g, "").slice(0, 80) || "game";
    reply.header("Content-Type", "application/zip").header("Content-Length", s.size);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${title} save ${found.backup.createdAt.slice(0, 10)}.zip`)}`);
    return reply.send(createReadStream(found.path));
  });

  app.delete<{ Params: { addon: string; id: string; saveId: string } }>("/api/store-games/:addon/:id/saves/:saveId", async (req) => {
    const key = storeKey(req.params.addon, req.params.id);
    const user = requirePerson(req);
    if (ctx.saves.file(user.id, Number(req.params.saveId))?.backup.gameId !== key || !(await ctx.saves.remove(user.id, Number(req.params.saveId)))) throw new HttpProblem(404, "Save not found");
    return { ok: true };
  });
}
