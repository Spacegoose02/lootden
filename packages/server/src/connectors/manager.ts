import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { PC_PLATFORM, platformFor } from "@lootden/shared";
import type { Library } from "../catalog/library.js";
import { now, type Db } from "../db/database.js";
import type { FetchLike } from "../metadata/http.js";
import { ProwlarrClient, type SearchResult } from "./prowlarr.js";
import { DelugeClient } from "./deluge.js";
import { QBittorrentClient } from "./qbittorrent.js";
import { resolveTorrent } from "./torrent.js";
import { TransmissionClient } from "./transmission.js";
import { SabnzbdClient } from "./sabnzbd.js";
import { loadConnectorSettings, type ConnectorSettings } from "./settings.js";
import { findInnoextract, findServerSevenZip, tidyDownload, type ImportProgress, type ProgressFn, type TidyOptions } from "./tidy.js";
import type { ActiveDownload, DownloadClient, TorrentClient } from "./types.js";
import { judgeRelease, type Judged } from "./rules.js";

export interface FolderItem {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  settling: boolean;
  status: "new" | "importing" | "imported" | "failed" | "skipped";
  target: string | null;
  error: string | null;
  progress: ImportProgress | null;
}

/** Copies a file or folder, reporting bytes as they go (fs.cp can't say how far it got). */
async function copyTree(source: string, target: string, onBytes: (n: number) => void, top = true): Promise<void> {
  // Inside a download, symlinks (say, one to /data) are skipped, never copied into the library.
  const s = top ? await stat(source) : await lstat(source);
  if (s.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const e of await readdir(source)) await copyTree(path.join(source, e), path.join(target, e), onBytes, false);
  } else if (s.isFile()) {
    const count = new Transform({
      transform(chunk: Buffer, _enc, done) {
        onBytes(chunk.length);
        done(null, chunk);
      },
    });
    await pipeline(createReadStream(source), count, createWriteStream(target, { flags: "wx" }));
    await utimes(target, s.atime, s.mtime);
  }
}

/** Total size and newest change time of a file or folder. */
async function folderSize(p: string, depth = 0): Promise<{ size: number; modified: number }> {
  const s = await stat(p).catch(() => null);
  if (!s) return { size: 0, modified: 0 };
  if (!s.isDirectory() || depth > 32) return { size: s.size, modified: s.mtimeMs };
  let size = 0;
  let modified = s.mtimeMs;
  for (const e of await readdir(p).catch(() => [] as string[])) {
    const r = await folderSize(path.join(p, e), depth + 1);
    size += r.size;
    modified = Math.max(modified, r.modified);
  }
  return { size, modified };
}

export interface DownloadRecord {
  id: number;
  client: ActiveDownload["client"];
  externalId: string | null;
  name: string;
  addedAt: string;
  status: "downloading" | "importing" | "imported" | "failed" | "removed";
  /** While importing: which step and how far. */
  progress?: ImportProgress | null;
  importedPath: string | null;
  importedAt: string | null;
  error: string | null;
  /** Emulated system the download goes to; null for PC games. */
  platform: string | null;
  /** Live numbers from the client when it still has the download. */
  live: ActiveDownload | null;
}

interface Row {
  id: number;
  client: ActiveDownload["client"];
  external_id: string | null;
  name: string;
  added_at: string;
  status: DownloadRecord["status"];
  imported_path: string | null;
  imported_at: string | null;
  error: string | null;
  platform: string | null;
}

/** Maps a client-side path (e.g. /data/torrents/games/X) to this container's view of it. */
export function mapPath(p: string, mappings: ConnectorSettings["import"]["pathMappings"]): string {
  const norm = p.replace(/\\/g, "/");
  const hit = [...mappings].sort((a, b) => b.from.length - a.from.length).find((m) => norm === m.from || norm.startsWith(m.from.replace(/\/$/, "") + "/"));
  return hit ? path.posix.join(hit.to, norm.slice(hit.from.replace(/\/$/, "").length)) : norm;
}

/** Imports from the downloads folder get ids above this; downloads LootDen sent use their own row id. */
const FOLDER_ID_BASE = 1_000_000_000;

/** The same id every time for one folder entry, so a retry finds the staging copy an earlier try left behind. */
export function folderImportId(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(name, "utf8")) h = Math.imul(h ^ ch, 0x01000193) >>> 0;
  return FOLDER_ID_BASE + (h % FOLDER_ID_BASE);
}

/** Node only retries a recursive rm on ENOTEMPTY/EBUSY/EPERM when asked to. */
const RM_RETRY = { recursive: true, force: true, maxRetries: 5, retryDelay: 500 } as const;

/** Has at least one byte of real data (an emptied-out folder left by a half-finished move doesn't). */
async function hasData(p: string): Promise<boolean> {
  return (await folderSize(p)).size > 0;
}

const sanitize = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "") || "download";

/**
 * Sends Prowlarr results to qBittorrent or SABnzbd, follows them, and copies or
 * moves finished downloads into the games folder so they appear in the library.
 */
export class DownloadManager {
  private reconciling: Promise<void> | null = null;
  /** Imports in flight, by download id or "folder:<name>". */
  private readonly progress = new Map<string, ImportProgress>();
  /** Staging folders an import is using right now; anything else named .import-<id> is a leftover. */
  private readonly activeStaging = new Set<string>();
  /** File operations, swappable in tests to act like separate mounts or a busy share. */
  fsOps = { rename, rm };

  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /**
   * Runs on every finished import before it counts as in the library (virus scan, alerts).
   * Returns where the game ended up, or null when it was held back for review.
   */
  afterImport: (target: string, name: string) => Promise<string | null> = async (t) => t;
  /** Told about grabs and failures, for alerts. */
  onEvent: (e: { kind: "grabbed" | "failed"; title: string; message?: string }) => void = () => {};

  settings(): ConnectorSettings {
    return loadConnectorSettings(this.db);
  }

  clients(): DownloadClient[] {
    const s = this.settings();
    return [
      new QBittorrentClient(s.qbittorrent, this.fetchImpl),
      new TransmissionClient(s.transmission, this.fetchImpl),
      new DelugeClient(s.deluge, this.fetchImpl),
      new SabnzbdClient(s.sabnzbd, this.fetchImpl),
    ];
  }

  /** The torrent client chosen in Settings. */
  torrentClient(): TorrentClient {
    const name = this.settings().torrentClient;
    const c = this.clients().find((x) => x.name === name) as TorrentClient | undefined;
    if (!c?.configured) throw new Error(`${name === "qbittorrent" ? "qBittorrent" : name === "transmission" ? "Transmission" : "Deluge"} is not set up; add it under Settings, Download clients`);
    return c;
  }

  client(name: string): DownloadClient {
    const c = this.clients().find((x) => x.name === name);
    if (!c?.configured) throw new Error(`${name} is not set up`);
    return c;
  }

  prowlarr(): ProwlarrClient {
    return new ProwlarrClient(this.settings().prowlarr, this.fetchImpl);
  }

  async test(which: string): Promise<string> {
    return which === "prowlarr" ? this.prowlarr().test() : this.client(which).test();
  }

  /** Prowlarr results, each judged by the release rules; the best allowed one is marked. */
  async search(query: string, wantedTitle?: string): Promise<Array<SearchResult & Judged>> {
    const p = this.prowlarr();
    if (!p.configured) throw new Error("Prowlarr is not set up");
    const rules = this.settings().rules;
    const judged = (await p.search(query)).map((r) => ({ ...r, ...judgeRelease(r, rules, wantedTitle) }));
    const best = judged.filter((r) => r.allowed).sort((a, b) => b.score - a.score)[0];
    return judged.map((r) => ({ ...r, best: r === best }));
  }

  /** Sends a link (magnet, .torrent or .nzb URL) to the matching client and starts tracking it. */
  async grab(input: { url: string; title: string; protocol: "torrent" | "usenet"; platform?: string | null }, userId: number | null): Promise<DownloadRecord> {
    const client = input.protocol === "usenet" ? this.client("sabnzbd") : this.torrentClient();
    const platform = input.platform && input.platform !== PC_PLATFORM ? platformFor(input.platform).id : null;
    const result = this.db
      .prepare("INSERT INTO downloads (client, name, source_url, added_by, added_at, platform) VALUES (?, ?, ?, ?, ?, ?)")
      .run(client.name, input.title, input.url, userId, now(), platform);
    const id = Number(result.lastInsertRowid);
    try {
      // Torrents are fetched here and handed over as a file or magnet, then checked: clients
      // can't always reach Prowlarr's links, and qBittorrent drops those without an error.
      const external = input.protocol === "torrent" ? await (client as TorrentClient).addTorrent(await resolveTorrent(input.url, this.fetchImpl), `gm-${id}`) : await client.add(input.url, input.title);
      this.db.prepare("UPDATE downloads SET external_id = ? WHERE id = ?").run(external, id);
      this.onEvent({ kind: "grabbed", title: input.title });
    } catch (err) {
      this.db.prepare("UPDATE downloads SET status = 'failed', error = ? WHERE id = ?").run((err as Error).message, id);
      this.onEvent({ kind: "failed", title: input.title, message: (err as Error).message });
      throw err;
    }
    return this.get(id)!;
  }

  private rows(): Row[] {
    return this.db.prepare("SELECT * FROM downloads WHERE status != 'removed' ORDER BY id DESC LIMIT 200").all() as unknown as Row[];
  }

  get(id: number): DownloadRecord | undefined {
    const r = this.db.prepare("SELECT * FROM downloads WHERE id = ?").get(id) as Row | undefined;
    return r && this.toRecord(r, null);
  }

  private toRecord(r: Row, live: ActiveDownload | null): DownloadRecord {
    return {
      id: r.id,
      client: r.client,
      externalId: r.external_id,
      name: r.name,
      addedAt: r.added_at,
      status: r.status,
      importedPath: r.imported_path,
      importedAt: r.imported_at,
      error: r.error,
      platform: r.platform ?? null,
      progress: this.progress.get(String(r.id)) ?? null,
      live,
    };
  }

  /** Finds the client's entry for one of our rows: SABnzbd by nzo id, qBittorrent by our tag. */
  private match(r: Row, live: Array<ActiveDownload & { tags?: string }>): ActiveDownload | null {
    if (!r.external_id) return null;
    return (
      live.find((d) => d.client === r.client && (d.id.toLowerCase() === r.external_id!.toLowerCase() || (d.tags ?? "").split(/,\s*/).includes(r.external_id!))) ?? null
    );
  }

  private async liveAll(): Promise<ActiveDownload[]> {
    const out: ActiveDownload[] = [];
    for (const c of this.clients().filter((x) => x.configured)) {
      try {
        out.push(...(await c.list()));
      } catch (err) {
        this.log.warn({ client: c.name, err: (err as Error).message }, "Could not read download client");
      }
    }
    return out;
  }

  /** Our downloads with live progress, plus anything else in the clients' game category. */
  async list(): Promise<{ downloads: DownloadRecord[]; other: ActiveDownload[] }> {
    const live = await this.liveAll();
    const used = new Set<ActiveDownload>();
    const downloads = this.rows().map((r) => {
      const l = this.match(r, live);
      if (l) used.add(l);
      return this.toRecord(r, l);
    });
    return { downloads, other: live.filter((l) => !used.has(l)) };
  }

  async control(id: number, action: "pause" | "resume" | "remove", deleteFiles = false): Promise<void> {
    const r = this.db.prepare("SELECT * FROM downloads WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new Error("No such download");
    const live = this.match(r, await this.liveAll());
    const client = this.client(r.client);
    if (action === "remove") {
      if (live) await client.remove(live.id, deleteFiles);
      this.db.prepare("UPDATE downloads SET status = 'removed' WHERE id = ?").run(id);
      return;
    }
    if (!live) throw new Error("The download client no longer has this download");
    await (action === "pause" ? client.pause(live.id) : client.resume(live.id));
  }

  /** Imports finished downloads. Runs on a timer and after each list in the UI. */
  reconcile(): Promise<void> {
    this.reconciling ??= this.doReconcile().finally(() => (this.reconciling = null));
    return this.reconciling;
  }

  // ---- Games already sitting in the downloads folder ------------------------------

  /** Entries in the downloads folder, with whether each was imported. Newest first. */
  async folderItems(): Promise<FolderItem[]> {
    const dir = this.settings().import.folder;
    if (!dir) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch((err: Error) => {
      throw new Error(`Can't read the downloads folder ${dir}: ${err.message}`);
    });
    const done = new Map(
      (this.db.prepare("SELECT * FROM folder_imports").all() as Array<{ name: string; status: string; target: string | null; error: string | null }>).map((r) => [r.name, r]),
    );
    const items: FolderItem[] = [];
    for (const e of entries) {
      if (e.name.startsWith(".") || /\.(part|!qb|crdownload|tmp)$/i.test(e.name) || /^(_unpack|_failed|incomplete)/i.test(e.name)) continue;
      if (!e.isDirectory() && !e.isFile()) continue;
      const { size, modified } = await folderSize(path.join(dir, e.name));
      const rec = done.get(e.name);
      items.push({
        name: e.name,
        sizeBytes: size,
        modifiedAt: new Date(modified).toISOString(),
        // Still being written if anything in it changed in the last two minutes.
        settling: Date.now() - modified < 120_000,
        status: (rec?.status as FolderItem["status"]) ?? "new",
        target: rec?.target ?? null,
        error: rec?.error ?? null,
        progress: this.progress.get(`folder:${e.name}`) ?? null,
      });
    }
    return items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }

  /** Imports one entry of the downloads folder with the usual clean-up (unpack, strip junk, re-zip). */
  async importFromFolder(name: string, platform: string | null = null): Promise<string> {
    const s = this.settings();
    if (!s.import.folder) throw new Error("Set the downloads folder first");
    if (name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new Error("Bad name");
    const source = path.join(s.import.folder, name);
    const sys = platform && platform !== PC_PLATFORM ? platformFor(platform).id : null;
    // Copy unless the admin chose move: the client may still be seeding it.
    const mode = s.import.mode === "move" ? "move" : "copy";
    if (this.progress.has(`folder:${name}`)) throw new Error(`${name} is already being imported`);
    const id = folderImportId(name);
    const previous = this.db.prepare("SELECT status, at FROM folder_imports WHERE name = ?").get(name) as { status: string; at: string } | undefined;
    // An earlier try that failed after moving the files left them in a staging folder under a random id:
    // give that folder this entry's id, so the import below picks up where it stopped.
    if (previous?.status === "failed") await this.adoptLegacyStaging(source, id, previous.at);
    const record = this.db.prepare(
      "INSERT INTO folder_imports (name, status, target, error, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET status = excluded.status, target = excluded.target, error = excluded.error, at = excluded.at",
    );
    record.run(name, "importing", null, null, now());
    try {
      const imported = await this.importPath(source, mode, name, s.import.tidy, id, sys, `folder:${name}`);
      const target = await this.afterImport(imported, name);
      if (!target) {
        record.run(name, "failed", imported, "Held for review: the virus scan flagged it (see Downloads, Held for review)", now());
        throw new Error("The virus scan flagged this download; it's held for review on the Downloads page");
      }
      record.run(name, "imported", target, null, now());
      this.log.info({ name, target }, "Imported from the downloads folder");
      void this.library.rescan();
      return target;
    } catch (err) {
      record.run(name, "failed", null, (err as Error).message, now());
      throw err;
    }
  }

  /** Leaves an entry alone from now on (not a game, or already in the library). */
  skipFolderItem(name: string): void {
    this.db
      .prepare("INSERT INTO folder_imports (name, status, at) VALUES (?, 'skipped', ?) ON CONFLICT(name) DO UPDATE SET status = 'skipped', at = excluded.at")
      .run(name, now());
  }

  /**
   * Imports new entries of the downloads folder. Entries that belong to a download LootDen
   * sent are left to that download's own import, so a finished game isn't taken twice (and
   * moved out from under the other import).
   */
  private async autoImportFolder(claimed: Set<string>): Promise<void> {
    const s = this.settings();
    if (!s.import.folder || !s.import.autoImportFolder) return;
    for (const item of await this.folderItems().catch(() => [])) {
      if (item.status !== "new" || item.settling || claimed.has(item.name)) continue;
      await this.importFromFolder(item.name).catch((err: Error) => this.log.warn({ name: item.name, err: err.message }, "Folder import failed"));
    }
  }

  /** The downloads-folder entry a finished download lives in, when it's in that folder. */
  private folderEntry(source: string): string | null {
    const dir = this.settings().import.folder;
    if (!dir) return null;
    const rel = path.relative(dir, source);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return rel.split(/[\\/]/)[0] ?? null;
  }

  /**
   * This container's path for a path the download client reported. Uses the path mappings, and when
   * they don't lead anywhere (none set up, or a client that sees the share as /data/games while this
   * container has it at /downloads), looks for the same name in the downloads folder: first the last
   * part of the path, then the last two, and so on.
   */
  private async resolveSource(clientPath: string): Promise<string> {
    const s = this.settings().import;
    const mapped = mapPath(clientPath, s.pathMappings);
    if (!s.folder || (await stat(mapped).catch(() => null))) return mapped;
    const parts = clientPath.replace(/\\/g, "/").split("/").filter(Boolean);
    for (let k = 1; k <= Math.min(parts.length, 4); k++) {
      const candidate = path.join(s.folder, ...parts.slice(-k));
      if (await stat(candidate).catch(() => null)) return candidate;
    }
    // Gone from the downloads folder because an import from there moved it and then failed: its
    // files wait in that import's staging folder, which the downloads-folder import picks up again.
    const name = parts.at(-1);
    if (name && (await stat(path.join(this.library.gamesDir, `.import-${folderImportId(name)}`)).catch(() => null))) return path.join(s.folder, name);
    return mapped;
  }

  /** Where an earlier import put this download, when it already happened (from the downloads folder). */
  private alreadyImported(source: string): string | null {
    const entry = this.folderEntry(source) ?? path.basename(source);
    const row = this.db.prepare("SELECT target FROM folder_imports WHERE name = ? AND status = 'imported'").get(entry) as { target: string | null } | undefined;
    return row ? (row.target ?? "") : null;
  }

  private async doReconcile(): Promise<void> {
    const rows = this.rows();
    const pending = rows.filter((r) => r.status === "downloading");
    const live = rows.some((r) => r.status === "downloading" || r.status === "importing") ? await this.liveAll() : [];
    const settings = this.settings();
    // Folder entries that belong to our own downloads; the folder auto-import leaves them alone.
    const claimed = new Set<string>();
    const sources = new Map<number, string>();
    for (const r of rows) {
      const l = r.status === "downloading" ? this.match(r, live) : null;
      if (!l?.path) continue;
      const source = await this.resolveSource(l.path);
      sources.set(r.id, source);
      const entry = this.folderEntry(source);
      if (entry) claimed.add(entry);
    }
    await this.autoImportFolder(claimed);
    if (!pending.length) return;
    let imported = false;
    for (const r of pending) {
      const l = this.match(r, live);
      if (!l) continue;
      const source = sources.get(r.id) ?? null;
      // Moved into the library already (by hand from the downloads folder, or a run before this
      // one): the client now reports the files missing, which isn't a failure.
      const earlier = source ? this.alreadyImported(source) : null;
      if (earlier !== null && !(await stat(source!).catch(() => null))) {
        this.db.prepare("UPDATE downloads SET status = 'imported', imported_path = ?, imported_at = ?, error = NULL WHERE id = ?").run(earlier || null, now(), r.id);
        continue;
      }
      if (l.state === "failed") {
        this.db.prepare("UPDATE downloads SET status = 'failed', error = ? WHERE id = ?").run("The download client reported a failure", r.id);
        continue;
      }
      const finished = l.progress >= 1 && (l.state === "completed" || l.state === "seeding");
      if (!finished || settings.import.mode === "off" || !source) continue;
      try {
        this.db.prepare("UPDATE downloads SET status = 'importing' WHERE id = ?").run(r.id);
        // Sitting right in the downloads folder: import it the way that list does, so an earlier
        // try from there (or its leftover staging copy) is picked up instead of started over.
        const own = this.folderEntry(source);
        if (own && path.join(settings.import.folder, own) === path.normalize(source)) {
          const target = await this.importFromFolder(own, r.platform);
          this.db.prepare("UPDATE downloads SET status = 'imported', imported_path = ?, imported_at = ?, error = NULL WHERE id = ?").run(target, now(), r.id);
          this.log.info({ name: r.name, target }, "Imported download into the library");
          if (settings.import.mode === "move")
            await this.client(r.client)
              .remove(l.id, true)
              .catch((err: Error) => this.log.warn({ name: r.name, err: err.message }, "Couldn't remove the imported download from its client"));
          continue;
        }
        const placed = await this.importPath(source, settings.import.mode, r.name, settings.import.tidy, r.id, r.platform, String(r.id));
        const target = await this.afterImport(placed, r.name);
        if (!target) {
          this.db.prepare("UPDATE downloads SET status = 'failed', error = ? WHERE id = ?").run("Held for review: the virus scan flagged it", r.id);
          continue;
        }
        this.db.prepare("UPDATE downloads SET status = 'imported', imported_path = ?, imported_at = ?, error = NULL WHERE id = ?").run(target, now(), r.id);
        // The downloads folder list shows it as imported too, instead of offering it again.
        const entry = this.folderEntry(source);
        if (entry)
          this.db
            .prepare("INSERT INTO folder_imports (name, status, target, error, at) VALUES (?, 'imported', ?, NULL, ?) ON CONFLICT(name) DO UPDATE SET status = 'imported', target = excluded.target, error = NULL, at = excluded.at")
            .run(entry, target, now());
        this.log.info({ name: r.name, target }, "Imported download into the library");
        imported = true;
        // Moved: drop it from the client too, with whatever junk the import left behind.
        if (settings.import.mode === "move")
          await this.client(r.client)
            .remove(l.id, true)
            .catch((err: Error) => this.log.warn({ name: r.name, err: err.message }, "Couldn't remove the imported download from its client"));
      } catch (err) {
        const msg = (err as NodeJS.ErrnoException).code === "EROFS" || (err as NodeJS.ErrnoException).code === "EACCES"
          ? "The games folder is read-only; mount it read-write to import downloads"
          : (err as Error).message;
        this.db.prepare("UPDATE downloads SET status = 'downloading', error = ? WHERE id = ?").run(msg, r.id);
        this.log.warn({ name: r.name, err: msg }, "Import failed");
      }
    }
    if (imported) await this.library.rescan();
  }

  /**
   * Imports something LootDen downloaded itself (the Download Manager) with the usual clean-up
   * and virus scan. Moves it, since nothing is seeding it. Returns where it ended up.
   */
  async importDownloaded(source: string, name: string, platform: string | null, id: number, onProgress: ProgressFn = () => {}): Promise<string> {
    const tidy = this.settings().import.tidy;
    const placed = await this.importWithProgress(source, "move", name, tidy, id, platform, onProgress);
    const target = await this.afterImport(placed, name);
    if (!target) throw new Error("Held for review: the virus scan flagged it (see Downloads, Held for review)");
    await this.library.rescan();
    return target;
  }

  private async importPath(source: string, mode: "copy" | "move", releaseName: string, tidy: TidyOptions, id: number, platform: string | null, key: string): Promise<string> {
    const report: ProgressFn = (p) => this.progress.set(key, p);
    try {
      return await this.importWithProgress(source, mode, releaseName, tidy, id, platform, report);
    } finally {
      this.progress.delete(key);
    }
  }

  private async importWithProgress(source: string, mode: "copy" | "move", releaseName: string, tidy: TidyOptions, id: number, platform: string | null, report: ProgressFn): Promise<string> {
    // Emulated games go to their system's folder as plain files: emulators open ROMs and disc images directly.
    const targetDir = platform ? path.join(this.library.gamesDir, "Emulation", platform) : this.library.gamesDir;
    // Work on a private copy in the games folder (hidden from scans), so seeding torrents stay intact.
    const staging = path.join(this.library.gamesDir, `.import-${id}`);
    // A move that got as far as staging before failing has the only full copy there; the source may be
    // an emptied-out folder by now. Carry on from staging instead of throwing it away.
    const resume = (await stat(staging).catch(() => null))?.isDirectory() === true && !(await hasData(source));
    const s = await stat(source).catch(() => null);
    if (!s && !resume) {
      const folder = this.settings().import.folder;
      throw new Error(`Finished download not found at ${source}${folder ? ` or in the downloads folder (${folder})` : ""}; check the path mappings`);
    }
    if (platform) {
      await mkdir(targetDir, { recursive: true });
      tidy = { ...tidy, repack: "folder" };
    }
    const tidyOn = tidy.stripJunk || tidy.extract || tidy.repack === "zip";
    // A lone ROM or disc image needs no tidying; it sits next to the system's other games.
    if (!resume && (!tidyOn || (platform && s!.isFile() && !/\.(zip|7z|rar)$/i.test(source)))) return this.place(source, path.join(targetDir, sanitize(path.basename(source))), mode, report);

    this.activeStaging.add(staging);
    try {
      if (resume) {
        this.log.info({ name: releaseName, staging }, "Resuming an import from the copy an earlier try left in the games folder");
        // Whatever an earlier try couldn't delete from the downloads folder goes now.
        if (s) await this.removeSource(source);
      } else {
        await this.fsOps.rm(staging, RM_RETRY);
        if (s!.isDirectory()) await this.place(source, staging, mode, report);
        else {
          await mkdir(staging, { recursive: true });
          await this.place(source, path.join(staging, path.basename(source)), mode, report);
        }
      }
      try {
        const tidied = await tidyDownload(staging, releaseName || path.basename(source), targetDir, tidy, await findServerSevenZip(), report, platform ? null : await findInnoextract());
        this.log.info({ name: releaseName, removed: tidied.removed, extracted: tidied.extracted, warnings: tidied.warnings }, "Tidied download");
        return tidied.target;
      } catch (err) {
        await this.fsOps.rm(`${staging}.installed`, RM_RETRY).catch(() => {});
        // Copied: the original is still in the downloads folder, so the staging copy can go. Moved: staging
        // holds the only copy of the game, so it stays, and the next try picks it up from there.
        if (mode === "copy") await this.fsOps.rm(staging, RM_RETRY).catch(() => {});
        else this.log.warn({ name: releaseName, staging }, "Import failed after moving; the files are kept in the games folder for the next try");
        throw err;
      }
    } finally {
      this.activeStaging.delete(staging);
    }
  }

  /** Moves or copies one file or folder to target, through a temporary name so half-copied games never show up. */
  private async place(source: string, target: string, mode: "copy" | "move", report: ProgressFn = () => {}): Promise<string> {
    if (await stat(target).catch(() => null)) throw new Error(`${path.basename(target)} already exists in the games folder`);
    if (mode === "move") {
      try {
        await this.fsOps.rename(source, target);
        return target;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      }
    }
    const temp = `${target}.importing`;
    await this.fsOps.rm(temp, RM_RETRY);
    const { size } = await folderSize(source);
    let copied = 0;
    report({ stage: "copying", percent: 0 });
    try {
      await copyTree(source, temp, (n) => {
        copied += n;
        report({ stage: "copying", percent: size ? Math.min(100, Math.floor((copied / size) * 100)) : null });
      });
    } catch (err) {
      await this.fsOps.rm(temp, RM_RETRY).catch(() => {});
      throw err;
    }
    await this.fsOps.rename(temp, target);
    if (mode === "move") await this.removeSource(source);
    return target;
  }

  /**
   * Deletes what was moved out of the downloads folder. The game is safely in the games folder by
   * now, so failing here doesn't fail the import: a torrent client still seeding the files, or a
   * share (Unraid's /mnt/user, SMB, Docker Desktop) that hasn't let go of them yet, makes the folder
   * refuse to go ("ENOTEMPTY: directory not empty") even after every file in it was deleted.
   */
  private async removeSource(source: string): Promise<void> {
    try {
      await this.fsOps.rm(source, RM_RETRY);
    } catch (err) {
      this.log.warn({ source, err: (err as Error).message }, "Imported, but couldn't remove the original from the downloads folder; delete what's left of it by hand");
    }
  }

  /**
   * Finds the staging folder an older failed move left behind (named with a random id) and renames
   * it to this entry's own staging name. Only when the source is emptied out (its files are gone, so
   * they must be in staging) and exactly one leftover was last changed around when that try failed.
   */
  private async adoptLegacyStaging(source: string, id: number, failedAt: string): Promise<void> {
    const staging = path.join(this.library.gamesDir, `.import-${id}`);
    if ((await stat(staging).catch(() => null)) || (await hasData(source))) return;
    const failed = Date.parse(failedAt);
    if (!Number.isFinite(failed)) return;
    const candidates: string[] = [];
    for (const e of await readdir(this.library.gamesDir, { withFileTypes: true }).catch(() => [])) {
      const m = /^\.import-(\d+)$/.exec(e.name);
      if (!m || !e.isDirectory() || Number(m[1]) < FOLDER_ID_BASE || Number(m[1]) === id) continue;
      const full = path.join(this.library.gamesDir, e.name);
      if (this.activeStaging.has(full)) continue;
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      // The copy finishes (and the staging folder gets its name) moments before the failed delete is recorded.
      const changed = Math.max(st.mtimeMs, st.ctimeMs);
      if (changed <= failed + 5 * 60_000 && changed >= failed - 6 * 3600_000 && (await hasData(full))) candidates.push(full);
    }
    if (candidates.length !== 1) {
      if (candidates.length > 1) this.log.warn({ source, candidates }, "Several leftover imports could belong to this download; not guessing");
      return;
    }
    await this.fsOps.rename(candidates[0]!, staging);
    this.log.info({ source, from: candidates[0], to: staging }, "Found the files of an earlier failed import");
  }
}
