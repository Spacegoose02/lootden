import path from "node:path";
import type { LocalStoreGame } from "@lootden/shared";
import type { StoreScanner } from "./index.js";
import { regQuery } from "./windows.js";

/** Games Ubisoft Connect installed, from its registry keys (Installs\<game id>\InstallDir). */
export function ubisoftFromRegistry(keys: Map<string, Record<string, string>>): LocalStoreGame[] {
  const out: LocalStoreGame[] = [];
  for (const [key, v] of keys) {
    const id = key.match(/\\Installs\\(\d+)$/i)?.[1];
    if (!id || !v.InstallDir) continue;
    const dir = v.InstallDir.replace(/[\\/]+$/, "");
    out.push({ addon: "ubisoft", store: "Ubisoft Connect", externalId: id, title: path.win32.basename(dir), installDir: dir, launchUrl: `uplay://launch/${id}/0` });
  }
  return out;
}

/** Ubisoft Connect has no library API LootDen can use, so its installed games come from the PC only. */
export const ubisoftScanner: StoreScanner = {
  addon: "ubisoft",
  platforms: ["win32"],
  scan: async () => ubisoftFromRegistry(await regQuery("HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs")),
};
