import { createHash } from "node:crypto";
import { copyFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { groupArchiveSets } from "@lootden/shared";
import type { GameServerClient } from "./api.js";
import { downloadFile } from "./downloader.js";
import { extractArchive, findSevenZip } from "./extractor.js";
import { isManifest } from "./installer.js";
import type { RateLimiter } from "./throttle.js";

/** The list of files an install put down, kept beside the manifest so the install can be checked later. */
export const FILES_NAME = ".lootden-files.json";
const REPAIR_DIR = ".lootden-repair";
/** Folders the app keeps its own things in: never part of the game's files. */
const OWN = new Set([FILES_NAME, REPAIR_DIR, ".lootden-backup", ".lootden-updates"]);
/** Files games rewrite as they run (settings, logs): checked to exist, not for their contents. */
const CHANGING = /\.(ini|cfg|conf|config|json|xml|txt|log|dat|sav|save|yaml|yml|toml|lua|bak|tmp)$/i;
const SAMPLE = 64 * 1024;

export interface FileRecord {
  path: string;
  size: number;
  /** SHA-1 of the first and last 64 KB: catches damaged files without reading whole games. */
  sample: string;
}

export interface VerifyResult {
  /** "install": against the list made when it was installed; "server": against the server's files (unpacked games). */
  basis: "install" | "server";
  checked: number;
  missing: string[];
  changed: string[];
}

async function sampleOf(full: string, size: number): Promise<string> {
  const h = createHash("sha1");
  const fh = await open(full, "r");
  try {
    const head = Buffer.alloc(Math.min(SAMPLE, size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (size > SAMPLE) {
      const tail = Buffer.alloc(Math.min(SAMPLE, size - SAMPLE));
      await fh.read(tail, 0, tail.length, size - tail.length);
      h.update(tail);
    }
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}

async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (!rel && (OWN.has(e.name) || isManifest(e.name))) continue;
    if (e.isDirectory()) out.push(...(await walk(root, r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** Records every file in a freshly installed game, for Verify files later. */
export async function recordFiles(gameDir: string): Promise<number> {
  const files: FileRecord[] = [];
  for (const rel of await walk(gameDir)) {
    const full = path.join(gameDir, ...rel.split("/"));
    const size = (await stat(full)).size;
    files.push({ path: rel, size, sample: await sampleOf(full, size) });
  }
  await writeFile(path.join(gameDir, FILES_NAME), JSON.stringify({ recordedAt: new Date().toISOString(), files }) + "\n");
  return files.length;
}

/** A game's own files with their sizes: the install's list when there is one, else every file in the folder. */
export async function listGameFiles(gameDir: string): Promise<Array<{ path: string; size: number }>> {
  const record = await readRecord(gameDir);
  if (record) {
    const out: Array<{ path: string; size: number }> = [];
    for (const f of record) {
      const size = await stat(path.join(gameDir, ...f.path.split("/"))).then((x) => x.size, () => -1);
      if (size >= 0) out.push({ path: f.path, size });
    }
    return out;
  }
  const out: Array<{ path: string; size: number }> = [];
  for (const rel of await walk(gameDir)) out.push({ path: rel, size: (await stat(path.join(gameDir, ...rel.split("/")))).size });
  return out;
}

export async function readRecord(gameDir: string): Promise<FileRecord[] | null> {
  try {
    const j = JSON.parse(await readFile(path.join(gameDir, FILES_NAME), "utf8")) as { files?: FileRecord[] };
    return Array.isArray(j.files) ? j.files : null;
  } catch {
    return null;
  }
}

async function check(gameDir: string, expected: Array<{ path: string; size: number; sample?: string }>, onProgress?: (done: number, total: number) => void): Promise<{ missing: string[]; changed: string[] }> {
  const missing: string[] = [];
  const changed: string[] = [];
  let i = 0;
  for (const f of expected) {
    onProgress?.(i++, expected.length);
    const full = path.join(gameDir, ...f.path.split("/"));
    if (!full.startsWith(path.resolve(gameDir) + path.sep)) continue;
    let size: number;
    try {
      size = (await stat(full)).size;
    } catch {
      missing.push(f.path);
      continue;
    }
    if (CHANGING.test(f.path)) continue;
    if (size !== f.size || (f.sample && (await sampleOf(full, size)) !== f.sample)) changed.push(f.path);
  }
  onProgress?.(expected.length, expected.length);
  return { missing, changed };
}

/**
 * Checks an installed game: against the list made when it was installed, or (installs from
 * before that list, unpacked games only) against the server's own files.
 */
export async function verifyGame(api: GameServerClient | null, gameId: string, gameDir: string, onProgress?: (done: number, total: number) => void): Promise<VerifyResult> {
  const record = await readRecord(gameDir);
  if (record) return { basis: "install", checked: record.length, ...(await check(gameDir, record, onProgress)) };
  if (!api) throw new Error("This install has no file list yet; connect to the server to check it");
  const game = await api.getGame(gameId);
  if (game.packed) throw new Error("This game was installed from an archive before LootDen kept file lists. Reinstall it once and Verify will work from then on.");
  const files = game.files.map((f) => ({ path: f.path, size: f.size }));
  return { basis: "server", checked: files.length, ...(await check(gameDir, files, onProgress)) };
}

export interface RepairOptions {
  sevenZipPath: string;
  limiter?: RateLimiter;
  signal?: AbortSignal;
  onProgress?: (step: string, received?: number, total?: number) => void;
}

/**
 * Fixes what Verify found: unpacked games get just the broken files downloaded again; games
 * that came as archives get the archives downloaded and unpacked to one side, and only the
 * broken files copied over, so settings and mods in the game's folder are left alone.
 */
export async function repairGame(api: GameServerClient, gameId: string, gameDir: string, broken: string[], opts: RepairOptions): Promise<number> {
  if (!broken.length) return 0;
  const game = await api.getGame(gameId);
  const want = new Set(broken);
  const inside = (rel: string) => {
    const full = path.resolve(gameDir, ...rel.split("/"));
    if (!full.startsWith(path.resolve(gameDir) + path.sep)) throw new Error(`Refusing unsafe path: ${rel}`);
    return full;
  };
  if (!game.packed) {
    let n = 0;
    for (const f of game.files.filter((x) => want.has(x.path))) {
      opts.signal?.throwIfAborted();
      const dest = inside(f.path);
      await rm(dest, { force: true });
      await rm(`${dest}.part`, { force: true });
      opts.onProgress?.(`Downloading ${f.path}`, 0, f.size);
      await downloadFile({ url: api.fileUrl(game.id, f.index), headers: api.headers(), dest, expectedSize: f.size, signal: opts.signal, limiter: opts.limiter, onProgress: (r, t) => opts.onProgress?.(`Downloading ${f.path}`, r, t) });
      n++;
    }
    await recordFiles(gameDir);
    return n;
  }
  const sevenZip = await findSevenZip(opts.sevenZipPath);
  if (!sevenZip) throw new Error("Repairing a packed game needs 7-Zip");
  const work = path.join(gameDir, REPAIR_DIR);
  const out = path.join(work, "files");
  await mkdir(out, { recursive: true });
  try {
    for (const f of game.files) {
      opts.signal?.throwIfAborted();
      const dest = path.resolve(work, "archives", ...f.path.split("/"));
      opts.onProgress?.(`Downloading ${f.path}`, 0, f.size);
      await downloadFile({ url: api.fileUrl(game.id, f.index), headers: api.headers(), dest, expectedSize: f.size, signal: opts.signal, limiter: opts.limiter, onProgress: (r, t) => opts.onProgress?.(`Downloading ${f.path}`, r, t) });
    }
    for (const set of groupArchiveSets(game.files.filter((f) => f.archive).map((f) => f.path))) {
      opts.onProgress?.(`Unpacking ${set.first}`);
      const first = path.resolve(work, "archives", ...set.first.split("/"));
      await extractArchive(sevenZip, set.kind, first, path.join(out, path.dirname(set.first)));
    }
    // Loose (not archived) files in a packed game come straight from the download.
    for (const f of game.files.filter((x) => !x.archive)) {
      const from = path.resolve(work, "archives", ...f.path.split("/"));
      await mkdir(path.dirname(path.join(out, f.path)), { recursive: true });
      await copyFile(from, path.join(out, ...f.path.split("/")));
    }
    // The install lifted a lone wrapper folder's contents up; look inside it the same way.
    let root = out;
    const top = (await readdir(out, { withFileTypes: true })).filter((e) => !isManifest(e.name));
    if (top.length === 1 && top[0]!.isDirectory() && !broken.some((b) => b.startsWith(`${top[0]!.name}/`))) root = path.join(out, top[0]!.name);
    let n = 0;
    for (const rel of broken) {
      const from = path.join(root, ...rel.split("/"));
      try {
        await stat(from);
      } catch {
        continue;
      }
      const to = inside(rel);
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
      n++;
    }
    await recordFiles(gameDir);
    return n;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

