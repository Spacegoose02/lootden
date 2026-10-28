import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { workshopModsPath } from "@lootden/shared";
import { extractArchive, type SevenZip } from "./extractor.js";

/**
 * Steam Workshop items on this PC, through Valve's SteamCMD: downloaded with an anonymous
 * login (which works for games whose Workshop allows it) and copied into the game's mods folder.
 */

const STEAMCMD: Record<string, { url: string; exe: string }> = {
  win32: { url: "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip", exe: "steamcmd.exe" },
  linux: { url: "https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz", exe: "steamcmd.sh" },
};

/** The marker each installed item's folder gets, so LootDen knows what it put there. */
export const WORKSHOP_MARKER = ".lootden-workshop.json";

export interface InstalledWorkshopItem {
  id: string;
  title: string;
  installedAt: string;
  dir: string;
}

const isId = (s: string) => /^\d{1,20}$/.test(s);

/** SteamCMD in dir, downloaded from Valve the first time it's needed. */
export async function ensureSteamCmd(dir: string, opts: { platform?: NodeJS.Platform; sevenZip?: SevenZip | null; fetchImpl?: typeof fetch } = {}): Promise<string> {
  const platform = opts.platform ?? process.platform;
  const pick = STEAMCMD[platform];
  if (!pick) throw new Error("Steam Workshop downloads work on Windows and Linux");
  const exe = path.join(dir, pick.exe);
  if (existsSync(exe)) return exe;
  await mkdir(dir, { recursive: true });
  const archive = path.join(dir, path.basename(new URL(pick.url).pathname));
  const res = await (opts.fetchImpl ?? fetch)(pick.url);
  if (!res.ok || !res.body) throw new Error(`Couldn't download SteamCMD from Valve (${res.status})`);
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(archive));
  if (platform === "win32") {
    if (!opts.sevenZip) throw new Error("7-Zip is needed to unpack SteamCMD");
    await extractArchive(opts.sevenZip, "zip", archive, dir);
  } else {
    await run("tar", ["-xzf", archive, "-C", dir]);
    await chmod(exe, 0o755).catch(() => {});
  }
  await rm(archive, { force: true });
  if (!existsSync(exe)) throw new Error("SteamCMD didn't unpack as expected");
  return exe;
}

function run(cmd: string, args: string[], onLine?: (line: string) => void, timeoutMs = 30 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    const take = (d: Buffer) => {
      const text = d.toString();
      out += text;
      if (out.length > 200_000) out = out.slice(-100_000);
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine?.(line.trim());
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (err) => (clearTimeout(timer), reject(err)));
    child.on("close", (code) => {
      clearTimeout(timer);
      // SteamCMD often exits non-zero after a successful download (it updates itself first), so its output decides.
      if (code === 0 || cmd.includes("steamcmd")) resolve(out);
      else reject(new Error(`${path.basename(cmd)} exited with ${code}: ${out.trim().slice(-300)}`));
    });
  });
}

/** What SteamCMD's output says about one item: where it went, or why it didn't. */
export function steamCmdResult(output: string, itemId: string): { dir: string } | { error: string } {
  const ok = output.match(new RegExp(`Success\\. Downloaded item ${itemId} to "([^"]+)"`));
  if (ok) return { dir: ok[1]! };
  const failed = output.match(/ERROR! Download item \d+ failed \(([^)]+)\)/)?.[1];
  if (failed === "Failure" || failed === "Access Denied" || /No subscription|Login Failure/i.test(output))
    return { error: "Steam won't hand this item out without signing in: this game's Workshop needs a Steam account that owns the game" };
  if (failed === "File Not Found") return { error: "That Workshop item doesn't exist any more" };
  if (failed) return { error: `Steam couldn't download it (${failed})` };
  return { error: "SteamCMD finished without downloading the item; try again in a moment" };
}

/** Downloads one item into workDir with an anonymous login; returns the folder its files are in. */
export async function downloadWorkshopItem(steamcmd: string, workDir: string, appId: string, itemId: string, onLine?: (line: string) => void): Promise<string> {
  if (!isId(appId) || !isId(itemId)) throw new Error("That isn't a Workshop item");
  await mkdir(workDir, { recursive: true });
  const output = await run(steamcmd, ["+force_install_dir", workDir, "+login", "anonymous", "+workshop_download_item", appId, itemId, "validate", "+quit"], onLine);
  const r = steamCmdResult(output, itemId);
  if ("error" in r) throw new Error(r.error);
  return existsSync(r.dir) ? r.dir : path.join(workDir, "steamapps", "workshop", "content", appId, itemId);
}

/** The item's folder in the game's mods folder, which must stay inside the game's install. */
function itemDir(gameDir: string, modsPath: string, itemId: string): string {
  const mods = workshopModsPath(modsPath);
  if (!mods) throw new Error("Set this game's mods folder first");
  if (!isId(itemId)) throw new Error("That isn't a Workshop item");
  const root = path.resolve(gameDir);
  const target = path.resolve(root, mods, itemId);
  if (!target.startsWith(root + path.sep)) throw new Error("The mods folder has to be inside the game's folder");
  return target;
}

/** Copies a downloaded item into <game>/<mods folder>/<item id>, replacing an older copy. */
export async function installWorkshopItem(contentDir: string, gameDir: string, modsPath: string, item: { id: string; title: string }): Promise<InstalledWorkshopItem> {
  const target = itemDir(gameDir, modsPath, item.id);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(contentDir, target, { recursive: true });
  const installedAt = new Date().toISOString();
  await writeFile(path.join(target, WORKSHOP_MARKER), JSON.stringify({ id: item.id, title: item.title.slice(0, 200), installedAt }, null, 2));
  return { id: item.id, title: item.title, installedAt, dir: target };
}

/** The items LootDen installed in a game's mods folder. */
export async function listWorkshopItems(gameDir: string, modsPath: string): Promise<InstalledWorkshopItem[]> {
  const mods = workshopModsPath(modsPath);
  if (!mods) return [];
  const root = path.resolve(gameDir, mods);
  const out: InstalledWorkshopItem[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!isId(name)) continue;
    const marker = await readFile(path.join(root, name, WORKSHOP_MARKER), "utf8").catch(() => null);
    if (!marker) continue;
    try {
      const m = JSON.parse(marker) as { title?: string; installedAt?: string };
      out.push({ id: name, title: m.title ?? name, installedAt: m.installedAt ?? "", dir: path.join(root, name) });
    } catch {
      /* not ours */
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Removes an item LootDen installed (only folders carrying its marker). */
export async function removeWorkshopItem(gameDir: string, modsPath: string, itemId: string): Promise<void> {
  const target = itemDir(gameDir, modsPath, itemId);
  if (!existsSync(path.join(target, WORKSHOP_MARKER))) throw new Error("LootDen didn't install that item");
  await rm(target, { recursive: true, force: true });
}
