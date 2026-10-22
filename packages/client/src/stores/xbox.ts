import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { LocalStoreGame } from "@lootden/shared";
import { listDrives } from "../drives.js";
import type { StoreScanner } from "./index.js";

/**
 * The game folders the Xbox app uses on a drive. Each drive it installs to has a .GamingRoot
 * file: "RGBX", two 32-bit numbers, then the folder names in UTF-16, each ending in a zero.
 */
export function gamingRootFolders(data: Buffer): string[] {
  if (data.length < 8 || data.subarray(0, 4).toString("latin1") !== "RGBX") return [];
  return data
    .subarray(8)
    .toString("utf16le")
    .split("\0")
    .map((s) => s.trim())
    .filter((s) => s && !/[\u0000-\u001f]/.test(s));
}

/** A game installed by the Xbox app, from its MicrosoftGame.config. */
export function xboxFromConfig(xml: string, dir: string): LocalStoreGame | null {
  const hexId = xml.match(/<TitleId>\s*([0-9A-Fa-f]{1,8})\s*<\/TitleId>/)?.[1];
  if (!hexId) return null;
  const name = xml.match(/DefaultDisplayName="([^"]+)"/)?.[1] ?? xml.match(/<Identity[^>]*Name="([^"]+)"/)?.[1] ?? path.basename(dir);
  const storeId = xml.match(/<StoreId>\s*([A-Z0-9]{12})\s*<\/StoreId>/)?.[1];
  return {
    addon: "xbox",
    // Xbox Live (and OpenXBL) give the title id in decimal.
    externalId: String(parseInt(hexId, 16)),
    title: name.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"'),
    installDir: dir,
    ...(storeId ? { launchUrl: `msxbox://game/?productId=${storeId}` } : {}),
  };
}

export const xboxScanner: StoreScanner = {
  addon: "xbox",
  platforms: ["win32"],
  async scan() {
    const out: LocalStoreGame[] = [];
    for (const drive of await listDrives()) {
      const root = await readFile(path.join(drive.path, ".GamingRoot")).catch(() => null);
      const folders = root ? gamingRootFolders(root) : [];
      for (const folder of folders.length ? folders : ["XboxGames"]) {
        const base = path.join(drive.path, folder);
        for (const game of await readdir(base).catch(() => [] as string[])) {
          const dir = path.join(base, game);
          for (const config of [path.join(dir, "Content", "MicrosoftGame.config"), path.join(dir, "MicrosoftGame.config")]) {
            const xml = await readFile(config, "utf8").catch(() => null);
            const found = xml && xboxFromConfig(xml, dir);
            if (found) {
              out.push(found);
              break;
            }
          }
        }
      }
    }
    return out;
  },
};
