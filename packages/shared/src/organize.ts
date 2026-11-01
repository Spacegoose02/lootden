import type { GameSummary } from "./index.js";

/** One person's own marks on a game: favourite, hidden, tags and custom fields. */
export interface GameMarks {
  favourite: boolean;
  hidden: boolean;
  tags: string[];
  /** Custom fields this person made up ("Mods installed": "Yes"). */
  fields: Record<string, string>;
}

export const NO_MARKS: GameMarks = { favourite: false, hidden: false, tags: [], fields: {} };

/** A change to marks, for one game or many (bulk edit). */
export interface MarksPatch {
  favourite?: boolean;
  hidden?: boolean;
  /** Replaces all tags. */
  tags?: string[];
  addTags?: string[];
  removeTags?: string[];
  /** Sets fields; an empty value removes that field. */
  fields?: Record<string, string>;
}

export const MAX_TAGS = 30;
export const MAX_FIELDS = 30;

/** A tag as typed: trimmed, one line, up to 40 characters. Empty when nothing's left. */
export function cleanTag(t: unknown): string {
  return String(t ?? "").replace(/[\0-\x1f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function cleanTags(input: unknown): string[] {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of list.map(cleanTag)) {
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.slice(0, MAX_TAGS);
}

export function cleanFields(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = cleanTag(k);
    if (!key) continue;
    out[key] = String(v ?? "").replace(/\0/g, "").trim().slice(0, 500);
  }
  return out;
}

/** Applies a patch to marks; fields with an empty value are removed. */
export function applyMarks(cur: GameMarks, patch: MarksPatch): GameMarks {
  let tags = patch.tags ? cleanTags(patch.tags) : cur.tags;
  if (patch.addTags) tags = cleanTags([...tags, ...patch.addTags]);
  if (patch.removeTags) {
    const drop = new Set(cleanTags(patch.removeTags).map((t) => t.toLowerCase()));
    tags = tags.filter((t) => !drop.has(t.toLowerCase()));
  }
  const fields = { ...cur.fields };
  for (const [k, v] of Object.entries(cleanFields(patch.fields))) {
    if (v) fields[k] = v;
    else delete fields[k];
  }
  if (Object.keys(fields).length > MAX_FIELDS) throw new Error(`At most ${MAX_FIELDS} custom fields per game`);
  return {
    favourite: patch.favourite ?? cur.favourite,
    hidden: patch.hidden ?? cur.hidden,
    tags,
    fields,
  };
}

/**
 * A smart shelf's rules: the shelf fills itself with every library game that matches all of
 * them, for whoever is looking (statuses, tags and play time are theirs).
 */
export interface SmartRules {
  /** Any of these genres. */
  genres?: string[];
  /** "pc" or an emulated system. */
  platform?: string;
  /** Any of these backlog statuses ("none" for games without one). */
  statuses?: string[];
  /** All of these tags. */
  tags?: string[];
  favourite?: boolean;
  /** Played: true for played, false for never played. */
  played?: boolean;
  installed?: boolean;
  together?: boolean;
  controller?: "any" | "full";
  kidSafe?: boolean;
  /** Critic rating at least this (0-100). */
  minRating?: number;
  /** Released in or after / before or in this year. */
  fromYear?: number;
  toYear?: number;
  /** Added to the library in the last N days. */
  addedDays?: number;
  /** Title contains. */
  search?: string;
  /** How they're sorted, and at most how many. */
  sort?: "title" | "added" | "rating" | "release" | "random";
  limit?: number;
}

const year = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) >= 1970 && Number(v) <= 2100 ? Number(v) : undefined);

/** Rules from the shelf editor, checked. Null when nothing is set (an ordinary shelf). */
export function cleanSmartRules(input: unknown): SmartRules | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const out: SmartRules = {};
  const list = (v: unknown) => (Array.isArray(v) ? cleanTags(v) : []);
  if (list(r.genres).length) out.genres = list(r.genres);
  if (typeof r.platform === "string" && /^[a-z0-9-]{1,30}$/.test(r.platform)) out.platform = r.platform;
  if (list(r.statuses).length) out.statuses = list(r.statuses);
  if (list(r.tags).length) out.tags = list(r.tags);
  for (const k of ["favourite", "played", "installed", "together", "kidSafe"] as const) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  if (r.controller === "any" || r.controller === "full") out.controller = r.controller;
  if (Number.isFinite(Number(r.minRating)) && r.minRating !== null && r.minRating !== "" && Number(r.minRating) > 0) out.minRating = Math.min(100, Math.round(Number(r.minRating)));
  if (year(r.fromYear)) out.fromYear = year(r.fromYear);
  if (year(r.toYear)) out.toYear = year(r.toYear);
  if (Number(r.addedDays) > 0) out.addedDays = Math.min(3650, Math.round(Number(r.addedDays)));
  const search = cleanTag(r.search);
  if (search) out.search = search;
  const sortable = Object.keys(out).length > 0;
  if (["title", "added", "rating", "release", "random"].includes(String(r.sort))) out.sort = r.sort as SmartRules["sort"];
  if (Number(r.limit) > 0) out.limit = Math.min(500, Math.round(Number(r.limit)));
  return sortable ? out : null;
}

/** What smart rules need to know about the person looking. */
export interface RuleContext {
  status: (gameId: string) => string | null;
  marks: (gameId: string) => GameMarks;
  played: (gameId: string) => boolean;
  installed: (gameId: string) => boolean;
  now?: number;
}

export function matchesRules(g: GameSummary, r: SmartRules, ctx: RuleContext): boolean {
  if (r.genres && !r.genres.some((x) => g.genres.some((y) => y.toLowerCase() === x.toLowerCase()))) return false;
  if (r.platform && g.platform !== r.platform) return false;
  if (r.statuses && !r.statuses.includes(ctx.status(g.id) ?? "none")) return false;
  const m = ctx.marks(g.id);
  if (r.tags && !r.tags.every((t) => m.tags.some((x) => x.toLowerCase() === t.toLowerCase()))) return false;
  if (r.favourite !== undefined && m.favourite !== r.favourite) return false;
  if (r.played !== undefined && ctx.played(g.id) !== r.played) return false;
  if (r.installed !== undefined && ctx.installed(g.id) !== r.installed) return false;
  if (r.together !== undefined && !!g.together?.length !== r.together) return false;
  if (r.controller === "full" && g.controllerSupport !== "full") return false;
  if (r.controller === "any" && g.controllerSupport !== "full" && g.controllerSupport !== "partial") return false;
  if (r.kidSafe && g.kidSafe !== true) return false;
  if (r.minRating !== undefined && (g.rating ?? -1) < r.minRating) return false;
  if (r.fromYear !== undefined && (g.releaseYear ?? 0) < r.fromYear) return false;
  if (r.toYear !== undefined && (g.releaseYear ?? 9999) > r.toYear) return false;
  if (r.addedDays !== undefined && Date.parse(g.addedAt) < (ctx.now ?? Date.now()) - r.addedDays * 86400_000) return false;
  if (r.search && !g.title.toLowerCase().includes(r.search.toLowerCase())) return false;
  return true;
}

/** The games a smart shelf shows, sorted and capped. Hidden games stay out unless asked for by tag. */
export function smartShelfGames(games: GameSummary[], r: SmartRules, ctx: RuleContext): GameSummary[] {
  let out = games.filter((g) => g.kind === "game" && !ctx.marks(g.id).hidden && matchesRules(g, r, ctx));
  switch (r.sort) {
    case "added":
      out.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
      break;
    case "rating":
      out.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
      break;
    case "release":
      out.sort((a, b) => (b.releaseYear ?? 0) - (a.releaseYear ?? 0));
      break;
    case "random": {
      // Same order all day, so the shelf doesn't jump around on every visit.
      const day = new Date(ctx.now ?? Date.now()).toISOString().slice(0, 10);
      const h = (s: string) => [...(s + day)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7);
      out.sort((a, b) => h(a.id) - h(b.id));
      break;
    }
    default:
      out.sort((a, b) => a.title.localeCompare(b.title));
  }
  if (r.limit) out = out.slice(0, r.limit);
  return out;
}

/** Store games that are the same game: one from LootDen's library (by libraryGameId), or the same title on several stores. */
export function duplicateKey(g: { libraryGameId?: string | null; title: string }): string {
  if (g.libraryGameId) return `lib:${g.libraryGameId}`;
  return `t:${g.title
    .toLowerCase()
    .replace(/[®™©]/g, "")
    .replace(/\b(goty|game of the year|definitive|complete|remastered|enhanced|deluxe)( edition)?\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()}`;
}
