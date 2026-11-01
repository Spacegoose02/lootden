import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { LocalStoreGame } from "@lootden/shared";
import type { StoreScanner } from "./index.js";
import { regQuery } from "./windows.js";

/**
 * Amazon Games, Battle.net, the Rockstar Games Launcher and the Riot Client: none of them has a
 * library API LootDen can use, so their installed games are found on the PC, mostly from
 * Windows' list of installed programs, which each launcher fills in.
 */

const UNINSTALL = ["HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall"];

async function uninstallKeys(): Promise<Map<string, Record<string, string>>> {
  const all = new Map<string, Record<string, string>>();
  for (const k of UNINSTALL) for (const [key, v] of await regQuery(k, true)) all.set(key, v);
  return all;
}

const clean = (s: string | undefined) => (s ?? "").replace(/^"|"$/g, "").replace(/[\\/]+$/, "").trim();
const tidyTitle = (s: string) => s.replace(/[™®©]/g, "").trim();

/**
 * Links for launchers that have no link of their own (Rockstar, Riot). The app turns them into
 * the launcher's own command on the PC, so the server never hands it a program to run.
 */
export const LAUNCHER_SCHEME = "lootden-launcher://";

// ---- Amazon Games -------------------------------------------------------------------------

/** Amazon Games uninstalls each game with "Amazon Game Remover.exe -m Game -p <product id>". */
export function amazonFromUninstall(keys: Map<string, Record<string, string>>): LocalStoreGame[] {
  const out: LocalStoreGame[] = [];
  for (const v of keys.values()) {
    const by = `${v.UninstallString ?? ""}`;
    const id = /Amazon Game Remover\.exe.*?-p\s+"?(amzn1\.adg\.product\.[\w-]+)"?/i.exec(by)?.[1];
    const dir = clean(v.InstallLocation);
    if (!id || !dir) continue;
    out.push({ addon: "amazon", store: "Amazon Games", externalId: id, title: tidyTitle(v.DisplayName ?? path.win32.basename(dir)), installDir: dir, launchUrl: `amazon-games://play/${id}` });
  }
  return out;
}

export const amazonScanner: StoreScanner = {
  addon: "amazon",
  name: "Amazon Games",
  platforms: ["win32"],
  scan: async () => amazonFromUninstall(await uninstallKeys()),
};

// ---- Battle.net ---------------------------------------------------------------------------

/** Battle.net's install ids (--uid) and the codes its battlenet:// links start games with. */
export const BATTLENET_CODES: Record<string, string> = {
  wow: "WoW",
  wow_classic: "WoWC",
  wow_classic_era: "WoWC",
  s1: "S1",
  s2: "S2",
  d3: "D3",
  diablo3: "D3",
  fenris: "Fen",
  osi: "OSI",
  hs_beta: "WTCG",
  hero: "Hero",
  heroes: "Hero",
  prometheus: "Pro",
  w3: "W3",
  viper: "VIPR",
  odin: "ODIN",
  lazarus: "LAZR",
  zeus: "ZEUS",
  fore: "FORE",
  auks: "AUKS",
  rtro: "RTRO",
  wlby: "WLBY",
  anbs: "ANBS",
  gryphon: "GRY",
};

/** Battle.net's games uninstall through "Blizzard Uninstaller.exe ... --uid=<id>". */
export function battlenetFromUninstall(keys: Map<string, Record<string, string>>): LocalStoreGame[] {
  const out: LocalStoreGame[] = [];
  for (const v of keys.values()) {
    const by = `${v.UninstallString ?? ""}`;
    if (!/Blizzard Uninstaller\.exe|Battle\.net/i.test(by)) continue;
    const uid = /--uid=([\w-]+)/i.exec(by)?.[1]?.toLowerCase();
    const dir = clean(v.InstallLocation);
    if (!uid || !dir || uid === "battle.net") continue;
    const code = BATTLENET_CODES[uid] ?? BATTLENET_CODES[uid.replace(/_(beta|ptr)$/, "")];
    out.push({ addon: "battlenet", store: "Battle.net", externalId: uid, title: tidyTitle(v.DisplayName ?? path.win32.basename(dir)), installDir: dir, launchUrl: `battlenet://${code ?? ""}` });
  }
  return out;
}

export const battlenetScanner: StoreScanner = {
  addon: "battlenet",
  name: "Battle.net",
  platforms: ["win32"],
  scan: async () => battlenetFromUninstall(await uninstallKeys()),
};

// ---- Rockstar Games Launcher --------------------------------------------------------------

/** Rockstar's games uninstall through "Rockstar Games\Launcher\uninstall.exe -uninstall=<title>". */
export function rockstarFromUninstall(keys: Map<string, Record<string, string>>): LocalStoreGame[] {
  const out: LocalStoreGame[] = [];
  for (const v of keys.values()) {
    const m = /Rockstar Games\\Launcher\\uninstall\.exe"?\s+-uninstall=(\w+)/i.exec(v.UninstallString ?? "");
    const dir = clean(v.InstallLocation);
    if (!m || !dir || m[1]!.toLowerCase() === "launcher") continue;
    out.push({ addon: "rockstar", store: "Rockstar Games", externalId: m[1]!.toLowerCase(), title: tidyTitle(v.DisplayName ?? path.win32.basename(dir)), installDir: dir, launchUrl: `${LAUNCHER_SCHEME}rockstar/${m[1]!.toLowerCase()}` });
  }
  return out;
}

export const rockstarScanner: StoreScanner = {
  addon: "rockstar",
  name: "Rockstar Games Launcher",
  platforms: ["win32"],
  scan: async () => rockstarFromUninstall(await uninstallKeys()),
};

// ---- Riot Client --------------------------------------------------------------------------

const RIOT_TITLES: Record<string, string> = { valorant: "VALORANT", league_of_legends: "League of Legends", bacon: "Legends of Runeterra", lion: "2XKO" };
const programData = () => process.env.ProgramData ?? process.env.PROGRAMDATA ?? "C:\\ProgramData";

/** A Riot game's product_settings.yaml: where it's installed. */
export function riotFromSettings(product: string, yaml: string): LocalStoreGame | null {
  const dir = /^product_install_full_path:\s*"?([^"\r\n]+)"?\s*$/m.exec(yaml)?.[1]?.trim();
  if (!dir || !/^[a-z0-9_]+$/.test(product) || product === "riot_client") return null;
  return { addon: "riot", store: "Riot Games", externalId: product, title: RIOT_TITLES[product] ?? path.win32.basename(dir.replace(/[\\/]+$/, "")), installDir: dir.replace(/[\\/]+$/, ""), launchUrl: `${LAUNCHER_SCHEME}riot/${product}` };
}

export const riotScanner: StoreScanner = {
  addon: "riot",
  name: "Riot Client",
  platforms: ["win32"],
  async scan() {
    const meta = path.join(programData(), "Riot Games", "Metadata");
    const out: LocalStoreGame[] = [];
    for (const d of await readdir(meta).catch(() => [] as string[])) {
      const m = /^([a-z0-9_]+)\.live$/.exec(d);
      if (!m) continue;
      const yaml = await readFile(path.join(meta, d, `${d}.product_settings.yaml`), "utf8").catch(() => null);
      const g = yaml && riotFromSettings(m[1]!, yaml);
      if (g) out.push(g);
    }
    return out;
  },
};

// ---- Starting games from those launchers --------------------------------------------------

/** Where the Riot Client is, from RiotClientInstalls.json. */
export function riotClientPath(json: string): string | null {
  try {
    const j = JSON.parse(json) as Record<string, unknown>;
    const p = [j.rc_default, j.rc_live].find((x): x is string => typeof x === "string" && /RiotClientServices\.exe$/i.test(x));
    return p ?? null;
  } catch {
    return null;
  }
}

/**
 * The command a lootden-launcher:// link stands for on this PC, built from what's installed here
 * (never from the link itself beyond a short id). Null when it isn't one, or the launcher isn't here.
 */
export async function resolveLauncherLink(url: string, find: (addon: string, id: string) => Promise<LocalStoreGame | undefined> = async (addon, id) => (addon === "rockstar" ? (await rockstarScanner.scan()) : await riotScanner.scan()).find((g) => g.externalId === id)): Promise<{ cmd: string; args: string[] } | null> {
  const m = /^lootden-launcher:\/\/(rockstar|riot)\/([a-z0-9_]{1,40})$/i.exec(url);
  if (!m) return null;
  const [, kind, id] = [m[0], m[1]!.toLowerCase(), m[2]!.toLowerCase()];
  if (kind === "riot") {
    const exe = riotClientPath(await readFile(path.join(programData(), "Riot Games", "RiotClientInstalls.json"), "utf8").catch(() => ""));
    if (!exe) throw new Error("The Riot Client isn't installed on this PC");
    return { cmd: exe, args: [`--launch-product=${id}`, "--launch-patchline=live"] };
  }
  const game = await find("rockstar", id);
  const launcher = [...(await uninstallKeys()).values()].map((v) => /"?([^"]*Rockstar Games\\Launcher)\\uninstall\.exe/i.exec(v.UninstallString ?? "")?.[1]).find(Boolean);
  if (!game || !launcher) throw new Error("The Rockstar Games Launcher or this game isn't installed on this PC");
  return { cmd: path.win32.join(launcher, "Launcher.exe"), args: ["-launchTitleInFolder", game.installDir] };
}
