import { mkdir, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { groupArchiveSets, safeFolderName, versionFromName, type GameDetail, type GameSummary } from "@lootden/shared";
import type { GameServerClient } from "./api.js";
import { downloadFile } from "./downloader.js";
import { extractArchive, findSevenZip } from "./extractor.js";
import { detectSetup } from "./installed.js";

export const MANIFEST_NAME = ".lootden.json";
/** The manifest's name before the rename to LootDen; still read, and replaced on the next write. */
export const LEGACY_MANIFEST_NAME = ".game-manager.json";
export const isManifest = (name: string) => name === MANIFEST_NAME || name === LEGACY_MANIFEST_NAME;

export type InstallEvent =
  | { type: "start"; game: GameDetail; gameDir: string }
  | { type: "download"; file: string; index: number; count: number; received: number; total: number }
  | { type: "downloaded"; file: string; skipped: boolean }
  | { type: "extract"; archive: string }
  | { type: "removed"; files: string[] }
  | { type: "warning"; message: string }
  | { type: "done"; gameDir: string };

export interface InstallOptions {
  /** Parent folder; the game goes in its own subfolder. Lets the user pick a drive per install. */
  installDir: string;
  keepArchives: boolean;
  sevenZipPath: string;
  /** Name reported to the server for play tracking; defaults to the computer name. */
  device?: string;
  /** Aborting stops the download; the .part file stays so the next install resumes. */
  signal?: AbortSignal;
  onEvent?: (event: InstallEvent) => void;
  /** False for scratch downloads (preparing a disc game) that shouldn't count as an install. */
  report?: boolean;
  /** False keeps a single wrapper folder as it is instead of lifting its contents up. */
  hoist?: boolean;
}

/** Resolves a user's argument to one game: exact id, exact title, then a unique partial title match. */
export function pickGame(games: GameSummary[], query: string): GameSummary {
  const q = query.trim().toLowerCase();
  const exact = games.find((g) => g.id === query || g.title.toLowerCase() === q || g.source.toLowerCase() === q);
  if (exact) return exact;
  const partial = games.filter((g) => g.title.toLowerCase().includes(q));
  if (partial.length === 1) return partial[0]!;
  if (partial.length === 0) throw new Error(`No game matches "${query}"`);
  throw new Error(`"${query}" matches ${partial.length} games: ${partial.slice(0, 8).map((g) => g.title).join(", ")}${partial.length > 8 ? ", ..." : ""}`);
}

function localPath(gameDir: string, relPath: string): string {
  const full = path.resolve(gameDir, ...relPath.split("/"));
  if (!full.startsWith(path.resolve(gameDir) + path.sep)) throw new Error(`Refusing unsafe path from server: ${relPath}`);
  return full;
}

/** Errors Windows gives while another program (antivirus, the search indexer) still has a file open. */
const LOCKED = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Renames, retrying for a while when the source is locked. Freshly unpacked files are often
 * still being scanned by antivirus, and Windows won't move a folder with an open file in it.
 */
export async function renameRetrying(from: string, to: string, waits = [100, 250, 500, 1000, 2000, 4000], move: (from: string, to: string) => Promise<void> = rename): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await move(from, to);
    } catch (err) {
      if (i >= waits.length || !LOCKED.has((err as NodeJS.ErrnoException).code ?? "")) throw err;
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

/**
 * Repacks often wrap everything in one folder; lift its contents up so the game isn't nested
 * twice. It's only tidying, so when Windows keeps the folder locked the game stays nested
 * (and still works) rather than failing the install. Returns a warning when that happens.
 */
export async function hoistSingleFolder(gameDir: string, move: (from: string, to: string) => Promise<void> = renameRetrying): Promise<string | null> {
  const entries = (await readdir(gameDir, { withFileTypes: true })).filter((e) => !isManifest(e.name));
  if (entries.length !== 1 || !entries[0]!.isDirectory()) return null;
  const name = entries[0]!.name;
  const wrapper = path.join(gameDir, `.gm-hoist-${Date.now()}`);
  try {
    await move(path.join(gameDir, name), wrapper);
  } catch (err) {
    return `Left the files inside "${name}" because Windows kept the folder locked (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). The game works from there.`;
  }
  const moved: string[] = [];
  try {
    for (const child of await readdir(wrapper)) {
      await move(path.join(wrapper, child), path.join(gameDir, child));
      moved.push(child);
    }
  } catch (err) {
    // Put back what was already lifted, so the files aren't split across two folders.
    for (const child of moved) await move(path.join(gameDir, child), path.join(wrapper, child)).catch(() => {});
    await move(wrapper, path.join(gameDir, name)).catch(() => {});
    return `Left the files inside "${name}" because Windows kept a file locked (${(err as NodeJS.ErrnoException).code ?? (err as Error).message}). The game works from there.`;
  }
  await rm(wrapper, { recursive: true, force: true });
  return null;
}

export async function installGame(api: GameServerClient, gameId: string, opts: InstallOptions): Promise<string> {
  const emit = opts.onEvent ?? (() => {});
  const game = await api.getGame(gameId);
  const empty = game.files.find((f) => f.archive && f.size === 0);
  if (empty) throw new Error(`${empty.path} is empty (0 bytes) on the server, so there's nothing to unpack. Delete it from the library and download it again.`);
  // Find 7-Zip before spending hours downloading.
  const sevenZip = game.packed ? await findSevenZip(opts.sevenZipPath) : null;
  if (game.packed && !sevenZip) throw new Error("This game is packed but 7-Zip was not found. Install 7-Zip or set sevenZipPath.");
  if (game.files.some((f) => f.archive === "rar") && sevenZip && !sevenZip.supportsRar) {
    throw new Error("This game contains RAR archives, which need a full 7-Zip install (only the bundled 7za was found).");
  }

  const gameDir = path.join(opts.installDir, safeFolderName(game.title));
  await mkdir(gameDir, { recursive: true });
  emit({ type: "start", game, gameDir });

  // Downloading packed games temporarily needs room for the archive and the unpacked files.
  try {
    const s = await statfs(gameDir);
    const free = s.bavail * s.bsize;
    if (free < game.sizeBytes) throw new Error(`Not enough space in ${opts.installDir}: need ${game.sizeBytes} bytes, ${free} free`);
    if (game.packed && free < game.sizeBytes * 2) {
      emit({ type: "warning", message: "Free space may run out while unpacking (archive and files exist side by side for a while)." });
    }
  } catch (err) {
    if ((err as Error).message.startsWith("Not enough space")) throw err;
  }

  for (const file of game.files) {
    const dest = localPath(gameDir, file.path);
    const fetched = await downloadFile({
      url: api.fileUrl(game.id, file.index),
      headers: api.headers(),
      dest,
      expectedSize: file.size,
      signal: opts.signal,
      onProgress: (received, total) =>
        emit({ type: "download", file: file.path, index: file.index, count: game.files.length, received, total }),
    });
    emit({ type: "downloaded", file: file.path, skipped: !fetched });
  }

  const archivePaths = game.files.filter((f) => f.archive).map((f) => f.path);
  for (const set of groupArchiveSets(archivePaths)) {
    opts.signal?.throwIfAborted();
    const first = localPath(gameDir, set.first);
    emit({ type: "extract", archive: set.first });
    await extractArchive(sevenZip!, set.kind, first, path.dirname(first));
    if (!opts.keepArchives) {
      // Only reached when 7-Zip reported success, so a failed unpack never loses the download.
      for (const volume of set.volumes) await rm(localPath(gameDir, volume), { force: true });
      emit({ type: "removed", files: set.volumes });
    }
  }
  if (archivePaths.length > 0 && !opts.keepArchives && opts.hoist !== false) {
    const warning = await hoistSingleFolder(gameDir);
    if (warning) emit({ type: "warning", message: warning });
  }

  // An installer inside an archive only shows once it's unpacked, so check the files we ended up with too.
  const needsSetup = game.platform === "pc" ? (game.needsSetup ?? (await detectSetup(gameDir))) : null;
  await rm(path.join(gameDir, LEGACY_MANIFEST_NAME), { force: true });
  await writeFile(
    path.join(gameDir, MANIFEST_NAME),
    JSON.stringify(
      { gameId: game.id, title: game.title, source: game.source, platform: game.platform, needsSetup, version: game.version ?? versionFromName(game.title) ?? versionFromName(game.source ?? "") ?? null, versionSetBy: { how: "install", device: opts.device ?? os.hostname(), at: new Date().toISOString() }, serverModifiedAt: game.modifiedAt, installedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
  if (opts.report !== false) await api.reportActivity({ gameId: game.id, device: opts.device ?? os.hostname(), event: "installed", installPath: gameDir });
  emit({ type: "done", gameDir });
  return gameDir;
}
