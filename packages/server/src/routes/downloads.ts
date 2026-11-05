import type { FastifyInstance } from "fastify";
import { downloadLinkKind, downloadLinkTitle } from "@lootden/shared";
import { maskedConnectorSettings, saveConnectorSettings, type ConnectorSettings } from "../connectors/settings.js";
import { HttpProblem, requireAdmin, type AppContext } from "../context.js";

/** Admin-only: searching indexers, sending downloads to clients and importing results. */
export function downloadRoutes(app: FastifyInstance, ctx: AppContext) {
  const dm = ctx.downloads;
  const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw new HttpProblem(400, (err as Error).message);
    }
  };

  app.get("/api/connectors", async (req) => {
    requireAdmin(req);
    return maskedConnectorSettings(dm.settings());
  });

  app.put<{ Body: Partial<ConnectorSettings> }>("/api/connectors", async (req) => {
    requireAdmin(req);
    return wrap(async () => maskedConnectorSettings(saveConnectorSettings(ctx.db, req.body ?? {})));
  });

  app.post<{ Params: { name: string } }>("/api/connectors/:name/test", async (req) => {
    requireAdmin(req);
    if (!["qbittorrent", "transmission", "deluge", "sabnzbd", "prowlarr"].includes(req.params.name)) throw new HttpProblem(404, "Unknown connector");
    return wrap(async () => ({ ok: true, message: await dm.test(req.params.name) }));
  });

  app.get<{ Querystring: { q?: string } }>("/api/downloads/search", async (req) => {
    requireAdmin(req);
    if (!req.query.q?.trim()) throw new HttpProblem(400, "Search for something");
    return wrap(() => dm.search(req.query.q!.trim()));
  });

  app.post<{ Body: { url: string; title: string; protocol: "torrent" | "usenet"; platform?: string | null } }>("/api/downloads", async (req) => {
    const p = requireAdmin(req);
    const b = req.body ?? ({} as never);
    if (!b.url || !b.title || !["torrent", "usenet"].includes(b.protocol)) throw new HttpProblem(400, "url, title and protocol (torrent or usenet) are required");
    if (!/^(magnet:|https?:\/\/)/i.test(b.url)) throw new HttpProblem(400, "Only magnet links and http(s) URLs can be sent");
    return wrap(() => dm.grab(b, p.user?.id ?? null));
  });

  /**
   * One link from anywhere (the desktop app's built-in browser, mostly): magnets and .torrent
   * links go to the torrent client, .nzb links to SABnzbd, everything else to the Download Manager.
   */
  app.post<{ Body: { url?: string; title?: string; kind?: string; platform?: string | null } }>("/api/downloads/link", async (req) => {
    const p = requireAdmin(req);
    const url = String(req.body?.url ?? "").trim();
    const guessed = downloadLinkKind(url);
    // The browser knows a file was a .torrent or .nzb even when its address doesn't say (download.php?id=...).
    const kind = guessed && /^https?:/i.test(url) && (req.body?.kind === "torrent" || req.body?.kind === "usenet") ? req.body.kind : guessed;
    if (!kind) throw new HttpProblem(400, "Only magnet links and http(s) links can be sent to downloads");
    const title = String(req.body?.title ?? "").trim().slice(0, 200) || downloadLinkTitle(url);
    if (kind === "direct") {
      return wrap(async () => {
        const pkg = ctx.direct.add({ links: url, name: req.body?.title?.trim() || null, platform: req.body?.platform }, p.user?.id ?? null);
        return { kind, title: pkg.name, to: "the Download Manager" };
      });
    }
    return wrap(async () => {
      const r = await dm.grab({ url, title, protocol: kind, platform: req.body?.platform }, p.user?.id ?? null);
      return { kind, title: r.name, to: kind === "usenet" ? "SABnzbd" : "the torrent client" };
    });
  });

  // Games already in the downloads folder: list, import with clean-up, or skip.
  app.get("/api/downloads/folder", async (req) => {
    requireAdmin(req);
    return wrap(async () => ({ folder: ctx.downloads.settings().import.folder, items: await dm.folderItems() }));
  });
  app.post<{ Body: { name?: string; platform?: string | null } }>("/api/downloads/folder/import", async (req) => {
    requireAdmin(req);
    if (!req.body?.name) throw new HttpProblem(400, "Which entry?");
    return wrap(async () => ({ target: await dm.importFromFolder(req.body.name!, req.body.platform ?? null) }));
  });
  app.post<{ Body: { name?: string } }>("/api/downloads/folder/skip", async (req) => {
    requireAdmin(req);
    if (!req.body?.name) throw new HttpProblem(400, "Which entry?");
    dm.skipFolderItem(req.body.name);
    return { ok: true };
  });

  app.get("/api/downloads", async (req) => {
    requireAdmin(req);
    void dm.reconcile().catch(() => {});
    return dm.list();
  });

  app.post<{ Params: { id: string }; Body: { action: "pause" | "resume" | "remove"; deleteFiles?: boolean } }>("/api/downloads/:id", async (req) => {
    requireAdmin(req);
    const action = req.body?.action;
    if (!["pause", "resume", "remove"].includes(action)) throw new HttpProblem(400, "action is pause, resume or remove");
    return wrap(async () => {
      await dm.control(Number(req.params.id), action, !!req.body?.deleteFiles);
      return { ok: true };
    });
  });
}
