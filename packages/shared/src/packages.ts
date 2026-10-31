// Telling full games apart from update and DLC packages by their file or folder names.

/** "game": installs on its own. "update": a patch applied over an installed game. "dlc": extra content for one. */
export type PackageKind = "game" | "update" | "dlc";

export interface PackageInfo {
  kind: PackageKind;
  /** The game's name with the update or DLC wording and version removed, for matching to the base game. */
  baseTitle: string;
  /** The version the package brings the game to ("1.3.0.5"), or a full game's own version. */
  version: string | null;
  /** The version an update expects to be installed first, when the name says ("v1.2 to v1.3"). */
  fromVersion: string | null;
}

const VERSION = String.raw`v(?:ersion)?[ ._]?(\d+(?:[._]\d+){0,3}[a-z]?)`;
/** "Update", "Patch", "Hotfix", "Title Update 3", "TU5". */
const UPDATE_WORD = /(?<![a-z])(title[ ._-]?update|update|patch|hot[ ._-]?fix|tu\d+)(?![a-z])/i;
const DLC_WORD = /(?<![a-z])(dlc|expansion[ ._-]?pack|season[ ._-]?pass|add[ ._-]?on)(?![a-z])/i;
/** "incl. Update 3", "+ 5 DLCs", "with Patch": a full game that already contains them. */
const BUNDLED = /(?<![a-z])(incl(?:uding|\.)?|with|plus|and|\+|complete|goty|edition|bundle|collection)[ ._-]*(?:all[ ._-]+)?(?:\d+[ ._-]*)?(?:the[ ._-]+)?(title[ ._-]?update|update|patch|hot[ ._-]?fix|dlcs?|expansions?)/i;
/** "v1.2 to v1.3", "v1.2-v1.3", "from v1.2". */
const FROM_TO = new RegExp(String.raw`${VERSION}[ ._]*(?:to|-|_|→|->)[ ._]*${VERSION}`, "i");
const FROM = new RegExp(String.raw`(?<![a-z])from[ ._]+${VERSION}`, "i");
const ANY_VERSION = new RegExp(String.raw`(?<![a-z0-9])${VERSION}(?![a-z0-9])`, "gi");

const clean = (v: string) => v.replace(/_/g, ".");

/** "Build 12345", "Build.12345". */
const BUILD = /(?<![a-z0-9])build[ ._]?(\d{3,})(?!\d)/i;
/** "(1.0.3)", "[1.2]": a version in brackets, with or without its v. */
const BRACKETED = /[([]v?(\d+(?:\.\d+){1,3}[a-z]?)[)\]]/i;
/**
 * "Occupy Mars 1.0.2": a bare version needs two dots or more, so a title's own number
 * ("College Football 26", "Metal Gear Solid 3", "Fallout 3.5") never counts as one.
 */
const BARE_DOTTED = /(?<=^|[\s_(-])(\d+(?:\.\d+){2,3}[a-z]?)(?![\w.])/i;

/**
 * A version written without a "v": "Build 12345", "[1.0.3]" or a bare "1.0.2". Only used when
 * the name has no "v1.2" style version, which is the clearest way to write one.
 */
function looseVersion(base: string): string | null {
  // A name that starts with it ("Build 1000 Houses") is a title.
  const build = base.match(BUILD);
  if (build && build.index! > 0) return `Build ${build[1]}`;
  return base.match(BRACKETED)?.[1] ?? base.match(BARE_DOTTED)?.[1] ?? null;
}

/** The version a file or folder name gives, if any: "Game v1.2", "Game Build 12345", "Game [1.0.3]". */
export function versionFromName(name: string): string | null {
  const base = name.replace(/(\.part\d+)?\.(zip|7z|rar|exe|msi|iso)(\.\d{3})?$/i, "");
  const versions = [...base.matchAll(ANY_VERSION)].map((m) => clean(m[1]!));
  return versions.pop() ?? looseVersion(base);
}

/** GOG installers: setup_critter_cove_1.2.3_(64bit)_(12345).exe. */
const GOG_SETUP = /^setup_.+?_v?(\d+(?:\.\d+)+[a-z]?)(?:_|\.exe$)/i;
const NOT_THE_GAME = /(^|\/)(_commonredist|redist|redistributables?|directx|physx|vcredist|dotnet|__installer|support|prerequisites?)(\/|$)/i;
const WHOLE_FILE = /\.(exe|msi|zip|7z|rar|iso)(\.\d{3})?$/i;

/**
 * A game's version from what's inside its folder, for folders whose own name doesn't say
 * ("Critter Cove"): a GOG installer's name, the one folder everything sits in
 * ("Critter Cove/Critter Cove v1.2/..."), or an installer or archive at the top.
 */
export function versionFromFiles(files: Array<{ path: string }>): string | null {
  const paths = files.map((f) => f.path.replace(/\\/g, "/")).filter((p) => !NOT_THE_GAME.test(p));
  for (const p of paths) {
    if (p.split("/").length > 2) continue;
    const m = p.split("/").pop()!.match(GOG_SETUP);
    if (m) return m[1]!;
  }
  const tops = new Set(paths.map((p) => p.split("/")[0]!));
  if (tops.size === 1 && paths.every((p) => p.includes("/"))) {
    const v = versionFromName([...tops][0]!);
    if (v) return v;
  }
  for (const p of paths) {
    if (p.includes("/") || !WHOLE_FILE.test(p)) continue;
    const v = versionFromName(p);
    if (v) return v;
  }
  return null;
}

/** "v1.2" for people, or "Build 12345" as it is. */
export function versionLabel(version: string): string {
  return /^build /i.test(version) ? version : `v${version}`;
}

/** Reads what a library entry is from its name ("Game.Update.v1.3-GROUP", "Game v1.2 to v1.3 Patch.zip"). */
export function packageInfo(name: string, folderHint?: "update" | "dlc"): PackageInfo {
  const base = name.replace(/(\.part\d+)?\.(zip|7z|rar|exe|msi)(\.\d{3})?$/i, "");
  const fromTo = base.match(FROM_TO);
  const versions = [...base.matchAll(ANY_VERSION)].map((m) => clean(m[1]!));
  const fromVersion = fromTo ? clean(fromTo[1]!) : (base.match(FROM)?.[1] ? clean(base.match(FROM)![1]!) : null);
  const version = fromTo ? clean(fromTo[2]!) : (versions.filter((v) => v !== fromVersion).pop() ?? (fromVersion ? null : looseVersion(base)));

  let kind: PackageKind = "game";
  if (!BUNDLED.test(base)) {
    // A name that starts with the word ("Patch Quest") is a game's title, not a patch.
    if ((UPDATE_WORD.test(base) && base.search(UPDATE_WORD) > 0) || fromTo || fromVersion) kind = "update";
    else if (DLC_WORD.test(base)) kind = "dlc";
  }
  if (kind === "game" && folderHint) kind = folderHint;

  // The base game's name is everything before the first update/DLC word or version.
  const cut = kind === "game" ? -1 : Math.min(...[UPDATE_WORD, DLC_WORD, new RegExp(String.raw`(?<![a-z0-9])${VERSION}`, "i"), /(?<![a-z])from[ ._]/i].map((re) => base.search(re)).filter((i) => i > 0));
  const head = cut > 0 && Number.isFinite(cut) ? base.slice(0, cut) : base;
  const baseTitle = head
    .replace(/[([{].*$/, "")
    .replace(/-[a-z0-9]+$/i, (m) => (/[a-z]/i.test(m) && m === m.toUpperCase() ? "" : m)) // trailing -GROUP
    .replace(/[._]+/g, " ")
    .replace(/[\s-]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return { kind, baseTitle: baseTitle || base, version, fromVersion };
}

/** -1, 0 or 1, comparing dotted version numbers ("1.10.2" > "1.9"). */
export function compareVersion(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^build\s*/i, "").split(/[._-]/).map((x) => parseInt(x, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Why LootDen thinks an entry is a full game, an update or DLC, for the badge beside it. */
export interface KindReason {
  /**
   * - "admin": set by an admin.
   * - "folder": it's in an Updates or DLC folder.
   * - "name": its name says update or DLC.
   * - "size": it's about as big as its game, so it's the full game whatever its name says.
   * - "content": its files look like a full installer, or like a patch.
   */
  by: "admin" | "folder" | "name" | "size" | "content";
  /** "high" when name, size and files agree; "low" when there was little to go on. */
  confidence: "high" | "medium" | "low";
  /** One line for people: "64.2 GB, 98% of Cyberpunk 2077". */
  note: string;
}

/** A package this size or bigger, next to its game's size, is a full copy of the game. */
export const FULL_GAME_SIZE_RATIO = 0.7;

const DELTA_FILE = /\.(xdelta3?|vcdiff|bsdiff|bps|ups|ppf|delta)$/i;
const PATCHER_EXE = /(^|[/_ .-])(patch|update|hotfix)[^/]*\.exe$/i;
/** GOG-style full installers: setup_game_1.2_(1234).exe with setup_game_1.2_(1234)-1.bin beside it. */
const FULL_INSTALLER_PART = /(^|\/)setup_[^/]+-\d+\.bin$/i;
/** Repacks and full installs carry the game's redistributables; patches don't. */
const REDIST = /(^|\/)(_commonredist|redist|redistributables?|directx|__installer)\//i;

/** What a package's files say it is: a full game, a patch, or nothing either way. */
export function contentHint(files: Array<{ path: string }>): { says: "full" | "patch"; why: string } | null {
  const names = files.map((f) => f.path.replace(/\\/g, "/"));
  if (names.some((n) => DELTA_FILE.test(n))) return { says: "patch", why: "has patch delta files" };
  if (names.some((n) => FULL_INSTALLER_PART.test(n))) return { says: "full", why: "has a full installer with data files" };
  if (names.some((n) => REDIST.test(n))) return { says: "full", why: "includes the game's redistributables" };
  if (names.length <= 3 && names.some((n) => PATCHER_EXE.test(n))) return { says: "patch", why: "is a patch program" };
  return null;
}
