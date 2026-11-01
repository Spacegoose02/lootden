import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { truckModFileName, truckModTitle, type TruckGame, type TruckMod } from "@lootden/shared";
import { json, now, type Db } from "../db/database.js";

/** Map mods run to a few GB; anything past this is almost certainly not a mod. */
export const MAX_TRUCK_MOD_BYTES = 20 * 1024 * 1024 * 1024;

interface Row {
  id: number;
  game: TruckGame;
  title: string;
  file_name: string;
  file: string;
  size: number;
  source_url: string | null;
  mod_version: string | null;
  compatible: string;
  added_by: number | null;
  added_by_name: string | null;
  added_at: string;
  updated_at: string;
}

const SELECT = "SELECT m.*, u.display_name AS added_by_name FROM truck_mods m LEFT JOIN users u ON u.id = m.added_by";

/** Only web addresses are kept as a mod's source. */
function cleanSource(input: string | null | undefined): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

/**
 * Truck game mods (ATS, ETS2) shared through the server: files in <data>/truck-mods/<game>/.
 * Everyone signed in (but kid profiles) can list and fetch them, and add more; whoever added a
 * mod, or an admin, can delete it.
 */
export class TruckModStore {
  readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
  ) {
    this.dir = path.join(dataDir, "truck-mods");
  }

  private view(r: Row, viewer: { id: number; admin: boolean } | null): TruckMod {
    return {
      id: r.id,
      game: r.game,
      title: r.title,
      fileName: r.file_name,
      sizeBytes: r.size,
      sourceUrl: r.source_url,
      modVersion: r.mod_version,
      compatibleVersions: json<string[]>(r.compatible, []),
      addedBy: r.added_by_name,
      addedAt: r.added_at,
      updatedAt: r.updated_at,
      canDelete: !!viewer && (viewer.admin || (r.added_by !== null && r.added_by === viewer.id)),
    };
  }

  private row(id: number): Row | undefined {
    return this.db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as Row | undefined;
  }

  list(game: TruckGame, viewer: { id: number; admin: boolean } | null): TruckMod[] {
    const rows = this.db.prepare(`${SELECT} WHERE m.game = ? ORDER BY m.updated_at DESC, m.id DESC`).all(game) as unknown as Row[];
    return rows.map((r) => this.view(r, viewer));
  }

  get(id: number, viewer: { id: number; admin: boolean } | null): TruckMod | null {
    const r = this.row(id);
    return r ? this.view(r, viewer) : null;
  }

  /** The mod's file on disk, or null when there's no such mod. */
  file(id: number): { path: string; mod: TruckMod } | null {
    const r = this.row(id);
    return r ? { path: path.join(this.dir, r.file), mod: this.view(r, null) } : null;
  }

  /** Keeps an uploaded mod; one with the same file name for the game is replaced (a newer version). */
  async add(
    game: TruckGame,
    input: { fileName: string; title?: string | null; sourceUrl?: string | null; modVersion?: string | null; compatibleVersions?: string[] },
    body: Readable,
    viewer: { id: number; admin: boolean },
  ): Promise<TruckMod> {
    const fileName = truckModFileName(input.fileName);
    const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || truckModTitle(fileName);
    const rel = path.join(game, `${randomBytes(6).toString("hex")}-${fileName.replace(/[^\w.() -]+/g, "_")}`);
    const target = path.join(this.dir, rel);
    await mkdir(path.dirname(target), { recursive: true });
    const part = `${target}.part`;
    let size = 0;
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_TRUCK_MOD_BYTES) body.destroy(new Error("That file is too big to be a mod (over 20 GB)"));
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
    const bytes = (await stat(target)).size;
    const at = now();
    const source = cleanSource(input.sourceUrl);
    const modVersion = String(input.modVersion ?? "").trim().slice(0, 60) || null;
    const compatible = JSON.stringify([...new Set((input.compatibleVersions ?? []).map((v) => String(v).trim()).filter((v) => /^\d+\.\d+[\d.*]*$/.test(v)))].slice(0, 20));
    const old = this.db.prepare("SELECT id, file FROM truck_mods WHERE game = ? AND file_name = ?").get(game, fileName) as { id: number; file: string } | undefined;
    let id: number;
    if (old) {
      this.db
        .prepare("UPDATE truck_mods SET title = ?, file_name = ?, file = ?, size = ?, source_url = COALESCE(?, source_url), mod_version = ?, compatible = ?, updated_at = ? WHERE id = ?")
        .run(title, fileName, rel, bytes, source, modVersion, compatible, at, old.id);
      await rm(path.join(this.dir, old.file), { force: true });
      id = old.id;
    } else {
      const r = this.db
        .prepare("INSERT INTO truck_mods (game, title, file_name, file, size, source_url, mod_version, compatible, added_by, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(game, title, fileName, rel, bytes, source, modVersion, compatible, viewer.id, at, at);
      id = Number(r.lastInsertRowid);
    }
    return this.view(this.row(id)!, viewer);
  }

  /** Renames a mod (its title; the file keeps its name). */
  rename(id: number, title: string, viewer: { id: number; admin: boolean }): TruckMod | null {
    const r = this.row(id);
    if (!r || !this.view(r, viewer).canDelete) return null;
    const clean = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!clean) throw new Error("Give the mod a name");
    this.db.prepare("UPDATE truck_mods SET title = ? WHERE id = ?").run(clean, id);
    return this.view(this.row(id)!, viewer);
  }

  /** Deletes a mod the viewer added (any mod, for an admin). False when it's not there or not theirs. */
  async remove(id: number, viewer: { id: number; admin: boolean }): Promise<boolean> {
    const r = this.row(id);
    if (!r || !this.view(r, viewer).canDelete) return false;
    this.db.prepare("DELETE FROM truck_mods WHERE id = ?").run(id);
    await rm(path.join(this.dir, r.file), { force: true });
    return true;
  }
}
