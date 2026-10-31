import { createHash } from "node:crypto";
import { mkdir, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { cleanTogether, compareVersion, contentHint, togetherFromMetadata, type TogetherTag, FULL_GAME_SIZE_RATIO, PC_PLATFORM, setupKindOf, type KindReason, PLATFORMS, type ControllerSupport, type GameDetail, type GameMetadata, type GameSummary, type LibraryStats, type PackageKind, versionLabel } from "@lootden/shared";
import { json, now, type Db } from "../db/database.js";
import { kidSafeFromRatings } from "../metadata/ratings.js";
import { cleanTitle, titleSimilarity } from "../metadata/titles.js";
import { findServerSevenZip } from "../connectors/tidy.js";
import { archivesToPeek, peekArchive, type PeekResult } from "./peek.js";
import { gameIdFor, resolveGameFile, scanLibrary, type ScannedGame } from "./scanner.js";

export interface GameQuery {
  search?: string;
  genre?: string;
  controller?: "full" | "partial" | "any";
  kidSafe?: boolean;
  /** Only games no metadata provider has matched yet (admin clean-up list). */
  missingMetadata?: boolean;
  /** "pc", "emulated" (every other system) or one platform id. Unset means everything. */
  platform?: string;
  /** "game" (the default) leaves update and DLC packages out; "addon" is updates and DLC together. */
  kind?: PackageKind | "addon" | "all";
  sort?: "title" | "added" | "release" | "rating" | "size";
  order?: "asc" | "desc";
  limit?: number;
}

/** What one entry turned out to be. */
interface PackageVerdict {
  kind: PackageKind;
  baseGameId: string | null;
  /** A full game that was named as an update: the library game it's a copy of, for its art and name. */
  lookalike: string | null;
  reason: KindReason | null;
}

const formatSize = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
};

interface GameRow {
  id: string;
  added_at: string;
  title_override: string | null;
  kid_safe_override: number | null;
  controller_override: string | null;
  cover_override: string | null;
  background_override: string | null;
  save_path: string | null;
  kind_override: string | null;
  base_game_override: string | null;
  together_override: string | null;
  version_override: string | null;
}

interface MetadataRow {
  game_id: string;
  provider: string;
  provider_id: string;
  name: string;
  summary: string | null;
  cover_url: string | null;
  screenshots: string;
  genres: string;
  themes: string;
  game_modes: string;
  release_date: string | null;
  rating: number | null;
  age_ratings: string;
  controller_support: string | null;
  steam_app_id: string | null;
  locked: number;
  fetched_at: string;
}

export function metadataFromRow(row: MetadataRow): GameMetadata {
  return {
    provider: row.provider,
    providerId: row.provider_id,
    name: row.name,
    summary: row.summary,
    coverUrl: row.cover_url,
    screenshots: json(row.screenshots, []),
    genres: json(row.genres, []),
    themes: json(row.themes, []),
    gameModes: json(row.game_modes, []),
    releaseDate: row.release_date,
    rating: row.rating,
    ageRatings: json(row.age_ratings, []),
    controllerSupport: (row.controller_support as ControllerSupport | null) ?? null,
    steamAppId: row.steam_app_id,
    locked: row.locked === 1,
    fetchedAt: row.fetched_at,
  };
}

/**
 * The catalog. File lists come from scanning the games folder (the source of truth);
 * the database adds first-seen dates, admin overrides and metadata.
 */
export class Library {
  private scanned = new Map<string, ScannedGame>();
  private lastScanAt: Date | null = null;
  private lastScanMs: number | null = null;
  private scanning: Promise<void> | null = null;
  private listeners: Array<(games: ScannedGame[]) => void> = [];
  /** Looking inside archives for installers after a scan; scans don't wait for it. */
  private peeking: Promise<void> | null = null;
  private sevenZip: Promise<string | null> | null = null;
  /** What each entry is and which game each update or DLC belongs to; rebuilt after scans, overrides and metadata changes (and at most every few seconds). */
  private baseCache: { at: number; map: Map<string, PackageVerdict> } | null = null;
  private latestCache: { from: Map<string, PackageVerdict>; map: Map<string, string> } | null = null;
  /** Versions an admin typed in for games whose names don't say, by game id. */
  private versionOverrides: Map<string, string> | null = null;

  constructor(
    private readonly db: Db,
    readonly gamesDir: string,
  ) {}

  /** Called after every scan; the metadata service uses it to pick up new games. */
  onScanned(listener: (games: ScannedGame[]) => void): void {
    this.listeners.push(listener);
  }

  /** Runs a scan, or joins the one already running. */
  rescan(): Promise<void> {
    this.scanning ??= (async () => {
      const started = Date.now();
      try {
        const games = await scanLibrary(this.gamesDir);
        this.applyPeeks(games);
        this.sync(games);
        this.scanned = new Map(games.map((g) => [g.id, g]));
        this.baseCache = null;
        this.lastScanAt = new Date();
        this.lastScanMs = Date.now() - started;
      } finally {
        this.scanning = null;
      }
      const games = [...this.scanned.values()];
      for (const l of this.listeners) l(games);
      void this.peekArchives();
    })();
    return this.scanning;
  }

  /** Resolves once every packed game from the last scan has been checked for an installer inside. */
  async archivesChecked(): Promise<void> {
    while (this.scanning || this.peeking) await (this.scanning ?? this.peeking);
  }

  /** PC games whose installer could be inside an archive the scanner can't see into. */
  private peekable(g: ScannedGame): boolean {
    return g.platform === PC_PLATFORM && g.kind === "game" && g.needsSetup === null && g.packed;
  }

  private peekRow(full: string, size: number, modifiedAt: string): PeekResult | undefined {
    const row = this.db.prepare("SELECT size, modified_at, result FROM archive_peeks WHERE path = ?").get(full) as { size: number; modified_at: string; result: PeekResult } | undefined;
    return row && row.size === size && row.modified_at === modifiedAt ? row.result : undefined;
  }

  /** Marks packed games as installers from what earlier peeks found, so a rescan doesn't lose it. */
  private applyPeeks(games: ScannedGame[]): void {
    for (const g of games) {
      if (!this.peekable(g)) continue;
      for (const f of archivesToPeek(g.files)) {
        const r = this.peekRow(resolveGameFile(this.gamesDir, g, f), f.size, f.modifiedAt);
        if (r === "disc" || r === "installer") {
          g.needsSetup = r;
          break;
        }
      }
    }
  }

  /**
   * Lists the archives of packed games with 7-Zip (a few at a time, each one once) to find the
   * ones that are really installers or disc images, so "Install here and upload" shows before
   * anyone has downloaded or unpacked them.
   */
  private peekArchives(): Promise<void> {
    this.peeking ??= (async () => {
      try {
        this.sevenZip ??= findServerSevenZip().then((z) => z?.path ?? null);
        const bin = await this.sevenZip;
        if (!bin) return;
        const todo = [...this.scanned.values()].filter((g) => this.peekable(g));
        const save = this.db.prepare("INSERT INTO archive_peeks (path, size, modified_at, result) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET size = excluded.size, modified_at = excluded.modified_at, result = excluded.result");
        let changed = false;
        const work = async () => {
          for (let g = todo.shift(); g; g = todo.shift()) {
            for (const f of archivesToPeek(g.files)) {
              const full = resolveGameFile(this.gamesDir, g, f);
              let r = this.peekRow(full, f.size, f.modifiedAt);
              if (r === undefined) {
                r = await peekArchive(bin, full);
                save.run(full, f.size, f.modifiedAt, r);
              }
              if (r === "disc" || r === "installer") {
                // The scan may have been replaced meanwhile; mark whichever copy is current.
                const current = this.scanned.get(g.id);
                if (current) current.needsSetup = r;
                g.needsSetup = r;
                changed = true;
                break;
              }
            }
          }
        };
        await Promise.all([work(), work(), work()]);
        if (changed) this.baseCache = null;
      } catch (err) {
        console.warn(`Couldn't look inside archives: ${(err as Error).message}`);
      } finally {
        this.peeking = null;
      }
    })();
    return this.peeking;
  }

  private sync(games: ScannedGame[]): void {
    const ts = now();
    const insert = this.db.prepare(
      "INSERT INTO games (id, source, added_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET removed_at = NULL",
    );
    this.db.exec("BEGIN");
    try {
      for (const g of games) insert.run(g.id, g.source, ts);
      const present = new Set(games.map((g) => g.id));
      const known = this.db.prepare("SELECT id FROM games WHERE removed_at IS NULL").all() as Array<{ id: string }>;
      const markRemoved = this.db.prepare("UPDATE games SET removed_at = ? WHERE id = ?");
      for (const { id } of known) if (!present.has(id)) markRemoved.run(ts, id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  scannedGame(id: string): ScannedGame | undefined {
    return this.scanned.get(id);
  }

  allScanned(): ScannedGame[] {
    return [...this.scanned.values()];
  }

  private rows(): { games: Map<string, GameRow>; meta: Map<string, MetadataRow> } {
    const games = new Map(
      (this.db.prepare("SELECT id, added_at, title_override, kid_safe_override, controller_override, cover_override, background_override, save_path, kind_override, base_game_override, together_override, version_override FROM games").all() as unknown as GameRow[]).map(
        (r) => [r.id, r],
      ),
    );
    const meta = new Map((this.db.prepare("SELECT * FROM metadata").all() as unknown as MetadataRow[]).map((r) => [r.game_id, r]));
    return { games, meta };
  }

  /**
   * Decides what every entry is and matches each update and DLC to its game.
   * - An admin's choice always wins.
   * - Otherwise the name or folder says update or DLC, and the package is matched to the library
   *   game whose name fits best ("Cyberpunk 2077 Update v2.1" belongs to "Cyberpunk 2077").
   * - A package about as big as that game, or whose files are a full installer, is the full game
   *   whatever it's called, and goes back in the library.
   */
  private packages(): Map<string, PackageVerdict> {
    if (this.baseCache && Date.now() - this.baseCache.at < 5000) return this.baseCache.map;
    const { games: rows, meta } = this.rows();
    const all = [...this.scanned.values()];
    const adminKind = (id: string): PackageKind | null => {
      const k = rows.get(id)?.kind_override;
      return k === "game" || k === "update" || k === "dlc" ? k : null;
    };
    const games = all.filter((g) => (adminKind(g.id) ?? g.kind) === "game");
    const names = new Map(
      games.map((g) => {
        const row = rows.get(g.id);
        const shown = [row?.title_override, meta.get(g.id)?.name, g.title].filter((x): x is string => !!x);
        return [g.id, [...shown, cleanTitle(path.posix.basename(g.source)).query]];
      }),
    );
    const match = (p: ScannedGame): ScannedGame | null => {
      const want = cleanTitle(p.baseTitle).query;
      let best: { g: ScannedGame; score: number } | null = null;
      for (const g of games) {
        if (g.platform !== p.platform || g.id === p.id) continue;
        const score = Math.max(...names.get(g.id)!.map((n) => titleSimilarity(want, n)));
        if (score >= 0.8 && (!best || score > best.score)) best = { g, score };
      }
      return best?.g ?? null;
    };
    const titleOf = (g: ScannedGame) => rows.get(g.id)?.title_override || meta.get(g.id)?.name || g.title;

    const map = new Map<string, PackageVerdict>();
    for (const p of all) {
      const row = rows.get(p.id);
      const admin = adminKind(p.id);
      if (admin) {
        const chosen = row?.base_game_override;
        const base = admin === "game" ? null : chosen ? (chosen !== "none" && this.scanned.has(chosen) ? chosen : null) : (match(p)?.id ?? null);
        map.set(p.id, { kind: admin, baseGameId: base, lookalike: null, reason: p.kind === admin && admin === "game" ? null : { by: "admin", confidence: "high", note: "Set by an admin" } });
        continue;
      }
      if (p.kind === "game") {
        map.set(p.id, { kind: "game", baseGameId: null, lookalike: null, reason: null });
        continue;
      }
      const chosen = row?.base_game_override;
      const base = chosen ? (chosen !== "none" ? (this.scanned.get(chosen) ?? null) : null) : match(p);
      const hint = contentHint(p.files);
      const ratio = base && base.sizeBytes > 0 ? p.sizeBytes / base.sizeBytes : null;
      const share = ratio != null && base ? `${formatSize(p.sizeBytes)}, ${ratio < 0.01 ? "under 1%" : `${Math.round(ratio * 100)}%`} of ${titleOf(base)}` : formatSize(p.sizeBytes);
      // "v1.5 to v1.6" is a patch's name; it takes a near-identical size to say otherwise.
      const fullBySize = ratio != null && ratio >= (p.fromVersion ? 0.9 : FULL_GAME_SIZE_RATIO) && hint?.says !== "patch";
      if (fullBySize) {
        map.set(p.id, { kind: "game", baseGameId: null, lookalike: base!.id, reason: { by: "size", confidence: hint?.says === "full" || ratio! >= 0.9 ? "high" : "medium", note: `Full game: ${share}` } });
        continue;
      }
      if (hint?.says === "full" && p.kind === "update") {
        map.set(p.id, { kind: "game", baseGameId: null, lookalike: base?.id ?? null, reason: { by: "content", confidence: "medium", note: `Full game: ${hint.why}` } });
        continue;
      }
      const inFolder = /^(updates|patches|dlcs?)\//i.test(p.source);
      const label = p.kind === "dlc" ? "DLC" : "Update";
      const confidence = hint?.says === "patch" || (ratio != null && ratio < 0.3) ? "high" : ratio == null ? "low" : "medium";
      const why = hint?.says === "patch" ? hint.why : inFolder ? `in the ${p.source.split("/")[0]} folder` : "named as one";
      map.set(p.id, {
        kind: p.kind,
        baseGameId: base?.id ?? null,
        lookalike: null,
        reason: { by: hint?.says === "patch" ? "content" : inFolder ? "folder" : "name", confidence, note: `${label}: ${why} · ${share}` },
      });
    }
    this.baseCache = { at: Date.now(), map };
    return map;
  }

  /** A game's version: what an admin set, or what its file and folder names say. */
  private versionOf(g: ScannedGame): string | null {
    this.versionOverrides ??= new Map(
      (this.db.prepare("SELECT id, version_override FROM games WHERE version_override IS NOT NULL").all() as Array<{ id: string; version_override: string }>).map((r) => [r.id, r.version_override]),
    );
    return this.versionOverrides.get(g.id) ?? g.version;
  }

  /** Newest version on the server per game: its own name's, or the highest of its updates'. */
  private latestVersions(): Map<string, string> {
    const verdicts = this.packages();
    if (this.latestCache?.from === verdicts) return this.latestCache.map;
    const map = new Map<string, string>();
    for (const g of this.scanned.values()) {
      const v = verdicts.get(g.id);
      const owner = v?.kind === "update" ? v.baseGameId : (v?.kind ?? g.kind) === "game" ? g.id : null;
      const version = this.versionOf(g);
      if (!owner || !version) continue;
      const best = map.get(owner);
      if (!best || compareVersion(version, best) > 0) map.set(owner, version);
    }
    this.latestCache = { from: verdicts, map };
    return map;
  }

  private verdict(g: ScannedGame): PackageVerdict {
    return this.packages().get(g.id) ?? { kind: g.kind, baseGameId: null, lookalike: null, reason: null };
  }

  private view(g: ScannedGame, row: GameRow | undefined, metaRow: MetadataRow | undefined): GameDetail {
    const metadata = metaRow ? metadataFromRow(metaRow) : null;
    const { kind, baseGameId, lookalike, reason } = this.verdict(g);
    // Updates and DLC, and full games that were named as updates, borrow their game's art and name.
    const baseGame = baseGameId || lookalike ? this.get((baseGameId ?? lookalike)!, false) : undefined;
    const ownCover = imageUrl(g.id, "cover", row?.cover_override ?? metadata?.coverUrl ?? (metadata?.steamAppId ? "steam" : null) ?? metadata?.screenshots[0] ?? null);
    const ownKidSafe =
      row?.kid_safe_override != null ? row.kid_safe_override === 1 : metadata ? kidSafeFromRatings(metadata.ageRatings) : null;
    const { files, entryModifiedAt, ...base } = g;
    return {
      ...base,
      title: row?.title_override || metadata?.name || (lookalike ? `${g.baseTitle}${g.version ? ` ${versionLabel(g.version)}` : ""}` : g.title),
      // "Recently added" follows the folder's Date modified, like sorting the games folder in Explorer.
      addedAt: entryModifiedAt ?? row?.added_at ?? new Date(0).toISOString(),
      // Updates and DLC show their game's art unless they have their own.
      coverUrl: ownCover ?? baseGame?.coverUrl ?? null,
      backgroundUrl: imageUrl(g.id, "background", row?.background_override ?? metadata?.screenshots[0] ?? (metadata?.steamAppId ? "steam" : null)),
      genres: metadata?.genres ?? [],
      releaseYear: metadata?.releaseDate ? Number(metadata.releaseDate.slice(0, 4)) : null,
      rating: metadata?.rating != null ? Math.round(metadata.rating) : null,
      controllerSupport: (row?.controller_override as ControllerSupport | null) ?? metadata?.controllerSupport ?? null,
      // Updates and DLC are as kid-safe as their game.
      kidSafe: ownKidSafe ?? baseGame?.kidSafe ?? null,
      kind,
      version: this.versionOf(g),
      fromVersion: kind === "update" ? g.fromVersion : null,
      baseGameId,
      kindReason: reason,
      latestVersion: kind === "game" ? (this.latestVersions().get(g.id) ?? null) : null,
      together: row?.together_override != null ? cleanTogether(json(row.together_override, [])) : togetherFromMetadata(metadata?.gameModes ?? [], metadata?.genres ?? []),
      // A full game named as an update was skipped by the scanner's setup check.
      needsSetup: kind !== "game" ? null : (g.needsSetup ?? (g.kind !== "game" && g.platform === PC_PLATFORM ? setupKindOf(files) : null)),
      files,
      metadata: metadata && throughServer(g.id, metadata),
      overrides: {
        title: row?.title_override ?? null,
        kidSafe: row?.kid_safe_override == null ? null : row.kid_safe_override === 1,
        controllerSupport: (row?.controller_override as ControllerSupport | null) ?? null,
        cover: row?.cover_override ?? null,
        background: row?.background_override ?? null,
        together: row?.together_override != null ? cleanTogether(json(row.together_override, [])) : null,
        version: row?.version_override ?? null,
      },
      savePath: row?.save_path ?? null,
      addons: [],
      baseGame: null,
      packageOverrides: {
        kind: (row?.kind_override as PackageKind | null) ?? null,
        baseGameId: row?.base_game_override ?? null,
      },
    };
  }

  /** One game with its file list. `related` adds its updates and DLC, or the game an update belongs to. */
  get(id: string, related = true): GameDetail | undefined {
    const g = this.scanned.get(id);
    if (!g) return undefined;
    const row = this.db.prepare("SELECT id, added_at, title_override, kid_safe_override, controller_override, cover_override, background_override, save_path, kind_override, base_game_override, together_override, version_override FROM games WHERE id = ?").get(id) as
      | GameRow
      | undefined;
    const meta = this.db.prepare("SELECT * FROM metadata WHERE game_id = ?").get(id) as MetadataRow | undefined;
    const game = this.view(g, row, meta);
    if (!related) return game;
    if (game.kind === "game") {
      game.addons = this.list({ kind: "addon" })
        .filter((a) => a.baseGameId === id)
        .sort((a, b) => (a.kind === b.kind ? (b.version && a.version ? compareVersion(b.version, a.version) : 0) : a.kind === "update" ? -1 : 1));
    } else if (game.baseGameId) {
      const base = this.get(game.baseGameId, false);
      if (base) game.baseGame = { id: base.id, title: base.title, coverUrl: base.coverUrl, version: base.version };
    }
    return game;
  }

  /** Admin: corrects what an entry is and which game it belongs to (null = work it out from the name, "none" = no game). */
  setPackage(id: string, o: { kind?: PackageKind | null; baseGameId?: string | null }): void {
    if (o.kind !== undefined) this.db.prepare("UPDATE games SET kind_override = ? WHERE id = ?").run(o.kind, id);
    if (o.baseGameId !== undefined) {
      if (o.baseGameId && o.baseGameId !== "none" && !this.scanned.has(o.baseGameId)) throw new Error("Unknown game");
      if (o.baseGameId === id) throw new Error("An update can't belong to itself");
      this.db.prepare("UPDATE games SET base_game_override = ? WHERE id = ?").run(o.baseGameId, id);
    }
    this.baseCache = null;
  }

  list(query: GameQuery = {}): GameSummary[] {
    const { games, meta } = this.rows();
    const q = query.search?.trim().toLowerCase();
    const genre = query.genre?.toLowerCase();
    let out: GameSummary[] = [];
    for (const g of this.scanned.values()) {
      const { kind } = this.verdict(g);
      const want = query.kind ?? "game";
      if (want !== "all" && (want === "addon" ? kind === "game" : kind !== want)) continue;
      const { files: _f, metadata: _m, overrides: _o, backgroundUrl: _b, savePath: _s, addons: _a, baseGame: _g, packageOverrides: _p, ...summary } = this.view(g, games.get(g.id), meta.get(g.id));
      if (q && !summary.title.toLowerCase().includes(q) && !summary.source.toLowerCase().includes(q)) continue;
      if (query.platform === "emulated" ? summary.platform === PC_PLATFORM : query.platform && summary.platform !== query.platform) continue;
      if (genre && !summary.genres.some((x) => x.toLowerCase() === genre)) continue;
      if (query.kidSafe && summary.kidSafe !== true) continue;
      if (query.missingMetadata && meta.has(g.id)) continue;
      if (query.controller === "full" && summary.controllerSupport !== "full") continue;
      if (query.controller === "partial" && summary.controllerSupport !== "partial") continue;
      if (query.controller === "any" && summary.controllerSupport !== "partial" && summary.controllerSupport !== "full") continue;
      out.push(summary);
    }
    const dir = query.order === "desc" ? -1 : 1;
    const by = query.sort ?? "title";
    const key = (s: GameSummary): string | number =>
      by === "added" ? s.addedAt : by === "release" ? (s.releaseYear ?? 0) : by === "rating" ? (s.rating ?? -1) : by === "size" ? s.sizeBytes : s.title.toLowerCase();
    out.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const c = typeof ka === "number" ? ka - (kb as number) : ka.localeCompare(kb as string);
      return c * dir || a.title.localeCompare(b.title);
    });
    if (query.limit) out = out.slice(0, query.limit);
    return out;
  }

  /** Systems in the library with game counts, PC first, for the Emulation section. */
  platforms(kidSafeOnly = false): Array<{ id: string; count: number; sizeBytes: number }> {
    const counts = new Map<string, { id: string; count: number; sizeBytes: number }>();
    for (const g of this.list({ kidSafe: kidSafeOnly })) {
      const c = counts.get(g.platform) ?? { id: g.platform, count: 0, sizeBytes: 0 };
      c.count++;
      c.sizeBytes += g.sizeBytes;
      counts.set(g.platform, c);
    }
    const order = (id: string) => (id === PC_PLATFORM ? -1 : PLATFORMS.findIndex((x) => x.id === id) >>> 0);
    return [...counts.values()].sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id));
  }

  /** Distinct genres with counts, for filter menus. */
  genres(kidSafeOnly = false, platform?: string): Array<{ name: string; count: number }> {
    const counts = new Map<string, number>();
    for (const g of this.list({ kidSafe: kidSafeOnly, platform })) for (const name of g.genres) counts.set(name, (counts.get(name) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  /**
   * Swaps a game for a new copy (the zipped install made from a disc image or installer).
   * The new file is already in the games folder; the old one moves to .replaced/ and its
   * metadata, overrides, play history and saves carry over to the new id.
   */
  async replaceGame(oldId: string, newSource: string): Promise<GameDetail> {
    const old = this.scanned.get(oldId);
    if (!old) throw new Error("Unknown game");
    const newId = gameIdFor(newSource);
    const replaced = path.join(this.gamesDir, ".replaced");
    await mkdir(replaced, { recursive: true });
    await rename(path.join(this.gamesDir, old.source), path.join(replaced, `${Date.now()}-${old.source.replaceAll("/", " - ")}`));
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO games (id, source, added_at, title_override, kid_safe_override, controller_override, cover_override, background_override, save_path, kind_override, base_game_override, together_override)
           SELECT ?, ?, added_at, title_override, kid_safe_override, controller_override, cover_override, background_override, save_path, kind_override, base_game_override, together_override FROM games WHERE id = ?
           ON CONFLICT(id) DO NOTHING`,
        )
        .run(newId, newSource, oldId);
      for (const table of ["metadata", "metadata_attempts", "user_games", "saves", "play_sessions", "shelf_games"]) {
        this.db.prepare(`UPDATE OR IGNORE ${table} SET game_id = ? WHERE game_id = ?`).run(newId, oldId);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    await this.rescan();
    const game = this.get(newId);
    if (!game) throw new Error(`${newSource} didn't show up in the library after the upload`);
    return game;
  }

  /**
   * Admin: takes a game out of the library. Its files move to .deleted/ in the games folder,
   * or are removed for good with `permanent`. Its settings, artwork and saves stay in the
   * database, so moving the files back brings the game back as it was.
   */
  async deleteGame(id: string, permanent = false): Promise<void> {
    const game = this.scanned.get(id);
    if (!game) throw new Error("Unknown game");
    const full = path.resolve(this.gamesDir, game.source);
    if (!full.startsWith(path.resolve(this.gamesDir) + path.sep)) throw new Error("Unknown game");
    if (permanent) await rm(full, { recursive: true, force: true });
    else {
      const deleted = path.join(this.gamesDir, ".deleted");
      await mkdir(deleted, { recursive: true });
      await rename(full, path.join(deleted, `${Date.now()}-${game.source.replaceAll("/", " - ")}`));
    }
    await this.rescan();
  }

  setSavePath(id: string, savePath: string | null): void {
    this.db.prepare("UPDATE games SET save_path = ? WHERE id = ?").run(savePath || null, id);
  }

  setOverrides(id: string, o: { title?: string | null; kidSafe?: boolean | null; controller?: ControllerSupport | null; together?: TogetherTag[] | null; version?: string | null }): void {
    if (o.version !== undefined) {
      this.db.prepare("UPDATE games SET version_override = ? WHERE id = ?").run(o.version, id);
      this.versionOverrides = null;
      this.latestCache = null;
    }
    if (o.together !== undefined) this.db.prepare("UPDATE games SET together_override = ? WHERE id = ?").run(o.together === null ? null : JSON.stringify(cleanTogether(o.together)), id);
    if (o.title !== undefined) this.db.prepare("UPDATE games SET title_override = ? WHERE id = ?").run(o.title || null, id);
    if (o.kidSafe !== undefined) this.db.prepare("UPDATE games SET kid_safe_override = ? WHERE id = ?").run(o.kidSafe === null ? null : o.kidSafe ? 1 : 0, id);
    if (o.controller !== undefined) this.db.prepare("UPDATE games SET controller_override = ? WHERE id = ?").run(o.controller, id);
  }

  async stats(): Promise<LibraryStats> {
    let disk: LibraryStats["disk"] = null;
    try {
      const s = await statfs(this.gamesDir);
      disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
    } catch {
      disk = null;
    }
    let totalBytes = 0;
    for (const g of this.scanned.values()) totalBytes += g.sizeBytes;
    return {
      gameCount: this.scanned.size,
      totalBytes,
      lastScanAt: this.lastScanAt?.toISOString() ?? null,
      lastScanMs: this.lastScanMs,
      disk,
    };
  }
}

/** Server URL of a game image; the version changes whenever the source does, so browsers refetch. */
/** ScreenScraper images only load with credentials, so the browser gets them through the server. */
function throughServer(id: string, m: GameMetadata): GameMetadata {
  const ss = (u: string | null) => !!u && /^https?:\/\/([^/]+\.)?screenscraper\.fr\//.test(u);
  if (!ss(m.coverUrl) && !m.screenshots.some(ss)) return m;
  return {
    ...m,
    coverUrl: ss(m.coverUrl) ? `/api/games/${id}/cover` : m.coverUrl,
    screenshots: m.screenshots.map((u, i) => (ss(u) ? `/api/games/${id}/screenshots/${i}` : u)),
  };
}

function imageUrl(id: string, kind: "cover" | "background", source: string | null): string | null {
  if (!source) return null;
  const v = createHash("sha1").update(source).digest("hex").slice(0, 8);
  return `/api/games/${id}/${kind}?v=${v}`;
}
