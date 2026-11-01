import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { steamRoots } from "./stores/steam.js";

export interface LocalScreenshot {
  path: string;
  /** Steam or Xbox Game Bar (Windows' Captures folder). */
  from: "steam" | "captures";
  takenAt: string;
  bytes: number;
}

const IMAGE = /\.(jpe?g|png)$/i;
const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function images(dir: string, from: LocalScreenshot["from"], keep: (name: string) => boolean): Promise<LocalScreenshot[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: LocalScreenshot[] = [];
  for (const n of names) {
    if (!IMAGE.test(n) || !keep(n)) continue;
    const s = await stat(path.join(dir, n)).catch(() => null);
    if (s?.isFile()) out.push({ path: path.join(dir, n), from, takenAt: s.mtime.toISOString(), bytes: s.size });
  }
  return out;
}

export interface LocalShotOptions {
  steamAppId?: string | null;
  title: string;
  platform?: NodeJS.Platform;
  /** Tests: Steam folders and the Captures folder. */
  steamRoots?: string[];
  capturesDir?: string;
}

/**
 * Screenshots of a game already on this PC: Steam's (userdata/<account>/760/remote/<appid>/screenshots)
 * and Xbox Game Bar's (Videos/Captures, named after the game's window). Newest first.
 */
export async function findLocalScreenshots(opts: LocalShotOptions): Promise<LocalScreenshot[]> {
  const platform = opts.platform ?? process.platform;
  const out: LocalScreenshot[] = [];
  if (opts.steamAppId && /^\d{1,10}$/.test(opts.steamAppId)) {
    for (const root of opts.steamRoots ?? (await steamRoots(platform))) {
      const users = await readdir(path.join(root, "userdata")).catch(() => [] as string[]);
      for (const u of users.filter((x) => /^\d+$/.test(x))) {
        out.push(...(await images(path.join(root, "userdata", u, "760", "remote", opts.steamAppId, "screenshots"), "steam", () => true)));
      }
    }
  }
  const want = loose(opts.title);
  const captures = opts.capturesDir ?? (platform === "win32" ? path.join(os.homedir(), "Videos", "Captures") : null);
  // Game Bar names files "<Window title> <date>.png"; match the game's title at the start.
  if (captures && want.length >= 3) out.push(...(await images(captures, "captures", (n) => loose(n).startsWith(want))));
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.path) && seen.add(s.path)).sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}
