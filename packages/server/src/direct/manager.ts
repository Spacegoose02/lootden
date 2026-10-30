import { createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { archiveKindOf, PC_PLATFORM, platformFor } from "@lootden/shared";
import type { Library } from "../catalog/library.js";
import type { DownloadManager } from "../connectors/manager.js";
import { archiveProblem, type ImportProgress } from "../connectors/tidy.js";
import { now, type Db } from "../db/database.js";
import type { FetchLike } from "../metadata/http.js";
import { dispositionName, hostName, LinkError, parseLinks, resolveLink, urlFileName, type ResolvedLink } from "./hosts.js";

export type PackageStatus = "queued" | "downloading" | "paused" | "importing" | "imported" | "failed";
export type FileStatus = "queued" | "downloading" | "done" | "failed";

export interface DirectFile {
  id: number;
  url: string;
  host: string;
  fileName: string | null;
  sizeBytes: number | null;
  receivedBytes: number;
  status: FileStatus;
  error: string | null;
}

export interface DirectPackage {
  id: number;
  name: string;
  platform: string | null;
  status: PackageStatus;
  error: string | null;
  importedPath: string | null;
  addedAt: string;
  finishedAt: string | null;
  files: DirectFile[];
  /** Bytes per second while downloading. */
  speed: number | null;
  /** While importing: which step and how far. */
  progress: ImportProgress | null;
}

export interface LinkCheck {
  url: string;
  host: string;
  ok: boolean;
  fileName: string | null;
  sizeBytes: number | null;
  error: string | null;
}

interface PackageRow {
  id: number;
  name: string;
  platform: string | null;
  status: PackageStatus;
  error: string | null;
  imported_path: string | null;
  added_at: string;
  finished_at: string | null;
}

interface FileRow {
  id: number;
  package_id: number;
  position: number;
  url: string;
  host: string;
  file_name: string | null;
  size_bytes: number | null;
  received_bytes: number;
  status: FileStatus;
  error: string | null;
}

const safeName = (name: string) => name.replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "").replace(/^\.+/, "") || "download";

/** A game name from its first file: "Cool.Game.v1.2.part01.rar" → "Cool.Game.v1.2". */
export function packageNameFrom(fileName: string): string {
  return safeName(fileName.replace(/(\.part\d+)?\.(rar|zip|7z|iso|bin|exe|r\d\d|\d{3})$/i, "").replace(/\.(7z|zip|rar)$/i, ""));
}

/**
 * The Download Manager: links from file hosts (MediaFire, Datanodes, Pixeldrain and others)
 * are turned into direct downloads, fetched by the server one game at a time with resume,
 * and imported into the library like any other finished download.
 */
export class DirectDownloads {
  private running: { id: number; abort: AbortController } | null = null;
  private readonly live = new Map<number, { received: number; speed: number; at: number; mark: number }>();
  private readonly importing = new Map<number, ImportProgress>();

  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly downloads: DownloadManager,
    private readonly log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  /** Told about finished and failed games, for alerts. */
  onEvent: (e: { kind: "imported" | "failed"; title: string; message?: string }) => void = () => {};

  /** Where files wait until the whole game is down: hidden inside the games folder, so the import is a rename. */
  private staging(id: number): string {
    return path.join(this.library.gamesDir, ".lootden-direct", String(id));
  }

  /** Resolves each link without downloading, so the admin sees names and sizes first. */
  async check(text: string): Promise<LinkCheck[]> {
    const links = parseLinks(text);
    if (!links.length) throw new Error("Paste at least one http(s) link");
    if (links.length > 100) throw new Error("That's more than 100 links; add them in smaller batches");
    const out: LinkCheck[] = [];
    // A few at a time, so a long list doesn't hammer one host.
    for (let i = 0; i < links.length; i += 4) {
      out.push(
        ...(await Promise.all(
          links.slice(i, i + 4).map(async (url): Promise<LinkCheck> => {
            try {
              const r = await this.resolve(url);
              return { url, host: r.host, ok: true, fileName: r.fileName, sizeBytes: r.sizeBytes, error: null };
            } catch (err) {
              return { url, host: hostName(url), ok: false, fileName: null, sizeBytes: null, error: (err as Error).message };
            }
          }),
        )),
      );
    }
    return out;
  }

  /** Queues the links as one game. */
  add(input: { links: string; name?: string | null; platform?: string | null }, userId: number | null): DirectPackage {
    const links = parseLinks(input.links ?? "");
    if (!links.length) throw new Error("Paste at least one http(s) link");
    if (links.length > 100) throw new Error("That's more than 100 links; add them in smaller batches");
    const platform = input.platform && input.platform !== PC_PLATFORM ? platformFor(input.platform).id : null;
    // Hosts put the file name somewhere in the path (MediaFire: /file/<key>/<name>/file).
    const fromUrl = new URL(links[0]!).pathname.split("/").map((s) => decodeURIComponent(s)).reverse().find((s) => /\.[a-z0-9]{2,4}$/i.test(s));
    const name = safeName(input.name?.trim() || (fromUrl ? packageNameFrom(fromUrl) : `${hostName(links[0]!)} download ${new Date().toISOString().slice(0, 10)}`));
    const id = Number(
      this.db.prepare("INSERT INTO direct_packages (name, platform, status, added_by, added_at) VALUES (?, ?, 'queued', ?, ?)").run(name, platform, userId, now()).lastInsertRowid,
    );
    const insert = this.db.prepare("INSERT INTO direct_files (package_id, position, url, host, status) VALUES (?, ?, ?, ?, 'queued')");
    links.forEach((url, i) => insert.run(id, i, url, hostName(url)));
    this.kick();
    return this.get(id)!;
  }

  get(id: number): DirectPackage | undefined {
    const row = this.db.prepare("SELECT * FROM direct_packages WHERE id = ?").get(id) as PackageRow | undefined;
    return row && this.toPackage(row);
  }

  list(): DirectPackage[] {
    return (this.db.prepare("SELECT * FROM direct_packages ORDER BY id DESC LIMIT 100").all() as unknown as PackageRow[]).map((r) => this.toPackage(r));
  }

  private toPackage(r: PackageRow): DirectPackage {
    const live = this.live.get(r.id);
    const files = (this.db.prepare("SELECT * FROM direct_files WHERE package_id = ? ORDER BY position").all(r.id) as unknown as FileRow[]).map(
      (f): DirectFile => ({
        id: f.id,
        url: f.url,
        host: f.host,
        fileName: f.file_name,
        sizeBytes: f.size_bytes,
        // The file being written reports its live count; the database is only updated now and then.
        receivedBytes: f.status === "downloading" && live ? live.received : f.received_bytes,
        status: f.status,
        error: f.error,
      }),
    );
    return {
      id: r.id,
      name: r.name,
      platform: r.platform,
      status: r.status,
      error: r.error,
      importedPath: r.imported_path,
      addedAt: r.added_at,
      finishedAt: r.finished_at,
      files,
      speed: r.status === "downloading" && live ? live.speed : null,
      progress: this.importing.get(r.id) ?? null,
    };
  }

  async control(id: number, action: "pause" | "resume" | "retry" | "remove"): Promise<void> {
    const pkg = this.get(id);
    if (!pkg) throw new Error("No such download");
    if (action === "pause") {
      if (!["queued", "downloading"].includes(pkg.status)) throw new Error("Only queued or running downloads can be paused");
      this.setStatus(id, "paused");
      if (this.running?.id === id) this.running.abort.abort();
      return;
    }
    if (action === "resume" || action === "retry") {
      if (pkg.status === "imported" || pkg.status === "importing") throw new Error("This one is already finished");
      this.db.prepare("UPDATE direct_files SET status = 'queued', error = NULL WHERE package_id = ? AND status IN ('failed', 'downloading')").run(id);
      this.db.prepare("UPDATE direct_packages SET status = 'queued', error = NULL WHERE id = ?").run(id);
      this.kick();
      return;
    }
    if (pkg.status === "importing") throw new Error("Wait for the import to finish");
    if (this.running?.id === id) {
      this.running.abort.abort();
      await this.current?.catch(() => {});
    }
    this.db.prepare("DELETE FROM direct_packages WHERE id = ?").run(id);
    await rm(this.staging(id), { recursive: true, force: true });
  }

  /** After a restart: anything mid-download carries on from where its files stopped. */
  resumeAll(): void {
    this.db.prepare("UPDATE direct_packages SET status = 'queued' WHERE status IN ('downloading', 'importing')").run();
    this.db.prepare("UPDATE direct_files SET status = 'queued' WHERE status = 'downloading'").run();
    this.kick();
  }

  private current: Promise<void> | null = null;

  /** Starts the next queued game when nothing is running. */
  kick(): void {
    if (this.running) return;
    const next = this.db.prepare("SELECT * FROM direct_packages WHERE status = 'queued' ORDER BY id LIMIT 1").get() as PackageRow | undefined;
    if (!next) return;
    const abort = new AbortController();
    this.running = { id: next.id, abort };
    this.current = this.run(next, abort.signal)
      .catch((err: Error) => this.log.warn({ name: next.name, err: err.message }, "Direct download failed"))
      .finally(() => {
        this.running = null;
        this.current = null;
        this.live.delete(next.id);
        this.kick();
      });
  }

  /** Waits until nothing is downloading (tests). */
  async idle(): Promise<void> {
    while (this.current) await this.current;
  }

  /** Called when a package changes status. */
  onChange: () => void = () => {};

  private setStatus(id: number, status: PackageStatus, error: string | null = null): void {
    this.db.prepare("UPDATE direct_packages SET status = ?, error = ? WHERE id = ?").run(status, error, id);
    this.onChange();
  }

  private async resolve(url: string): Promise<ResolvedLink> {
    return resolveLink(url, this.fetchImpl);
  }

  private async run(pkg: PackageRow, signal: AbortSignal): Promise<void> {
    this.setStatus(pkg.id, "downloading");
    const dir = path.join(this.staging(pkg.id), pkg.name);
    await mkdir(dir, { recursive: true });
    const files = this.db.prepare("SELECT * FROM direct_files WHERE package_id = ? ORDER BY position").all(pkg.id) as unknown as FileRow[];
    const used = new Set(files.filter((f) => f.status === "done" && f.file_name).map((f) => f.file_name!.toLowerCase()));
    for (const f of files) {
      // A failed import throws the files away, so a retry downloads those again.
      if (f.status === "done" && f.file_name && (await stat(path.join(dir, f.file_name)).catch(() => null))) continue;
      if (signal.aborted) return;
      try {
        await this.fetchFile(pkg.id, f, dir, used, signal);
      } catch (err) {
        if (signal.aborted) {
          // Paused or removed: keep the partial file so resuming carries on.
          this.db.prepare("UPDATE direct_files SET status = 'queued' WHERE id = ? AND status = 'downloading'").run(f.id);
          return;
        }
        const msg = (err as Error).message;
        this.db.prepare("UPDATE direct_files SET status = 'failed', error = ? WHERE id = ?").run(msg, f.id);
        this.setStatus(pkg.id, "failed", `${f.file_name ?? f.url}: ${msg}`);
        this.onEvent({ kind: "failed", title: pkg.name, message: msg });
        return;
      }
    }

    // Everything is down: import it like a finished torrent (unpack, tidy, virus scan).
    this.setStatus(pkg.id, "importing");
    try {
      const names = await readdir(dir);
      // An emulated game that's a single ROM or disc image goes in as that file.
      const source = pkg.platform && names.length === 1 ? path.join(dir, names[0]!) : dir;
      const target = await this.downloads.importDownloaded(source, pkg.name, pkg.platform, 2_000_000_000 + pkg.id, (p) => this.importing.set(pkg.id, p));
      this.db.prepare("UPDATE direct_packages SET status = 'imported', imported_path = ?, finished_at = ?, error = NULL WHERE id = ?").run(target, now(), pkg.id);
      this.onChange();
      await rm(this.staging(pkg.id), { recursive: true, force: true });
      this.log.info({ name: pkg.name, target }, "Imported direct download");
    } catch (err) {
      this.setStatus(pkg.id, "failed", (err as Error).message);
      this.onEvent({ kind: "failed", title: pkg.name, message: (err as Error).message });
    } finally {
      this.importing.delete(pkg.id);
    }
  }

  /** Downloads one file into dir, resuming a .part file when the host allows ranges. */
  private async fetchFile(pkgId: number, f: FileRow, dir: string, used: Set<string>, signal: AbortSignal): Promise<void> {
    this.db.prepare("UPDATE direct_files SET status = 'downloading', error = NULL WHERE id = ?").run(f.id);
    // Direct links expire, so each file is resolved again right before it downloads.
    const link = await this.resolve(f.url);
    let name = f.file_name ?? link.fileName;
    const partOf = (n: string) => path.join(dir, `${n}.part`);
    const have = name ? ((await stat(partOf(name)).catch(() => null))?.size ?? 0) : 0;

    const res = await this.fetchImpl(link.url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) LootDen", ...link.headers, ...(have ? { Range: `bytes=${have}-` } : {}) },
      signal,
    });
    if (!res.ok || !res.body) throw new LinkError(`The file host answered HTTP ${res.status}`);
    if (/text\/html/i.test(res.headers.get("content-type") ?? "")) throw new LinkError("The host sent a web page instead of the file (the link may need a captcha or has expired)");

    if (!f.file_name) {
      name = dispositionName(res.headers.get("content-disposition")) ?? name ?? urlFileName(res.url || link.url) ?? `file-${f.position + 1}`;
      name = safeName(path.basename(name));
      // Two links can carry the same name; keep both.
      if (used.has(name.toLowerCase())) name = `${f.position + 1}-${name}`;
    }
    name = name!;
    used.add(name.toLowerCase());
    const resumed = res.status === 206 && have > 0;
    const total = res.headers.get("content-range")?.match(/\/(\d+)$/)?.[1];
    const size = total ? Number(total) : Number(res.headers.get("content-length") || 0) + (resumed ? have : 0) || link.sizeBytes;
    this.db.prepare("UPDATE direct_files SET file_name = ?, size_bytes = ? WHERE id = ?").run(name, size || null, f.id);

    let received = resumed ? have : 0;
    const state = { received, speed: 0, at: Date.now(), mark: received };
    this.live.set(pkgId, state);
    let saved = Date.now();
    const count = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        received += chunk.length;
        state.received = received;
        const t = Date.now();
        if (t - state.at >= 1000) {
          state.speed = Math.round(((received - state.mark) * 1000) / (t - state.at));
          state.at = t;
          state.mark = received;
        }
        if (t - saved > 5000) {
          saved = t;
          this.db.prepare("UPDATE direct_files SET received_bytes = ? WHERE id = ?").run(received, f.id);
        }
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as never), count, createWriteStream(partOf(name), { flags: resumed ? "a" : "w" }), { signal });
    if (size && received < size) throw new LinkError(`The download stopped early (${received} of ${size} bytes); retry to carry on`);
    const problem = archiveKindOf(name) ? await archiveProblem(partOf(name), name) : received === 0 ? `${name} is empty (0 bytes)` : null;
    if (problem) {
      // Start over on retry rather than resuming a bad file.
      await rm(partOf(name), { force: true });
      throw new LinkError(problem);
    }
    await rename(partOf(name), path.join(dir, name));
    this.db.prepare("UPDATE direct_files SET status = 'done', received_bytes = ?, size_bytes = COALESCE(size_bytes, ?) WHERE id = ?").run(received, received, f.id);
  }
}
