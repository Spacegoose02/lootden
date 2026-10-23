import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LocalStoreGame } from "@lootden/shared";
import { steamInstalled } from "./steam.js";
import { xboxFromConfig } from "./xbox.js";

const isDir = (p: string) => stat(p).then((s) => s.isDirectory(), () => false);
const children = async (dir: string) => (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));

/** A GOG game's folder: its goggame-<id>.info file names it. */
async function gogGame(dir: string): Promise<LocalStoreGame | null> {
  const info = (await readdir(dir).catch(() => [] as string[])).find((f) => /^goggame-\d+\.info$/.test(f));
  if (!info) return null;
  const m = JSON.parse(await readFile(path.join(dir, info), "utf8").catch(() => "{}")) as { gameId?: string; rootGameId?: string; name?: string };
  // DLC folders carry their own info file pointing at the main game.
  if (!m.gameId || (m.rootGameId && m.rootGameId !== m.gameId)) return null;
  return { addon: "gog", store: "GOG", externalId: m.gameId, title: m.name || path.basename(dir), installDir: dir, launchUrl: `goggalaxy://openGameView/${m.gameId}` };
}

/** An Epic game's folder: .egstore/*.mancpn says which catalogue item it is. */
async function epicGame(dir: string): Promise<LocalStoreGame | null> {
  const store = path.join(dir, ".egstore");
  const file = (await readdir(store).catch(() => [] as string[])).find((f) => f.endsWith(".mancpn"));
  if (!file) return null;
  const m = JSON.parse(await readFile(path.join(store, file), "utf8").catch(() => "{}")) as { AppName?: string; CatalogNamespace?: string; CatalogItemId?: string };
  if (!m.AppName) return null;
  const launchUrl = m.CatalogNamespace && m.CatalogItemId ? `com.epicgames.launcher://apps/${encodeURIComponent(`${m.CatalogNamespace}:${m.CatalogItemId}:${m.AppName}`)}?action=launch&silent=true` : undefined;
  return { addon: "epic", store: "Epic Games", externalId: m.AppName, title: path.basename(dir), installDir: dir, ...(launchUrl ? { launchUrl } : {}) };
}

async function xboxGame(dir: string): Promise<LocalStoreGame | null> {
  for (const config of [path.join(dir, "Content", "MicrosoftGame.config"), path.join(dir, "MicrosoftGame.config")]) {
    const xml = await readFile(config, "utf8").catch(() => null);
    const found = xml && xboxFromConfig(xml, dir);
    if (found) return found;
  }
  return null;
}

/**
 * Store games in a folder someone picked on this PC (a second drive's library, a folder the
 * launchers don't list): a Steam library (anything with steamapps in it), and GOG, Epic and Xbox
 * app game folders, recognised by the files each store leaves in them. The folder itself and
 * the folders right inside it are looked at.
 */
export async function scanFolder(dir: string): Promise<LocalStoreGame[]> {
  const out: LocalStoreGame[] = [];
  const steamLib = path.basename(dir).toLowerCase() === "steamapps" ? path.dirname(dir) : (await isDir(path.join(dir, "steamapps"))) ? dir : null;
  if (steamLib) out.push(...(await steamInstalled(steamLib)));
  for (const d of [dir, ...(await children(dir))]) {
    if (path.basename(d).toLowerCase() === "steamapps") continue;
    const g = (await gogGame(d)) ?? (await epicGame(d)) ?? (await xboxGame(d));
    if (g) out.push(g);
  }
  return out;
}
