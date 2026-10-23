import path from "node:path";
import type { LocalStoreGame } from "@lootden/shared";
import type { StoreScanner } from "./index.js";
import { regQuery } from "./windows.js";

/**
 * Proper names for Ubisoft Connect's games, from Windows' list of installed programs
 * ("Uplay Install <game id>" keys). Without them a game is known only by its install folder,
 * which is often written as one word ("FarCry6").
 */
export function ubisoftNames(keys: Map<string, Record<string, string>>): Map<string, string> {
  const names = new Map<string, string>();
  for (const [key, v] of keys) {
    const id = key.match(/\\Uplay Install (\d+)$/i)?.[1];
    if (id && v.DisplayName) names.set(id, v.DisplayName.trim());
  }
  return names;
}

/** Games Ubisoft Connect installed, from its registry keys (Installs\<game id>\InstallDir). */
export function ubisoftFromRegistry(keys: Map<string, Record<string, string>>, names: Map<string, string> = new Map()): LocalStoreGame[] {
  const out: LocalStoreGame[] = [];
  for (const [key, v] of keys) {
    const id = key.match(/\\Installs\\(\d+)$/i)?.[1];
    if (!id || !v.InstallDir) continue;
    const dir = v.InstallDir.replace(/[\\/]+$/, "");
    out.push({ addon: "ubisoft", store: "Ubisoft Connect", externalId: id, title: names.get(id) ?? path.win32.basename(dir), installDir: dir, launchUrl: `uplay://launch/${id}/0` });
  }
  return out;
}

/** Ubisoft Connect has no library API LootDen can use, so its installed games come from the PC only. */
export const ubisoftScanner: StoreScanner = {
  addon: "ubisoft",
  name: "Ubisoft Connect",
  platforms: ["win32"],
  scan: async () =>
    ubisoftFromRegistry(
      await regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs"),
      ubisoftNames(await regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", true)),
    ),
};
