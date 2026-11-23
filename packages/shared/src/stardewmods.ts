// Stardew Valley mods (SMAPI) shared by the household. The server keeps one mod set: each mod's
// zip as downloaded (from Nexus, or uploaded), what its manifest.json files say, and whether an
// admin has it switched on. The desktop app makes each PC's Mods folder match that set (adding,
// updating and switching mods off), so co-op players always have the same mods. A mod is
// switched off by putting a dot in front of its folder's name, which SMAPI skips.

export const STARDEW_STEAM_APP_ID = "413150";

/** Whether a game is Stardew Valley, by its Steam app id or its title. */
export function isStardew(steamAppId: string | null | undefined, title: string | null | undefined): boolean {
  if (String(steamAppId ?? "") === STARDEW_STEAM_APP_ID) return true;
  return /stardew\s*valley/i.test(String(title ?? ""));
}

/** A mod another mod needs. SMAPI treats a dependency as required unless it says IsRequired: false. */
export interface SmapiDependency {
  uniqueId: string;
  minimumVersion: string | null;
  required: boolean;
}

/** What one manifest.json says about the mod in its folder. */
export interface SmapiManifest {
  uniqueId: string;
  name: string;
  author: string | null;
  version: string;
  description: string | null;
  /** For a content pack, the mod that loads it (Content Patcher, for "[CP]" packs). */
  contentPackFor: SmapiDependency | null;
  dependencies: SmapiDependency[];
  /** Like "Nexus:1915", where SMAPI checks for updates. */
  updateKeys: string[];
  /** The mod's folder inside the zip ("" for a manifest at the top), "/" between folders. */
  folder: string;
}

/** SMAPI's own mods, installed with it in every Mods folder; LootDen leaves them alone. */
export function isSmapiBundled(uniqueId: string): boolean {
  return /^SMAPI\./i.test(uniqueId);
}

/** Lets manifest.json be what SMAPI accepts: a BOM, // and /* comments, trailing commas. */
function looseJson(text: string): unknown {
  const src = text.replace(/^﻿/, "");
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** A key of a manifest, whatever its case (SMAPI doesn't mind "UniqueID" or "uniqueId"). */
function pick(obj: Record<string, unknown>, key: string): unknown {
  const k = Object.keys(obj).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : obj[k];
}

const str = (v: unknown, max = 200): string | null => {
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim().slice(0, max);
  return s || null;
};

/** SMAPI versions can be strings ("1.2.3") or, in old manifests, { MajorVersion, MinorVersion, PatchVersion }. */
function versionOf(v: unknown): string | null {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const parts = ["MajorVersion", "MinorVersion", "PatchVersion"].map((k) => Number(pick(o, k) ?? 0));
    return parts.every((n) => Number.isFinite(n)) ? parts.join(".") : null;
  }
  return str(v, 60);
}

function dependencyOf(v: unknown, requiredByDefault: boolean): SmapiDependency | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const uniqueId = str(pick(o, "UniqueID"));
  if (!uniqueId) return null;
  const req = pick(o, "IsRequired");
  return { uniqueId, minimumVersion: versionOf(pick(o, "MinimumVersion")), required: typeof req === "boolean" ? req : requiredByDefault };
}

/** Reads a manifest.json; null when it isn't one (no UniqueID, or not JSON at all). */
export function parseSmapiManifest(text: string, folder = ""): SmapiManifest | null {
  let raw: unknown;
  try {
    raw = looseJson(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const uniqueId = str(pick(o, "UniqueID"));
  if (!uniqueId) return null;
  const deps = pick(o, "Dependencies");
  const keys = pick(o, "UpdateKeys");
  return {
    uniqueId,
    name: str(pick(o, "Name")) ?? uniqueId,
    author: str(pick(o, "Author")),
    version: versionOf(pick(o, "Version")) ?? "0.0.0",
    description: str(pick(o, "Description"), 500),
    contentPackFor: dependencyOf(pick(o, "ContentPackFor"), true),
    dependencies: Array.isArray(deps) ? deps.map((d) => dependencyOf(d, true)).filter((d): d is SmapiDependency => !!d).slice(0, 50) : [],
    updateKeys: Array.isArray(keys) ? keys.map((k) => str(k, 100)).filter((k): k is string => !!k).slice(0, 10) : [],
    folder: folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
  };
}

/**
 * Compares two mod versions the way SMAPI does, near enough: numbers part by part, and a
 * version with a prerelease tag ("1.2.0-beta") before the same version without one.
 */
export function compareModVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main = "", ...tag] = v.trim().replace(/^v/i, "").split(/[-+]/);
    return { nums: main.split(".").map((n) => Number.parseInt(n, 10) || 0), tag: tag.join("-") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.tag === y.tag) return 0;
  if (!x.tag) return 1;
  if (!y.tag) return -1;
  return x.tag.localeCompare(y.tag, undefined, { numeric: true, sensitivity: "base" });
}

/** The Nexus mod page an update key points to ("Nexus:1915"), if it has one. */
export function stardewNexusUrl(updateKeys: string[]): string | null {
  for (const k of updateKeys) {
    const m = /^nexus\s*:\s*(\d+)/i.exec(k);
    if (m) return `https://www.nexusmods.com/stardewvalley/mods/${m[1]}`;
  }
  return null;
}

export const STARDEW_NEXUS_URL = "https://www.nexusmods.com/stardewvalley/mods";

/** One mod in the shared set: a zip, which may hold several SMAPI mods (a mod and its content pack). */
export interface StardewMod {
  id: number;
  title: string;
  fileName: string;
  sizeBytes: number;
  /** The folder the zip goes into in Mods (switched off, it's ".<folder>"). */
  folder: string;
  /** Switched on for every PC. Only an admin can switch mods on or off. */
  enabled: boolean;
  mods: SmapiManifest[];
  sourceUrl: string | null;
  addedBy: string | null;
  addedAt: string;
  /** Changes when a newer zip replaces this one; PCs that installed an older one update. */
  updatedAt: string;
  /** Whether the viewer can delete it or rename it (who added it, or an admin). */
  canManage: boolean;
}

/** Something a switched-on mod needs that the set doesn't have on. */
export interface StardewProblem {
  /** The shared mod (zip) with the mod that needs it. */
  modId: number;
  modName: string;
  needs: string;
  /** "missing": not in the set; "off": in the set but switched off; "too-old": on, but older than needed. */
  kind: "missing" | "off" | "too-old";
  /** The name of what's needed, when the set has it. */
  needsName: string | null;
  minimumVersion: string | null;
  /** The version the set has, for "too-old". */
  haveVersion: string | null;
}

/** What the switched-on mods need that the set doesn't give them. SMAPI itself is never "missing". */
export function stardewProblems(set: StardewMod[]): StardewProblem[] {
  const on = new Map<string, SmapiManifest>();
  const off = new Map<string, SmapiManifest>();
  for (const pkg of set) for (const m of pkg.mods) (pkg.enabled ? on : off).set(m.uniqueId.toLowerCase(), m);
  const out: StardewProblem[] = [];
  for (const pkg of set) {
    if (!pkg.enabled) continue;
    for (const m of pkg.mods) {
      const needs = [...(m.contentPackFor ? [m.contentPackFor] : []), ...m.dependencies.filter((d) => d.required)];
      for (const d of needs) {
        const key = d.uniqueId.toLowerCase();
        if (isSmapiBundled(d.uniqueId) || key === "pathoschild.smapi") continue;
        const have = on.get(key);
        const base = { modId: pkg.id, modName: m.name, needs: d.uniqueId, minimumVersion: d.minimumVersion };
        if (have) {
          if (d.minimumVersion && compareModVersions(have.version, d.minimumVersion) < 0) {
            out.push({ ...base, kind: "too-old", needsName: have.name, haveVersion: have.version });
          }
        } else {
          const switchedOff = off.get(key);
          out.push({ ...base, kind: switchedOff ? "off" : "missing", needsName: switchedOff?.name ?? null, haveVersion: switchedOff?.version ?? null });
        }
      }
    }
  }
  return out;
}

/** A SMAPI mod found in a PC's Mods folder. */
export interface LocalStardewMod {
  uniqueId: string;
  name: string;
  version: string;
  /** Its folder inside Mods, "/" between folders. */
  path: string;
  /** False when SMAPI skips it (a folder on its path starts with a dot). */
  enabled: boolean;
  /** The shared mod LootDen installed it from, when it did. */
  sharedId: number | null;
}

/**
 * How one mod on a PC compares with the shared set: "match"; "missing" (on in the set, not on
 * here); "outdated" or "newer" (a different version here); "extra" (on here, not on in the set).
 */
export type StardewModState = "match" | "missing" | "outdated" | "newer" | "extra";

export interface StardewModDiff {
  uniqueId: string;
  name: string;
  state: StardewModState;
  setVersion: string | null;
  pcVersion: string | null;
}

/** The mods SMAPI loads on a PC (switched on), compared with what's on in the shared set. */
export function compareStardewMods(set: StardewMod[], pc: Array<Pick<LocalStardewMod, "uniqueId" | "name" | "version" | "enabled">>): StardewModDiff[] {
  const want = new Map<string, SmapiManifest>();
  for (const pkg of set) if (pkg.enabled) for (const m of pkg.mods) want.set(m.uniqueId.toLowerCase(), m);
  const have = new Map<string, Pick<LocalStardewMod, "uniqueId" | "name" | "version">>();
  for (const m of pc) if (m.enabled && !isSmapiBundled(m.uniqueId)) have.set(m.uniqueId.toLowerCase(), m);
  const out: StardewModDiff[] = [];
  for (const [key, m] of want) {
    const here = have.get(key);
    const cmp = here ? compareModVersions(here.version, m.version) : 0;
    out.push({ uniqueId: m.uniqueId, name: m.name, setVersion: m.version, pcVersion: here?.version ?? null, state: !here ? "missing" : cmp < 0 ? "outdated" : cmp > 0 ? "newer" : "match" });
  }
  for (const [key, m] of have) if (!want.has(key)) out.push({ uniqueId: m.uniqueId, name: m.name, setVersion: null, pcVersion: m.version, state: "extra" });
  return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** What a PC last told the server about its Mods folder. */
export interface StardewPcReport {
  device: string;
  user: string | null;
  reportedAt: string;
  /** The mods SMAPI loads there (switched on). */
  mods: Array<{ uniqueId: string; name: string; version: string }>;
  /** How they compare with the set as it is now; only the ones that differ. */
  differences: StardewModDiff[];
}

/** The shared set as a page shows it: the mods, what they're missing, and how each PC compares. */
export interface StardewModSet {
  mods: StardewMod[];
  problems: StardewProblem[];
  pcs: StardewPcReport[];
}

/** What making a PC's Mods folder match the set did. */
export interface StardewSyncResult {
  folder: string;
  added: string[];
  updated: string[];
  switchedOn: string[];
  switchedOff: string[];
  /** Mods put there by hand that aren't on in the set, switched off (with strict sync). */
  extrasOff: string[];
  failed: Array<{ name: string; error: string }>;
}
