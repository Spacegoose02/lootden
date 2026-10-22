import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LocalStoreGame } from "@lootden/shared";
import type { StoreScanner } from "./index.js";
import { regQuery } from "./windows.js";

/** Games GOG Galaxy (or a GOG offline installer) put on Windows, from the registry. */
export function gogFromRegistry(keys: Map<string, Record<string, string>>): LocalStoreGame[] {
  const out: LocalStoreGame[] = [];
  for (const v of keys.values()) {
    if (!v.gameID || !v.path) continue;
    out.push({ addon: "gog", externalId: v.gameID, title: v.gameName || path.win32.basename(v.path), installDir: v.path });
  }
  return out;
}

/** Games Heroic installed from GOG (Linux, and Windows people who use Heroic). */
export function gogFromHeroic(text: string): LocalStoreGame[] {
  const installed = (JSON.parse(text) as { installed?: Array<{ appName?: string; install_path?: string; title?: string }> }).installed ?? [];
  return installed
    .filter((g) => g.appName && g.install_path)
    .map((g) => ({
      addon: "gog",
      externalId: g.appName!,
      title: g.title || path.basename(g.install_path!),
      installDir: g.install_path!,
      launchUrl: `heroic://launch?appName=${encodeURIComponent(g.appName!)}&runner=gog`,
    }));
}

const heroicFiles = () => {
  const home = os.homedir();
  const config = process.platform === "win32" ? (process.env.APPDATA ?? path.join(home, "AppData", "Roaming")) : path.join(home, ".config");
  return [path.join(config, "heroic", "gog_store", "installed.json"), path.join(home, ".var", "app", "com.heroicgameslauncher.hgl", "config", "heroic", "gog_store", "installed.json")];
};

export const gogScanner: StoreScanner = {
  addon: "gog",
  platforms: ["win32", "linux"],
  async scan() {
    const found = new Map<string, LocalStoreGame>();
    for (const file of heroicFiles()) {
      const text = await readFile(file, "utf8").catch(() => null);
      if (text) for (const g of gogFromHeroic(text)) found.set(g.externalId, g);
    }
    // Galaxy's own installs win: its link opens Galaxy rather than Heroic.
    if (process.platform === "win32") for (const g of gogFromRegistry(await regQuery("HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games"))) found.set(g.externalId, g);
    return [...found.values()];
  },
};
