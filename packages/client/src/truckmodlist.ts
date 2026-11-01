import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseActiveMods, profileNameFromFolder, profileNameFromSii, siiFormat, writeActiveMods, type ActiveTruckMod, type TruckProfile } from "@lootden/shared";
import { steamLibraries, steamRoots } from "./stores/steam.js";
import { parseVdf, type Vdf } from "./stores/vdf.js";

/**
 * The truck games' profiles and load order on this PC, the Workshop items Steam has for them, and
 * moving old versions of mods out of the way. The game's folder is the one its "mod" folder is in.
 */

/** Where the profiles are: profiles/<hex name> (local) and steam_profiles/<hex name> (Steam Cloud). */
const PROFILE_DIRS: Array<{ dir: string; cloud: boolean }> = [
  { dir: "profiles", cloud: false },
  { dir: "steam_profiles", cloud: true },
];

async function head(file: string, bytes = 16): Promise<Uint8Array> {
  const fh = await open(file, "r");
  try {
    const buf = new Uint8Array(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.slice(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** One profile: its name, whether it can be read, and its active mods (top of the Mod Manager first). */
export async function readTruckProfile(dir: string, cloud: boolean): Promise<TruckProfile | null> {
  const file = path.join(dir, "profile.sii");
  const s = await stat(file).catch(() => null);
  if (!s?.isFile()) return null;
  const format = siiFormat(await head(file).catch(() => new Uint8Array()));
  let mods: ActiveTruckMod[] = [];
  let name = profileNameFromFolder(path.basename(dir));
  if (format === "text") {
    const text = await readFile(file, "utf8");
    mods = parseActiveMods(text);
    name = profileNameFromSii(text) ?? name;
  }
  return { dir, name: name ?? path.basename(dir), cloud, format, mods, modifiedAt: s.mtime.toISOString() };
}

/** Every profile of the game, the one played last first. */
export async function truckProfiles(gameDir: string): Promise<TruckProfile[]> {
  const out: TruckProfile[] = [];
  for (const { dir, cloud } of PROFILE_DIRS) {
    const root = path.join(gameDir, dir);
    for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory()) continue;
      const p = await readTruckProfile(path.join(root, e.name), cloud);
      if (p) out.push(p);
    }
  }
  return out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** A profile folder has to be one of the game's own (profiles/ or steam_profiles/). */
function checkProfileDir(gameDir: string, profileDir: string): string {
  const dir = path.resolve(profileDir);
  const parent = path.dirname(dir);
  const ok = PROFILE_DIRS.some((p) => path.resolve(gameDir, p.dir) === parent);
  if (!ok || !existsSync(path.join(dir, "profile.sii"))) throw new Error("That isn't one of the game's profiles");
  return dir;
}

/**
 * Puts a load order into a profile: its active mods become mods (top first). The old profile.sii
 * is kept beside it (profile.sii.lootden-<time>.bak). The game has to be closed, or it writes its
 * own list back when it exits.
 */
export async function applyTruckLoadOrder(gameDir: string, profileDir: string, mods: ActiveTruckMod[]): Promise<{ backup: string; profile: TruckProfile }> {
  const dir = checkProfileDir(gameDir, profileDir);
  const file = path.join(dir, "profile.sii");
  const format = siiFormat(await head(file));
  if (format !== "text") throw new Error("This profile is saved in the game's coded format; turn on readable saves and start the game once first");
  const clean = mods.filter((m) => m.package && !/[\r\n"|]/.test(m.package));
  const text = await readFile(file, "utf8");
  const next = writeActiveMods(text, clean);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(dir, `profile.sii.lootden-${stamp}.bak`);
  await copyFile(file, backup);
  await writeFile(`${file}.lootden-tmp`, next);
  await rename(`${file}.lootden-tmp`, file);
  return { backup, profile: (await readTruckProfile(dir, path.basename(path.dirname(dir)) === "steam_profiles"))! };
}

/**
 * Makes the game save profiles and saves as readable text from now on (uset g_save_format "2" in
 * its config.cfg), so LootDen can read and set the load order. Takes effect the next time the
 * game saves the profile (start it, then quit).
 */
export async function enableTruckTextSaves(gameDir: string): Promise<boolean> {
  const file = path.join(gameDir, "config.cfg");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) throw new Error("Start the game once on this PC first; its config.cfg isn't there yet");
  const line = /^uset g_save_format[ \t]+"?(\d+)"?[ \t]*(?=\r?$)/m;
  const m = text.match(line);
  if (m?.[1] === "2") return false;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const next = m ? text.replace(line, 'uset g_save_format "2"') : `${text.replace(/\s*$/, "")}${eol}uset g_save_format "2"${eol}`;
  await writeFile(file, next);
  return true;
}

/** The Workshop items Steam has downloaded for a game on this PC (its subscriptions), with when each was updated. */
export async function steamWorkshopSubscriptions(appId: string, roots?: string[]): Promise<Array<{ id: string; updatedAt: string | null; sizeBytes: number; dir: string }>> {
  if (!/^\d+$/.test(appId)) return [];
  const out = new Map<string, { id: string; updatedAt: string | null; sizeBytes: number; dir: string }>();
  for (const root of roots ?? (await steamRoots(process.platform))) {
    for (const lib of await steamLibraries(root).catch(() => [root])) {
      const workshop = path.join(lib, "steamapps", "workshop");
      const acf = await readFile(path.join(workshop, `appworkshop_${appId}.acf`), "utf8").catch(() => null);
      if (!acf) continue;
      const doc = (parseVdf(acf).AppWorkshop ?? {}) as Vdf;
      const installed = (doc.WorkshopItemsInstalled ?? {}) as Vdf;
      for (const [id, v] of Object.entries(installed)) {
        if (!/^\d{4,20}$/.test(id) || typeof v === "string") continue;
        const t = Number(v.timeupdated);
        out.set(id, { id, updatedAt: t > 0 ? new Date(t * 1000).toISOString() : null, sizeBytes: Number(v.size) || 0, dir: path.join(workshop, "content", appId, id) });
      }
    }
  }
  return [...out.values()];
}

/** The folder old versions of mods are moved to: "mod-old" beside the mod folder (the game doesn't look there). */
export function oldModsFolder(modDir: string): string {
  return path.join(path.dirname(modDir), "mod-old");
}

/**
 * Moves mod files out of the mod folder into mod-old (an older version replaced by a newer one,
 * or a double). Only plain file names in the folder are moved; returns the ones that were.
 */
export async function retireTruckModFiles(modDir: string, files: string[]): Promise<string[]> {
  const dest = oldModsFolder(modDir);
  const moved: string[] = [];
  for (const f of files) {
    if (!f || f !== path.basename(f) || !/\.(scs|zip)$/i.test(f)) continue;
    const from = path.join(modDir, f);
    if (!existsSync(from)) continue;
    await mkdir(dest, { recursive: true });
    let to = path.join(dest, f);
    for (let i = 2; existsSync(to); i++) to = path.join(dest, f.replace(/(\.\w+)$/, ` (${i})$1`));
    try {
      await rename(from, to);
    } catch {
      await copyFile(from, to);
      await rm(from, { force: true });
    }
    moved.push(f);
  }
  return moved;
}
