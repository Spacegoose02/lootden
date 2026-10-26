import type { LocalStoreGame } from "@lootden/shared";
import { eaScanner } from "./ea.js";
import { epicScanner } from "./epic.js";
import { scanFolder } from "./folders.js";
import { gogScanner } from "./gog.js";
import { steamScanner } from "./steam.js";
import { ubisoftScanner } from "./ubisoft.js";
import { xboxScanner } from "./xbox.js";

/**
 * Finds the games a store's launcher has installed on this PC (Steam's library folders,
 * GOG Galaxy, Epic's manifests...). Each library add-on that can tell adds one here, with the
 * same id as its server side in packages/server/src/addons.
 */
export interface StoreScanner {
  addon: string;
  /** The store's name, for the per-PC scanner settings. */
  name: string;
  /** Platforms the store runs on; the scanner is skipped elsewhere. */
  platforms: NodeJS.Platform[];
  scan(): Promise<LocalStoreGame[]>;
}

export const STORE_SCANNERS: StoreScanner[] = [steamScanner, gogScanner, epicScanner, xboxScanner, ubisoftScanner, eaScanner];

/** What this PC's scanners look at; kept per PC in the desktop app's settings, as drives and launchers differ. */
export interface StoreScanOptions {
  /** Stores not to look for (their add-on ids). */
  disabled?: string[];
  /** Extra folders to look in, picked by the person. */
  folders?: string[];
}

/** Every store game installed on this PC. A store that isn't installed, or fails to read, adds nothing. */
export async function scanStoreGames(scanners: StoreScanner[] = STORE_SCANNERS, platform: NodeJS.Platform = process.platform, opts: StoreScanOptions = {}): Promise<LocalStoreGame[]> {
  const off = new Set(opts.disabled ?? []);
  const found = await Promise.all([
    ...scanners.filter((s) => s.platforms.includes(platform) && !off.has(s.addon)).map((s) => s.scan().catch(() => [] as LocalStoreGame[])),
    ...(opts.folders ?? []).map((dir) => scanFolder(dir).catch(() => [] as LocalStoreGame[])),
  ]);
  // A game found by both its launcher and a picked folder is listed once, the launcher's way.
  const games = new Map<string, LocalStoreGame>();
  for (const g of found.flat()) if (!off.has(g.addon) && !games.has(`${g.addon}:${g.externalId}`)) games.set(`${g.addon}:${g.externalId}`, g);
  return [...games.values()];
}
