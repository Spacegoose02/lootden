import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { ROBLOX_ADDON, type GameListing } from "@lootden/shared";
import { HttpProblem, requireAdmin, requirePerson, type AppContext } from "../context.js";
import { STEAM_CALLBACK } from "../addons/steam-signin.js";

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

  /** Admins: values everyone's account uses when their own is empty (a Steam Web API key). */
  app.put<{ Params: { id: string }; Body: { config?: Record<string, unknown> } }>("/api/addons/:id/shared", async (req) => {
    requireAdmin(req);
    await fail(() => ctx.addons.setShared(req.params.id, req.body?.config ?? {}));
    return ctx.addons.list(requirePerson(req).id);
  });

  // ---- Sign in with Steam ----------------------------------------------------------------------

  /** The server's own address, for Steam to send people back to. */
  const base = (req: FastifyRequest) => ctx.config.publicUrl || `${req.protocol}://${req.headers.host ?? "localhost"}`;

  /** Where to send the person to sign in on Steam. The page opens it (the desktop app in the system browser). */
  app.post("/api/addons/steam/signin", async (req) => {
    const user = requirePerson(req);
    if (!ctx.addons.enabled("steam")) throw new HttpProblem(400, "Steam is switched off on this server");
    return { url: ctx.steamSignIn.start(user.id, base(req)) };
  });

  /**
   * Steam sends the browser back here. It may be the system browser with nobody signed in (the
   * desktop app), so the person comes from the sign-in's one-time state, not a cookie.
   */
  app.get<{ Querystring: Record<string, string> }>(STEAM_CALLBACK, async (req, reply) => {
    let message: string;
    let ok = false;
    try {
      const { userId, steamId } = await ctx.steamSignIn.finish(req.query);
      const user = ctx.users.byId(userId);
      if (!user) throw new Error("That LootDen account is gone");
      const games = await ctx.addons.saveFields(userId, "steam", { steamId }, { allowPrivate: user.role === "admin" });
      ok = true;
      message = games === null ? "Steam account linked. Add a Steam Web API key on your profile (or ask your admin to set one for everyone) to see your games." : `Steam account linked: ${games} games.`;
    } catch (err) {
      message = (err as Error).message;
    }
    // Signed in here too (a browser, not the desktop app's hand-off): straight back to the profile.
    if (req.principal?.user) return reply.redirect(`/profile?${ok ? "steam" : "steamError"}=${encodeURIComponent(message)}`);
    return reply.type("text/html").send(donePage(ok, message));
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
  /** Roblox games' pages come from Roblox and an admin's pick: nothing to rematch or restyle per person. */
  const editable = (req: FastifyRequest<One>) => {
    const g = one(req);
    if (g.addon === ROBLOX_ADDON) throw new HttpProblem(400, "Roblox games' details come from Roblox. An admin can refresh them in Settings, Roblox.");
    return g;
  };
  const kindOf = (k?: string) => {
    if (k !== "cover" && k !== "background") throw new HttpProblem(404, "Artwork is cover or background");
    return k;
  };

  app.get<{ Querystring: { title?: string } }>("/api/store-games/custom", async (req) => ctx.storeDetails.allCustom(requirePerson(req).id));

  app.get<One>("/api/store-games/:addon/:externalId", async (req) => {
    const g = one(req);
    if (g.addon === ROBLOX_ADDON) {
      const page = ctx.roblox.detail(g.user.id, g.externalId);
      if (!page) throw new HttpProblem(404, "No such game");
      return page;
    }
    if (!g.game && !g.title) throw new HttpProblem(404, "No such game");
    return ctx.storeDetails.detail(g.user.id, g.addon, g.externalId, g.game, g.title);
  });

  for (const kind of ["cover", "background"] as const) {
    app.get<One>(`/api/store-games/:addon/:externalId/${kind}`, async (req, reply) => {
      const g = one(req);
      if (g.addon === ROBLOX_ADDON) {
        // Roblox has square icons and wide screenshots: the cover is a poster made from both.
        if (kind === "cover") {
          const svg = await ctx.roblox.poster(g.user.id, g.externalId);
          if (!svg) throw new HttpProblem(404, "No cover");
          return reply.type("image/svg+xml").header("Cache-Control", "private, max-age=604800").header("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'").send(svg);
        }
        const url = ctx.roblox.screenshot(g.user.id, g.externalId);
        if (!url) throw new HttpProblem(404, `No ${kind}`);
        return reply.header("Cache-Control", "private, max-age=86400").redirect(url);
      }
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
    const g = editable(req);
    await fail(() => ctx.storeDetails.update(g.user.id, g.addon, g.externalId, { title: req.body?.title, match: req.body?.match }));
    return ctx.storeDetails.detail(g.user.id, g.addon, g.externalId, ctx.addons.game(g.user.id, g.addon, g.externalId), g.title);
  });

  /** Looks the game's match and details up again, for a wrong or out-of-date page. */
  app.post<One>("/api/store-games/:addon/:externalId/refresh", async (req) => {
    const g = editable(req);
    if (!g.game && !g.title) throw new HttpProblem(404, "No such game");
    await fail(() => ctx.storeDetails.refresh(g.user.id, g.addon, g.externalId, g.title));
    return ctx.storeDetails.detail(g.user.id, g.addon, g.externalId, g.game, g.title);
  });

  /** Games to pick a match from. */
  app.get<One>("/api/store-games/:addon/:externalId/matches", async (req) => {
    const g = editable(req);
    const q = String(req.query.q ?? "").trim() || g.title;
    if (!q) return [];
    const found = await fail(() => ctx.metadata.search(q));
    return found.slice(0, 30).map(
      (c): GameListing => ({ provider: c.provider, providerId: c.providerId, name: c.name, releaseDate: null, dateText: c.year ? String(c.year) : null, coverUrl: c.coverUrl, imageUrl: null, platforms: [], genres: [], url: null, libraryId: null }),
    );
  });

  app.get<One>("/api/store-games/:addon/:externalId/artwork/:kind", async (req) => {
    const g = editable(req);
    return fail(() => ctx.storeDetails.artworkOptions(g.user.id, g.addon, g.externalId, g.title, kindOf(req.params.kind), req.query.q?.trim() || undefined));
  });

  // Body: an image (Content-Type image/*) to upload, or JSON { url }.
  app.put<One>("/api/store-games/:addon/:externalId/artwork/:kind", async (req) => {
    const g = editable(req);
    const kind = kindOf(req.params.kind);
    await fail(async () => {
      if (Buffer.isBuffer(req.body)) await ctx.storeDetails.saveUpload(g.user.id, g.addon, g.externalId, kind, req.body, String(req.headers["content-type"]).split(";")[0]!);
      else ctx.storeDetails.setArtwork(g.user.id, g.addon, g.externalId, kind, String((req.body as { url?: string })?.url ?? "").trim() || null);
    });
    return ctx.storeDetails.detail(g.user.id, g.addon, g.externalId, ctx.addons.game(g.user.id, g.addon, g.externalId), g.title);
  });

  app.delete<One>("/api/store-games/:addon/:externalId/artwork/:kind", async (req) => {
    const g = editable(req);
    ctx.storeDetails.setArtwork(g.user.id, g.addon, g.externalId, kindOf(req.params.kind), null);
    return ctx.storeDetails.detail(g.user.id, g.addon, g.externalId, ctx.addons.game(g.user.id, g.addon, g.externalId), g.title);
  });
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Shown in the system browser when the desktop app's Steam sign-in finishes there. */
function donePage(ok: boolean, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${ok ? "Steam linked" : "Steam sign-in failed"}</title>
<style>body{font-family:system-ui,sans-serif;background:#0d0820;color:#f3eeff;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:1rem}</style></head>
<body><main><h1>${ok ? "Steam linked" : "Steam sign-in failed"}</h1><p>${escape(message)}</p><p>You can close this tab and go back to LootDen.</p></main></body></html>`;
}
