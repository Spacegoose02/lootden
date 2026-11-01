import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { isTruckGame, type TruckGame } from "@lootden/shared";
import { HttpProblem, requirePerson, requireUser, type AppContext } from "../context.js";

/** Truck game mods (ATS, ETS2) shared between PCs: list, add, fetch, rename and delete. */
export function truckModRoutes(app: FastifyInstance, ctx: AppContext) {
  const viewer = (req: FastifyRequest) => {
    const p = requireUser(req);
    if (p.user?.kidMode) throw new HttpProblem(403, "Not available on kid profiles");
    return { id: p.user?.id ?? 0, admin: p.role === "admin" };
  };
  const gameOf = (input: unknown): TruckGame => {
    if (!isTruckGame(input)) throw new HttpProblem(400, "Pick ats or ets2");
    return input;
  };
  const id = (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new HttpProblem(404, "Mod not found");
    return n;
  };

  app.get<{ Querystring: { game?: string } }>("/api/truck-mods", async (req) => ctx.truckMods.list(gameOf(req.query.game), viewer(req)));

  // Body: the mod file as downloaded (application/octet-stream). ?name= is its file name.
  app.post<{ Querystring: { game?: string; name?: string; title?: string; source?: string; version?: string; compat?: string } }>("/api/truck-mods", async (req) => {
    const v = viewer(req);
    requirePerson(req);
    const game = gameOf(req.query.game);
    if (!req.body || typeof (req.body as Readable).pipe !== "function") throw new HttpProblem(400, "Send the mod as application/octet-stream");
    try {
      return await ctx.truckMods.add(game, {
          fileName: String(req.query.name ?? ""),
          title: req.query.title,
          sourceUrl: req.query.source,
          modVersion: req.query.version,
          compatibleVersions: String(req.query.compat ?? "").split(",").filter(Boolean),
        }, req.body as Readable, v);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  });

  app.get<{ Params: { id: string } }>("/api/truck-mods/:id/file", async (req, reply) => {
    viewer(req);
    const found = ctx.truckMods.file(id(req.params.id));
    if (!found) throw new HttpProblem(404, "Mod not found");
    const s = await stat(found.path).catch(() => null);
    if (!s) throw new HttpProblem(404, "The mod's file is gone from the server");
    reply.header("Content-Type", "application/octet-stream").header("Content-Length", s.size);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(found.mod.fileName)}`);
    return reply.send(createReadStream(found.path));
  });

  app.patch<{ Params: { id: string }; Body: { title?: string } }>("/api/truck-mods/:id", async (req) => {
    const v = viewer(req);
    let mod;
    try {
      mod = ctx.truckMods.rename(id(req.params.id), String(req.body?.title ?? ""), v);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
    if (!mod) throw new HttpProblem(404, "Mod not found, or someone else added it");
    return mod;
  });

  app.delete<{ Params: { id: string } }>("/api/truck-mods/:id", async (req) => {
    if (!(await ctx.truckMods.remove(id(req.params.id), viewer(req)))) throw new HttpProblem(404, "Mod not found, or someone else added it");
    return { ok: true };
  });
}
