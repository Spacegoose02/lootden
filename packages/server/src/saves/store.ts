import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SaveBackup } from "@lootden/shared";
import { now, type Db } from "../db/database.js";

/** How many backups each player keeps per game; older ones are deleted on upload. */
export const KEEP_SAVES = 10;
/** Saves are small; anything bigger is almost certainly the wrong folder. */
export const MAX_SAVE_BYTES = 2 * 1024 * 1024 * 1024;

interface SaveRow {
  id: number;
  user_id: number;
  game_id: string;
  created_at: string;
  size: number;
  device: string | null;
  runner: string | null;
  file: string;
}

const toBackup = (r: SaveRow): SaveBackup => ({ id: r.id, gameId: r.game_id, createdAt: r.created_at, size: r.size, device: r.device, runner: r.runner ?? null });

/**
 * Per-player save backups: zips the clients upload, kept in <data>/saves/<user>/<game>/.
 * Only the player who uploaded a backup can list, download or delete it.
 */
export class SaveStore {
  readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
  ) {
    this.dir = path.join(dataDir, "saves");
  }

  list(userId: number, gameId: string): SaveBackup[] {
    const rows = this.db
      .prepare("SELECT * FROM saves WHERE user_id = ? AND game_id = ? ORDER BY created_at DESC, id DESC")
      .all(userId, gameId) as unknown as SaveRow[];
    return rows.map(toBackup);
  }

  /** Every game this player has backups for, newest first. */
  latestPerGame(userId: number): SaveBackup[] {
    const rows = this.db
      .prepare("SELECT * FROM saves WHERE id IN (SELECT MAX(id) FROM saves WHERE user_id = ? GROUP BY game_id) ORDER BY created_at DESC")
      .all(userId) as unknown as SaveRow[];
    return rows.map(toBackup);
  }

  private row(userId: number, saveId: number): SaveRow | undefined {
    return this.db.prepare("SELECT * FROM saves WHERE id = ? AND user_id = ?").get(saveId, userId) as SaveRow | undefined;
  }

  /** Absolute path of a backup's zip, or null when it isn't this player's. */
  file(userId: number, saveId: number): { path: string; backup: SaveBackup } | null {
    const r = this.row(userId, saveId);
    return r ? { path: path.join(this.dir, r.file), backup: toBackup(r) } : null;
  }

  async add(userId: number, gameId: string, body: Readable, device: string | null, runner: string | null = null): Promise<SaveBackup> {
    const created = now();
    const folder = path.join(String(userId), safeSegment(gameId));
    const name = `${created.replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.zip`;
    const rel = path.join(folder, name);
    const target = path.join(this.dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    const part = `${target}.part`;
    let size = 0;
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_SAVE_BYTES) body.destroy(new Error("Save backups are limited to 2 GB; check the save folder"));
    });
    try {
      await pipeline(body, createWriteStream(part));
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    if (size === 0) {
      await rm(part, { force: true });
      throw new Error("The upload was empty");
    }
    await rename(part, target);
    const cleanDevice = device?.trim().slice(0, 80) || null;
    const { lastInsertRowid } = this.db
      .prepare("INSERT INTO saves (user_id, game_id, created_at, size, device, runner, file) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(userId, gameId, created, (await stat(target)).size, cleanDevice, runner, rel);
    await this.prune(userId, gameId, runner);
    return toBackup(this.row(userId, Number(lastInsertRowid))!);
  }

  async remove(userId: number, saveId: number): Promise<boolean> {
    const r = this.row(userId, saveId);
    if (!r) return false;
    this.db.prepare("DELETE FROM saves WHERE id = ?").run(saveId);
    await rm(path.join(this.dir, r.file), { force: true });
    return true;
  }

  /** Keeps the newest backups per game, counted separately for the emulator and each recomp. */
  private async prune(userId: number, gameId: string, runner: string | null): Promise<void> {
    const old = this.db
      .prepare("SELECT * FROM saves WHERE user_id = ? AND game_id = ? AND runner IS ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?")
      .all(userId, gameId, runner, KEEP_SAVES) as unknown as SaveRow[];
    for (const r of old) await this.remove(userId, r.id);
  }
}

/** Game ids are path-like ("pc/Some Game"); flatten them into one folder name. */
function safeSegment(id: string): string {
  return id.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "_").slice(0, 120) || "_";
}

/**
 * Converts PCGamingWiki's {{p|...}} path templates to the placeholders clients expand.
 * Returns null for paths a client can't reach (registry, Steam cloud, other platforms).
 */
export function pcgwPathToTemplate(raw: string): string | null {
  const map: Record<string, string> = {
    game: "{game}",
    userprofile: "%USERPROFILE%",
    "userprofile\\documents": "%DOCUMENTS%",
    "userprofile\\appdata\\locallow": "%USERPROFILE%/AppData/LocalLow",
    appdata: "%APPDATA%",
    localappdata: "%LOCALAPPDATA%",
    public: "%PUBLIC%",
    allusersprofile: "%PROGRAMDATA%",
    programdata: "%PROGRAMDATA%",
  };
  let unknown = false;
  let s = raw.replace(/\{\{p\|([^}]+)\}\}/gi, (_m, name: string) => {
    const key = name.trim().toLowerCase();
    if (key === "uid" || key === "username") return "*";
    const v = map[key];
    if (!v) unknown = true;
    return v ?? "";
  });
  s = s.replace(/<ref>.*?<\/ref>|<ref[^>]*\/>/gi, "").replace(/<[^>]+>/g, "").trim();
  if (unknown || !s || /^(HKEY_|\{\{)/i.test(s) || !/^(\{game\}|%)/.test(s)) return null;
  return s.replace(/\\/g, "/").replace(/\/+$/, "");
}
