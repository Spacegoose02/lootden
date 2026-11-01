// Recomps: native PC versions of console games, rebuilt by their developers from the original game
// (Zelda 64: Recompiled, Star Fox 64: Recompiled). They're a second way to play a console game that's
// already in the library: the desktop app downloads the recomp from its developer's GitHub releases and
// hands it the ROM from the library. The recomp never comes from the LootDen server, and the game files
// never come from anywhere but the library.

export interface RecompInfo {
  id: string;
  name: string;
  /** The game it plays, as people know it. */
  game: string;
  /** owner/name on GitHub. Releases come from here only. */
  repo: string;
  /** The library platform whose games it plays. */
  platform: string;
  /** Titles it plays, squashed to lowercase letters and digits ("majorasmask"); a library title containing one matches. */
  titles: string[];
  /**
   * N64 recomps built on N64ModernRuntime keep a checked copy of the ROM in their data folder as
   * <romId>.z64 (big-endian). LootDen puts it there so the recomp skips its own "pick your ROM" screen.
   */
  rom?: {
    romId: string;
    /** The name in the ROM header, so the wrong game or a hack isn't handed over. */
    header: string;
    /** Header country code ("E" is USA), when only one release works. */
    country?: string;
    /** What to ask for when the library copy isn't the right one. */
    label: string;
  };
  /** Program names, tried in order (".exe" is added on Windows). */
  programs: string[];
  note?: string;
}

export const RECOMPS: RecompInfo[] = [
  {
    id: "zelda64recomp",
    name: "Zelda 64: Recompiled",
    game: "The Legend of Zelda: Majora's Mask",
    repo: "Zelda64Recomp/Zelda64Recomp",
    platform: "n64",
    titles: ["majorasmask"],
    rom: { romId: "mm.n64.us.1.0", header: "ZELDA MAJORA'S MASK", country: "E", label: "the USA release of Majora's Mask (.z64, .n64 or .v64)" },
    programs: ["Zelda64Recompiled"],
    note: "Needs the USA ROM. Mods, widescreen and high frame rates are in the game's own menu.",
  },
  {
    id: "starfox64recomp",
    name: "Star Fox 64: Recompiled",
    game: "Star Fox 64",
    repo: "sonicdcer/Starfox64Recomp",
    platform: "n64",
    titles: ["starfox64"],
    rom: { romId: "sf64.n64.us.1.1", header: "STARFOX64", country: "E", label: "the USA 1.1 release of Star Fox 64 (.z64, .n64 or .v64)" },
    programs: ["Starfox64Recompiled"],
    note: "Needs the USA 1.1 ROM (Lylat Wars and 1.0 aren't supported by the recomp).",
  },
];

export function recompInfo(id: string): RecompInfo | undefined {
  return RECOMPS.find((r) => r.id === id);
}

/** Lowercase letters and digits only: "The Legend of Zelda: Majora's Mask" -> "thelegendofzeldamajorasmask". */
export function squash(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Recomps that play this library game. */
export function recompsFor(game: { platform?: string | null; title: string }): RecompInfo[] {
  const t = squash(game.title);
  return RECOMPS.filter((r) => r.platform === (game.platform ?? "pc") && r.titles.some((x) => t.includes(x)));
}

// ---- Release files ------------------------------------------------------------------------

export type RecompOs = "win32" | "linux";
export type RecompArch = "x64" | "arm64";

/** Files in a release that are never the game. */
const NOT_THE_GAME = /debug|symbols|\.pdb|source|\.(sha256|sig|asc|txt|json)$/i;

function words(name: string): string[] {
  return name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Picks the release file for this PC from the words in its name (MyRecomp-v1.2-Windows-x64.zip),
 * or null when there isn't one. Archives LootDen can unpack only; installers are left for later.
 */
export function pickRecompAsset(names: string[], os: RecompOs, arch: RecompArch = "x64"): string | null {
  let best: { name: string; score: number } | null = null;
  for (const name of names) {
    if (NOT_THE_GAME.test(name)) continue;
    const w = words(name);
    const has = (...xs: string[]) => xs.some((x) => w.includes(x));
    const lower = name.toLowerCase();
    const appImage = lower.endsWith(".appimage");
    const archive = /\.(zip|7z)$/.test(lower);
    if (!archive && !(os === "linux" && appImage)) continue;
    if (has("macos", "mac", "osx", "darwin", "android", "ios", "apple")) continue;
    const forWindows = has("windows", "win", "win64", "win32", "msvc");
    const forLinux = has("linux") || appImage;
    if (os === "win32" ? !forWindows || forLinux : !forLinux || forWindows) continue;
    const arm = has("arm64", "aarch64", "arm");
    if ((arch === "x64") === arm) continue;
    let score = 0;
    if (has("x64", "x86", "amd64", "64")) score += 1;
    if (has("flatpak", "steamdeck", "deck")) score -= 2;
    if (lower.endsWith(".zip")) score += 1;
    if (!best || score > best.score) best = { name, score };
  }
  return best?.name ?? null;
}

/** "sha256:abc..." as GitHub gives it for each release file, or null. */
export function sha256FromDigest(digest: unknown): string | null {
  const m = typeof digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(digest.trim()) : null;
  return m ? m[1]!.toLowerCase() : null;
}

// ---- N64 ROMs ---------------------------------------------------------------------------

export type N64Order = "z64" | "v64" | "n64";

/** Which byte order an N64 ROM is in, from its first word, or null when it isn't one. */
export function n64Order(b: Uint8Array): N64Order | null {
  if (b.length < 0x40) return null;
  const w = [b[0], b[1], b[2], b[3]].join(",");
  if (w === "128,55,18,64") return "z64"; // 80 37 12 40
  if (w === "55,128,64,18") return "v64"; // 37 80 40 12
  if (w === "64,18,55,128") return "n64"; // 40 12 37 80
  return null;
}

/** The ROM in big-endian (.z64) order, the way N64ModernRuntime stores it. Returns the same array when it already is. */
export function toZ64(b: Uint8Array): Uint8Array {
  const order = n64Order(b);
  if (!order || order === "z64") return b;
  const out = new Uint8Array(b.length);
  if (order === "v64") {
    for (let i = 0; i + 1 < b.length; i += 2) {
      out[i] = b[i + 1]!;
      out[i + 1] = b[i]!;
    }
  } else {
    for (let i = 0; i + 3 < b.length; i += 4) {
      out[i] = b[i + 3]!;
      out[i + 1] = b[i + 2]!;
      out[i + 2] = b[i + 1]!;
      out[i + 3] = b[i]!;
    }
  }
  return out;
}

/** The game's name, country code and revision from an N64 ROM header (any byte order). */
export function n64Header(b: Uint8Array): { order: N64Order; name: string; country: string; version: number } | null {
  const order = n64Order(b);
  if (!order) return null;
  const head = toZ64(b.subarray(0, 0x40));
  const name = String.fromCharCode(...head.subarray(0x20, 0x34)).replace(/[\0\s]+$/, "");
  return { order, name, country: String.fromCharCode(head[0x3e]!), version: head[0x3f]! };
}

/** Why this ROM can't be handed to the recomp, or null when it can. */
export function recompRomProblem(r: RecompInfo, b: Uint8Array): string | null {
  if (!r.rom) return null;
  const h = n64Header(b);
  if (!h) return `That file isn't an N64 ROM. ${r.name} needs ${r.rom.label}.`;
  if (h.name.toUpperCase() !== r.rom.header) return `That ROM is "${h.name}". ${r.name} needs ${r.rom.label}.`;
  if (r.rom.country && h.country !== r.rom.country) return `That ROM is from another region. ${r.name} needs ${r.rom.label}.`;
  return null;
}

// ---- recomplauncher.json ----------------------------------------------------------------

/**
 * The parts of a recomp's recomplauncher.json that LootDen uses, read from the public format
 * (https://github.com/elripalda/RecompLauncher/blob/main/docs/DEVELOPERS.md): how to start it and
 * where its saves are. The rest (settings, setup steps, mods) comes in later versions.
 */
export interface RecompManifest {
  programs: string[];
  args: string[];
  env: Record<string, string>;
  saves: string[];
}

const strings = (v: unknown, max = 40): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string" && x.length > 0 && x.length < 500).slice(0, max);

/** Reads recomplauncher.json; anything unexpected is left out instead of failing. */
export function parseRecompManifest(input: unknown): RecompManifest {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const start = (o.start && typeof o.start === "object" ? o.start : {}) as Record<string, unknown>;
  const env: Record<string, string> = {};
  if (start.env && typeof start.env === "object") {
    for (const [k, v] of Object.entries(start.env as Record<string, unknown>)) {
      // Letters, digits and _ only, and never the system's own (PATH, HOME...).
      if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && !/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|SYSTEMROOT|WINDIR|LD_PRELOAD|LD_LIBRARY_PATH)$/i.test(k) && typeof v === "string") env[k] = v;
    }
  }
  return {
    // Program paths stay inside the recomp's folder.
    programs: strings(start.program).filter((p) => !p.split(/[\\/]/).includes("..") && !/^([a-z]:|[\\/])/i.test(p)),
    args: strings(start.args, 100),
    env,
    saves: strings(o.saves),
  };
}

/** Fills {install}, {game}, {documents}... in a manifest value. Unknown names stay as they are. */
export function fillRecompPath(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (m, name: string) => vars[name] ?? m);
}

/** The save-backup runner tag for a recomp, so its saves stay apart from the emulator's for the same game. */
export const recompRunner = (id: string) => `recomp:${id}`;
