import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GameListing } from "@lootden/shared";
import { HttpProblem, requireAdmin, requirePerson, type AppContext } from "../context.js";

/** Library add-ons: a person's store accounts on their profile, and the games those own. */
export function addonRoutes(app: FastifyInstance, ctx: AppContext) {
  const fail = async <T>(fn: () => Promise<T> | T): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
  };

  app.get("/api/addons", async (req) => ctx.addons.list(requirePerson(req).id));

  /** Connects (or updates) this person's account and syncs it straight away. */
  app.put<{ Params: { id: string }; Body: { config?: Record<string, unknown> } }>("/api/addons/:id/account", async (req) => {
    const user = requirePerson(req);
    const games = await fail(() => ctx.addons.connect(user.id, req.params.id, req.body?.config ?? {}, { allowPrivate: user.role === "admin" }));
    return { games, addons: ctx.addons.list(user.id) };
  });

  app.post<{ Params: { id: string } }>("/api/addons/:id/sync", async (req) => {
    const user = requirePerson(req);
    const games = await fail(() => ctx.addons.sync(user.id, req.params.id, { allowPrivate: user.role === "admin" }));
    return { games, addons: ctx.addons.list(user.id) };
  });

  app.delete<{ Params: { id: string } }>("/api/addons/:id/account", async (req) => {
    const user = requirePerson(req);
    ctx.addons.disconnect(user.id, req.params.id);
    return ctx.addons.list(user.id);
  });

  /** Admins: switch an add-on off (or back on) for everyone. */
  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/addons/:id", async (req) => {
    requireAdmin(req);
    await fail(() => ctx.addons.setEnabled(req.params.id, req.body?.enabled !== false));
    return ctx.addons.list(requirePerson(req).id);
  });

  app.get<{ Querystring: { addon?: string } }>("/api/store-games", async (req) => {
    const user = requirePerson(req);
    return ctx.addons.games(user.id, req.query.addon || undefined);
  });

  // ---- One store game: its page, artwork and a person's changes ----------------------------

  type One = { Params: { addon: string; externalId: string; kind?: string }; Querystring: { title?: string; q?: string } };
  /**
   * The game this request is about. Games found only on the person's PC (no account connected,
   * or a store like Ubisoft Connect) aren't on the server, so the app sends their title along.
   */
  const one = (req: FastifyRequest<One>) => {
    const user = requirePerson(req);
    const { addon, externalId } = req.params;
    if (!/^[a-z0-9-]{1,32}$/.test(addon) || !externalId || externalId.length > 200) throw new HttpProblem(404, "No such game");
    const game = ctx.addons.game(user.id, addon, externalId);
    const title = game?.title ?? String(req.query.title ?? "").trim().slice(0, 200);
    return { user, addon, externalId, game, title };
  };
  const kindOf = (k?: string) => {
    if (k !== "cover" && k !== "background") throw new HttpProblem(404, "Artwork is cover or background");
    return k;
  };

  app.get<{ Querystring: { title?: string } }>("/api/store-games/custom", async (req) => ctx.storeDetails.allCustom(requirePerson(req).id));

  app.get<One>("/api/store-games/:addon/:externalId", async (req) => {
    const g = one(req);
    if (!g.game && !g.title) throw new HttpProblem(404, "No such game");
    return ctx.storeDetails.detail(g.user.id, g.addon, g.externalId, g.game, g.title);
  });

  for (const kind of ["cover", "background"] as const) {
    app.get<One>(`/api/store-games/:addon/:externalId/${kind}`, async (req, reply) => {
      const g = one(req);
      const image = await ctx.storeDetails.image(g.user.id, g.addon, g.externalId, g.title, kind);
      if (!image) throw new HttpProblem(404, `No ${kind}`);
      // Addresses are loaded by the browser itself, so the server never fetches what a person typed in.
      if ("url" in image) return reply.header("Cache-Control", "private, max-age=86400").redirect(image.url);
      reply.header("Content-Type", image.contentType).header("Cache-Control", "private, max-age=604800");
      return reply.send(createReadStream(image.file));
    });
  }

  /** A new title or a different metadata match, for this person only. null puts the original back. */
  app.put<One & { Body: { title?: string | null; match?: { provider: string; providerId: string } | null } }>("/api/store-games/:addon/:externalId", async (req) => {
    const g = one(req);
    await fail(() => ctx.storeDetails.update(g.user.id, g.addon, g.externalId, { title: req.body?.title, match: req.body?.match }));
    return ctx.storeDetails.detail(g.user.id, g.addon, g.externalId, ctx.addons.game(g.user.id, g.addon, g.externalId), g.title);
  });

  /** Games to pick a match from. */
  app.get<One>("/api/store-games/:addon/:externalId/matches", async (req) => {
    const g = one(req);
    const q = String(req.query.q ?? "").trim() || g.title;
    if (!q) return [];
    const found = await fail(() => ctx.metadata.search(q));
    return found.slice(0, 30).map(
      (c): GameListing => ({ provider: c.provider, providerId: c.providerId, name: c.name, releaseDate: null, dateText: c.year ? String(c.year) : null, coverUrl: c.coverUrl, imageUrl: null, platforms: [], genres: [], url: null, libraryId: null }),
    );
  });

  app.get<One>("/api/store-games/:addon/:externalId/artwork/:kind", async (req) => {
    const g = one(req);
    return fail(() => ctx.storeDetails.artworkOptions(g.user.id, g.addon, g.externalId, g.title, kindOf(req.params.kind), req.query.q?.trim() || undefined));
  });

  // Body: an image (Content-Type image/*) to upload, or JSON { url }.
  app.put<One>("/api/store-games/:addon/:externalId/artwork/:kind", async (req) => {
    const g = one(req);
    const kind = kindOf(req.params.kind);
    await fail(async () => {
      if (Buffer.isBuffer(req.body)) await ctx.storeDetails.saveUpload(g.user.id, g.addon, g.externalId, kind, req.body, String(req.headers["content-type"]).split(";")[0]!);
      else ctx.storeDetails.setArtwork(g.user.id, g.addon, g.externalId, kind, String((req.body as { url?: string })?.url ?? "").trim() || null);
    });
    return ctx.storeDetails.detail(g.user.id, g.addon, g.externalId, ctx.addons.game(g.user.id, g.addon, g.externalId), g.title);
  });

  app.delete<One>("/api/store-games/:addon/:externalId/artwork/:kind", async (req) => {
    const g = one(req);
    ctx.storeDetails.setArtwork(g.user.id, g.addon, g.externalId, kindOf(req.params.kind), null);
    return ctx.storeDetails.detail(g.user.id, g.addon, g.externalId, ctx.addons.game(g.user.id, g.addon, g.externalId), g.title);
  });
}
