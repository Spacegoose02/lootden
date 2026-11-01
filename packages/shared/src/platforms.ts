// Systems LootDen knows. PC games live at the top of the games folder; everything else
// lives in Emulation/<platform>/ with one file or folder per game.

export interface Platform {
  /** Folder name under Emulation/ and the value stored on each game. */
  id: string;
  name: string;
  /** Short label for badges and tabs. */
  short: string;
  /** Other folder names that mean the same system (roms/psx, roms/megadrive, ...). */
  aliases: string[];
  /** Box art shape as width / height, so each system's grid looks like its shelf. */
  coverAspect: number;
  /** Accent colour for the system's header and badges. */
  color: string;
  /** Emulator that runs it in the desktop app; null for PC, and for systems only recomps play (Xbox 360). */
  emulator: string | null;
  /** Files the emulator opens, best first. Archives count when the emulator reads them directly. */
  extensions: string[];
  /** IGDB and RAWG platform ids so "Ridge Racer" on PS1 doesn't match the PSP game. */
  igdb: number | null;
  rawg: number | null;
  /** EmulatorJS core for playing in the browser; null when the system is too heavy for it. */
  browserCore?: string;
  /**
   * A browser emulator of its own instead of EmulatorJS: "tabstationtoo" is PCSX2 compiled to
   * WebAssembly, served by the LootDen server when the image includes it and an admin allows it.
   */
  browserPlayer?: "tabstationtoo";
}

const p = (x: Platform) => x;

export const PLATFORMS: Platform[] = [
  p({ id: "pc", name: "PC", short: "PC", aliases: ["windows", "win"], coverAspect: 3 / 4, color: "#4aa8ff", emulator: null, extensions: [], igdb: 6, rawg: 4 }),
  p({ id: "ps1", name: "PlayStation", short: "PS1", aliases: ["psx", "playstation", "ps"], coverAspect: 1, color: "#9aa0a6", emulator: "duckstation", extensions: ["m3u", "cue", "chd", "pbp", "iso", "bin", "img", "ecm"], igdb: 7, rawg: 27, browserCore: "psx" }),
  p({ id: "ps2", name: "PlayStation 2", short: "PS2", aliases: ["playstation2"], coverAspect: 0.7, color: "#3b5fd9", emulator: "pcsx2", extensions: ["chd", "iso", "cso", "zso", "cue", "bin", "gz"], igdb: 8, rawg: 15, browserPlayer: "tabstationtoo" }),
  p({ id: "ps3", name: "PlayStation 3", short: "PS3", aliases: ["playstation3"], coverAspect: 0.86, color: "#d0d4da", emulator: "rpcs3", extensions: ["bin", "iso", "pkg"], igdb: 9, rawg: 16 }),
  p({ id: "xbox", name: "Xbox", short: "Xbox", aliases: ["xbox-original", "ogxbox"], coverAspect: 0.7, color: "#3fbf3f", emulator: "xemu", extensions: ["xiso", "iso"], igdb: 11, rawg: 80 }),
  // No emulator in LootDen yet: Xbox 360 games play through their recomps (Unleashed Recompiled and others).
  p({ id: "x360", name: "Xbox 360", short: "X360", aliases: ["xbox360", "360"], coverAspect: 0.7, color: "#5dc21e", emulator: null, extensions: ["iso", "xex", "zar"], igdb: 12, rawg: 14 }),
  p({ id: "psp", name: "PlayStation Portable", short: "PSP", aliases: [], coverAspect: 0.58, color: "#6c6f75", emulator: "retroarch", extensions: ["chd", "cso", "iso", "pbp"], igdb: 38, rawg: 17, browserCore: "psp" }),
  p({ id: "nes", name: "NES", short: "NES", aliases: ["famicom", "fc"], coverAspect: 0.73, color: "#e4002b", emulator: "retroarch", extensions: ["nes", "fds", "unf", "zip", "7z"], igdb: 18, rawg: 49, browserCore: "nes" }),
  p({ id: "snes", name: "Super Nintendo", short: "SNES", aliases: ["sfc", "superfamicom"], coverAspect: 1.38, color: "#7b5cc4", emulator: "retroarch", extensions: ["sfc", "smc", "zip", "7z"], igdb: 19, rawg: 79, browserCore: "snes" }),
  p({ id: "n64", name: "Nintendo 64", short: "N64", aliases: [], coverAspect: 1.38, color: "#2a9d3c", emulator: "retroarch", extensions: ["z64", "n64", "v64", "zip", "7z"], igdb: 4, rawg: 83, browserCore: "n64" }),
  p({ id: "gb", name: "Game Boy", short: "GB", aliases: ["gameboy"], coverAspect: 1, color: "#8bac0f", emulator: "retroarch", extensions: ["gb", "zip", "7z"], igdb: 33, rawg: 26, browserCore: "gb" }),
  p({ id: "gbc", name: "Game Boy Color", short: "GBC", aliases: ["gameboycolor"], coverAspect: 1, color: "#c4219e", emulator: "retroarch", extensions: ["gbc", "gb", "zip", "7z"], igdb: 22, rawg: 43, browserCore: "gb" }),
  p({ id: "gba", name: "Game Boy Advance", short: "GBA", aliases: ["gameboyadvance"], coverAspect: 1, color: "#5a3fc0", emulator: "retroarch", extensions: ["gba", "zip", "7z"], igdb: 24, rawg: 24, browserCore: "gba" }),
  p({ id: "nds", name: "Nintendo DS", short: "DS", aliases: ["ds"], coverAspect: 0.9, color: "#a7a9ac", emulator: "retroarch", extensions: ["nds", "zip", "7z"], igdb: 20, rawg: 9, browserCore: "nds" }),
  p({ id: "gamecube", name: "GameCube", short: "GC", aliases: ["gc", "ngc"], coverAspect: 0.7, color: "#6a4fc9", emulator: "retroarch", extensions: ["rvz", "iso", "gcm", "ciso"], igdb: 21, rawg: 105 }),
  p({ id: "wii", name: "Wii", short: "Wii", aliases: [], coverAspect: 0.7, color: "#38b6e8", emulator: "retroarch", extensions: ["rvz", "wbfs", "iso"], igdb: 5, rawg: 11 }),
  p({ id: "genesis", name: "Sega Genesis", short: "Genesis", aliases: ["megadrive", "md"], coverAspect: 0.7, color: "#1f1f1f", emulator: "retroarch", extensions: ["md", "gen", "smd", "bin", "zip", "7z"], igdb: 29, rawg: 167, browserCore: "segaMD" }),
  p({ id: "saturn", name: "Sega Saturn", short: "Saturn", aliases: ["ss"], coverAspect: 0.7, color: "#4a6fb5", emulator: "retroarch", extensions: ["m3u", "cue", "chd"], igdb: 32, rawg: 107, browserCore: "segaSaturn" }),
  p({ id: "dreamcast", name: "Dreamcast", short: "DC", aliases: ["dc"], coverAspect: 1, color: "#f26522", emulator: "retroarch", extensions: ["m3u", "gdi", "chd", "cdi"], igdb: 23, rawg: 106 }),
];

/** The PC platform: the default for anything outside Emulation/. */
export const PC_PLATFORM = "pc";

/** Finds a platform by id or folder alias; unknown folders become their own basic platform. */
export function platformFor(folder: string): Platform {
  const key = folder.toLowerCase().replace(/[\s_]+/g, "");
  const known = PLATFORMS.find((x) => x.id === key || x.aliases.includes(key));
  if (known) return known;
  return { id: key, name: folder, short: folder.slice(0, 8), aliases: [], coverAspect: 3 / 4, color: "#888888", emulator: null, extensions: [], igdb: null, rawg: null };
}

/**
 * The file an emulator should open from a downloaded game: playlists and cue sheets
 * before the tracks they point at, then the platform's extensions in order.
 * PS3 folder games open through their EBOOT.BIN.
 */
export function pickRomFile(files: string[], platform: Platform): string | null {
  const lower = files.map((f) => f.toLowerCase());
  if (platform.id === "ps3") {
    const eboot = lower.findIndex((f) => /(^|\/)ps3_game\/usrdir\/eboot\.bin$/.test(f));
    if (eboot >= 0) return files[eboot]!;
  }
  for (const ext of platform.extensions) {
    const matches = files.filter((_, i) => lower[i]!.endsWith(`.${ext}`));
    if (matches.length) return matches.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0]!;
  }
  return null;
}

/** "Crash Bandicoot (USA) (Rev 1) [!]" → "Crash Bandicoot"; region and dump tags only confuse metadata search. */
export function romTitle(name: string, isFile = false): string {
  return (isFile ? name.replace(/(\.[a-z0-9]{1,5})+$/i, "") : name)
    .replace(/\s*[([][^)\]]*[)\]]/g, "")
    // Scene-style "Super.Mario.World" dots become spaces; "Dr. Mario" keeps its dot.
    .replace(/_+|\.(?=\S)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Disc images TabStationToo reads, best first. A BIN/CUE game plays when it has one .bin
 * (TabStationToo checks it holds a PS2 data track); multi-file BIN/CUE and CHDs with a parent don't.
 */
export const TABSTATIONTOO_DISCS = ["chd", "iso", "cso", "zso", "bin", "img", "gz"];

/**
 * The file to stream to the in-browser emulator, or null when the game can't play there.
 * The browser loads one file, so cue sheets with separate tracks and multi-file games don't work;
 * CHD, PBP, ISO, single-track BIN and cartridge ROMs (zipped or not) do.
 */
export function browserRomFile(files: Array<{ path: string; index: number }>, platform: Platform): { path: string; index: number } | null {
  if (!platform.browserCore && !platform.browserPlayer) return null;
  const singles = (platform.browserPlayer === "tabstationtoo" ? TABSTATIONTOO_DISCS : platform.extensions).filter((e) => !["m3u", "cue", "gdi"].includes(e));
  if (files.length === 1) return !platform.browserPlayer || singles.some((e) => files[0]!.path.toLowerCase().endsWith(`.${e}`)) ? files[0]! : null;
  for (const ext of singles) {
    const hits = files.filter((f) => f.path.toLowerCase().endsWith(`.${ext}`));
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}

/**
 * The in-game save (battery save or memory card) as one file inside a save backup, at the
 * same path the desktop emulator uses, so the browser and the desktop app share progress.
 * RetroArch cores and the browser's cores both write raw battery saves; PS1 memory cards are
 * raw 128 KB cards in both DuckStation and the browser.
 */
export function sharedSavePath(platform: Platform, romFile: string): string | null {
  const base = romFile.split("/").pop()!.replace(/\.[^.]+$/, "");
  if (platform.id === "ps1") return `memcards/${base}_1.mcd`;
  if (platform.emulator === "retroarch") return `saves/${base}.srm`;
  return null;
}
