import { chmod, copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { archiveKindOf, compareVersion, effectiveVersion, groupArchiveSets, setupKindOf, versionFromName, type GameDetail } from "@lootden/shared";
import type { GameServerClient } from "./api.js";
import { extractArchive, findSevenZip } from "./extractor.js";
import { exeStampOf, knownVersion, saveManifest, versionTag, type InstalledGame } from "./installed.js";
import { installGame, isManifest, type InstallEvent } from "./installer.js";
import { findSetup, installerArgs } from "./prepare.js";

/** Kept in each game's folder: copies of the files an update replaced, so it can be undone. */
export const BACKUP_FOLDER = ".lootden-backup";

/** An update recorded in the game's install manifest. */
export interface AppliedUpdate {
  id: string;
  title: string;
  kind: "update" | "dlc";
  /** The version the game was at before, to put back on undo. */
  previousVersion: string | null;
  version: string | null;
  /** "files": copied over the game, with a backup. "installer": its setup program was run. */
  mode: "files" | "installer";
  appliedAt: string;
  /** The computer that applied it (missing in records from older apps). */
  device?: string;
  replaced: number;
  added: number;
}

export interface ApplyUpdateOptions {
  /** Scratch folder for the download; it's deleted afterwards. */
  workDir: string;
  sevenZipPath: string;
  /** Apply even when the versions don't line up, or it was applied before. */
  force?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: InstallEvent | { type: "apply"; mode: AppliedUpdate["mode"]; target: string }) => void;
  /** Runs an update's setup program and resolves when it closes (the desktop app shows it). Without it, such updates are refused. */
  runInstaller?: (setup: string, target: string, args: string[]) => Promise<void>;
}

/** Thrown when an update doesn't fit the installed version; `force` applies it anyway. */
export class UpdateMismatchError extends Error {}

async function listFiles(dir: string, rel = "", out: string[] = []): Promise<string[]> {
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await listFiles(dir, r, out);
    else if (e.isFile() && !(rel === "" && isManifest(e.name))) out.push(r);
  }
  return out;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/**
 * Where the update's files start. Patches are often wrapped in a folder named after the game
 * or the patch ("Game v1.3/bin/game.exe"); a wrapper that doesn't exist in the installed game
 * is skipped, so the files land on the ones they replace.
 */
async function overlayRoot(staged: string, target: string): Promise<string> {
  let root = staged;
  for (let i = 0; i < 3; i++) {
    const entries = (await readdir(root, { withFileTypes: true })).filter((e) => !isManifest(e.name));
    if (entries.length !== 1 || !entries[0]!.isDirectory()) break;
    const inner = path.join(root, entries[0]!.name);
    // A folder of the same name in the game is only a real match if it shares files with the
    // wrapper; one left by a hand-extracted copy of the patch shouldn't swallow the update.
    if ((await exists(path.join(target, entries[0]!.name))) && (await sharesMore(inner, path.join(target, entries[0]!.name), target))) break;
    root = inner;
  }
  return root;
}

/**
 * Unpacks an update that is still nothing but archives once downloaded, such as a .rar the
 * server zipped up without unpacking. Copied over the game as it was, the game would get the
 * .rar instead of the files inside it. Archives sitting among other files are left alone,
 * since they can be the game's own data.
 */
async function unpackLeftovers(staged: string, sevenZipPath: string, signal?: AbortSignal): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const files = await listFiles(staged);
    if (!files.length || !files.every((f) => archiveKindOf(f))) return;
    const sets = groupArchiveSets(files);
    if (!sets.length) return;
    const sevenZip = await findSevenZip(sevenZipPath);
    if (!sevenZip) throw new Error("This update is packed but 7-Zip was not found. Install 7-Zip or set sevenZipPath.");
    for (const set of sets) {
      signal?.throwIfAborted();
      const first = path.join(staged, ...set.first.split("/"));
      await extractArchive(sevenZip, set.kind, first, path.dirname(first));
      for (const v of set.volumes) await rm(path.join(staged, ...v.split("/")), { force: true });
    }
  }
}

/** Whether more of `dir`'s top-level names exist in `match` than in `other`. */
async function sharesMore(dir: string, match: string, other: string): Promise<boolean> {
  let a = 0;
  let b = 0;
  for (const name of await readdir(dir)) {
    if (await exists(path.join(match, name))) a++;
    if (await exists(path.join(other, name))) b++;
  }
  return a >= b;
}

const LOCKED = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Copies a file over another one. Windows refuses (EPERM) to overwrite a read-only file, and
 * one that antivirus or the game's launcher briefly has open, so the read-only flag is cleared
 * and the copy retried for a while before giving up with a message that says what to do.
 */
export async function copyOver(from: string, to: string, waits = [100, 250, 500, 1000, 2000], copy: (from: string, to: string) => Promise<void> = copyFile): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      return await copy(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (!LOCKED.has(code)) throw err;
      if (i >= waits.length) {
        throw Object.assign(new Error(`Windows wouldn't let LootDen replace ${to} (${code}). Close the game and its launcher, then try again.`), { code, cause: err });
      }
      await chmod(to, 0o666).catch(() => {});
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }
}

/** Why an update shouldn't go on this copy, or null when it fits. */
export function updateProblem(update: Pick<GameDetail, "kind" | "title" | "version" | "fromVersion" | "id">, installed: Pick<InstalledGame, "version" | "updates" | "exeVersion">): string | null {
  if (installed.updates?.some((u) => u.id === update.id)) return `${update.title} is already applied`;
  if (update.kind !== "update") return null;
  const { version: have, fromExe } = effectiveVersion(installed, update);
  const outside = fromExe ? " (the game was updated outside LootDen)" : "";
  // Checked first: a game updated past this one also no longer matches its from version.
  if (update.version && have && compareVersion(update.version, have) <= 0) return `Version ${have} is installed${outside}, which is already ${update.version} or newer`;
  if (update.fromVersion && have && compareVersion(have, update.fromVersion) !== 0) {
    return `This update is for version ${update.fromVersion}, but version ${have} is installed${outside}`;
  }
  return null;
}

/**
 * Applies an update or DLC package to an installed game: downloads it, then either copies
 * its files over the game (keeping the files it replaces so it can be undone) or, when it's
 * a setup program, runs it against the game's folder. The new version is recorded.
 */
export async function applyUpdate(api: GameServerClient, updateId: string, installed: InstalledGame, opts: ApplyUpdateOptions): Promise<AppliedUpdate> {
  const update = await api.getGame(updateId);
  if (update.kind === "game") throw new Error(`${update.title} is a full game, not an update`);
  if (update.baseGameId && update.baseGameId !== installed.gameId) {
    throw new Error(`${update.title} is for ${update.baseGame?.title ?? "another game"}, not ${installed.title}`);
  }
  const problem = updateProblem(update, installed);
  if (problem && !opts.force) throw new UpdateMismatchError(problem);
  const target = installed.installedDir ?? installed.dir;
  if (!(await exists(target))) throw new Error(`${target} is missing`);

  const work = path.join(opts.workDir, `update-${update.id}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    // No hoisting: overlayRoot already looks past a wrapper folder, and moving a freshly
    // unpacked folder is what Windows refuses while antivirus is still scanning it.
    const staged = await installGame(api, update.id, { installDir: work, keepArchives: false, sevenZipPath: opts.sevenZipPath, signal: opts.signal, onEvent: opts.onEvent, report: false, hoist: false });
    await unpackLeftovers(staged, opts.sevenZipPath, opts.signal);
    const files = await listFiles(staged);
    if (!files.length) throw new Error(`${update.title} has no files`);

    // A setup program (or a single patcher .exe) is run against the game; anything else is copied over it.
    const setup = setupKindOf(files.map((p) => ({ path: p }))) === "installer" || (files.length === 1 && /\.(exe|msi)$/i.test(files[0]!)) ? await findSetup(staged) ?? path.join(staged, files[0]!) : null;
    const record: AppliedUpdate = {
      id: update.id,
      title: update.title,
      kind: update.kind,
      previousVersion: knownVersion(installed),
      // Always recorded, so the next update can be checked against it: the server's version,
      // or the one in the update's name ("... 1.0.141.3207 to 1.0.141.13368").
      version: update.kind === "update" ? (update.version ?? versionFromName(update.title) ?? knownVersion(installed)) : knownVersion(installed),
      mode: setup ? "installer" : "files",
      appliedAt: new Date().toISOString(),
      device: versionTag("update").device,
      replaced: 0,
      added: 0,
    };
    opts.onEvent?.({ type: "apply", mode: record.mode, target });

    if (setup) {
      if (!opts.runInstaller) throw new Error(`${update.title} is a setup program; run it from the desktop app`);
      await opts.runInstaller(setup, target, await installerArgs(setup, target));
    } else {
      const root = await overlayRoot(staged, target);
      const backup = path.join(installed.dir, BACKUP_FOLDER, update.id);
      await rm(backup, { recursive: true, force: true });
      const replaced: string[] = [];
      const added: string[] = [];
      for (const rel of await listFiles(root)) {
        const dest = path.resolve(target, ...rel.split("/"));
        if (!dest.startsWith(path.resolve(target) + path.sep)) throw new Error(`Refusing unsafe path in update: ${rel}`);
        if (await exists(dest)) {
          const keep = path.join(backup, "files", ...rel.split("/"));
          await mkdir(path.dirname(keep), { recursive: true });
          await copyFile(dest, keep);
          replaced.push(rel);
        } else added.push(rel);
        // The list is written as we go, so an interrupted update can still be undone.
        await mkdir(path.dirname(dest), { recursive: true });
        await copyOver(path.join(root, ...rel.split("/")), dest);
        if ((replaced.length + added.length) % 200 === 0) await writeChanges(backup, target, replaced, added);
      }
      await writeChanges(backup, target, replaced, added);
      record.replaced = replaced.length;
      record.added = added.length;
    }
    await saveManifest(installed.dir, {
      version: record.version,
      versionSetBy: versionTag("update"),
      // The exe as this update left it, so only a later change from outside counts as one.
      exeStamp: await exeStampOf(installed),
      updates: [...(installed.updates ?? []).filter((u) => u.id !== update.id), record],
    });
    return record;
  } finally {
    // A scratch folder that's still locked is left for next time, rather than turning a
    // finished update into an error.
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

async function writeChanges(backup: string, target: string, replaced: string[], added: string[]): Promise<void> {
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, "changes.json"), JSON.stringify({ target, replaced, added }, null, 2));
}

/**
 * Undoes an update that was copied over the game: removes the files it added and puts back
 * the ones it replaced. Only the most recent update can be undone, so files stay consistent.
 */
export async function undoUpdate(installed: InstalledGame, updateId: string): Promise<AppliedUpdate> {
  const updates = installed.updates ?? [];
  const record = updates.find((u) => u.id === updateId);
  if (!record) throw new Error("That update isn't applied to this copy");
  if (updates[updates.length - 1]!.id !== updateId) throw new Error(`Undo ${updates[updates.length - 1]!.title} first; it was applied after this one`);
  if (record.mode !== "files") throw new Error(`${record.title} was a setup program; use the game's own uninstaller or reinstall the game`);
  const backup = path.join(installed.dir, BACKUP_FOLDER, updateId);
  const changes = JSON.parse(await readFile(path.join(backup, "changes.json"), "utf8")) as { target: string; replaced: string[]; added: string[] };
  const target = installed.installedDir ?? installed.dir;
  const inside = (rel: string) => {
    const p = path.resolve(target, ...rel.split("/"));
    if (!p.startsWith(path.resolve(target) + path.sep)) throw new Error(`Refusing unsafe path: ${rel}`);
    return p;
  };
  for (const rel of changes.added) await rm(inside(rel), { force: true });
  for (const rel of changes.replaced) await copyOver(path.join(backup, "files", ...rel.split("/")), inside(rel));
  await rm(backup, { recursive: true, force: true });
  await saveManifest(installed.dir, {
    version: record.previousVersion,
    versionSetBy: versionTag("undo"),
    exeStamp: await exeStampOf(installed),
    updates: updates.filter((u) => u.id !== updateId),
  });
  return record;
}
