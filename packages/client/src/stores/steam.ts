import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LocalStoreGame } from "@lootden/shared";
import type { StoreScanner } from "./index.js";
import { parseVdf, type Vdf } from "./vdf.js";
import { regQuery } from "./windows.js";

/** Where Steam usually lives: the registry's answer on Windows, the usual folders on Linux (including Flatpak). */
async function steamRoots(platform: NodeJS.Platform): Promise<string[]> {
  if (platform === "win32") {
    const fromRegistry = [...(await regQuery("HKCU\\Software\\Valve\\Steam", false)).values()][0]?.SteamPath ?? null;
    return [fromRegistry, "C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam"].filter((p): p is string => !!p).map((p) => path.normalize(p));
  }
  const home = os.homedir();
  return [path.join(home, ".steam", "steam"), path.join(home, ".local", "share", "Steam"), path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam")];
}

/** Every Steam library folder: the main one plus those in libraryfolders.vdf. */
export async function steamLibraries(root: string): Promise<string[]> {
  const out = new Set<string>([root]);
  const text = await readFile(path.join(root, "steamapps", "libraryfolders.vdf"), "utf8").catch(() => null);
  const doc = text ? parseVdf(text) : {};
  const folders = (doc.libraryfolders ?? doc.LibraryFolders) as Vdf | undefined;
  for (const v of Object.values(folders ?? {})) {
    // Newer files: { "path" "D:\\SteamLibrary" ... }; older ones: "1" "D:\\SteamLibrary".
    const p = typeof v === "string" ? v : typeof v.path === "string" ? v.path : null;
    if (p && !/^\d+$/.test(p)) out.add(path.normalize(p));
  }
  return [...out];
}

/** Games fully installed in one library folder, from its appmanifest_*.acf files. */
export async function steamInstalled(library: string): Promise<LocalStoreGame[]> {
  const apps = path.join(library, "steamapps");
  const out: LocalStoreGame[] = [];
  for (const f of await readdir(apps).catch(() => [] as string[])) {
    if (!/^appmanifest_\d+\.acf$/.test(f)) continue;
    const state = parseVdf(await readFile(path.join(apps, f), "utf8").catch(() => "")).AppState as Vdf | undefined;
    if (!state || typeof state.appid !== "string" || typeof state.name !== "string") continue;
    // StateFlags 4 is "fully installed"; others are downloading, updating or uninstalled.
    if (typeof state.StateFlags === "string" && (Number(state.StateFlags) & 4) === 0) continue;
    // Proton, the Steam runtimes and redistributables are tools, not games.
    if (/^(Proton|Steam Linux Runtime|Steamworks Common Redistributables)/.test(state.name)) continue;
    out.push({ addon: "steam", store: "Steam", externalId: state.appid, title: state.name, launchUrl: `steam://rungameid/${state.appid}`, installDir: path.join(apps, "common", typeof state.installdir === "string" ? state.installdir : "") });
  }
  return out;
}

export const steamScanner: StoreScanner = {
  addon: "steam",
  name: "Steam",
  platforms: ["win32", "linux"],
  async scan() {
    const seen = new Map<string, LocalStoreGame>();
    for (const root of await steamRoots(process.platform)) {
      for (const lib of await steamLibraries(root)) for (const g of await steamInstalled(lib)) seen.set(g.externalId, g);
    }
    return [...seen.values()];
  },
};
