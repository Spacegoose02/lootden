import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Readable } from "node:stream";
import { HttpProblem, requirePerson, requireUser, type AppContext } from "../context.js";

/** The household's Stardew Valley mod set: list, add, fetch, switch on or off, rename, delete, and PC reports. */
export function stardewModRoutes(app: FastifyInstance, ctx: AppContext) {
  const viewer = (req: FastifyRequest) => {
    const p = requireUser(req);
    if (p.user?.kidMode) throw new HttpProblem(403, "Not available on kid profiles");
    return { id: p.user?.id ?? 0, admin: p.role === "admin" };
  };
  const id = (raw: string) => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new HttpProblem(404, "Mod not found");
    return n;
  };
  const problem = (err: unknown, fallback = 400) => new HttpProblem((err as { status?: number }).status ?? fallback, (err as Error).message);

  app.get("/api/stardew-mods", async (req) => ctx.stardewMods.set(viewer(req)));

  // Body: the mod's zip as downloaded (application/octet-stream). ?name= is its file name.
  app.post<{ Querystring: { name?: string; title?: string; source?: string } }>("/api/stardew-mods", async (req) => {
    const v = viewer(req);
    requirePerson(req);
    if (!req.body || typeof (req.body as Readable).pipe !== "function") throw new HttpProblem(400, "Send the mod as application/octet-stream");
    try {
      return await ctx.stardewMods.add({ fileName: String(req.query.name ?? ""), title: req.query.title, sourceUrl: req.query.source }, req.body as Readable, v);
    } catch (err) {
      throw problem(err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/stardew-mods/:id/file", async (req, reply) => {
    viewer(req);
    const found = ctx.stardewMods.file(id(req.params.id));
    if (!found) throw new HttpProblem(404, "Mod not found");
    const s = await stat(found.path).catch(() => null);
    if (!s) throw new HttpProblem(404, "The mod's file is gone from the server");
    reply.header("Content-Type", "application/zip").header("Content-Length", s.size);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(found.mod.fileName)}`);
    return reply.send(createReadStream(found.path));
  });

  app.patch<{ Params: { id: string }; Body: { title?: string; enabled?: boolean } }>("/api/stardew-mods/:id", async (req) => {
    const v = viewer(req);
    try {
      return ctx.stardewMods.update(id(req.params.id), { title: req.body?.title, enabled: req.body?.enabled }, v);
    } catch (err) {
      throw problem(err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/stardew-mods/:id", async (req) => {
    if (!(await ctx.stardewMods.remove(id(req.params.id), viewer(req)))) throw new HttpProblem(404, "Mod not found, or someone else added it");
    return { ok: true };
  });

  /** A PC's Mods folder after a sync or a look: { device, mods: [{ uniqueId, name, version }] }. */
  app.put<{ Body: { device?: string; mods?: unknown } }>("/api/stardew-mods/report", async (req) => {
    const v = viewer(req);
    try {
      ctx.stardewMods.report(String(req.body?.device ?? ""), v.id || null, req.body?.mods);
    } catch (err) {
      throw problem(err);
    }
    return { ok: true };
  });

  app.delete<{ Params: { device: string } }>("/api/stardew-mods/pcs/:device", async (req) => {
    if (!viewer(req).admin) throw new HttpProblem(403, "Only an admin can forget a PC");
    if (!ctx.stardewMods.forget(req.params.device)) throw new HttpProblem(404, "That PC isn't listed");
    return { ok: true };
  });
}
