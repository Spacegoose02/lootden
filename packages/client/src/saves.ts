import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SaveBackup } from "@lootden/shared";
import type { GameServerClient } from "./api.js";
import { extractArchive, type SevenZip } from "./extractor.js";

/** Environment-style placeholders the server's save paths use, with fallbacks off Windows. */
export function placeholder(name: string): string | undefined {
  const home = os.homedir();
  const env = process.env;
  switch (name.toUpperCase()) {
    case "USERPROFILE":
      return env.USERPROFILE ?? home;
    case "APPDATA":
      return env.APPDATA ?? path.join(home, "AppData", "Roaming");
    case "LOCALAPPDATA":
      return env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    case "DOCUMENTS":
      return path.join(env.USERPROFILE ?? home, "Documents");
    case "PROGRAMDATA":
      return env.PROGRAMDATA ?? env.ALLUSERSPROFILE;
    default:
      return env[name] ?? env[name.toUpperCase()];
  }
}

/**
 * Turns a save path template into a real folder: expands %VARS%, {game} and ~, and
 * resolves "*" segments (like a Steam user id) to the most recently changed match.
 */
export async function expandSavePath(template: string, installDir: string): Promise<string> {
  let p = template.trim().replace(/\{game\}/gi, installDir);
  p = p.replace(/%([A-Za-z_]+)%/g, (m, name: string) => {
    const v = placeholder(name);
    if (!v) throw new Error(`${m} isn't set on this computer`);
    return v;
  });
  if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
  const parts = p.split(/[\\/]+/);
  let current = parts[0] === "" ? path.sep : parts[0]! + (/^[A-Za-z]:$/.test(parts[0]!) ? path.sep : "");
  for (const part of parts.slice(1)) {
    if (!part) continue;
    if (part !== "*") {
      current = path.join(current, part);
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    let best: { name: string; time: number } | null = null;
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const t = (await stat(path.join(current, e.name))).mtimeMs;
      if (!best || t > best.time) best = { name: e.name, time: t };
    }
    if (!best) throw new Error(`No folder matches * in ${current}`);
    current = path.join(current, best.name);
  }
  return path.normalize(current);
}

export function run7z(sevenZip: SevenZip, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZip.path, args, { cwd, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`7-Zip exited with code ${code}: ${stderr.trim() || "no details"}`))));
  });
}

/** Zips the save folder and uploads it as a new backup for this player. */
export async function backupSaves(api: GameServerClient, sevenZip: SevenZip, gameId: string, saveDir: string, device: string): Promise<SaveBackup> {
  const s = await stat(saveDir).catch(() => null);
  if (!s?.isDirectory()) throw new Error(`No saves found at ${saveDir}`);
  if ((await readdir(saveDir)).length === 0) throw new Error(`The save folder ${saveDir} is empty`);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gm-save-"));
  try {
    const zip = path.join(tmp, "save.zip");
    await run7z(sevenZip, ["a", "-tzip", "-bd", "-y", zip, "*"], saveDir);
    return await api.uploadSave(gameId, await readFile(zip), device);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Restores a backup over the save folder. The current folder is kept next to it as
 * "<folder>.gm-backup-<time>" so nothing is lost if the wrong backup was picked.
 */
export async function restoreSaves(api: GameServerClient, sevenZip: SevenZip, gameId: string, saveId: number, saveDir: string): Promise<{ previous: string | null }> {
  const data = await api.downloadSave(gameId, saveId);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "gm-save-"));
  try {
    const zip = path.join(tmp, "save.zip");
    await writeFile(zip, data);
    let previous: string | null = null;
    if (await stat(saveDir).catch(() => null)) {
      previous = `${saveDir}.gm-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await rename(saveDir, previous);
    }
    await mkdir(saveDir, { recursive: true });
    try {
      await extractArchive(sevenZip, "zip", zip, saveDir);
    } catch (err) {
      // Put the old saves back rather than leave a half-restored folder.
      await rm(saveDir, { recursive: true, force: true });
      if (previous) await rename(previous, saveDir);
      throw err;
    }
    return { previous };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
