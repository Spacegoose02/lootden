import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseTruckManifest,
  TRUCK_GAMES,
  truckGameVersionFromLog,
  truckModFileName,
  truckModFit,
  truckModType,
  type InstalledTruckMod,
  type TruckGame,
  type TruckModFile,
  type TruckModManifest,
} from "@lootden/shared";
import { extractArchive, type SevenZip } from "./extractor.js";

/**
 * Mods for ATS and ETS2 on this PC. The games load every .scs (or .zip) in the "mod" folder of
 * their Documents folder; LootDen keeps a list of the files it put there (.lootden-mods.json) so
 * it only ever removes its own.
 */

export const TRUCK_MODS_LIST = ".lootden-mods.json";

/**
 * The game's mod folder: Documents\<game>\mod on Windows, ~/.local/share/<game>/mod for the
 * native Linux builds. documents is the real Documents folder (Electron knows it when it's been
 * moved into OneDrive); a set folder (a custom -homedir) wins over both.
 */
export function truckModsFolder(game: TruckGame, opts: { platform?: NodeJS.Platform; documents?: string; home?: string; custom?: string | null } = {}): string {
  if (opts.custom?.trim()) return path.resolve(opts.custom.trim());
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? os.homedir();
  const folder = TRUCK_GAMES[game].folder;
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  if (platform === "win32") return join(opts.documents ?? join(process.env.USERPROFILE ?? home, "Documents"), folder, "mod");
  return join(home, ".local", "share", folder, "mod");
}

interface ListFile {
  mods: InstalledTruckMod[];
}

async function readList(modDir: string): Promise<InstalledTruckMod[]> {
  const raw = await readFile(path.join(modDir, TRUCK_MODS_LIST), "utf8").catch(() => "");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<ListFile>;
    return (parsed.mods ?? []).filter((m) => m && Array.isArray(m.files) && m.files.every((f) => typeof f === "string" && f === path.basename(f)));
  } catch {
    return [];
  }
}

async function writeList(modDir: string, mods: InstalledTruckMod[]): Promise<void> {
  const file = path.join(modDir, TRUCK_MODS_LIST);
  await writeFile(`${file}.tmp`, JSON.stringify({ mods } satisfies ListFile, null, 2));
  await rename(`${file}.tmp`, file);
}

/** One key per installed mod: the server's id, or its first file for one only on this PC. */
export function installedTruckModKey(m: Pick<InstalledTruckMod, "serverId" | "files">): string {
  return m.serverId !== null ? `server:${m.serverId}` : `file:${m.files[0] ?? ""}`;
}

/** The mods LootDen put in the folder whose files are still there, newest first. */
export async function listTruckMods(modDir: string): Promise<InstalledTruckMod[]> {
  const mods = await readList(modDir);
  return mods.filter((m) => m.files.some((f) => existsSync(path.join(modDir, f)))).sort((a, b) => b.installedAt.localeCompare(a.installedAt));
}

/** The mod files in an unpacked archive: every .scs, at any depth; else zips that are mods themselves. */
async function modFilesIn(dir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await modFilesIn(full, depth + 1)));
    else if (e.isFile() && /\.scs$/i.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * Puts a downloaded mod in the game's mod folder: a .scs as it is, an archive unpacked to the
 * .scs files inside it. A .zip with no .scs inside is taken to be a mod itself (the games load
 * zipped mods too). Installing the same mod again (same server id or file name) replaces it.
 */
export async function installTruckMod(
  downloaded: string,
  modDir: string,
  info: { serverId: number | null; title: string; fileName: string; sourceUrl?: string | null },
  sevenZip: SevenZip | null,
): Promise<InstalledTruckMod> {
  const fileName = truckModFileName(info.fileName);
  const type = truckModType(fileName)!;
  await mkdir(modDir, { recursive: true });
  const list = await readList(modDir);
  const same = (m: InstalledTruckMod) => (info.serverId !== null && m.serverId === info.serverId) || (!!m.fileName && m.fileName.toLowerCase() === fileName.toLowerCase());
  const previous = list.filter(same);

  let work: string | null = null;
  const sources: Array<{ from: string; name: string }> = [];
  try {
    if (type === "scs") {
      sources.push({ from: downloaded, name: fileName });
    } else {
      if (!sevenZip) throw new Error("7-Zip is needed to unpack mod archives");
      work = await mkdtemp(path.join(os.tmpdir(), "lootden-truckmod-"));
      await extractArchive(sevenZip, type, downloaded, work);
      const found = await modFilesIn(work);
      if (found.length) {
        const seen = new Set<string>();
        for (const f of found) {
          let name = path.basename(f);
          // Two .scs with one name in different folders: keep both.
          for (let i = 2; seen.has(name.toLowerCase()); i++) name = path.basename(f).replace(/\.scs$/i, ` (${i}).scs`);
          seen.add(name.toLowerCase());
          sources.push({ from: f, name });
        }
      } else if (type === "zip" && existsSync(path.join(work, "manifest.sii"))) {
        sources.push({ from: downloaded, name: fileName });
      } else {
        throw new Error(`There's no mod (.scs file) inside ${fileName}`);
      }
    }

    // Out with the old version's files, then in with the new.
    for (const m of previous) for (const f of m.files) await rm(path.join(modDir, f), { force: true });
    for (const s of sources) await copyFile(s.from, path.join(modDir, s.name));
  } finally {
    if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  const mod: InstalledTruckMod = {
    serverId: info.serverId,
    title: String(info.title || fileName).slice(0, 200),
    files: sources.map((s) => s.name),
    installedAt: new Date().toISOString(),
    sourceUrl: info.sourceUrl ?? null,
    fileName,
  };
  // Another mod that claimed one of these file names no longer owns it.
  const taken = new Set(mod.files.map((f) => f.toLowerCase()));
  const rest = list
    .filter((m) => !same(m))
    .map((m) => ({ ...m, files: m.files.filter((f) => !taken.has(f.toLowerCase())) }))
    .filter((m) => m.files.length);
  await writeList(modDir, [mod, ...rest]);
  return mod;
}

/** Takes a mod LootDen installed out of the mod folder (by installedTruckModKey). */
export async function removeTruckMod(modDir: string, key: string): Promise<void> {
  const list = await readList(modDir);
  const mod = list.find((m) => installedTruckModKey(m) === key);
  if (!mod) throw new Error("LootDen didn't install that mod");
  for (const f of mod.files) await rm(path.join(modDir, f), { force: true });
  await writeList(modDir, list.filter((m) => m !== mod));
}

/** After a mod is kept on the server, the copy installed here is linked to it (so it shows as shared). */
export async function linkTruckMod(modDir: string, key: string, serverId: number): Promise<void> {
  const list = await readList(modDir);
  const mod = list.find((m) => installedTruckModKey(m) === key);
  if (!mod) return;
  mod.serverId = serverId;
  await writeList(modDir, list.filter((m) => m === mod || m.serverId !== serverId));
}

// ---- Which mods fit the game ------------------------------------------------------------

/** What the mod folder's game reports as its version in game.log.txt (beside the mod folder), or null. */
export async function truckGameVersion(modDir: string): Promise<string | null> {
  const log = await readFile(path.join(path.dirname(modDir), "game.log.txt"), "utf8").catch(() => "");
  // The version is near the top; no need to read a long log's whole tail.
  return log ? truckGameVersionFromLog(log.slice(0, 20_000)) : null;
}

/**
 * A mod's manifest.sii, read with 7-Zip: works for mods packed as zip (most of them, and every
 * .zip mod); mods packed in SCS's own HashFS format can't be read, which gives null.
 */
export function readTruckManifest(file: string, sevenZip: SevenZip, timeoutMs = 15_000): Promise<TruckModManifest | null> {
  return new Promise((resolve) => {
    const child = spawn(sevenZip.path, ["e", "-so", "-bd", "-pgm-no-password", file, "manifest.sii"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (d: Buffer) => {
      size += d.length;
      if (size > 256 * 1024) return child.kill();
      chunks.push(d);
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", () => (clearTimeout(timer), resolve(null)));
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8");
      resolve(code === 0 && /SiiNunit|mod_package/i.test(text) ? parseTruckManifest(text) : null);
    });
  });
}

const CACHE = ".lootden-mods-cache.json";
type ManifestCache = Record<string, { size: number; mtime: number; manifest: TruckModManifest | null }>;

/**
 * Every mod in the folder (LootDen's and the ones put there by hand) with what its manifest says
 * and whether it fits gameVersion. Manifests are remembered by file size and date, so only new
 * or changed mods are opened.
 */
export async function scanTruckMods(modDir: string, sevenZip: SevenZip | null, gameVersion: string | null): Promise<TruckModFile[]> {
  const names = (await readdir(modDir).catch(() => [] as string[])).filter((n) => /\.(scs|zip)$/i.test(n));
  const cachePath = path.join(modDir, CACHE);
  const cache: ManifestCache = await readFile(cachePath, "utf8").then((t) => JSON.parse(t) as ManifestCache, () => ({}));
  const fresh: ManifestCache = {};
  const owners = new Map<string, string>();
  for (const m of await readList(modDir)) for (const f of m.files) owners.set(f.toLowerCase(), installedTruckModKey(m));
  const out: TruckModFile[] = [];
  let changed = false;
  for (const file of names) {
    const s = await stat(path.join(modDir, file)).catch(() => null);
    if (!s?.isFile()) continue;
    const hit = cache[file];
    let manifest: TruckModManifest | null;
    if (hit && hit.size === s.size && hit.mtime === s.mtimeMs) manifest = hit.manifest;
    else {
      manifest = sevenZip ? await readTruckManifest(path.join(modDir, file), sevenZip) : null;
      changed = true;
    }
    if (sevenZip || hit) fresh[file] = { size: s.size, mtime: s.mtimeMs, manifest };
    out.push({
      file,
      sizeBytes: s.size,
      modifiedAt: s.mtime.toISOString(),
      manifest,
      fit: truckModFit(manifest?.compatibleVersions ?? [], gameVersion),
      installedKey: owners.get(file.toLowerCase()) ?? null,
    });
  }
  if (changed || Object.keys(cache).length !== Object.keys(fresh).length) await writeFile(cachePath, JSON.stringify(fresh)).catch(() => {});
  return out.sort((a, b) => a.file.localeCompare(b.file, undefined, { sensitivity: "base" }));
}
