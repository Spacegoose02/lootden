// The mod list and load order for the truck games (ATS, ETS2). The list is the household's record
// of every mod they use: where it comes from (a TruckyMods page, an SCS forum thread, a Steam
// Workshop item, a Dropbox link), the versions it was last known at, and whether its page still
// works. The desktop app checks the pages in a real browser (many mod sites refuse bots) and
// reads and writes the in-game load order in the player's profile.sii.

import type { TruckGame } from "./truckmods.js";

/**
 * What a check of a mod's page found: "live" (it's there), "renamed" (it's there under another
 * name), "moved" (the address sends you somewhere else), "login" (it's a sign-in page, not the
 * mod's), "dead" (gone, or the item was removed), "blocked" (the site wouldn't let the check
 * in; open it yourself) or "unchecked".
 */
export type ModLinkStatus = "unchecked" | "live" | "renamed" | "moved" | "login" | "dead" | "blocked";

export interface ModLinkCheck {
  status: ModLinkStatus;
  checkedAt: string;
  /** Where the page ended up, when that's not the link itself. */
  finalUrl: string | null;
  pageTitle: string | null;
  /** The mod's version and the game version it's for, as the page says (TruckyMods, forum titles, Workshop). */
  latestVersion: string | null;
  latestGameVersion: string | null;
  /** When the page says the mod was last updated (ISO date), when it does. */
  lastUpdated: string | null;
  note: string | null;
}

/** A mod on the household's list. */
export interface TrackedTruckMod {
  id: number;
  game: TruckGame;
  name: string;
  sourceUrl: string | null;
  /** The Steam Workshop item, for a Workshop mod (from its link, or the subscriptions on a PC). */
  workshopId: string | null;
  category: string | null;
  /** The game and mod versions written down for it (the spreadsheet's columns). */
  gameVersion: string | null;
  modVersion: string | null;
  notes: string | null;
  /** Mod files in the mod folder that are this mod (file names, as on the PCs). */
  files: string[];
  /** Other columns from an imported sheet, kept as they were. */
  extra: string[];
  /** No longer used (abandoned, replaced); kept for the record. */
  retired: boolean;
  check: ModLinkCheck | null;
  updatedAt: string;
}

export interface TrackedTruckModInput {
  name: string;
  sourceUrl?: string | null;
  workshopId?: string | null;
  category?: string | null;
  gameVersion?: string | null;
  modVersion?: string | null;
  notes?: string | null;
  files?: string[];
  extra?: string[];
  retired?: boolean;
}

/** Tracking bits that sites tack onto shared links (Facebook's fbclid and the like). */
const TRACKING = /^(fbclid|gclid|dclid|msclkid|igshid|mc_eid|mc_cid|_hsenc|_hsmi|utm_[a-z]+)$/i;

/** A web address without tracking bits, or null when it isn't one. */
export function cleanModUrl(input: string | null | undefined): string | null {
  const s = String(input ?? "").trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!u.hostname.includes(".")) return null;
  for (const key of [...u.searchParams.keys()]) if (TRACKING.test(key)) u.searchParams.delete(key);
  return u.toString().slice(0, 500);
}

/** The Steam Workshop item a link is ("…/sharedfiles/filedetails/?id=123"), or null. */
export function workshopIdFromUrl(input: string | null | undefined): string | null {
  const s = String(input ?? "");
  if (!/steamcommunity\.com\/(sharedfiles|workshop)\/filedetails/i.test(s)) return null;
  return s.match(/[?&]id=(\d{4,20})/)?.[1] ?? null;
}

export function workshopUrl(id: string): string {
  return `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
}

const looksLikeUrl = (s: string) => /^(https?:\/\/|www\.)\S+$/i.test(s.trim());
const looksLikeVersion = (s: string) => /^v?\d+(\.\d+)+[a-z]?$/i.test(s.trim());

/** Splits one line of a pasted sheet: tabs when there are any (Excel, Sheets), otherwise CSV. */
function cells(line: string): string[] {
  if (line.includes("\t")) return line.split("\t").map((c) => c.trim());
  if (!line.includes(",")) return [line.trim()];
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (out.push(cur.trim()), (cur = ""));
    else cur += ch;
  }
  out.push(cur.trim());
  // A name with a comma in it and nothing else that looks like a column: keep it whole.
  return out.length > 1 && !out.some((c) => looksLikeUrl(c) || looksLikeVersion(c)) ? [line.trim()] : out;
}

/**
 * Mods from a pasted spreadsheet: one per row, columns name, link, game version, mod version,
 * category, then anything else (kept as it is). A plain list of names (one per line) works too.
 * A header row is skipped.
 */
export function parseModSheet(text: string): TrackedTruckModInput[] {
  const out: TrackedTruckModInput[] = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const row = cells(raw);
    const name = row[0]?.replace(/\s+/g, " ").trim() ?? "";
    if (!name) continue;
    if (out.length === 0 && /^(mod\s*)?name$/i.test(name) && row.length > 1) continue;
    const rest = row.slice(1);
    let i = 0;
    const link = rest[i] !== undefined && (looksLikeUrl(rest[i]!) || rest[i] === "") ? rest[i++]! : "";
    const take = (ok: (s: string) => boolean) => (rest[i] !== undefined && (rest[i] === "" || ok(rest[i]!)) ? rest[i++]!.trim() : "");
    const gameVersion = take((s) => /^\d+\.\d+/.test(s));
    const modVersion = take(looksLikeVersion);
    const category = take((s) => !looksLikeUrl(s) && s.length <= 60);
    const extra = rest.slice(i).map((c) => c.slice(0, 200));
    while (extra.length && !extra[extra.length - 1]) extra.pop();
    const sourceUrl = cleanModUrl(link);
    out.push({
      name: name.slice(0, 200),
      sourceUrl,
      workshopId: workshopIdFromUrl(sourceUrl),
      gameVersion: gameVersion || null,
      modVersion: modVersion.replace(/^v/i, "") || null,
      category: category || null,
      extra,
    });
  }
  return out;
}

/** A name boiled down for matching: lower case, letters and digits, common noise words gone. */
export function modKey(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\.(scs|zip)$/i, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/\bv?\d+(\.\d+)+[a-z]?\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|for|mod|map|ats|ets2|by|and|a)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** How alike two mod names are, 0 to 1 (shared words over the shorter name's words). */
export function modNameMatch(a: string, b: string): number {
  const wa = new Set(modKey(a).split(" ").filter(Boolean));
  const wb = new Set(modKey(b).split(" ").filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size);
}

// ---- Checking a mod's page -------------------------------------------------------------

export interface ModPageVisit {
  /** The link as it is on the list. */
  url: string;
  /** Where the browser ended up (after redirects), or null when it never got there. */
  finalUrl: string | null;
  /** The main page's HTTP status; 0 when it never answered. */
  httpStatus: number;
  title: string;
  /** The page's visible text (the first few thousand characters are enough). */
  text: string;
  /** The link started a file download instead of showing a page. */
  download?: boolean;
  /** Why the browser couldn't load it (a network error), when it couldn't. */
  error?: string | null;
}

const BLOCKED = /just a moment|attention required|checking your browser|verify you are human|access denied|cf-browser-verification|ddos protection/i;
const LOGIN_PATH = /\/(my-?account|login|log-in|signin|sign-in|ucp\.php\?mode=login|wp-login)/i;
const GONE =
  /page (?:was )?not found|404 not found|this page (?:isn't|is not) available|content (?:isn't|is not) available|the requested topic does not exist|the requested forum does not exist|item (?:has been|was) removed|removed for violating|there was a problem accessing the item|file (?:has been )?(?:deleted|removed)|this file (?:isn't|is not) available|mod (?:was )?not found|no longer available/i;

const host = (u: string | null) => {
  try {
    return u ? new URL(u).hostname.replace(/^www\./, "").toLowerCase() : "";
  } catch {
    return "";
  }
};
const pathOf = (u: string | null) => {
  try {
    return u ? new URL(u).pathname.replace(/\/+$/, "").toLowerCase() : "";
  } catch {
    return "";
  }
};

/** "1.61", "1.61.x", "1.61.1.5s" as the major.minor part, or null. */
function gameVer(s: string | undefined): string | null {
  const m = String(s ?? "").match(/\b(1\.[1-9]\d)(?:\.[\dx*]+)*\b/i);
  return m ? m[1]! : null;
}

function isoDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/** What the page says about the mod's version, the game version and the last update. */
export function modPageVersions(title: string, text: string): Pick<ModLinkCheck, "latestVersion" | "latestGameVersion" | "lastUpdated"> {
  const body = String(text ?? "").slice(0, 40_000);
  const version =
    body.match(/(?:current|latest|mod)\s+version\s*[:\n]\s*v?([0-9][\w.\-]*)/i)?.[1] ??
    body.match(/\bversion\s*[:\n]\s*v?(\d+(?:\.\d+)+[a-z]?)\b/i)?.[1] ??
    String(title ?? "").match(/\bv\.?\s?(\d+(?:\.\d+)+[a-z]?)\b/i)?.[1] ??
    null;
  const game =
    gameVer(body.match(/(?:game\s+versions?|compatible\s+(?:with|versions?)|supported\s+(?:game\s+)?versions?|works\s+(?:with|on))\s*[:\n]?\s*(?:ats|ets2?|american truck simulator|euro truck simulator 2)?\s*([0-9][\w.*]*)/i)?.[1]) ??
    gameVer(String(title ?? "").match(/[[(]\s*(1\.\d{2}[\w.*]*)\s*[\])]/)?.[1]) ??
    gameVer(String(title ?? "").match(/\b(?:ats|ets2?)\s*(1\.\d{2})/i)?.[1]) ??
    null;
  const updated =
    isoDate(body.match(/(?:last\s+updated|updated(?:\s+on)?)\s*[:\n]?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\s+\w{3,9}\s+\d{4}|\w{3,9}\s+\d{1,2},?\s+\d{4})/i)?.[1]) ??
    isoDate(String(title ?? "").match(/\((\d{1,2}\/\d{1,2}\/\d{4})\)/)?.[1]) ??
    null;
  return { latestVersion: version ? version.slice(0, 40) : null, latestGameVersion: game, lastUpdated: updated };
}

/**
 * What a visit to a mod's page says about the link. name is the mod's name on the list, to spot
 * a page that now goes by another name.
 */
export function classifyModPage(visit: ModPageVisit, name: string, at = new Date().toISOString()): ModLinkCheck {
  const title = String(visit.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const text = String(visit.text ?? "");
  const finalUrl = visit.finalUrl && visit.finalUrl !== visit.url ? visit.finalUrl : null;
  const base: ModLinkCheck = { status: "live", checkedAt: at, finalUrl, pageTitle: title || null, latestVersion: null, latestGameVersion: null, lastUpdated: null, note: null };
  const head = `${title}\n${text.slice(0, 3000)}`;

  if (visit.download) return { ...base, note: "The link downloads the file directly" };
  if (!visit.finalUrl || visit.httpStatus === 0) return { ...base, status: "dead", note: visit.error ? `The site didn't answer (${visit.error})` : "The site didn't answer" };
  if (BLOCKED.test(title) || (visit.httpStatus === 403 || visit.httpStatus === 503 || visit.httpStatus === 429 ? BLOCKED.test(head) || text.length < 400 : false))
    return { ...base, status: "blocked", note: "The site wouldn't let the check in; open the link to see it yourself" };
  if (visit.httpStatus === 404 || visit.httpStatus === 410) return { ...base, status: "dead", note: `The page is gone (${visit.httpStatus})` };
  if (visit.httpStatus >= 500) return { ...base, status: "dead", note: `The site is having trouble (${visit.httpStatus})` };
  if (GONE.test(head)) return { ...base, status: "dead", note: "The page says the mod isn't there any more" };
  if (LOGIN_PATH.test(visit.url) || LOGIN_PATH.test(visit.finalUrl) || /^(log ?in|sign ?in)\b/i.test(title))
    return { ...base, status: "login", note: "This is a sign-in page, not the mod's page; link the mod's own page instead" };

  const found = modPageVersions(title, text);
  const out = { ...base, ...found };
  if (host(visit.finalUrl) && host(visit.finalUrl) !== host(visit.url))
    return { ...out, status: "moved", note: `The link now goes to ${host(visit.finalUrl)}` };
  if (finalUrl && pathOf(visit.finalUrl) !== pathOf(visit.url) && !/[?&]p=\d/.test(visit.finalUrl!))
    return { ...out, status: "moved", note: "The link now goes to another page" };
  const formerly = title.match(/formerly\s+["“']?([^"”')]+)/i);
  if (formerly || (title && name && modNameMatch(name, title) < 0.34))
    return { ...out, status: "renamed", note: `The page is now called “${title.replace(/\s*[|\-–—]\s*(Trucky\s*Mods|SCS Software).*$/i, "")}”` };
  return out;
}

// ---- The in-game load order (profile.sii) --------------------------------------------------

/** A mod in a profile's active mods: its package (a file's name, or a Workshop item) and its name in the Mod Manager. */
export interface ActiveTruckMod {
  /** "Coast_to_Coast" (the file Coast_to_Coast.scs) or "mod_workshop_package.00000000A4AAEB0A". */
  package: string;
  name: string;
}

/** The Steam Workshop item a package is (mod_workshop_package.<hex id>), or null. */
export function workshopIdFromPackage(pkg: string): string | null {
  const m = String(pkg).match(/^mod_workshop_package\.([0-9a-f]{1,16})$/i);
  if (!m) return null;
  try {
    return BigInt(`0x${m[1]}`).toString(10);
  } catch {
    return null;
  }
}

export function workshopPackage(id: string): string {
  return `mod_workshop_package.${BigInt(id).toString(16).toUpperCase().padStart(16, "0")}`;
}

const utf8 = new TextEncoder();
const fromUtf8 = (bytes: number[] | Uint8Array) => new TextDecoder().decode(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

/** SII strings escape bytes outside plain ASCII as \xNN (UTF-8) and quotes as \". */
function unescapeSii(s: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "x" && /^[0-9a-f]{2}$/i.test(s.slice(i + 2, i + 4))) {
      bytes.push(parseInt(s.slice(i + 2, i + 4), 16));
      i += 3;
    } else if (ch === "\\" && i + 1 < s.length) {
      bytes.push(...utf8.encode(s[++i]!));
    } else bytes.push(...utf8.encode(ch));
  }
  return fromUtf8(bytes);
}

function escapeSii(s: string): string {
  let out = "";
  for (const b of utf8.encode(s)) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    else if (b < 0x20 || b > 0x7e) out += `\\x${b.toString(16).padStart(2, "0")}`;
    else out += String.fromCharCode(b);
  }
  return out;
}

/** What kind of file a profile.sii is: readable text, or the game's encrypted or binary save formats. */
export function siiFormat(head: Uint8Array): "text" | "encrypted" | "binary" | "unknown" {
  const sig = String.fromCharCode(...head.slice(0, 11));
  if (/^(\xef\xbb\xbf)?SiiNunit/.test(sig)) return "text";
  if (sig.startsWith("ScsC")) return "encrypted";
  if (sig.startsWith("BSII")) return "binary";
  return "unknown";
}

/**
 * The active mods in a (text) profile.sii, in the Mod Manager's order: the first is the top of
 * its list, the one that wins when two mods change the same thing.
 */
export function parseActiveMods(sii: string): ActiveTruckMod[] {
  const entries = new Map<number, ActiveTruckMod>();
  for (const m of String(sii).matchAll(/^\s*active_mods\[(\d+)\]\s*:\s*"((?:[^"\\]|\\.)*)"/gm)) {
    const value = unescapeSii(m[2]!);
    const bar = value.indexOf("|");
    const pkg = bar >= 0 ? value.slice(0, bar) : value;
    const name = bar >= 0 ? value.slice(bar + 1) : value;
    if (pkg) entries.set(Number(m[1]), { package: pkg, name: name || pkg });
  }
  return [...entries.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

/** The profile's name (profile_name in profile.sii), or null. */
export function profileNameFromSii(sii: string): string | null {
  const m = String(sii).match(/^\s*profile_name\s*:\s*"((?:[^"\\]|\\.)*)"/m);
  return m ? unescapeSii(m[1]!) : null;
}

/** A profile folder's name is the profile's name in hex; this reads it back (or gives null). */
export function profileNameFromFolder(folder: string): string | null {
  if (!/^([0-9a-f]{2})+$/i.test(folder)) return null;
  const s = fromUtf8((folder.match(/../g) ?? []).map((h) => parseInt(h, 16)));
  return /[\u0000-\u001f�]/.test(s) ? null : s;
}

/** profile.sii with its active mods replaced by mods (first = top of the Mod Manager). */
export function writeActiveMods(sii: string, mods: ActiveTruckMod[]): string {
  const text = String(sii);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = mods.map((m, i) => ` active_mods[${i}]: "${escapeSii(`${m.package}|${m.name}`)}"`);
  const block = [` active_mods: ${mods.length}`, ...lines].join(eol);
  const count = /^[ \t]*active_mods\s*:\s*\d+[ \t]*\r?$/m;
  const item = /^[ \t]*active_mods\[\d*\]\s*:.*\r?\n?/gm;
  if (count.test(text)) {
    const without = text.replace(item, "");
    return without.replace(count, block);
  }
  // No active_mods yet: put them just inside the user_profile block.
  const open = text.match(/user_profile\s*:\s*[\w.]+\s*\{[^\n]*\n/);
  if (!open || open.index === undefined) throw new Error("This doesn't look like a profile.sii");
  const at = open.index + open[0].length;
  return text.slice(0, at) + block + eol + text.slice(at);
}

/** Where a saved load order's mod is on this PC: matched to a package here, or missing. */
export interface LoadOrderMatch {
  entry: ActiveTruckMod;
  /** The package on this PC it is, or null when this PC doesn't have it. */
  match: ActiveTruckMod | null;
}

/**
 * Lines up a saved load order with the mods this PC has (available: every package it could turn
 * on, with its name). A package matches by its id; one from a typed list (no package) by its name.
 */
export function matchLoadOrder(saved: ActiveTruckMod[], available: ActiveTruckMod[]): LoadOrderMatch[] {
  const byPkg = new Map(available.map((a) => [a.package.toLowerCase(), a]));
  const used = new Set<string>();
  const out: LoadOrderMatch[] = [];
  for (const entry of saved) {
    let match = entry.package ? byPkg.get(entry.package.toLowerCase()) ?? null : null;
    if (match && used.has(match.package)) match = null;
    if (!match) {
      const want = modKey(entry.name);
      const exact = available.find((a) => !used.has(a.package) && (modKey(a.name) === want || modKey(a.package) === want));
      let best: ActiveTruckMod | null = exact ?? null;
      if (!best && want) {
        let score = 0.75;
        for (const a of available) {
          if (used.has(a.package)) continue;
          const s = Math.max(modNameMatch(entry.name, a.name), modNameMatch(entry.name, a.package));
          if (s > score) (score = s), (best = a);
        }
      }
      match = best;
    }
    if (match) used.add(match.package);
    out.push({ entry, match });
  }
  return out;
}

/** A typed load order (one mod per line, top of the Mod Manager first) as entries without packages. */
export function parseLoadOrderText(text: string): ActiveTruckMod[] {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(\d+[.)]\s+|[-*•]\s+)/, "").trim())
    .filter(Boolean)
    .slice(0, 1000)
    .map((name) => ({ package: "", name: name.slice(0, 200) }));
}

/** A load order kept on the server, so any PC can put it in its profile. */
export interface TruckLoadOrder {
  id: number;
  game: TruckGame;
  name: string;
  mods: ActiveTruckMod[];
  updatedBy: string | null;
  updatedAt: string;
}

/** A game profile on this PC and what its active mods are. */
export interface TruckProfile {
  /** The profile's folder (profiles/<hex> or steam_profiles/<hex>). */
  dir: string;
  name: string;
  /** In Steam Cloud (steam_profiles): Steam may put back the cloud's copy. */
  cloud: boolean;
  format: "text" | "encrypted" | "binary" | "unknown";
  /** Its active mods; empty when the profile isn't readable. */
  mods: ActiveTruckMod[];
  modifiedAt: string;
}

// ---- Doubles in the mod folder ---------------------------------------------------------

/**
 * A file name boiled down to the mod it is, so two versions or copies of one mod come out the
 * same: versions ("_0.5.0.1_1.58", "v161"), copy marks ("(1)") and [tags] go; the words in
 * (parentheses) stay, since they often name a part ("More American Cities (Texas - v1.4)").
 */
export function modFileKey(file: string): string {
  let s = String(file ?? "").toLowerCase().replace(/\.(scs|zip)$/i, "");
  s = s.replace(/\s*\(\d+\)\s*$/, " ").replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/\bv?\d+(?:\.\d+)+[a-z]?\b/g, " ");
  s = s.replace(/[_\-.()]+/g, " ").replace(/[^a-z0-9 ]+/g, " ");
  const words = s.split(/\s+/).filter(Boolean).filter((w) => !/^v\d+$/.test(w));
  // A run of two or more bare numbers is a version written with spaces or underscores ("2 9 7 1 158").
  const out: string[] = [];
  for (let i = 0; i < words.length; ) {
    let j = i;
    while (j < words.length && /^\d+$/.test(words[j]!)) j++;
    if (j - i >= 2) i = j;
    else if (j > i) out.push(words[i++]!);
    else out.push(words[i++]!);
  }
  return out.join(" ");
}

export interface DuplicateModGroup {
  /** "versions": the same mod more than once (older versions, copies, alternatives); "same-file": byte-for-byte the same size. */
  reason: "versions" | "same-file";
  files: string[];
}

/**
 * Mod files that look like the same mod twice: one name with different versions or a "(1)" copy,
 * or two names with exactly the same size (a renamed copy). The game loads both, and the one
 * higher in the load order wins, which is often the older one.
 */
export function findDuplicateModFiles(files: Array<{ file: string; sizeBytes: number }>): DuplicateModGroup[] {
  const groups: DuplicateModGroup[] = [];
  const byKey = new Map<string, string[]>();
  for (const f of files) {
    const key = modFileKey(f.file);
    if (!key) continue;
    byKey.set(key, [...(byKey.get(key) ?? []), f.file]);
  }
  const grouped = new Set<string>();
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    groups.push({ reason: "versions", files: [...list].sort() });
    list.forEach((f) => grouped.add(f));
  }
  const bySize = new Map<number, string[]>();
  // Tiny files (fixes, a few KB) are often the same size by chance.
  for (const f of files) if (f.sizeBytes >= 1024 * 1024) bySize.set(f.sizeBytes, [...(bySize.get(f.sizeBytes) ?? []), f.file]);
  for (const list of bySize.values()) {
    const fresh = list.filter((f) => !grouped.has(f));
    if (list.length >= 2 && fresh.length >= 1) groups.push({ reason: "same-file", files: [...list].sort() });
  }
  return groups;
}
