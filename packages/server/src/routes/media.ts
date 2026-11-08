import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GameInfo, GameManual } from "@lootden/shared";
import { resolveGameFile } from "../catalog/scanner.js";
import { HttpProblem, requireAdmin, requireUser, type AppContext } from "../context.js";
import { gameInfo } from "../metadata/details.js";

/** PDFs in a game's own files that are its manual (or a guide or reference card). */
const MANUAL_FILE = /\.pdf$/i;
const MAX_MANUAL = 64 * 1024 * 1024;
const PREVIEW_TTL = 24 * 60 * 60 * 1000;

type Trailer = GameInfo["trailer"];

/**
 * Manuals and video previews for library games: the PDFs that came with a game (or one an admin
 * uploaded), and a trailer to play on hover and in attract mode, from Steam, IGDB or RAWG.
 */
export function mediaRoutes(app: FastifyInstance, ctx: AppContext) {
  const manualDir = path.join(ctx.config.dataDir, "manuals");
  const uploaded = (id: string) => path.join(manualDir, `${id.replace(/[^\w-]/g, "_")}.pdf`);
  const previews = new Map<string, { at: number; trailer: Trailer }>();

  const visibleGame = (req: FastifyRequest, id: string) => {
    const game = ctx.library.get(id);
    if (!game || (requireUser(req).kidMode && game.kidSafe !== true)) throw new HttpProblem(404, "Game not found");
    return game;
  };

  const exists = async (file: string) => {
    try {
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  };

  app.get<{ Params: { id: string } }>("/api/games/:id/manuals", async (req): Promise<GameManual[]> => {
    const game = visibleGame(req, req.params.id);
    const out: GameManual[] = [];
    if (await exists(uploaded(game.id))) out.push({ name: "Manual", url: `/api/games/${encodeURIComponent(game.id)}/manual`, uploaded: true });
    for (const f of game.files) {
      if (!MANUAL_FILE.test(f.path) || f.archive) continue;
      const name = f.path.split("/").pop()!;
      out.push({ name: name.replace(/\.pdf$/i, ""), url: `/api/games/${encodeURIComponent(game.id)}/manuals/${f.index}/${encodeURIComponent(name)}`, uploaded: false });
    }
    return out;
  });

  const sendPdf = async (reply: import("fastify").FastifyReply, file: string, name: string) => {
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      throw new HttpProblem(404, "No manual");
    }
    // Inline, so the browser's PDF viewer opens it in the page.
    reply.header("Content-Type", "application/pdf").header("Content-Length", size).header("Cache-Control", "private, max-age=3600");
    reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    return reply.send(createReadStream(file));
  };

  app.get<{ Params: { id: string } }>("/api/games/:id/manual", async (req, reply) => {
    const game = visibleGame(req, req.params.id);
    return sendPdf(reply, uploaded(game.id), `${game.title} manual.pdf`);
  });

  app.get<{ Params: { id: string; index: string; name: string } }>("/api/games/:id/manuals/:index/:name", async (req, reply) => {
    const game = visibleGame(req, req.params.id);
    const file = game.files[Number(req.params.index)];
    if (!file || !MANUAL_FILE.test(file.path) || file.archive) throw new HttpProblem(404, "No manual");
    return sendPdf(reply, resolveGameFile(ctx.config.gamesDir, game, file), file.path.split("/").pop()!);
  });

  /** Admin: upload a manual (application/pdf) for a game, e.g. a scanned one for an emulated game. */
  app.put<{ Params: { id: string } }>("/api/games/:id/manual", async (req) => {
    requireAdmin(req);
    const game = ctx.library.get(req.params.id);
    if (!game) throw new HttpProblem(404, "Game not found");
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpProblem(400, "Send the PDF as application/pdf");
    if (body.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpProblem(400, "That isn't a PDF");
    await mkdir(manualDir, { recursive: true });
    await writeFile(uploaded(game.id), body);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/games/:id/manual", async (req) => {
    requireAdmin(req);
    await rm(uploaded(req.params.id), { force: true });
    return { ok: true };
  });

  /**
   * A trailer to preview: Steam's first (a video file that plays muted on hover), else the
   * IGDB or RAWG match's. Remembered for a day, failures included, so a library of hovers
   * doesn't hammer the stores.
   */
  app.get<{ Params: { id: string } }>("/api/games/:id/preview", async (req) => {
    const game = visibleGame(req, req.params.id);
    const hit = previews.get(game.id);
    if (hit && Date.now() - hit.at < PREVIEW_TTL) return { trailer: hit.trailer };
    const m = game.metadata;
    const tries: Array<[string, string]> = [];
    if (m?.steamAppId) tries.push(["steam", m.steamAppId]);
    if (m && (m.provider === "igdb" || m.provider === "rawg")) tries.push([m.provider, m.providerId]);
    let trailer: Trailer = null;
    for (const [provider, id] of tries) {
      try {
        trailer = (await gameInfo(ctx.metadata, provider, id))?.trailer ?? null;
      } catch {
        trailer = null;
      }
      if (trailer) break;
    }
    previews.set(game.id, { at: Date.now(), trailer });
    if (previews.size > 2000) previews.delete(previews.keys().next().value!);
    return { trailer };
  });
}

export { MAX_MANUAL };
