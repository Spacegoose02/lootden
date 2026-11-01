import { createReadStream } from "node:fs";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { MarksPatch } from "@lootden/shared";
import { HttpProblem, requireAdmin, requirePerson, requireUser, type AppContext } from "../context.js";
import { cleanGameKey } from "../users/marks.js";

const fail = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (err) {
    throw new HttpProblem(400, (err as Error).message);
  }
};

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Favourites, hidden games, tags, custom fields and bulk edits; exporting the library; database backups. */
export function organizeRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---- Marks: favourite, hidden, tags, custom fields ------------------------------------

  app.get("/api/me/marks", async (req) => Object.fromEntries(ctx.marks.all(requirePerson(req).id)));
  app.get("/api/me/tags", async (req) => ctx.marks.vocabulary(requirePerson(req).id));
  app.patch<{ Params: { key: string }; Body: MarksPatch }>("/api/me/marks/:key", async (req) => {
    const me = requirePerson(req);
    const key = fail(() => cleanGameKey(req.params.key));
    return fail(() => ctx.marks.set(me.id, key, req.body ?? {}));
  });
  /** Bulk edit: the same change to many games (up to 2000). */
  app.post<{ Body: { keys?: unknown; patch?: MarksPatch; status?: string | null; shelfId?: number } }>("/api/me/marks/bulk", async (req) => {
    const p = requireUser(req);
    const me = requirePerson(req);
    const keys = fail(() => (Array.isArray(req.body?.keys) ? req.body.keys : []).slice(0, 2000).map(cleanGameKey));
    if (!keys.length) throw new HttpProblem(400, "Pick some games first");
    const patch = req.body?.patch ?? {};
    if (Object.keys(patch).length) fail(() => ctx.marks.bulk(me.id, keys, patch));
    // A backlog status and a shelf can come along in the same edit.
    if (req.body?.status !== undefined) for (const k of keys) fail(() => ctx.journal.set(me.id, k, { status: req.body!.status }));
    if (typeof req.body?.shelfId === "number") {
      for (const k of keys.filter((x) => !x.startsWith("store:"))) fail(() => ctx.shelves.addGame(req.body!.shelfId!, me.id, p.role === "admin", k));
    }
    return { changed: keys.length };
  });

  // ---- Exporting this person's library --------------------------------------------------

  const rows = (userId: number, kidMode: boolean) => {
    const marks = ctx.marks.all(userId);
    const statuses = new Map(ctx.journal.statuses(userId).map((s) => [s.gameId, s]));
    const played = new Map<string, { seconds: number; last: string | null }>();
    for (const s of ctx.users.gameStates(userId)) {
      const cur = played.get(s.gameId) ?? { seconds: 0, last: null };
      played.set(s.gameId, { seconds: cur.seconds + (s.playtimeSeconds ?? 0), last: [cur.last, s.lastPlayedAt].filter(Boolean).sort().pop() ?? null });
    }
    const lib = ctx.library.list({ kidSafe: kidMode }).map((g) => {
      const m = marks.get(g.id);
      const j = statuses.get(g.id);
      return {
        title: g.title,
        source: "LootDen",
        platform: g.platform,
        status: j?.status ?? null,
        rating: j?.rating ?? null,
        playtimeHours: Math.round(((played.get(g.id)?.seconds ?? 0) / 3600) * 10) / 10,
        lastPlayed: played.get(g.id)?.last ?? null,
        favourite: !!m?.favourite,
        hidden: !!m?.hidden,
        tags: m?.tags ?? [],
        fields: m?.fields ?? {},
        genres: g.genres,
        releaseYear: g.releaseYear,
        sizeBytes: g.sizeBytes,
        id: g.id,
      };
    });
    const store = kidMode
      ? []
      : ctx.addons.games(userId).map((g) => {
          const key = `store:${g.addon}:${g.externalId}`;
          const m = marks.get(key);
          const j = statuses.get(key);
          return {
            title: g.title,
            source: g.store,
            platform: "pc",
            status: j?.status ?? null,
            rating: j?.rating ?? null,
            playtimeHours: Math.round(((g.playtimeSeconds ?? 0) / 3600) * 10) / 10,
            lastPlayed: g.lastPlayedAt,
            favourite: !!m?.favourite,
            hidden: !!m?.hidden,
            tags: m?.tags ?? [],
            fields: m?.fields ?? {},
            genres: [] as string[],
            releaseYear: null as number | null,
            sizeBytes: null as number | null,
            id: key,
          };
        });
    return [...lib, ...store];
  };

  app.get("/api/me/export/library.json", async (req, reply) => {
    const p = requireUser(req);
    const me = requirePerson(req);
    return reply
      .header("content-disposition", `attachment; filename="lootden-library-${me.username}.json"`)
      .type("application/json")
      .send(JSON.stringify({ exportedAt: new Date().toISOString(), games: rows(me.id, p.kidMode) }, null, 2));
  });

  app.get("/api/me/export/library.csv", async (req, reply) => {
    const p = requireUser(req);
    const me = requirePerson(req);
    const all = rows(me.id, p.kidMode);
    const fieldNames = [...new Set(all.flatMap((r) => Object.keys(r.fields)))].sort();
    const head = ["Title", "Library", "Platform", "Status", "My rating", "Hours played", "Last played", "Favourite", "Hidden", "Tags", "Genres", "Release year", "Size (bytes)", "LootDen id", ...fieldNames];
    const lines = [head, ...all.map((r) => [r.title, r.source, r.platform, r.status, r.rating, r.playtimeHours, r.lastPlayed, r.favourite ? "yes" : "", r.hidden ? "yes" : "", r.tags.join("; "), r.genres.join("; "), r.releaseYear, r.sizeBytes, r.id, ...fieldNames.map((f) => r.fields[f] ?? "")])];
    return reply
      .header("content-disposition", `attachment; filename="lootden-library-${me.username}.csv"`)
      .type("text/csv; charset=utf-8")
      .send("﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n");
  });

  // ---- Database backups (admins) ------------------------------------------------------------

  const backupState = async () => ({ settings: ctx.backups.settings(), backups: await ctx.backups.list(), pendingRestore: ctx.backups.pendingRestore() });
  app.get("/api/backups", async (req) => {
    requireAdmin(req);
    return backupState();
  });
  app.put<{ Body: { daily?: boolean; keep?: number } }>("/api/backups/settings", async (req) => {
    requireAdmin(req);
    ctx.backups.setSettings({ ...(typeof req.body?.daily === "boolean" ? { daily: req.body.daily } : {}), ...(req.body?.keep !== undefined ? { keep: Number(req.body.keep) } : {}) });
    await ctx.backups.prune();
    return backupState();
  });
  app.post("/api/backups", async (req) => {
    requireAdmin(req);
    await ctx.backups.create("manual");
    return backupState();
  });
  app.post("/api/backups/upload", { bodyLimit: 2 * 1024 * 1024 * 1024 }, async (req) => {
    requireAdmin(req);
    if (req.headers["content-type"] !== "application/octet-stream") throw new HttpProblem(415, "Send the backup file as application/octet-stream");
    try {
      await ctx.backups.upload(req.body as Readable);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
    return backupState();
  });
  app.get<{ Params: { name: string } }>("/api/backups/:name", async (req, reply) => {
    requireAdmin(req);
    const file = fail(() => ctx.backups.file(req.params.name));
    return reply.header("content-disposition", `attachment; filename="${req.params.name}"`).type("application/octet-stream").send(createReadStream(file));
  });
  app.delete<{ Params: { name: string } }>("/api/backups/:name", async (req) => {
    requireAdmin(req);
    await fail(() => ctx.backups.file(req.params.name));
    await ctx.backups.remove(req.params.name);
    return backupState();
  });
  /** Restores at the next start: LootDen has to be restarted (its container, on Unraid). */
  app.post<{ Params: { name: string } }>("/api/backups/:name/restore", async (req) => {
    requireAdmin(req);
    try {
      await ctx.backups.stageRestore(req.params.name);
    } catch (err) {
      throw new HttpProblem(400, (err as Error).message);
    }
    return backupState();
  });
  app.delete("/api/backups/restore", async (req) => {
    requireAdmin(req);
    await ctx.backups.cancelRestore();
    return backupState();
  });
}
