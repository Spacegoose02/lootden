import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LocalStoreGame } from "@lootden/shared";
import type { StoreScanner } from "./index.js";

/** One of the Epic Games Launcher's install manifests (.item files, JSON). */
export function epicFromManifest(text: string): LocalStoreGame | null {
  const m = JSON.parse(text) as { AppName?: string; DisplayName?: string; InstallLocation?: string; bIsIncompleteInstall?: boolean; bIsApplication?: boolean; MainGameAppName?: string; CatalogNamespace?: string; CatalogItemId?: string };
  if (!m.AppName || !m.InstallLocation || m.bIsIncompleteInstall || m.bIsApplication === false) return null;
  // DLC installs carry their main game's AppName; the game itself is listed once.
  if (m.MainGameAppName && m.MainGameAppName !== m.AppName) return null;
  const launchUrl = m.CatalogNamespace && m.CatalogItemId ? `com.epicgames.launcher://apps/${encodeURIComponent(`${m.CatalogNamespace}:${m.CatalogItemId}:${m.AppName}`)}?action=launch&silent=true` : undefined;
  return { addon: "epic", store: "Epic Games", externalId: m.AppName, title: m.DisplayName || path.basename(m.InstallLocation), installDir: m.InstallLocation, ...(launchUrl ? { launchUrl } : {}) };
}

/** Games Heroic installed from Epic (through Legendary). */
export function epicFromHeroic(text: string): LocalStoreGame[] {
  const installed = JSON.parse(text) as Record<string, { app_name?: string; title?: string; install_path?: string; is_dlc?: boolean }>;
  return Object.values(installed)
    .filter((g) => g.app_name && g.install_path && !g.is_dlc)
    .map((g) => ({
      addon: "epic",
      store: "Epic Games",
      externalId: g.app_name!,
      title: g.title || path.basename(g.install_path!),
      installDir: g.install_path!,
      launchUrl: `heroic://launch?appName=${encodeURIComponent(g.app_name!)}&runner=legendary`,
    }));
}

export const epicScanner: StoreScanner = {
  addon: "epic",
  platforms: ["win32", "linux"],
  async scan() {
    const found = new Map<string, LocalStoreGame>();
    const home = os.homedir();
    const config = process.platform === "win32" ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming")) : path.join(home, ".config");
    for (const file of [path.join(config, "heroic", "legendaryConfig", "legendary", "installed.json"), path.join(home, ".var", "app", "com.heroicgameslauncher.hgl", "config", "heroic", "legendaryConfig", "legendary", "installed.json")]) {
      const text = await readFile(file, "utf8").catch(() => null);
      if (text) for (const g of epicFromHeroic(text)) found.set(g.externalId, g);
    }
    if (process.platform === "win32") {
      const dir = path.join(process.env.ProgramData ?? "C:\\ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests");
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        if (!f.endsWith(".item")) continue;
        const g = await readFile(path.join(dir, f), "utf8").then(epicFromManifest, () => null).catch(() => null);
        if (g) found.set(g.externalId, g);
      }
    }
    return [...found.values()];
  },
};
