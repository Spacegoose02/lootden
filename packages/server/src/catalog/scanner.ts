import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { archiveKindOf, packageInfo, PC_PLATFORM, platformFor, romTitle, setupKindOf, versionFromFiles, type GameFile, type GameSummary } from "@lootden/shared";

/** What the scanner knows from disk alone; the library adds database and metadata fields. */
export type ScannedGame = Pick<
  GameSummary,
  "id" | "title" | "source" | "layout" | "platform" | "sizeBytes" | "fileCount" | "packed" | "needsSetup" | "modifiedAt" | "kind" | "version" | "fromVersion"
> & {
  /** For updates and DLC: the game's name without the update wording, for finding the base game. */
  baseTitle: string;
  files: GameFile[];
  /** The game folder's (or file's) own "Date modified", which moves when a game is copied in. */
  entryModifiedAt: string;
};

/** Files that are never part of a game (OS clutter, partial transfers). */
const IGNORED = /^(\..*|thumbs\.db|desktop\.ini|.*\.(part|crdownload|!qb|tmp|importing))$/i;

export function gameIdFor(source: string): string {
  return createHash("sha1").update(source).digest("hex").slice(0, 12);
}

/** Turns "The.Sims.4_v1.2" style names into something readable. Metadata providers will replace this later. */
export function titleFromSource(source: string, isArchive: boolean): string {
  let name = source;
  if (isArchive) name = name.replace(/(\.part\d+)?\.(zip|7z|rar)(\.\d{3})?$/i, "");
  name = name.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return name || source;
}

/** "Cyberpunk.2077.Update.v2.1-GOG.zip" -> "Cyberpunk 2077 Update v2.1": keeps the dots in version numbers. */
export function packageTitle(name: string): string {
  const t = name
    .replace(/(\.part\d+)?\.(zip|7z|rar|exe|msi)(\.\d{3})?$/i, "")
    .replace(/-[A-Z0-9]{2,}$/, "")
    .replace(/(?<!\d)\.|\.(?!\d)|_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t || name;
}

async function walk(root: string, rel = ""): Promise<GameFile[]> {
  const out: GameFile[] = [];
  const entries = await readdir(path.join(root, rel), { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (IGNORED.test(entry.name)) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await walk(root, relPath)));
    } else if (entry.isFile()) {
      const s = await stat(path.join(root, relPath));
      out.push({
        index: 0,
        path: relPath,
        size: s.size,
        modifiedAt: s.mtime.toISOString(),
        archive: archiveKindOf(entry.name),
      });
    }
  }
  return out;
}

/** Top-level folders that hold emulated systems instead of being a game. */
export const EMULATION_FOLDERS = /^(emulation|roms)$/i;
/** Top-level folders whose entries are all updates (or DLC) for other games. */
export const UPDATE_FOLDERS = /^(updates|patches)$/i;
export const DLC_FOLDERS = /^dlcs?$/i;

function summarize(
  id: string,
  source: string,
  layout: ScannedGame["layout"],
  files: GameFile[],
  platform: string,
  entryModifiedAt: string,
  folderHint?: "update" | "dlc",
): ScannedGame {
  files.forEach((f, i) => (f.index = i));
  const newest = files.reduce((max, f) => (f.modifiedAt > max ? f.modifiedAt : max), "");
  const name = path.posix.basename(source);
  // Update and DLC packages are recognised by name ("Game Update v1.3") or by sitting in an Updates or DLC folder.
  const pkg = platform === PC_PLATFORM ? packageInfo(name, folderHint) : { kind: "game" as const, baseTitle: name, version: null, fromVersion: null };
  return {
    kind: pkg.kind,
    baseTitle: pkg.baseTitle,
    // A game folder whose name doesn't say ("Critter Cove") may still hold a named installer.
    version: pkg.version ?? (pkg.kind === "game" && platform === PC_PLATFORM && layout === "folder" ? versionFromFiles(files) : null),
    fromVersion: pkg.fromVersion,
    id,
    title: pkg.kind !== "game" ? packageTitle(name) : platform === PC_PLATFORM ? titleFromSource(name, layout === "archive") : romTitle(name, layout !== "folder") || name,
    source,
    layout,
    platform,
    sizeBytes: files.reduce((sum, f) => sum + f.size, 0),
    fileCount: files.length,
    packed: files.some((f) => f.archive !== undefined),
    // Emulators play disc images as they are; only PC discs and installers need setting up.
    // An update's setup program runs over the installed game, so it isn't one to set up on the server.
    needsSetup: platform === PC_PLATFORM && pkg.kind === "game" ? setupKindOf(files) : null,
    modifiedAt: newest || new Date(0).toISOString(),
    entryModifiedAt,
    files,
  };
}

/**
 * Scans the library root. Each top-level folder is one game; each top-level
 * archive file is one game. Loose non-archive files at the root are ignored.
 * Split archives at the root (Game.part1.rar, Game.part2.rar) belong in a folder.
 */
export async function scanLibrary(gamesDir: string): Promise<ScannedGame[]> {
  const games: ScannedGame[] = [];
  for (const entry of await readdir(gamesDir, { withFileTypes: true })) {
    if (IGNORED.test(entry.name)) continue;
    if (entry.isDirectory() && EMULATION_FOLDERS.test(entry.name)) {
      games.push(...(await scanEmulation(gamesDir, entry.name)));
      continue;
    }
    if (entry.isDirectory() && (UPDATE_FOLDERS.test(entry.name) || DLC_FOLDERS.test(entry.name))) {
      const hint = UPDATE_FOLDERS.test(entry.name) ? "update" : "dlc";
      for (const inner of await readdir(path.join(gamesDir, entry.name), { withFileTypes: true }).catch(() => [])) {
        if (IGNORED.test(inner.name)) continue;
        const pkg = await scanEntry(gamesDir, `${entry.name}/${inner.name}`, inner.isDirectory(), PC_PLATFORM, hint);
        if (pkg) games.push(pkg);
      }
      continue;
    }
    const game = await scanEntry(gamesDir, entry.name, entry.isDirectory(), PC_PLATFORM);
    if (game) games.push(game);
  }
  return games.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
}

/** Emulation/<platform>/<game>: every file or folder inside a platform folder is one game. */
async function scanEmulation(gamesDir: string, folder: string): Promise<ScannedGame[]> {
  const games: ScannedGame[] = [];
  const systems = await readdir(path.join(gamesDir, folder), { withFileTypes: true }).catch(() => []);
  for (const system of systems) {
    if (!system.isDirectory() || IGNORED.test(system.name) || /^(bios|system|firmware)$/i.test(system.name)) continue;
    const platform = platformFor(system.name).id;
    const dir = `${folder}/${system.name}`;
    const entries = await readdir(path.join(gamesDir, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (IGNORED.test(entry.name)) continue;
      const game = await scanEntry(gamesDir, `${dir}/${entry.name}`, entry.isDirectory(), platform);
      if (game) games.push(game);
    }
  }
  return games;
}

async function scanEntry(gamesDir: string, source: string, isDir: boolean, platform: string, folderHint?: "update" | "dlc"): Promise<ScannedGame | null> {
  const full = path.join(gamesDir, source);
  const name = path.posix.basename(source);
  try {
    if (isDir) {
      const files = await walk(full);
      // Unpacked files keep the dates from inside the archive, so the folder's own date says when it arrived.
      return files.length ? summarize(gameIdFor(source), source, "folder", files, platform, (await stat(full)).mtime.toISOString(), folderHint) : null;
    }
    const archive = archiveKindOf(name);
    // Loose files at the top are only games when they're archives; inside a platform folder any file is a ROM.
    // A patch can be a single setup program, so loose .exe/.msi files count inside an Updates or DLC folder.
    if (!archive && platform === PC_PLATFORM && !(folderHint && /\.(exe|msi)$/i.test(name))) return null;
    const s = await stat(full);
    if (!s.isFile()) return null;
    return summarize(gameIdFor(source), source, archive ? "archive" : "file", [{ index: 0, path: name, size: s.size, modifiedAt: s.mtime.toISOString(), archive }], platform, s.mtime.toISOString(), folderHint);
  } catch (err) {
    // One unreadable folder should not take down the whole library.
    console.warn(`Skipping ${source}: ${(err as Error).message}`);
    return null;
  }
}

/** Absolute path of a game file on disk, refusing anything that escapes the library root. */
export function resolveGameFile(gamesDir: string, game: Pick<ScannedGame, "layout" | "source">, file: GameFile): string {
  const base = game.layout === "folder" ? path.join(gamesDir, game.source) : path.join(gamesDir, path.posix.dirname(game.source));
  const full = path.resolve(base, file.path);
  const root = path.resolve(gamesDir) + path.sep;
  if (!full.startsWith(root)) throw new Error("Path escapes the games folder");
  return full;
}
