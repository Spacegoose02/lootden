import { createReadStream, createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { readdir, rename, rm, stat, truncate } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { PC_PLATFORM, safeFolderName, type ControllerSupport, type GameSummary, type PackageKind } from "@lootden/shared";
import type { GameQuery } from "../catalog/library.js";
import { resolveGameFile } from "../catalog/scanner.js";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";

/** Parses a single "bytes=start-end" range. Returns null for absent/unsupported headers, "invalid" when unsatisfiable. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null; // multi-range or other units: fall back to the full file
  const [, s, e] = m;
  let start: number;
  let end: number;
  if (s === "") {
    if (e === "") return "invalid";
    const suffix = Number(e);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** File system errors in words an admin can act on (the container usually runs as 99:100 on Unraid). */
export function writeProblem(err: NodeJS.ErrnoException): string {
  if (err.code === "EROFS") return "The games folder is mounted read-only. Remove :ro (or set it to Read/Write in the Unraid template) so uploads can be saved.";
  if (err.code === "EACCES" || err.code === "EPERM") return `The server isn't allowed to write in the games folder (${err.message}). Give the container's user write access to it.`;
  if (err.code === "ENOSPC") return "The games folder is out of space.";
  return err.message;
}

/** Parts from uploads that were never finished, after a day. */
async function removeStaleParts(gamesDir: string): Promise<void> {
  const cutoff = Date.now() - 24 * 3600_000;
  for (const name of await readdir(gamesDir).catch(() => [] as string[])) {
    if (!/^\.lootden-upload-.+\.part$/.test(name)) continue;
    const file = path.join(gamesDir, name);
    const s = await stat(file).catch(() => null);
    if (s && s.mtimeMs < cutoff) await rm(file, { force: true }).catch(() => {});
  }
}

type ListQuery = {
  search?: string;
  genre?: string;
  controller?: GameQuery["controller"];
  kidSafe?: string;
  missingMetadata?: string;
  platform?: string;
  kind?: GameQuery["kind"];
  sort?: GameQuery["sort"];
  order?: GameQuery["order"];
  limit?: string;
};

export function gameRoutes(app: FastifyInstance, ctx: AppContext) {
  const kidOnly = (req: FastifyRequest) => requireUser(req).kidMode;

  /** Kid profiles cannot see or download games that are not known to be kid-safe. */
  const visibleGame = (req: FastifyRequest, id: string) => {
    const game = ctx.library.get(id);
    if (!game || (kidOnly(req) && game.kidSafe !== true)) throw new HttpProblem(404, "Game not found");
    return game;
  };

  app.get<{ Querystring: ListQuery }>("/api/games", async (req) => {
    const q = req.query;
    return ctx.library.list({
      search: q.search,
      genre: q.genre,
      controller: q.controller,
      kidSafe: kidOnly(req) || q.kidSafe === "true" || q.kidSafe === "1",
      missingMetadata: q.missingMetadata === "true",
      platform: q.platform || undefined,
      kind: q.kind && ["game", "update", "dlc", "addon", "all"].includes(q.kind) ? q.kind : undefined,
      sort: q.sort,
      order: q.order,
      limit: q.limit ? Number(q.limit) : undefined,
    });
  });

  app.get<{ Querystring: { platform?: string } }>("/api/genres", async (req) => ctx.library.genres(kidOnly(req), req.query.platform || undefined));
  app.get("/api/platforms", async (req) => ctx.library.platforms(kidOnly(req)));

  /** Rows for the featured home page. */
  app.get("/api/home", async (req) => {
    const p = requireUser(req);
    const kidSafe = p.kidMode;
    // The home page is the PC shelf; emulated games get one row of their own and the Emulation section.
    const everything = ctx.library.list({ kidSafe });
    const all = everything.filter((g) => g.platform === PC_PLATFORM);
    const sections: Array<{ id: string; title: string; games: GameSummary[] }> = [];
    const add = (id: string, title: string, games: GameSummary[]) => games.length && sections.push({ id, title, games: games.slice(0, 20) });

    if (p.user) {
      const mine = ctx.users.gameStates(p.user.id);
      const byId = new Map(everything.map((g) => [g.id, g]));
      const games = (ids: string[]) => [...new Set(ids)].map((id) => byId.get(id)!).filter(Boolean);
      // Installed on any of this person's devices, last played or installed first. The desktop app
      // narrows it to the games on that PC. Not cut to 20, so the app still finds its own.
      const installed = mine
        .filter((s) => s.installedAt && !s.uninstalledAt)
        .sort((a, b) => (b.lastPlayedAt ?? b.installedAt!).localeCompare(a.lastPlayedAt ?? a.installedAt!));
      const installedGames = games(installed.map((s) => s.gameId));
      if (installedGames.length) sections.push({ id: "installed", title: "Installed", games: installedGames.slice(0, 100) });
      add("continue", "Continue playing", games(mine.filter((s) => s.lastPlayedAt).map((s) => s.gameId)));
    }
    // Disc images and installers wait for an admin to install them once in the app and upload the result.
    if (p.role === "admin") add("setup", "Needs setting up", all.filter((g) => g.needsSetup));
    // Copies that are behind GOG, itch.io or Steam (the daily update check).
    if (p.role === "admin") {
      const behind = new Set(ctx.versions.behind().map((c) => c.gameId));
      add("updates", "Updates available", all.filter((g) => behind.has(g.id)));
    }
    add("recent", "Recently added", ctx.library.list({ kidSafe, platform: PC_PLATFORM, sort: "added", order: "desc", limit: 20 }));
    add("emulation", "New on the Emulation shelf", ctx.library.list({ kidSafe, platform: "emulated", sort: "added", order: "desc", limit: 20 }));
    add("top", "Top rated", all.filter((g) => g.rating != null).sort((a, b) => b.rating! - a.rating!));
    add("controller", "Great with a controller", all.filter((g) => g.controllerSupport === "full"));
    if (!kidSafe) add("kids", "Family friendly", all.filter((g) => g.kidSafe === true));
    for (const { name } of ctx.library.genres(kidSafe, PC_PLATFORM).slice(0, 6)) add(`genre:${name}`, name, all.filter((g) => g.genres.includes(name)));
    const featured = all
      .filter((g) => g.coverUrl)
      .sort(() => Math.random() - 0.5)
      .slice(0, 6)
      .map((g) => {
        const d = ctx.library.get(g.id);
        return { ...g, backgroundUrl: d?.backgroundUrl ?? null, blurb: d?.metadata?.summary?.slice(0, 280) ?? null };
      });
    return { featured, sections };
  });

  app.get<{ Params: { id: string } }>("/api/games/:id", async (req) => visibleGame(req, req.params.id));

  /** Latest update notes from the game's Steam news feed; empty when the game isn't on Steam. */
  app.get<{ Params: { id: string } }>("/api/games/:id/updates", async (req) => {
    const game = visibleGame(req, req.params.id);
    const appId = game.metadata?.steamAppId;
    if (!appId) return { source: null, items: [] };
    try {
      return { source: "Steam", items: await ctx.updates.forSteamApp(appId) };
    } catch (err) {
      return { source: "Steam", items: [], error: (err as Error).message };
    }
  });

  for (const kind of ["cover", "background"] as const) {
    app.get<{ Params: { id: string } }>(`/api/games/:id/${kind}`, async (req, reply) => {
      visibleGame(req, req.params.id);
      const image = await ctx.metadata.imageFile(req.params.id, kind);
      if (!image) throw new HttpProblem(404, `No ${kind}`);
      // URLs carry ?v=<hash of the source>, so a long cache is safe.
      reply.header("Content-Type", image.contentType).header("Cache-Control", "private, max-age=604800");
      return reply.send(createReadStream(image.file));
    });
  }

  app.get<{ Params: { id: string; index: string } }>("/api/games/:id/screenshots/:index", async (req, reply) => {
    visibleGame(req, req.params.id);
    const index = Number(req.params.index);
    const image = Number.isInteger(index) && index >= 0 && index < 50 ? await ctx.metadata.screenshotFile(req.params.id, index) : null;
    if (!image) throw new HttpProblem(404, "No screenshot");
    reply.header("Content-Type", image.contentType).header("Cache-Control", "private, max-age=86400");
    return reply.send(createReadStream(image.file));
  });

  // ---- Admin: custom artwork --------------------------------------------------

  app.get<{ Params: { id: string; kind: string }; Querystring: { q?: string } }>("/api/games/:id/artwork/:kind", async (req) => {
    requireAdmin(req);
    const kind = artworkKind(req.params.kind);
    visibleGame(req, req.params.id);
    try {
      return await ctx.metadata.artworkOptions(req.params.id, kind, req.query.q?.trim() || undefined);
    } catch (err) {
      throw new HttpProblem(502, (err as Error).message);
    }
  });

  // Body: an image (Content-Type image/*) to upload, or JSON { url } to use an image from the web.
  app.put<{ Params: { id: string; kind: string } }>("/api/games/:id/artwork/:kind", async (req) => {
    requireAdmin(req);
    const kind = artworkKind(req.params.kind);
    visibleGame(req, req.params.id);
    try {
      if (Buffer.isBuffer(req.body)) await ctx.metadata.saveUpload(req.params.id, kind, req.body, String(req.headers["content-type"]).split(";")[0]!);
      else ctx.metadata.setOverride(req.params.id, kind, String((req.body as { url?: string })?.url ?? "").trim());
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
    return ctx.library.get(req.params.id);
  });

  app.delete<{ Params: { id: string; kind: string } }>("/api/games/:id/artwork/:kind", async (req) => {
    requireAdmin(req);
    ctx.metadata.setOverride(req.params.id, artworkKind(req.params.kind), null);
    return ctx.library.get(req.params.id);
  });

  /**
   * Admin: replace a disc-image or installer game with the zipped, installed game
   * (application/octet-stream). The original moves to .replaced/ in the games folder.
   * The desktop app sends it in parts (below), so a reverse proxy's upload limit or a dropped
   * connection doesn't fail a many-GB upload; this one-shot form is kept for older apps.
   */
  app.put<{ Params: { id: string }; Querystring: { version?: string } }>("/api/games/:id/prepared", async (req) => {
    requireAdmin(req);
    const game = visibleGame(req, req.params.id);
    if (!req.body || typeof (req.body as Readable).pipe !== "function") throw new HttpProblem(400, "Send the zip as application/octet-stream");
    const temp = path.join(ctx.config.gamesDir, `.lootden-upload-${randomUUID()}.part`);
    try {
      await pipeline(req.body as Readable, createWriteStream(temp));
    } catch (err) {
      await rm(temp, { force: true });
      throw new HttpProblem(400, (err as Error).message);
    }
    return finishPrepared(game.id, game.title, temp, req.query.version);
  });

  const partFile = (upload: string) => {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(upload)) throw new HttpProblem(400, "Bad upload id");
    return path.join(ctx.config.gamesDir, `.lootden-upload-${upload}.part`);
  };

  /** How much of an upload in parts has arrived, so the app can carry on after a dropped connection. */
  app.get<{ Params: { id: string; upload: string } }>("/api/games/:id/prepared/parts/:upload", async (req) => {
    requireAdmin(req);
    visibleGame(req, req.params.id);
    return { size: (await stat(partFile(req.params.upload)).catch(() => null))?.size ?? 0 };
  });

  /** One part of the zip, appended at ?offset= (0 starts the upload over). */
  app.put<{ Params: { id: string; upload: string }; Querystring: { offset?: string } }>("/api/games/:id/prepared/parts/:upload", async (req) => {
    requireAdmin(req);
    visibleGame(req, req.params.id);
    if (!req.body || typeof (req.body as Readable).pipe !== "function") throw new HttpProblem(400, "Send the part as application/octet-stream");
    const file = partFile(req.params.upload);
    const offset = Number(req.query.offset ?? 0);
    if (offset === 0) await removeStaleParts(ctx.config.gamesDir);
    const size = (await stat(file).catch(() => null))?.size ?? 0;
    if (offset !== 0 && offset !== size) {
      (req.body as Readable).resume();
      throw new HttpProblem(409, `The server has ${size} bytes of this upload, not ${offset}`);
    }
    try {
      await pipeline(req.body as Readable, createWriteStream(file, { flags: offset === 0 ? "w" : "a" }));
    } catch (err) {
      // Drop the half-written part so a retry at the same offset lines up again.
      await truncate(file, offset).catch(() => {});
      throw new HttpProblem(400, writeProblem(err as NodeJS.ErrnoException));
    }
    return { size: (await stat(file)).size };
  });

  app.post<{ Params: { id: string; upload: string }; Querystring: { version?: string } }>("/api/games/:id/prepared/parts/:upload/finish", async (req) => {
    requireAdmin(req);
    const game = visibleGame(req, req.params.id);
    const file = partFile(req.params.upload);
    if (!(await stat(file).catch(() => null))) throw new HttpProblem(404, "Nothing was uploaded for this game");
    return finishPrepared(game.id, game.title, file, req.query.version);
  });

  /** Puts an uploaded zip in the games folder and swaps it in for the disc or installer copy. */
  async function finishPrepared(gameId: string, title: string, temp: string, rawVersion?: string) {
    try {
      if ((await stat(temp)).size === 0) throw new HttpProblem(400, "The upload was empty");
      const version = rawVersion?.trim().replace(/^v/i, "");
      const base = safeFolderName(version ? `${title} v${version}` : title);
      // A name that's taken (say, by a zip a failed earlier try left behind) gets a number.
      let name = `${base}.zip`;
      for (let n = 2; await stat(path.join(ctx.config.gamesDir, name)).catch(() => null); n++) name = `${base} (${n}).zip`;
      const target = path.join(ctx.config.gamesDir, name);
      await rename(temp, target);
      try {
        return await ctx.library.replaceGame(gameId, name);
      } catch (err) {
        // Don't leave the zip behind as a second copy of the game.
        await rm(target, { force: true });
        throw new HttpProblem(500, `The upload arrived but the original couldn't be moved to .replaced: ${writeProblem(err as NodeJS.ErrnoException)}`);
      }
    } catch (err) {
      await rm(temp, { force: true });
      if (err instanceof HttpProblem) throw err;
      throw new HttpProblem(400, writeProblem(err as NodeJS.ErrnoException));
    }
  }

  // The trailing /:name form lets in-browser emulators see the file's extension.
  for (const route of ["/api/games/:id/files/:index", "/api/games/:id/files/:index/:name"])
  app.get<{ Params: { id: string; index: string } }>(route, async (req, reply) => {
    const game = visibleGame(req, req.params.id);
    const file = game.files[Number(req.params.index)];
    if (!file) throw new HttpProblem(404, "File not found");

    const fullPath = resolveGameFile(ctx.config.gamesDir, game, file);
    let size: number;
    try {
      size = (await stat(fullPath)).size;
    } catch {
      throw new HttpProblem(404, "File is gone from disk; rescan the library");
    }

    const fileName = file.path.split("/").pop()!;
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);

    const range = parseRange(req.headers.range, size);
    if (range === "invalid") {
      reply.header("Content-Range", `bytes */${size}`);
      return reply.code(416).send();
    }
    if (range) {
      reply.code(206);
      reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
      reply.header("Content-Length", range.end - range.start + 1);
      return reply.send(createReadStream(fullPath, { start: range.start, end: range.end }));
    }
    reply.header("Content-Length", size);
    return reply.send(createReadStream(fullPath));
  });

  // ---- Admin: overrides and metadata matching ---------------------------------

  app.patch<{ Params: { id: string }; Body: { title?: string | null; kidSafe?: boolean | null; controllerSupport?: ControllerSupport | null } }>(
    "/api/games/:id",
    async (req) => {
      requireAdmin(req);
      if (!ctx.library.get(req.params.id)) throw new HttpProblem(404, "Game not found");
      const b = req.body ?? {};
      if (b.controllerSupport != null && !["full", "partial", "none"].includes(b.controllerSupport)) {
        throw new HttpProblem(400, "controllerSupport is full, partial, none or null");
      }
      ctx.library.setOverrides(req.params.id, { title: b.title, kidSafe: b.kidSafe, controller: b.controllerSupport });
      return ctx.library.get(req.params.id);
    },
  );

  /** Admin: remove a game. Its files go to .deleted/ in the games folder unless ?permanent=true. */
  app.delete<{ Params: { id: string }; Querystring: { permanent?: string } }>("/api/games/:id", async (req) => {
    requireAdmin(req);
    if (!ctx.library.get(req.params.id)) throw new HttpProblem(404, "Game not found");
    try {
      await ctx.library.deleteGame(req.params.id, req.query.permanent === "true");
    } catch (err) {
      throw new HttpProblem(500, `Couldn't delete the game's files: ${writeProblem(err as NodeJS.ErrnoException)}`);
    }
    return { deleted: req.params.id };
  });

  /** What an entry is (game, update, DLC) and which game an update or DLC belongs to. null puts it back to automatic. */
  app.put<{ Params: { id: string }; Body: { kind?: PackageKind | null; baseGameId?: string | null } }>("/api/games/:id/package", async (req) => {
    requireAdmin(req);
    if (!ctx.library.get(req.params.id)) throw new HttpProblem(404, "Game not found");
    const b = req.body ?? {};
    if (b.kind != null && !["game", "update", "dlc"].includes(b.kind)) throw new HttpProblem(400, "kind is game, update, dlc or null");
    try {
      ctx.library.setPackage(req.params.id, { kind: b.kind, baseGameId: b.baseGameId });
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
    return ctx.library.get(req.params.id);
  });

  app.get("/api/metadata/status", async (req) => {
    requireAdmin(req);
    return ctx.metadata.status();
  });

  /**
   * Looks games up. By default only the ones without metadata (force retries those tried lately
   * too). scope looks matched games up again as well: "all", "pc", "emulated" or one system's id.
   */
  app.post<{ Body: { force?: boolean; scope?: string } }>("/api/metadata/refresh", async (req) => {
    requireAdmin(req);
    const scope = req.body?.scope;
    if (!scope) return { queued: ctx.metadata.queueMissing(ctx.library.allScanned(), !!req.body?.force) };
    const games = ctx.library
      .allScanned()
      .filter((g) => g.kind === "game" && (scope === "all" || (scope === "pc" ? g.platform === PC_PLATFORM : scope === "emulated" ? g.platform !== PC_PLATFORM : g.platform === scope)));
    return { queued: ctx.metadata.queueRefresh(games.map((g) => g.id)) };
  });

  /** One game looked up again now (see MetadataService.refresh). */
  app.post<{ Params: { id: string } }>("/api/games/:id/metadata/refresh", async (req) => {
    requireAdmin(req);
    if (!ctx.library.get(req.params.id)) throw new HttpProblem(404, "Game not found");
    try {
      await ctx.metadata.refresh(req.params.id);
    } catch (err) {
      throw new HttpProblem(502, `Couldn't refresh the metadata: ${(err as Error).message}`);
    }
    return ctx.library.get(req.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { q?: string } }>("/api/games/:id/metadata/search", async (req) => {
    requireAdmin(req);
    const game = ctx.library.get(req.params.id);
    if (!game) throw new HttpProblem(404, "Game not found");
    return ctx.metadata.search(req.query.q || game.title, null, game.platform);
  });

  app.put<{ Params: { id: string }; Body: { provider: string; providerId: string } }>("/api/games/:id/metadata", async (req) => {
    requireAdmin(req);
    if (!ctx.library.get(req.params.id)) throw new HttpProblem(404, "Game not found");
    await ctx.metadata.apply(req.params.id, req.body?.provider, String(req.body?.providerId ?? ""));
    return ctx.library.get(req.params.id);
  });

  app.delete<{ Params: { id: string } }>("/api/games/:id/metadata", async (req) => {
    requireAdmin(req);
    ctx.metadata.clear(req.params.id);
    return { ok: true };
  });

  // ---- Library ----------------------------------------------------------------

  app.get("/api/library/stats", async () => ctx.library.stats());

  app.post("/api/library/rescan", async (req) => {
    requireAdmin(req);
    await ctx.library.rescan();
    return ctx.library.stats();
  });
}

function artworkKind(k: string): "cover" | "background" {
  if (k !== "cover" && k !== "background") throw new HttpProblem(404, "Artwork is cover or background");
  return k;
}
