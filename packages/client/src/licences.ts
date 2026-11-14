import { copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentIdIn, LICENCE_PLATFORMS, rapFileName, RAP_BYTES, type GameLicence } from "@lootden/shared";
import type { GameServerClient } from "./api.js";

/** Where in an installed game LootDen keeps the licences the server has for it. */
export const LICENCE_FOLDER = "licences";

/** RPCS3's licence folder for its first (default) user, inside its data folder. */
export const RPCS3_EXDATA = path.join("dev_hdd0", "home", "00000001", "exdata");

/**
 * Brings a PS3 game's licence files from the server into its install folder, so they're there
 * offline too. Returns the names it wrote; a game with none (or a non-PS3 game) writes nothing.
 */
export async function downloadLicences(api: GameServerClient, gameId: string, platform: string, gameDir: string): Promise<string[]> {
  if (!LICENCE_PLATFORMS.includes(platform)) return [];
  const licences = await api.json<GameLicence[]>(`/api/games/${encodeURIComponent(gameId)}/licences`);
  const written: string[] = [];
  if (!licences.length) return written;
  const dir = path.join(gameDir, LICENCE_FOLDER);
  await mkdir(dir, { recursive: true });
  for (const l of licences) {
    const name = rapFileName(l.contentId);
    const data = await api.download(`/api/games/${encodeURIComponent(gameId)}/licences/${encodeURIComponent(l.name)}`);
    const dest = path.join(dir, name);
    const have = await readFile(dest).catch(() => null);
    if (have && Buffer.compare(have, Buffer.from(data)) === 0) continue;
    await writeFile(dest, data);
    written.push(name);
  }
  return written;
}

/**
 * Copies every .rap in an installed game (the server's, and any that came in the game's own
 * files) into RPCS3's exdata folder under the name RPCS3 looks for. Returns the names copied.
 */
export async function installLicences(gameDir: string, exdataDir: string): Promise<string[]> {
  const raps = await findRaps(gameDir);
  const copied: string[] = [];
  for (const rel of raps) {
    const contentId = contentIdIn(path.posix.basename(rel));
    if (!contentId) continue;
    const from = path.join(gameDir, ...rel.split("/"));
    if ((await stat(from)).size !== RAP_BYTES) continue;
    const dest = path.join(exdataDir, rapFileName(contentId));
    const [a, b] = await Promise.all([readFile(from), readFile(dest).catch(() => null)]);
    if (b && Buffer.compare(a, b) === 0) continue;
    await mkdir(exdataDir, { recursive: true });
    await copyFile(from, dest);
    copied.push(rapFileName(contentId));
  }
  return copied;
}

/** Every .rap under a folder, relative with forward slashes. */
async function findRaps(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await findRaps(dir, r)));
    else if (e.isFile() && /\.rap$/i.test(e.name)) out.push(r);
  }
  return out;
}
