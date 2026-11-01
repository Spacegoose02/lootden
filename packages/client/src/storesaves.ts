import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SaveBackup } from "@lootden/shared";
import type { GameServerClient } from "./api.js";
import { extractArchive, type SevenZip } from "./extractor.js";
import { placeholder, run7z } from "./saves.js";

/** A save location from Ludusavi's manifest, in LootDen's placeholders (%APPDATA%/..., {game}/...). */
export interface SaveLocation {
  template: string;
  tags: string[];
}

export interface FoundSave {
  template: string;
  /** A file or folder that exists now. */
  path: string;
}

const MAP_FILE = "lootden-saves.json";
const GLOB = /[*?]/;

/** A template with its placeholders filled in, still with any * and ? in it; null when it can't apply here. */
export function fillTemplate(template: string, installDir: string | null, env: (name: string) => string | undefined = placeholder): string | null {
  if (/\{game\}/i.test(template) && !installDir) return null;
  let missing = false;
  const p = template.replace(/\{game\}/gi, installDir ?? "").replace(/%([A-Za-z_]+)%/g, (_m, name: string) => {
    const v = env(name);
    if (!v) missing = true;
    return v ?? "";
  });
  return missing ? null : p;
}

/** One path segment's wildcard as a regular expression (case-insensitive, as Windows is). */
const segmentRegex = (seg: string) => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");

/** Whether a real path is one a filled template points at (used to check a backup before restoring it). */
export function matchesPattern(pattern: string, real: string): boolean {
  const a = path.resolve(pattern).split(/[\\/]+/).filter(Boolean);
  const b = path.resolve(real).split(/[\\/]+/).filter(Boolean);
  const walk = (i: number, j: number): boolean => {
    if (i === a.length) return j === b.length;
    if (a[i] === "**") return walk(i + 1, j) || (j < b.length && walk(i, j + 1));
    return j < b.length && segmentRegex(a[i]!).test(b[j]!) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

/** Every existing file or folder a filled template matches. */
export async function globPaths(pattern: string): Promise<string[]> {
  const abs = path.resolve(pattern);
  const parts = abs.split(/[\\/]+/);
  const root = parts[0] === "" ? path.sep : `${parts[0]}${path.sep}`;
  let current = [root];
  for (const [i, seg] of parts.slice(1).entries()) {
    if (!seg) continue;
    const next: string[] = [];
    if (seg === "**") {
      // Any depth (up to 6 levels), including none.
      let level = current;
      next.push(...level);
      for (let d = 0; d < 6 && level.length; d++) {
        const deeper: string[] = [];
        for (const dir of level) for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (e.isDirectory()) deeper.push(path.join(dir, e.name));
        next.push(...deeper);
        level = deeper;
      }
    } else if (GLOB.test(seg)) {
      const re = segmentRegex(seg);
      for (const dir of current) for (const e of await readdir(dir).catch(() => [] as string[])) if (re.test(e)) next.push(path.join(dir, e));
    } else {
      for (const dir of current) {
        const p = path.join(dir, seg);
        // Only the last segment may be a file; the rest must be folders that exist.
        const s = await stat(p).catch(() => null);
        if (s && (s.isDirectory() || i === parts.length - 2)) next.push(p);
      }
    }
    current = [...new Set(next)];
    if (!current.length) return [];
  }
  const out: string[] = [];
  for (const p of current) if (await stat(p).catch(() => null)) out.push(p);
  return out;
}

/** The saves (and settings) a store game has on this PC right now. */
export async function findStoreSaves(locations: SaveLocation[], installDir: string | null): Promise<FoundSave[]> {
  const found = new Map<string, FoundSave>();
  for (const l of locations) {
    const pattern = fillTemplate(l.template, installDir);
    if (!pattern) continue;
    for (const p of await globPaths(pattern)) {
      const key = path.resolve(p).toLowerCase();
      // A file inside a folder already being backed up isn't copied twice.
      if ([...found.keys()].some((k) => key.startsWith(k + path.sep))) continue;
      for (const k of [...found.keys()]) if (k.startsWith(key + path.sep)) found.delete(k);
      found.set(key, { template: l.template, path: path.resolve(p) });
    }
  }
  return [...found.values()];
}

/** Zips a store game's saves from wherever they are, with a map of where each came from, and uploads it. */
export async function backupStoreSaves(api: GameServerClient, sevenZip: SevenZip, key: string, locations: SaveLocation[], installDir: string | null, device: string): Promise<SaveBackup & { files: number }> {
  const found = await findStoreSaves(locations, installDir);
  if (!found.length) throw new Error("No saves found on this PC yet");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gm-ssave-"));
  try {
    const stage = path.join(tmp, "stage");
    const entries: Array<{ dir: string; name: string; original: string; template: string }> = [];
    for (const [i, f] of found.entries()) {
      const dir = String(i);
      const name = path.basename(f.path);
      await mkdir(path.join(stage, dir), { recursive: true });
      await cp(f.path, path.join(stage, dir, name), { recursive: true, force: true, errorOnExist: false });
      entries.push({ dir, name, original: f.path, template: f.template });
    }
    await writeFile(path.join(stage, MAP_FILE), JSON.stringify({ version: 1, platform: process.platform, entries }, null, 2));
    const zip = path.join(tmp, "save.zip");
    await run7z(sevenZip, ["a", "-tzip", "-bd", "-y", zip, "*"], stage);
    const saved = await api.uploadSave(key, await readFile(zip), device);
    return { ...saved, files: found.length };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Puts a backup's files back where they came from. Each place must still be one of the game's
 * save locations on this PC, so a backup can't write anywhere else. What was there is kept
 * in `keepDir` first.
 */
export async function restoreStoreSaves(api: GameServerClient, sevenZip: SevenZip, key: string, saveId: number, locations: SaveLocation[], installDir: string | null, keepDir: string): Promise<{ restored: number; previous: string }> {
  const data = await api.downloadSave(key, saveId);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gm-ssave-"));
  try {
    const zip = path.join(tmp, "save.zip");
    await writeFile(zip, data);
    const out = path.join(tmp, "out");
    await mkdir(out, { recursive: true });
    await extractArchive(sevenZip, "zip", zip, out);
    const map = JSON.parse(await readFile(path.join(out, MAP_FILE), "utf8").catch(() => "{}")) as { entries?: Array<{ dir: string; name: string; original: string }> };
    if (!Array.isArray(map.entries) || !map.entries.length) throw new Error("That backup has no list of where its files go");
    const patterns = locations.map((l) => fillTemplate(l.template, installDir)).filter((p): p is string => !!p);
    for (const e of map.entries) {
      if (typeof e.original !== "string" || !path.isAbsolute(e.original) || !patterns.some((p) => matchesPattern(p, e.original))) {
        throw new Error(`The backup wants to write to ${e.original}, which isn't one of this game's save places here`);
      }
      if (!/^\d+$/.test(e.dir) || path.basename(e.name) !== e.name) throw new Error("That backup's list of files is damaged");
    }
    const previous = path.join(keepDir, `${key.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    for (const e of map.entries) {
      const from = path.join(out, e.dir, e.name);
      if (!(await stat(from).catch(() => null))) continue;
      if (await stat(e.original).catch(() => null)) {
        await mkdir(path.join(previous, e.dir), { recursive: true });
        await cp(e.original, path.join(previous, e.dir, path.basename(e.original)), { recursive: true, force: true });
        await rm(e.original, { recursive: true, force: true });
      }
      await mkdir(path.dirname(e.original), { recursive: true });
      await cp(from, e.original, { recursive: true, force: true });
    }
    return { restored: map.entries.length, previous };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
