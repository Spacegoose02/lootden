import type { LocalStoreGame } from "@lootden/shared";

/**
 * Finds the games a store's launcher has installed on this PC (Steam's library folders,
 * GOG Galaxy, Epic's manifests...). Each library add-on that can tell adds one here, with the
 * same id as its server side in packages/server/src/addons.
 */
export interface StoreScanner {
  addon: string;
  /** Platforms the store runs on; the scanner is skipped elsewhere. */
  platforms: NodeJS.Platform[];
  scan(): Promise<LocalStoreGame[]>;
}

export const STORE_SCANNERS: StoreScanner[] = [];

/** Every store game installed on this PC. A store that isn't installed, or fails to read, adds nothing. */
export async function scanStoreGames(scanners: StoreScanner[] = STORE_SCANNERS, platform: NodeJS.Platform = process.platform): Promise<LocalStoreGame[]> {
  const found = await Promise.all(scanners.filter((s) => s.platforms.includes(platform)).map((s) => s.scan().catch(() => [] as LocalStoreGame[])));
  return found.flat();
}
