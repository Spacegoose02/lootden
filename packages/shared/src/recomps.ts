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
  /** Program names, tried in order (".exe" is added on Windows). Empty: the release's own recomplauncher.json says, or LootDen guesses. */
  programs: string[];
  note?: string;
  /** Added by an admin from a GitHub link, rather than built into LootDen. */
  custom?: boolean;
}

/**
 * What an admin types to add a recomp: its GitHub link (or owner/name), the library system it plays,
 * and the titles of the games it plays. Throws with a message for the person when something's off.
 */
export function cleanCustomRecomp(input: unknown, platforms: string[]): RecompInfo {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const link = typeof o.repo === "string" ? o.repo.trim() : "";
  const m = /^(?:https?:\/\/(?:www\.)?github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[?#].*)?$/.exec(link) ?? /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/.*$/.exec(link);
  if (!m) throw new Error("Paste the recomp's GitHub link, like https://github.com/owner/name");
  const repo = `${m[1]}/${m[2]}`;
  const platform = typeof o.platform === "string" ? o.platform : "";
  if (!platforms.includes(platform) || platform === "pc") throw new Error("Pick the console the recomp's game is from");
  const titles = [...new Set(strings(o.titles, 10).map(squash).filter((t) => t.length >= 3))];
  if (!titles.length) throw new Error("Add the title of the game it plays, as it's named in your library");
  const id = squash(m[2]!).slice(0, 40);
  if (!id || RECOMPS.some((r) => r.id === id)) throw new Error(RECOMPS.some((r) => r.id === id) ? "LootDen already knows that recomp" : "That link doesn't name a repository");
  const name = (typeof o.name === "string" && o.name.trim().slice(0, 80)) || m[2]!.replace(/[-_.]+/g, " ");
  const game = (typeof o.game === "string" && o.game.trim().slice(0, 120)) || strings(o.titles, 1)[0]!.trim().slice(0, 120);
  return { id, name, game, repo, platform, titles, programs: [], custom: true };
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

/** A recomp by id: LootDen's own, or one an admin added (pass the server's list). */
export function recompInfo(id: string, added: RecompInfo[] = []): RecompInfo | undefined {
  return RECOMPS.find((r) => r.id === id) ?? added.find((r) => r.id === id);
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
export function recompsFor(game: { platform?: string | null; title: string }, added: RecompInfo[] = []): RecompInfo[] {
  const t = squash(game.title);
  return [...RECOMPS, ...added].filter((r) => r.platform === (game.platform ?? "pc") && r.titles.some((x) => t.includes(x)));
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
  /** Settings files LootDen edits before every start. */
  config: RecompConfigFile[];
  /** Choices the player makes on the game's page. */
  settings: RecompSetting[];
  /** A setup step run without a window before the first start, and again when the game file changes. */
  prepare: { programs: string[]; args: string[]; label: string; timeout: number } | null;
  /** Messages for exit codes, shown instead of "it crashed". */
  exitCodes: Record<string, string>;
}

export type RecompConfigFormat = "toml" | "ini" | "json";

export interface RecompConfigFile {
  id: string;
  format: RecompConfigFormat;
  /** Where it is: the first entry whose `if` exists, else the first without one. */
  file: Array<{ path: string; if?: string }>;
  /** Key that holds the path to the game file, written on every start. */
  gamePath: string | null;
  /** Set only when missing or empty. */
  ensure: Record<string, string>;
  /** Set on every start. */
  always: Record<string, string>;
  /** Set only when the file doesn't exist yet. */
  fresh: Record<string, string>;
}

export interface RecompChoice {
  label: string;
  /** Keys this choice writes, in the file the setting names. */
  set: Record<string, string>;
  /** Arguments this choice adds on Play (settings with in: "args"). */
  args: string[];
}

export interface RecompSetting {
  id: string;
  label: string;
  help: string;
  /** A config file's id, or "args". */
  in: string;
  choices: RecompChoice[];
  defaults: Record<string, string>;
  /** Greyed out unless these keys have these values. */
  when: Record<string, string>;
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
  const prep = o.prepare && typeof o.prepare === "object" ? (o.prepare as Record<string, unknown>) : null;
  const prepPrograms = prep ? strings(prep.program).filter(insideFolder) : [];
  const exitCodes: Record<string, string> = {};
  if (o.exit_codes && typeof o.exit_codes === "object") {
    for (const [k, v] of Object.entries(o.exit_codes as Record<string, unknown>).slice(0, 50)) if (/^-?\d{1,12}$/.test(k) && typeof v === "string") exitCodes[k] = v.slice(0, 300);
  }
  const config = objects(o.config).slice(0, 10).map(cleanConfig).filter((c): c is RecompConfigFile => c !== null);
  return {
    // Program paths stay inside the recomp's folder.
    programs: strings(start.program).filter(insideFolder),
    args: strings(start.args, 100),
    env,
    saves: strings(o.saves),
    config,
    settings: objects(o.settings).slice(0, 40).map(cleanSetting).filter((x): x is RecompSetting => x !== null),
    prepare: prepPrograms.length
      ? {
          programs: prepPrograms,
          args: strings(prep!.args, 100),
          label: typeof prep!.label === "string" ? prep!.label.slice(0, 120) : "Getting the extras",
          timeout: typeof prep!.timeout === "number" && prep!.timeout > 0 ? Math.min(prep!.timeout, 3600) : 300,
        }
      : null,
    exitCodes,
  };
}

const insideFolder = (p: string) => !p.split(/[\\/]/).includes("..") && !/^([a-z]:|[\\/])/i.test(p);
const objects = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) : []);
const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.\- ]{0,99}$/;
function keyValues(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 100)) {
      if (!KEY.test(k)) continue;
      if (typeof x === "string") out[k] = x.slice(0, 1000);
      else if (typeof x === "number" || typeof x === "boolean") out[k] = String(x);
    }
  }
  return out;
}

function cleanConfig(c: Record<string, unknown>): RecompConfigFile | null {
  const format = c.format;
  if (format !== "toml" && format !== "ini" && format !== "json") return null;
  const file = (typeof c.file === "string" ? [{ path: c.file }] : objects(c.file))
    .map((f) => ({ path: typeof f.path === "string" ? f.path : "", ...(typeof f.if === "string" ? { if: f.if } : {}) }))
    .filter((f) => f.path.length > 0 && f.path.length < 500)
    .slice(0, 5);
  if (!file.length) return null;
  return {
    id: typeof c.id === "string" && /^[\w-]{1,40}$/.test(c.id) ? c.id : "main",
    format,
    file,
    gamePath: typeof c.game_path === "string" && KEY.test(c.game_path) ? c.game_path : null,
    ensure: keyValues(c.ensure),
    always: keyValues(c.always),
    fresh: keyValues(c.new),
  };
}

function cleanSetting(x: Record<string, unknown>): RecompSetting | null {
  if (typeof x.id !== "string" || !/^[\w-]{1,40}$/.test(x.id) || typeof x.label !== "string") return null;
  const where = typeof x.in === "string" && /^[\w-]{1,40}$/.test(x.in) ? x.in : "main";
  const choices = objects(x.choices)
    .slice(0, 20)
    .filter((c) => typeof c.label === "string")
    .map((c) => ({ label: (c.label as string).slice(0, 60), set: keyValues(c.set), args: strings(c.args, 20) }));
  if (!choices.length) return null;
  return { id: x.id, label: x.label.slice(0, 60), help: typeof x.help === "string" ? x.help.slice(0, 300) : "", in: where, choices, defaults: keyValues(x.defaults), when: keyValues(x.when) };
}

// ---- Settings files ------------------------------------------------------------------

/** A key's place in a file: TOML and INI "section.key" means key under [section]; JSON dots walk objects. */
function splitKey(key: string): { section: string | null; name: string } {
  const i = key.lastIndexOf(".");
  return i > 0 ? { section: key.slice(0, i), name: key.slice(i + 1) } : { section: null, name: key };
}

/**
 * Reads the keys of a TOML or INI file as their raw text ("1", "\"xenos\""), so they compare with the
 * values a manifest writes. Only plain `key = value` lines; arrays and tables of tables are left alone.
 */
export function readConfigKeys(text: string, format: RecompConfigFormat): Record<string, string> {
  if (format === "json") {
    const out: Record<string, string> = {};
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      return out;
    }
    const walk = (v: unknown, prefix: string) => {
      if (v && typeof v === "object" && !Array.isArray(v)) for (const [k, x] of Object.entries(v)) walk(x, prefix ? `${prefix}.${k}` : k);
      else if (prefix) out[prefix] = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v);
    };
    walk(root, "");
    return out;
  }
  const out: Record<string, string> = {};
  let section: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (head) {
      section = head[1]!.trim();
      continue;
    }
    const kv = /^\s*([^=#;\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv) out[section ? `${section}.${kv[1]}` : kv[1]!] = kv[2]!;
  }
  return out;
}

/**
 * Sets keys in a TOML, INI or JSON file's text and returns the new text. TOML and INI change line by
 * line, so comments, order and keys LootDen doesn't know stay as they were. Values go in as written.
 */
export function writeConfigKeys(text: string, format: RecompConfigFormat, values: Record<string, string>): string {
  if (format === "json") {
    let root: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) root = parsed;
    } catch {
      // A broken file is replaced by the keys LootDen knows.
    }
    for (const [key, raw] of Object.entries(values)) {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
      const parts = key.split(".");
      let at = root;
      for (const p of parts.slice(0, -1)) {
        if (!at[p] || typeof at[p] !== "object" || Array.isArray(at[p])) at[p] = {};
        at = at[p] as Record<string, unknown>;
      }
      at[parts.at(-1)!] = value;
    }
    return JSON.stringify(root, null, 2) + "\n";
  }
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.length && lines.at(-1) === "") lines.pop();
  const header = (line: string) => /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1]?.trim() ?? null;
  for (const [key, value] of Object.entries(values)) {
    const { section, name } = splitKey(key);
    // The lines that belong to the section: from its header (or the top) to the next header.
    let start = 0;
    if (section !== null) {
      const h = lines.findIndex((l) => header(l) === section);
      if (h < 0) {
        if (lines.length && lines.at(-1)!.trim() !== "") lines.push("");
        lines.push(`[${section}]`, `${name} = ${value}`);
        continue;
      }
      start = h + 1;
    }
    let end = start;
    while (end < lines.length && header(lines[end]!) === null) end++;
    let done = false;
    for (let i = start; i < end; i++) {
      const kv = /^(\s*)([^=#;\s\[][^=]*?)(\s*=\s*)(.*?)\s*$/.exec(lines[i]!);
      if (kv && kv[2] === name) {
        lines[i] = `${kv[1]}${kv[2]}${kv[3]}${value}`;
        done = true;
        break;
      }
    }
    if (done) continue;
    let at = end;
    while (at > start && lines[at - 1]!.trim() === "") at--;
    lines.splice(at, 0, `${name} = ${value}`);
  }
  return lines.join(nl) + nl;
}

/** The choice a file-backed setting is on: the first whose keys all match the file (missing keys read from defaults). */
export function currentChoice(setting: RecompSetting, keys: Record<string, string>): number {
  const value = (k: string) => keys[k] ?? setting.defaults[k];
  const i = setting.choices.findIndex((c) => Object.keys(c.set).length > 0 && Object.entries(c.set).every(([k, v]) => value(k) === v));
  return i;
}

/** Whether a setting applies now, from its `when` keys. */
export function settingApplies(setting: RecompSetting, keys: Record<string, string>): boolean {
  return Object.entries(setting.when).every(([k, v]) => (keys[k] ?? setting.defaults[k]) === v);
}

/** A "progress 0.4 Unpacking menu art" line from a setup step, or null. */
export function prepareProgress(line: string): { fraction: number; text: string } | null {
  const m = /^\s*progress\s+(\d*\.?\d+)\s*(.*)$/i.exec(line);
  if (!m) return null;
  return { fraction: Math.max(0, Math.min(1, Number(m[1]))), text: m[2]!.trim().slice(0, 200) };
}

/** Fills {install}, {game}, {documents}... in a manifest value. Unknown names stay as they are. */
export function fillRecompPath(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (m, name: string) => vars[name] ?? m);
}

/** The save-backup runner tag for a recomp, so its saves stay apart from the emulator's for the same game. */
export const recompRunner = (id: string) => `recomp:${id}`;
