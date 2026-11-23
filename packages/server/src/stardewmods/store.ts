import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  compareStardewMods,
  parseSmapiManifest,
  stardewProblems,
  type SmapiManifest,
  type StardewMod,
  type StardewModSet,
  type StardewPcReport,
} from "@lootden/shared";
import { json, now, type Db } from "../db/database.js";
import { readZipEntry, zipEntries } from "./zip.js";

/** The biggest Stardew mods (expansions like Stardew Valley Expanded) are a few hundred MB. */
export const MAX_STARDEW_MOD_BYTES = 2 * 1024 * 1024 * 1024;

export interface Viewer {
  id: number;
  admin: boolean;
}

interface Row {
  id: number;
  title: string;
  file_name: string;
  file: string;
  size: number;
  folder: string;
  enabled: number;
  manifests: string;
  source_url: string | null;
  added_by: number | null;
  added_by_name: string | null;
  added_at: string;
  updated_at: string;
}

const SELECT = "SELECT m.*, u.display_name AS added_by_name FROM stardew_mods m LEFT JOIN users u ON u.id = m.added_by";

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

/** A name that's safe as one folder on Windows and Linux, and that SMAPI won't skip (no leading dot). */
export function safeFolderName(input: string): string {
  const s = input
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100);
  return s || "Mod";
}

/** What's in a mod zip: its SMAPI mods, and the folder it goes into in Mods. */
export async function readStardewZip(file: string, fileName: string): Promise<{ folder: string; mods: SmapiManifest[] }> {
  const entries = (await zipEntries(file)).filter((e) => e.name && !/(^|\/)__MACOSX\//.test(e.name));
  const manifests = entries.filter((e) => /(^|\/)manifest\.json$/i.test(e.name));
  const dirs = manifests.map((e) => e.name.replace(/\/?manifest\.json$/i, "")).sort((a, b) => a.length - b.length);
  // SMAPI stops at the first folder with a manifest; one deeper inside it isn't a mod of its own.
  const top: string[] = [];
  for (const d of dirs) if (!top.some((t) => t === "" || d === t || d.startsWith(`${t}/`))) top.push(d);
  const mods: SmapiManifest[] = [];
  for (const dir of top) {
    const entry = manifests.find((e) => e.name.replace(/\/?manifest\.json$/i, "") === dir)!;
    const parsed = parseSmapiManifest((await readZipEntry(file, entry)).toString("utf8"), dir);
    if (parsed && !mods.some((m) => m.uniqueId.toLowerCase() === parsed.uniqueId.toLowerCase())) mods.push(parsed);
  }
  if (!mods.length) throw new Error("There's no SMAPI mod (a manifest.json) in that zip");
  // Everything under one folder: that folder goes into Mods. Loose files: a folder named after the zip.
  const firsts = new Set(entries.map((e) => e.name.split("/")[0]));
  const single = firsts.size === 1 && entries.some((e) => e.name.includes("/")) ? [...firsts][0]! : null;
  const stem = fileName.replace(/\.zip$/i, "").replace(/[-_ ]\d+(?:-\d+)+$/, "");
  return { folder: safeFolderName(single ?? stem), mods };
}

/**
 * The household's Stardew Valley mod set, kept in <data>/stardew-mods/. Everyone signed in
 * (but kid profiles) can see it and add mods; only admins switch mods on or off, and a mod
 * someone else adds starts switched off until an admin turns it on. PCs report what their Mods
 * folder has so the page can show where they differ.
 */
export class StardewModStore {
  readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
  ) {
    this.dir = path.join(dataDir, "stardew-mods");
  }

  private view(r: Row, viewer: Viewer | null): StardewMod {
    return {
      id: r.id,
      title: r.title,
      fileName: r.file_name,
      sizeBytes: r.size,
      folder: r.folder,
      enabled: !!r.enabled,
      mods: json<SmapiManifest[]>(r.manifests, []),
      sourceUrl: r.source_url,
      addedBy: r.added_by_name,
      addedAt: r.added_at,
      updatedAt: r.updated_at,
      canManage: !!viewer && (viewer.admin || (r.added_by !== null && r.added_by === viewer.id)),
    };
  }

  private row(id: number): Row | undefined {
    return this.db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as Row | undefined;
  }

  list(viewer: Viewer | null): StardewMod[] {
    const rows = this.db.prepare(`${SELECT} ORDER BY m.title COLLATE NOCASE, m.id`).all() as unknown as Row[];
    return rows.map((r) => this.view(r, viewer));
  }

  /** The set with what it's missing and how each PC compares. */
  set(viewer: Viewer | null): StardewModSet {
    const mods = this.list(viewer);
    return { mods, problems: stardewProblems(mods), pcs: this.reports(mods) };
  }

  get(id: number, viewer: Viewer | null): StardewMod | null {
    const r = this.row(id);
    return r ? this.view(r, viewer) : null;
  }

  file(id: number): { path: string; mod: StardewMod } | null {
    const r = this.row(id);
    return r ? { path: path.join(this.dir, r.file), mod: this.view(r, null) } : null;
  }

  /**
   * Keeps an uploaded mod zip. A zip with a mod already in the set (by its UniqueID) is that
   * mod's new version and replaces it, keeping whether it's on; a new one is on when an admin
   * added it.
   */
  async add(input: { fileName: string; title?: string | null; sourceUrl?: string | null }, body: Readable, viewer: Viewer): Promise<StardewMod> {
    const fileName = path.basename(String(input.fileName ?? "").replace(/\\/g, "/")).trim().slice(0, 200);
    if (!/\.zip$/i.test(fileName)) throw new Error("Add the mod's .zip, as downloaded from Nexus");
    await mkdir(this.dir, { recursive: true });
    const rel = `${randomBytes(6).toString("hex")}-${fileName.replace(/[^\w.() -]+/g, "_")}`;
    const target = path.join(this.dir, rel);
    const part = `${target}.part`;
    let size = 0;
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STARDEW_MOD_BYTES) body.destroy(new Error("That file is too big to be a mod (over 2 GB)"));
    });
    try {
      await pipeline(body, createWriteStream(part));
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    let read: { folder: string; mods: SmapiManifest[] };
    try {
      if (size === 0) throw new Error("The upload was empty");
      read = await readStardewZip(part, fileName);
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    }
    await rename(part, target);
    const bytes = (await stat(target)).size;
    const at = now();
    const source = cleanSource(input.sourceUrl);
    const ids = new Set(read.mods.map((m) => m.uniqueId.toLowerCase()));
    const old = this.list(null).find((p) => p.mods.some((m) => ids.has(m.uniqueId.toLowerCase())));
    const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || old?.title || read.mods.find((m) => !m.contentPackFor)?.name || read.mods[0]!.name;
    // Two mods can't share a folder in Mods.
    const taken = new Set(this.list(null).filter((p) => p.id !== old?.id).map((p) => p.folder.toLowerCase()));
    let folder = read.folder;
    for (let i = 2; taken.has(folder.toLowerCase()); i++) folder = `${read.folder} (${i})`;
    const manifests = JSON.stringify(read.mods);
    let id: number;
    if (old) {
      const oldFile = (this.row(old.id) as Row).file;
      this.db
        .prepare("UPDATE stardew_mods SET title = ?, file_name = ?, file = ?, size = ?, folder = ?, manifests = ?, source_url = COALESCE(?, source_url), updated_at = ? WHERE id = ?")
        .run(input.title ? title : old.title, fileName, rel, bytes, folder, manifests, source, at, old.id);
      await rm(path.join(this.dir, oldFile), { force: true });
      id = old.id;
    } else {
      const r = this.db
        .prepare("INSERT INTO stardew_mods (title, file_name, file, size, folder, enabled, manifests, source_url, added_by, added_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(title, fileName, rel, bytes, folder, viewer.admin ? 1 : 0, manifests, source, viewer.id, at, at);
      id = Number(r.lastInsertRowid);
    }
    return this.view(this.row(id)!, viewer);
  }

  /** Renames a mod (who added it, or an admin) and switches it on or off (admins only). */
  update(id: number, patch: { title?: unknown; enabled?: unknown }, viewer: Viewer): StardewMod {
    const r = this.row(id);
    if (!r) throw Object.assign(new Error("Mod not found"), { status: 404 });
    if (patch.enabled !== undefined) {
      if (!viewer.admin) throw Object.assign(new Error("Only an admin can switch mods on or off"), { status: 403 });
      this.db.prepare("UPDATE stardew_mods SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, id);
    }
    if (patch.title !== undefined) {
      if (!this.view(r, viewer).canManage) throw Object.assign(new Error("Only whoever added it, or an admin, can rename it"), { status: 403 });
      const clean = String(patch.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!clean) throw Object.assign(new Error("Give the mod a name"), { status: 400 });
      this.db.prepare("UPDATE stardew_mods SET title = ? WHERE id = ?").run(clean, id);
    }
    return this.view(this.row(id)!, viewer);
  }

  /** Deletes a mod from the set; PCs switch their copy off at their next sync. */
  async remove(id: number, viewer: Viewer): Promise<boolean> {
    const r = this.row(id);
    if (!r || !this.view(r, viewer).canManage) return false;
    this.db.prepare("DELETE FROM stardew_mods WHERE id = ?").run(id);
    await rm(path.join(this.dir, r.file), { force: true });
    return true;
  }

  /** A PC's Mods folder as it is now (the mods SMAPI loads there). */
  report(device: string, userId: number | null, mods: unknown): void {
    const name = String(device ?? "").replace(/\s+/g, " ").trim().slice(0, 100);
    if (!name) throw new Error("Name the PC");
    const list = (Array.isArray(mods) ? mods : [])
      .slice(0, 1000)
      .map((m) => {
        const o = (m ?? {}) as Record<string, unknown>;
        return { uniqueId: String(o.uniqueId ?? "").trim().slice(0, 200), name: String(o.name ?? "").trim().slice(0, 200), version: String(o.version ?? "").trim().slice(0, 60) };
      })
      .filter((m) => m.uniqueId);
    this.db
      .prepare("INSERT INTO stardew_pc_reports (device, user_id, mods, reported_at) VALUES (?, ?, ?, ?) ON CONFLICT(device) DO UPDATE SET user_id = excluded.user_id, mods = excluded.mods, reported_at = excluded.reported_at")
      .run(name, userId, JSON.stringify(list), now());
  }

  private reports(set: StardewMod[]): StardewPcReport[] {
    const rows = this.db
      .prepare("SELECT r.device, r.mods, r.reported_at, u.display_name AS user FROM stardew_pc_reports r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.reported_at DESC")
      .all() as Array<{ device: string; mods: string; reported_at: string; user: string | null }>;
    return rows.map((r) => {
      const mods = json<StardewPcReport["mods"]>(r.mods, []);
      return {
        device: r.device,
        user: r.user,
        reportedAt: r.reported_at,
        mods,
        differences: compareStardewMods(set, mods.map((m) => ({ ...m, enabled: true }))).filter((d) => d.state !== "match"),
      };
    });
  }

  /** Forgets a PC (one that's gone), so the page stops showing it. */
  forget(device: string): boolean {
    return this.db.prepare("DELETE FROM stardew_pc_reports WHERE device = ?").run(String(device)).changes > 0;
  }
}
