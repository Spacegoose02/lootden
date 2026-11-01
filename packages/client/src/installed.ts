import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { effectiveVersion, safeFolderName, setupKindOf } from "@lootden/shared";
import { isManifest, LEGACY_MANIFEST_NAME, MANIFEST_NAME } from "./installer.js";
import type { AppliedUpdate } from "./updates.js";
import { exeVersion } from "./exeversion.js";

export interface InstalledGame {
  gameId: string;
  title: string;
  dir: string;
  installedAt: string;
  /** Executable chosen to launch the game, relative to dir (or absolute when installed elsewhere), once known. */
  executable?: string;
  /** "pc", or the emulated system (played through an emulator instead of an executable). */
  platform: string;
  /** The game's file or folder name on the server, for finding the copy again if its id changes. */
  source?: string;
  /** The download is still a disc image or installer that has to be run before Play works. */
  needsSetup?: "disc" | "installer" | null;
  /** Where the installer put the game, once it has been run. */
  installedDir?: string;
  /** The game's version, from the server's file name at install time and raised by each update. */
  version?: string | null;
  /** Updates and DLC applied to this copy, oldest first. */
  updates?: AppliedUpdate[];
  /** Which computer last set version, when, and how. */
  versionSetBy?: VersionTag | null;
  /**
   * The executable's size and modified time when LootDen last wrote or checked it. While the
   * exe still matches, nothing outside LootDen has touched the game.
   */
  exeStamp?: ExeStamp | null;
  /**
   * The version stamped on the game's executable, read each time games are listed (not saved),
   * and only when the exe changed since LootDen last saw it (so null while it hasn't).
   * Shows an update made outside LootDen, such as by the game's own launcher.
   */
  exeVersion?: string | null;
}

export interface VersionTag {
  how: "install" | "update" | "undo" | "backfill";
  device: string;
  at: string;
}

export interface ExeStamp {
  size: number;
  mtimeMs: number;
}

/** A tag for a version LootDen is writing now, on this computer. */
export function versionTag(how: VersionTag["how"]): VersionTag {
  return { how, device: os.hostname(), at: new Date().toISOString() };
}

/** The version LootDen knows a copy is at: the manifest's, or the newest an applied update recorded. */
export function knownVersion(g: Pick<InstalledGame, "version" | "updates">): string | null {
  return g.version ?? [...(g.updates ?? [])].reverse().find((u) => u.version)?.version ?? null;
}

function exePath(g: Pick<InstalledGame, "dir" | "executable">): string | null {
  if (!g.executable) return null;
  return path.isAbsolute(g.executable) ? g.executable : path.join(g.dir, g.executable);
}

/** The game's executable as it is now, or null when it has none (yet). */
export async function exeStampOf(g: Pick<InstalledGame, "dir" | "executable">): Promise<ExeStamp | null> {
  const exe = exePath(g);
  if (!exe) return null;
  const s = await stat(exe).catch(() => null);
  return s?.isFile() ? { size: s.size, mtimeMs: Math.round(s.mtimeMs) } : null;
}

const sameStamp = (a: ExeStamp | null | undefined, b: ExeStamp | null) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** The manifest file's contents: .lootden.json, or .game-manager.json from before the rename. */
async function readManifestFile(dir: string): Promise<Record<string, unknown> | null> {
  for (const name of [MANIFEST_NAME, LEGACY_MANIFEST_NAME]) {
    const text = await readFile(path.join(dir, name), "utf8").catch(() => null);
    if (text !== null) return JSON.parse(text);
  }
  return null;
}

async function readManifest(dir: string): Promise<InstalledGame | null> {
  try {
    const m = (await readManifestFile(dir)) as Record<string, any> | null;
    if (!m) return null;
    if (typeof m.gameId !== "string") return null;
    return {
      gameId: m.gameId,
      title: m.title ?? path.basename(dir),
      dir,
      installedAt: m.installedAt ?? "",
      executable: m.executable,
      platform: m.platform ?? "pc",
      source: m.source,
      needsSetup: m.needsSetup,
      installedDir: m.installedDir,
      version: m.version ?? null,
      updates: Array.isArray(m.updates) ? m.updates : [],
      versionSetBy: m.versionSetBy ?? null,
      exeStamp: m.exeStamp ?? null,
    };
  } catch {
    return null;
  }
}

/** Merges fields into a game's install manifest. */
export async function saveManifest(dir: string, patch: Record<string, unknown>): Promise<void> {
  const m = (await readManifestFile(dir)) ?? {};
  await writeFile(path.join(dir, MANIFEST_NAME), JSON.stringify({ ...m, ...patch }, null, 2) + "\n");
  // Written under the new name now, so the old file can go.
  await rm(path.join(dir, LEGACY_MANIFEST_NAME), { force: true });
}

async function listFiles(dir: string, depth: number, rel = "", out: string[] = []): Promise<string[]> {
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory() && depth > 0) await listFiles(dir, depth - 1, r, out);
    else if (e.isFile() && !isManifest(e.name)) out.push(r);
  }
  return out;
}

/** Whether a downloaded folder is still a disc image or installer rather than the game itself. */
export async function detectSetup(dir: string): Promise<"disc" | "installer" | null> {
  return setupKindOf((await listFiles(dir, 3)).map((p) => ({ path: p })));
}

/**
 * Installed PC games whose manifest doesn't say yet whether they need setting up (installs
 * from older apps) are checked once and the answer saved.
 */
async function withSetupKnown(g: InstalledGame): Promise<InstalledGame> {
  if (g.needsSetup !== undefined || g.platform !== "pc" || g.executable) return g;
  const needsSetup = await detectSetup(g.dir);
  await saveManifest(g.dir, { needsSetup }).catch(() => {});
  return { ...g, needsSetup };
}

/**
 * Fills in what an install from an older app is missing, once: the version, from the newest
 * update LootDen applied to it.
 */
async function withVersionKnown(g: InstalledGame): Promise<InstalledGame> {
  if (g.version) return g;
  const version = knownVersion(g);
  if (!version) return g;
  const versionSetBy = versionTag("backfill");
  await saveManifest(g.dir, { version, versionSetBy }).catch(() => {});
  return { ...g, version, versionSetBy };
}

/**
 * Reads the exe's version only when the exe changed since LootDen last wrote or checked it,
 * which is the sign the game was updated outside LootDen. An install from an older app has no
 * stamp yet: it's saved now, unless the exe already reads newer than what LootDen knows.
 */
async function withExeVersion(g: InstalledGame): Promise<InstalledGame> {
  if (g.platform !== "pc") return g;
  const stamp = await exeStampOf(g);
  if (!stamp) return g;
  if (sameStamp(g.exeStamp, stamp)) return { ...g, exeVersion: null };
  const read = { ...g, exeVersion: await exeVersion(exePath(g)!) };
  if (!g.exeStamp && !effectiveVersion(read).fromExe) {
    await saveManifest(g.dir, { exeStamp: stamp }).catch(() => {});
    return { ...read, exeStamp: stamp, exeVersion: null };
  }
  return read;
}

/** Finds installed games by their manifest in each install folder (one level deep). */
export async function listInstalled(installDirs: string[]): Promise<InstalledGame[]> {
  const out: InstalledGame[] = [];
  const seen = new Set<string>();
  for (const root of installDirs) {
    let entries: string[] = [];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const m = await readManifest(path.join(root, name));
      const key = path.resolve(path.join(root, name)).toLowerCase();
      if (m && !seen.has(key)) {
        seen.add(key);
        out.push(await withExeVersion(await withVersionKnown(await withSetupKnown(m))));
      }
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

export interface GameRef {
  id: string;
  title: string;
  source: string;
  platform: string;
}

const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/**
 * Looks for copies of a game already on this computer, so it never gets downloaded twice:
 * an install whose manifest has its id, or the same server file or title (the id changes
 * when an admin replaces an installer with the installed game), and folders named after
 * the game that have files but no manifest (a copy made by hand, or an install from before).
 */
export async function findCopies(installDirs: string[], game: GameRef): Promise<{ installed: InstalledGame | null; relinked: boolean; loose: string[] }> {
  const all = await listInstalled(installDirs);
  const byId = all.find((g) => g.gameId === game.id);
  if (byId) return { installed: byId, relinked: false, loose: [] };
  const other = all.find((g) => g.platform === game.platform && (same(g.source, game.source) || same(g.title, game.title)));
  if (other) {
    await saveManifest(other.dir, { gameId: game.id, title: game.title, source: game.source });
    return { installed: { ...other, gameId: game.id, title: game.title, source: game.source }, relinked: true, loose: [] };
  }
  const loose: string[] = [];
  const folder = safeFolderName(game.title);
  for (const root of new Set(installDirs.map((d) => path.resolve(d)))) {
    const dir = path.join(root, folder);
    const entries = await readdir(dir).catch(() => [] as string[]);
    if (entries.length && !entries.some(isManifest)) loose.push(dir);
  }
  return { installed: null, relinked: false, loose };
}

/** Marks a folder the user already has as this game's install, without downloading anything. */
export async function adoptFolder(dir: string, game: GameRef): Promise<InstalledGame> {
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`${dir} is not a folder`);
  const needsSetup = game.platform === "pc" ? await detectSetup(dir) : null;
  await rm(path.join(dir, LEGACY_MANIFEST_NAME), { force: true });
  await writeFile(
    path.join(dir, MANIFEST_NAME),
    JSON.stringify({ gameId: game.id, title: game.title, source: game.source, platform: game.platform, needsSetup, installedAt: new Date().toISOString(), adopted: true }, null, 2) + "\n",
  );
  return (await readManifest(dir))!;
}

/**
 * Deletes an installed game folder. Refuses any folder without our manifest, so a
 * wrong path can never wipe something the app did not install.
 */
export async function uninstallGame(dir: string): Promise<InstalledGame> {
  const m = await readManifest(dir);
  if (!m) throw new Error(`${dir} is not a LootDen install (no ${MANIFEST_NAME}); not deleting it`);
  const s = await stat(dir);
  if (!s.isDirectory()) throw new Error(`${dir} is not a folder`);
  await rm(dir, { recursive: true, force: true });
  return m;
}
