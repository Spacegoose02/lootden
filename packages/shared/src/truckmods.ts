// Mods for SCS Software's truck games (American Truck Simulator, Euro Truck Simulator 2). The
// games load mods from a "mod" folder in the player's Documents, not from the game's install,
// so these are kept apart from the Steam Workshop items that go into a game's own folder.
// Mods come in through the desktop app's browser (TruckyMods' "Manual Download", or any .scs
// file), are installed on that PC and kept on the server so every other PC can add them too.

export type TruckGame = "ats" | "ets2";

export interface TruckGameInfo {
  id: TruckGame;
  name: string;
  short: string;
  steamAppId: string;
  /** The game's folder in Documents (Windows) or ~/.local/share (Linux); mods go in its "mod" folder. */
  folder: string;
  /** The game's page on TruckyMods. */
  truckyModsUrl: string;
}

export const TRUCK_GAMES: Record<TruckGame, TruckGameInfo> = {
  ats: {
    id: "ats",
    name: "American Truck Simulator",
    short: "ATS",
    steamAppId: "270880",
    folder: "American Truck Simulator",
    truckyModsUrl: "https://truckymods.io/american-truck-simulator",
  },
  ets2: {
    id: "ets2",
    name: "Euro Truck Simulator 2",
    short: "ETS2",
    steamAppId: "227300",
    folder: "Euro Truck Simulator 2",
    truckyModsUrl: "https://truckymods.io/euro-truck-simulator-2",
  },
};

export function isTruckGame(x: unknown): x is TruckGame {
  return x === "ats" || x === "ets2";
}

/** The truck game a Steam app id is, if any. */
export function truckGameForSteamApp(appId: string | null | undefined): TruckGame | null {
  for (const g of Object.values(TRUCK_GAMES)) if (g.steamAppId === String(appId ?? "")) return g.id;
  return null;
}

/** A library game is a truck game when its Steam app id or its title says so. */
export function truckGameFor(steamAppId: string | null | undefined, title: string | null | undefined): TruckGame | null {
  const byId = truckGameForSteamApp(steamAppId);
  if (byId) return byId;
  const t = String(title ?? "").toLowerCase();
  if (/american truck simulator/.test(t)) return "ats";
  if (/euro truck simulator 2/.test(t)) return "ets2";
  return null;
}

/** The game a page or download address is about, from words in it; null when it doesn't say. */
export function truckGameFromUrl(url: string | null | undefined): TruckGame | null {
  const s = decodeURIComponentSafe(String(url ?? "")).toLowerCase();
  if (/american[-_ ]?truck[-_ ]?simulator|[/=._-]ats(?:[/?&._-]|$)/.test(s)) return "ats";
  if (/euro[-_ ]?truck[-_ ]?simulator|[/=._-]ets2?(?:[/?&._-]|$)/.test(s)) return "ets2";
  return null;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The file types a truck mod download comes as: a mod itself, or an archive of them. */
export const TRUCK_MOD_TYPES = [".scs", ".zip", ".7z", ".rar"] as const;

/** The kind of truck mod file a name is, or null when it isn't one. */
export function truckModType(fileName: string): "scs" | "zip" | "7z" | "rar" | null {
  const m = String(fileName).toLowerCase().match(/\.(scs|zip|7z|rar)$/);
  return m ? (m[1] as "scs" | "zip" | "7z" | "rar") : null;
}

/** Whether a site is TruckyMods (or Trucky's file servers), where archives are taken as mods. */
export function isTruckyModsUrl(url: string | null | undefined): boolean {
  try {
    const host = new URL(String(url ?? "")).hostname.toLowerCase();
    return /(^|\.)truckymods\.io$|(^|\.)truckyapp\.com$/.test(host);
  } catch {
    return false;
  }
}

/** A file name safe to keep on the server and in the game's mod folder: no folders, no odd characters. */
export function truckModFileName(input: string): string {
  const base = String(input ?? "").split(/[\\/]/).pop() ?? "";
  const clean = base
    .replace(/[\u0000-\u001f<>:"|?*]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!clean || !truckModType(clean)) throw new Error("Truck mods are .scs files, or .zip, .7z or .rar archives of them");
  if (clean.length <= 150) return clean;
  const ext = clean.slice(clean.lastIndexOf("."));
  return clean.slice(0, 150 - ext.length) + ext;
}

/** A mod kept on the server for a truck game. */
export interface TruckMod {
  id: number;
  game: TruckGame;
  title: string;
  /** The file as it was downloaded: a .scs, or an archive the app unpacks. */
  fileName: string;
  sizeBytes: number;
  /** The page it came from (its TruckyMods page), when known. */
  sourceUrl: string | null;
  /** The mod's own version and the game versions it says it's for (from its manifest.sii), when the app could read them. */
  modVersion: string | null;
  compatibleVersions: string[];
  addedBy: string | null;
  addedAt: string;
  /** When its file last changed (a newer version of the same file replaces the old one). */
  updatedAt: string;
  /** The person asking added it (or is an admin), so they may delete it. */
  canDelete: boolean;
}

/** A mod LootDen put in a truck game's mod folder on this PC. */
export interface InstalledTruckMod {
  /** The server's id for it, or null for one added on this PC while the server couldn't take it. */
  serverId: number | null;
  title: string;
  /** The .scs (or .zip) files it put in the mod folder. */
  files: string[];
  installedAt: string;
  sourceUrl: string | null;
  /** The server's file name for it, so a newer upload of the same file shows as an update. */
  fileName: string | null;
}

/** What a mod's manifest.sii says about it (null fields: it doesn't say, or couldn't be read). */
export interface TruckModManifest {
  name: string | null;
  version: string | null;
  author: string | null;
  /** Game versions the mod says it works with, like "1.53.*". Empty: it doesn't say. */
  compatibleVersions: string[];
}

/**
 * Whether a mod fits the game: "ok", "outdated" (made for an older game), "newer" (needs a newer
 * game than this PC has) or "unknown" (the mod or the game doesn't say which versions).
 */
export type TruckModFit = "ok" | "outdated" | "newer" | "unknown";

/** A mod file in a truck game's mod folder, whoever put it there, and whether it fits the game. */
export interface TruckModFile {
  file: string;
  sizeBytes: number;
  modifiedAt: string;
  manifest: TruckModManifest | null;
  fit: TruckModFit;
  /** LootDen installed it: the installed mod's key (see installedTruckModKey). */
  installedKey: string | null;
}

/** Reads a mod's manifest.sii (SiiNunit text). */
export function parseTruckManifest(text: string): TruckModManifest {
  const str = (key: string) => {
    const m = text.match(new RegExp(`(?:^|\\s)${key}\\s*:\\s*"([^"]*)"`, "m"));
    return m ? m[1]!.trim().slice(0, 200) || null : null;
  };
  const compatibleVersions = [...text.matchAll(/compatible_versions\[\d*\]\s*:\s*"([^"]+)"/g)].map((m) => m[1]!.trim()).filter((v) => /^\d+\.\d+/.test(v));
  return { name: str("display_name"), version: str("package_version"), author: str("author"), compatibleVersions: [...new Set(compatibleVersions)].slice(0, 20) };
}

/** "1.53.3.14s" or "1.53.*" as [1, 53]: the part of a version that mods are made for. */
function majorMinor(v: string): [number, number] | null {
  const m = String(v).match(/^(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Whether a mod made for compatible (its manifest's versions) fits a game at gameVersion. */
export function truckModFit(compatible: string[], gameVersion: string | null): TruckModFit {
  const game = gameVersion ? majorMinor(gameVersion) : null;
  const wants = compatible.map(majorMinor).filter((x): x is [number, number] => !!x);
  if (!game || !wants.length) return "unknown";
  const cmp = (a: [number, number], b: [number, number]) => a[0] - b[0] || a[1] - b[1];
  if (wants.some((w) => cmp(w, game) === 0)) return "ok";
  return wants.every((w) => cmp(w, game) < 0) ? "outdated" : "newer";
}

/** The game's version from its game.log.txt ("... init ver.1.53.3.14s ..."), or null. */
export function truckGameVersionFromLog(log: string): string | null {
  const m = log.match(/init ver\.?\s*(\d+\.\d+(?:\.\d+)*[a-z]?)/i) ?? log.match(/\bver(?:sion)?[.:\s]+(\d+\.\d+\.\d+(?:\.\d+)?)/i);
  return m ? m[1]! : null;
}

/** A readable title for a mod from its file name: "my_cool-mod_v1.2.scs" is "my cool mod v1.2". */
export function truckModTitle(fileName: string): string {
  const stem = String(fileName).replace(/\.(scs|zip|7z|rar)$/i, "");
  return stem.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "Mod";
}
