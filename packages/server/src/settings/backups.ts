import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { existsSync, renameSync, rmSync } from "node:fs";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { json, MIGRATIONS, type Db } from "../db/database.js";

export interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: string;
}

export interface BackupSettings {
  /** Make one a day by itself. */
  daily: boolean;
  /** How many to keep (the oldest go first). */
  keep: number;
}

const KEY = "backups";
const NAME = /^lootden-[A-Za-z0-9-]{1,60}\.db$/;
/** The restore to finish at the next start, next to the database. */
export const PENDING_RESTORE = "restore-pending.db";
/** Biggest upload taken: the database without artwork is far smaller. */
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/**
 * Copies of the database (everyone's accounts, play time, journals, shelves, settings) in
 * <data>/backups, made on demand or once a day, and restoring one at the next start.
 * Artwork and save backups live beside it in the data folder and aren't included.
 */
export class BackupService {
  readonly dir: string;

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
  ) {
    this.dir = path.join(dataDir, "backups");
  }

  settings(): BackupSettings {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    const s = json<Partial<BackupSettings>>(row?.value, {});
    return { daily: s.daily !== false, keep: Math.min(60, Math.max(1, Math.round(Number(s.keep) || 7))) };
  }

  setSettings(patch: Partial<BackupSettings>): BackupSettings {
    const next = { ...this.settings(), ...patch };
    const clean = { daily: !!next.daily, keep: Math.min(60, Math.max(1, Math.round(Number(next.keep) || 7))) };
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(clean));
    return clean;
  }

  async list(): Promise<BackupInfo[]> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => NAME.test(n));
    const out: BackupInfo[] = [];
    for (const n of names) {
      const s = await stat(path.join(this.dir, n)).catch(() => null);
      if (s?.isFile()) out.push({ name: n, bytes: s.size, createdAt: s.mtime.toISOString() });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  }

  /** A backup's file, for downloading; throws for anything that isn't one. */
  file(name: string): string {
    if (!NAME.test(name)) throw new Error("No such backup");
    const f = path.join(this.dir, name);
    if (!existsSync(f)) throw new Error("No such backup");
    return f;
  }

  /** A consistent copy of the live database, taken without stopping anything. */
  async create(kind: "manual" | "daily" | "upload" = "manual"): Promise<BackupInfo> {
    await mkdir(this.dir, { recursive: true });
    const name = `lootden-${stamp()}-${kind}.db`;
    const file = path.join(this.dir, name);
    await rm(file, { force: true });
    this.db.prepare("VACUUM INTO ?").run(file);
    await this.prune();
    const s = await stat(file);
    return { name, bytes: s.size, createdAt: s.mtime.toISOString() };
  }

  /** Keeps the newest `keep` backups. */
  async prune(): Promise<void> {
    const keep = this.settings().keep;
    for (const old of (await this.list()).slice(keep)) await rm(path.join(this.dir, old.name), { force: true });
  }

  async remove(name: string): Promise<void> {
    await rm(this.file(name), { force: true });
  }

  /** The daily backup, when it's on and the newest is older than about a day. */
  async runDaily(): Promise<BackupInfo | null> {
    if (!this.settings().daily) return null;
    const newest = (await this.list())[0];
    if (newest && Date.now() - Date.parse(newest.createdAt) < 20 * 3600_000) return null;
    return this.create("daily");
  }

  /** Checks a file is a LootDen database this version can open. */
  static check(file: string): void {
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      const { user_version: v } = db.prepare("PRAGMA user_version").get() as { user_version: number };
      const users = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
      if (!users || !v) throw new Error("That file isn't a LootDen backup");
      if (v > MIGRATIONS.length) throw new Error("That backup is from a newer LootDen; update the server first");
    } catch (err) {
      const m = (err as Error).message;
      throw new Error(/LootDen/.test(m) ? m : "That file isn't a LootDen backup");
    } finally {
      db?.close();
    }
  }

  /** A backup file uploaded from a PC, kept with the others once it checks out. */
  async upload(body: Readable): Promise<BackupInfo> {
    await mkdir(this.dir, { recursive: true });
    const name = `lootden-${stamp()}-upload.db`;
    const tmp = path.join(this.dir, `.${name}.part`);
    let size = 0;
    body.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BACKUP_BYTES) body.destroy(new Error("That file is too big for a LootDen backup"));
    });
    try {
      await pipeline(body, createWriteStream(tmp));
      BackupService.check(tmp);
      await rename(tmp, path.join(this.dir, name));
    } finally {
      await rm(tmp, { force: true });
    }
    await this.prune();
    const s = await stat(path.join(this.dir, name));
    return { name, bytes: s.size, createdAt: s.mtime.toISOString() };
  }

  /** Puts a backup in place to be restored when LootDen next starts (after a safety backup of now). */
  async stageRestore(name: string): Promise<void> {
    const file = this.file(name);
    BackupService.check(file);
    await this.create("manual");
    await copyFile(file, path.join(this.dataDir, PENDING_RESTORE));
  }

  async cancelRestore(): Promise<void> {
    await rm(path.join(this.dataDir, PENDING_RESTORE), { force: true });
  }

  pendingRestore(): boolean {
    return existsSync(path.join(this.dataDir, PENDING_RESTORE));
  }
}

/**
 * At start-up, before the database opens: a staged restore replaces it. The database being
 * replaced is kept as <name>.before-restore.
 */
export function applyPendingRestore(dataDir: string, dbFile: string): boolean {
  const pending = path.join(dataDir, PENDING_RESTORE);
  if (!existsSync(pending)) return false;
  BackupService.check(pending);
  if (existsSync(dbFile)) renameSync(dbFile, `${dbFile}.before-restore`);
  for (const ext of ["-wal", "-shm"]) rmSync(`${dbFile}${ext}`, { force: true });
  renameSync(pending, dbFile);
  return true;
}
