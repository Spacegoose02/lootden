import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LocalStoreGame } from "@lootden/shared";
import type { StoreScanner } from "./index.js";
import { regQuery } from "./windows.js";

const UNINSTALL_KEYS = ["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"];

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();

/** The link that starts (or installs) a game in the EA app, which still answers Origin's links. */
export const eaLaunchUrl = (offerId: string) => `origin2://game/launch?offerIds=${encodeURIComponent(offerId)}&autoDownload=1`;

/**
 * The EA app (and Origin before it) leaves __Installer\installerdata.xml in every game it
 * installs: the game's offer ids and its name. The "Origin.OFR..." style id is the one the
 * launch link wants; older games only have numbers.
 */
export function eaFromInstallerData(xml: string, dir: string): LocalStoreGame | null {
  const ids = [...xml.matchAll(/<contentID>\s*([^<]+?)\s*<\/contentID>/gi)].map((m) => decode(m[1]!));
  const offer = ids.find((id) => /^[A-Za-z]+\.OFR\./.test(id)) ?? ids[0];
  if (!offer) return null;
  const titles = [...xml.matchAll(/<gameTitle\b([^>]*)>([^<]*)<\/gameTitle>/gi)].map((m) => ({ locale: /locale="([^"]*)"/i.exec(m[1]!)?.[1] ?? "", title: decode(m[2]!) }));
  // Older manifests: <localeInfo locale="en_US"><title>...</title>
  const older = /<title>([^<]+)<\/title>/i.exec(xml)?.[1];
  const title = titles.find((t) => /^en[_-]US$/i.test(t.locale) && t.title)?.title ?? titles.find((t) => t.title)?.title ?? (older ? decode(older) : path.win32.basename(dir));
  return { addon: "ea", store: "EA app", externalId: offer, title: title.replace(/[™®©]/g, "").trim(), installDir: dir, launchUrl: eaLaunchUrl(offer) };
}

/**
 * Folders EA games are installed in, from Windows' list of installed programs: the EA app's
 * games uninstall through its EAInstaller Cleanup.exe (Origin's through Origin), and say
 * where they are.
 */
export function eaInstallDirs(keys: Map<string, Record<string, string>>): Array<{ dir: string; name: string }> {
  const out: Array<{ dir: string; name: string }> = [];
  for (const v of keys.values()) {
    const by = `${v.UninstallString ?? ""} ${v.QuietUninstallString ?? ""}`;
    if (!v.InstallLocation || !/EAInstaller|\\Origin\\|Origin\.exe/i.test(by)) continue;
    out.push({ dir: v.InstallLocation.replace(/^"|"$/g, "").replace(/[\\/]+$/, ""), name: v.DisplayName ?? "" });
  }
  return out;
}

/** Install folders set in the EA app (user.downloadinplacedir in its user_*.ini files). */
export function eaLibraryDirs(ini: string): string[] {
  return [...ini.matchAll(/^\s*user\.downloadinplacedir\s*=\s*(.+?)\s*$/gim)].map((m) => m[1]!.replace(/[\\/]+$/, ""));
}

/** An EA game's folder, if it has the EA app's installer data. */
export async function eaGame(dir: string): Promise<LocalStoreGame | null> {
  const xml = await readFile(path.join(dir, "__Installer", "installerdata.xml"), "utf8").catch(() => null);
  return xml ? eaFromInstallerData(xml, dir) : null;
}

/**
 * The EA app has no library API LootDen can use, and its own list of installs is encrypted,
 * so its games are found on the PC: through Windows' installed programs, and in the EA app's
 * install folders (EA Games in Program Files unless changed).
 */
export const eaScanner: StoreScanner = {
  addon: "ea",
  name: "EA app",
  platforms: ["win32"],
  async scan() {
    const dirs = new Map<string, string>();
    for (const key of UNINSTALL_KEYS) for (const d of eaInstallDirs(await regQuery(key, true))) dirs.set(d.dir.toLowerCase(), d.dir);
    const roots = [path.join(process.env.ProgramFiles ?? "C:\\Program Files", "EA Games")];
    const settings = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Electronic Arts", "EA Desktop");
    for (const f of await readdir(settings).catch(() => [] as string[])) {
      if (/^user_.*\.ini$/i.test(f)) roots.push(...eaLibraryDirs(await readFile(path.join(settings, f), "utf8").catch(() => "")));
    }
    for (const root of roots) {
      for (const e of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (e.isDirectory()) dirs.set(path.join(root, e.name).toLowerCase(), path.join(root, e.name));
      }
    }
    const found = new Map<string, LocalStoreGame>();
    for (const dir of dirs.values()) {
      const g = await eaGame(dir).catch(() => null);
      if (g && !found.has(g.externalId)) found.set(g.externalId, g);
    }
    return [...found.values()];
  },
};
