import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { PC_PLATFORM, platformFor, type GameMetadata, type Platform } from "@lootden/shared";
import type { Library } from "../catalog/library.js";
import type { ScannedGame } from "../catalog/scanner.js";
import { now, type Db } from "../db/database.js";
import type { FetchLike } from "./http.js";
import type { ServerConfig } from "../config.js";
import { IgdbProvider } from "./igdb.js";
import { LaunchBoxProvider } from "./launchbox.js";
import { RawgProvider } from "./rawg.js";
import { MAX_HASH_BYTES, ScreenScraperProvider } from "./screenscraper.js";
import { TheGamesDbProvider } from "./thegamesdb.js";
import { SteamGridDb, type ArtworkOption } from "./steamgriddb.js";
import { PcGamingWiki } from "./pcgamingwiki.js";
import { steamCover, steamHeader, SteamProvider } from "./steam.js";
import { cleanTitle, matchScore, type CleanTitle } from "./titles.js";
import type { Candidate, MetadataProvider, ProviderResult, RomHints } from "./types.js";

/** Below this score a match is left for an admin to pick by hand. */
export const AUTO_MATCH_THRESHOLD = 0.6;
const RETRY_UNMATCHED_DAYS = 7;

export interface MetadataStatus {
  providers: string[];
  queued: number;
  running: boolean;
  matched: number;
  unmatched: number;
}

export type ArtworkKind = "cover" | "background";

/** Sources whose "cover" is a wide banner or screenshot, so SteamGridDB's portrait art replaces it. */
const WIDE_COVERS = new Set(["rawg", "steam"]);

export class MetadataService {
  igdb!: IgdbProvider;
  rawg!: RawgProvider;
  steamgriddb!: SteamGridDb;
  screenscraper!: ScreenScraperProvider;
  thegamesdb!: TheGamesDbProvider;
  launchbox!: LaunchBoxProvider;
  readonly steam: SteamProvider;
  readonly pcgw: PcGamingWiki;
  private queue: string[] = [];
  /** Queued games to look up again even though they have metadata (Refresh), not just the missing ones. */
  private readonly refreshing = new Set<string>();
  /** Image downloads in progress, so simultaneous requests for one image share a download. */
  private readonly downloads = new Map<string, Promise<{ file: string; contentType: string } | null>>();
  /** Games already logged as having no usable artwork, so the log isn't repeated on every request. */
  private readonly reportedMissing = new Set<string>();
  private running = false;

  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly dataDir: string,
    private readonly config: Pick<ServerConfig, "igdb" | "rawg" | "steamgriddb" | "screenscraper" | "thegamesdb" | "launchbox" | "metadataOrder">,
    private readonly log: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void },
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.steam = new SteamProvider(fetchImpl);
    this.pcgw = new PcGamingWiki(fetchImpl);
    this.configure();
  }

  /** (Re)creates the keyed providers from the current config, e.g. after keys change in the UI. */
  configure(): void {
    this.igdb = new IgdbProvider(this.config.igdb.clientId, this.config.igdb.clientSecret, this.fetchImpl);
    this.rawg = new RawgProvider(this.config.rawg.apiKey, this.fetchImpl);
    this.steamgriddb = new SteamGridDb(this.config.steamgriddb.apiKey, this.fetchImpl);
    this.screenscraper = new ScreenScraperProvider({ ...this.config.screenscraper }, this.fetchImpl);
    this.thegamesdb = new TheGamesDbProvider(this.config.thegamesdb.apiKey, this.fetchImpl);
    this.launchbox?.close();
    this.launchbox = new LaunchBoxProvider(this.config.launchbox.enabled, path.join(this.dataDir, "launchbox"), this.log, this.fetchImpl);
  }

  /** Every source that is set up (keys entered), whatever the admin's order says. */
  get providers(): MetadataProvider[] {
    return [this.igdb, this.screenscraper, this.launchbox, this.thegamesdb, this.rawg, this.steam].filter((p) => p.enabled);
  }

  /** The sources to try for PC or emulated games, in the admin's order, skipping ones turned off or not set up. */
  ordered(emulated: boolean): MetadataProvider[] {
    const order = emulated ? this.config.metadataOrder.emulated : this.config.metadataOrder.pc;
    const all = this.providers;
    return order.map((id) => all.find((p) => p.name === id)).filter((p): p is MetadataProvider => !!p);
  }

  /** Checks a keyed service answers, for the Test buttons in the admin UI. */
  async test(name: string): Promise<string> {
    if (name === "igdb") {
      if (!this.igdb.enabled) throw new Error("Enter the IGDB client ID and secret first");
      return `IGDB found ${(await this.igdb.search("Portal")).length} results for "Portal"`;
    }
    if (name === "rawg") {
      if (!this.rawg.enabled) throw new Error("Enter the RAWG API key first");
      return `RAWG found ${(await this.rawg.search("Portal")).length} results for "Portal"`;
    }
    if (name === "steamgriddb") {
      if (!this.steamgriddb.enabled) throw new Error("Enter the SteamGridDB API key first");
      return `SteamGridDB found ${(await this.steamgriddb.search("Portal")).length} results for "Portal"`;
    }
    if (name === "screenscraper") {
      if (!this.screenscraper.enabled) throw new Error("Enter the ScreenScraper developer ID and password first");
      const n = (await this.screenscraper.search("Sonic the Hedgehog", platformFor("genesis"))).length;
      return `ScreenScraper found ${n} results for "Sonic the Hedgehog" on Genesis`;
    }
    if (name === "thegamesdb") {
      if (!this.thegamesdb.enabled) throw new Error("Enter the TheGamesDB API key first");
      return `TheGamesDB found ${(await this.thegamesdb.search("Super Mario Bros", platformFor("nes"))).length} results for "Super Mario Bros" on NES`;
    }
    if (name === "launchbox") {
      if (!this.launchbox.enabled) throw new Error("Turn on the LaunchBox games database first");
      if (this.launchbox.downloading) return "LaunchBox's database is still downloading (about 100 MB); try again in a few minutes";
      const n = await this.launchbox.count();
      if (n === null) {
        void this.launchbox.refresh().catch(() => {});
        return `Downloading LaunchBox's database (about 100 MB) in the background${this.launchbox.lastError ? `; the last try failed: ${this.launchbox.lastError}` : ""}. Test again in a few minutes`;
      }
      return `LaunchBox's database is ready with ${n.toLocaleString("en")} games`;
    }
    throw new Error(`Unknown service ${name}`);
  }

  provider(name: string): MetadataProvider | undefined {
    return this.providers.find((p) => p.name === name);
  }

  status(): MetadataStatus {
    const matched = (this.db.prepare("SELECT COUNT(*) AS n FROM metadata").get() as { n: number }).n;
    return {
      providers: this.providers.map((p) => p.name),
      queued: this.queue.length,
      running: this.running,
      matched,
      unmatched: Math.max(0, this.library.allScanned().length - matched),
    };
  }

  /** Queues games that have no metadata and were not tried recently. */
  queueMissing(games: ScannedGame[], force = false): number {
    const cutoff = new Date(Date.now() - RETRY_UNMATCHED_DAYS * 86400_000).toISOString();
    const have = new Set((this.db.prepare("SELECT game_id FROM metadata").all() as Array<{ game_id: string }>).map((r) => r.game_id));
    const tried = new Set(
      (this.db.prepare("SELECT game_id FROM metadata_attempts WHERE attempted_at > ?").all(cutoff) as Array<{ game_id: string }>).map((r) => r.game_id),
    );
    // Updates and DLC show their game's details, so only full games are looked up.
    const ids = games.filter((g) => g.kind === "game" && !have.has(g.id) && (force || !tried.has(g.id))).map((g) => g.id);
    return this.enqueue(ids);
  }

  /**
   * Queues games to look up again from the current sources and their order: matched games
   * too, so new keys or a new priority reach games matched before. Hand-picked matches keep
   * their pick and just get its details fetched again.
   */
  queueRefresh(ids: string[]): number {
    for (const id of ids) this.refreshing.add(id);
    return this.enqueue(ids);
  }

  enqueue(ids: string[]): number {
    const fresh = ids.filter((id) => !this.queue.includes(id));
    this.queue.push(...fresh);
    void this.drain();
    return fresh.length;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const id = this.queue.shift()!;
        try {
          if (this.refreshing.delete(id)) await this.refresh(id);
          else await this.autoMatch(id);
        } catch (err) {
          this.recordAttempt(id, (err as Error).message);
          this.log.warn({ gameId: id, err: (err as Error).message }, "Metadata lookup failed");
        }
        this.onLookedUp();
      }
    } finally {
      this.running = false;
    }
  }

  /** Called after each game's lookup, matched or not. */
  onLookedUp: () => void = () => {};

  /** Waits for the queue to empty (tests, CLI). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 20));
  }

  private recordAttempt(gameId: string, error: string | null): void {
    this.db
      .prepare("INSERT INTO metadata_attempts (game_id, attempted_at, error) VALUES (?, ?, ?) ON CONFLICT(game_id) DO UPDATE SET attempted_at = excluded.attempted_at, error = excluded.error")
      .run(gameId, now(), error);
  }

  /** Searches every enabled provider for a game, best matches first. */
  async search(query: string, year: number | null = null, platform?: string): Promise<Array<Candidate & { score: number }>> {
    const clean = { query, year };
    const system = platform && platform !== PC_PLATFORM ? platformFor(platform) : undefined;
    const results: Array<Candidate & { score: number }> = [];
    for (const p of this.ordered(!!system)) {
      try {
        for (const c of await p.search(query, system)) results.push({ ...c, score: matchScore(clean, c) });
      } catch (err) {
        this.log.warn({ provider: p.name, err: (err as Error).message }, "Metadata search failed");
      }
    }
    return results.sort((a, b) => b.score - a.score);
  }

  async autoMatch(gameId: string): Promise<GameMetadata | null> {
    const game = this.library.scannedGame(gameId);
    if (!game) return null;
    const existing = this.db.prepare("SELECT locked FROM metadata WHERE game_id = ?").get(gameId) as { locked: number } | undefined;
    if (existing?.locked) return null;

    // Emulated games are matched on their tidied ROM name, on their own system only.
    const emulated = game.platform !== PC_PLATFORM;
    const clean = cleanTitle(emulated ? game.title : game.source);
    const system = emulated ? platformFor(game.platform) : undefined;
    const rom = emulated && game.layout !== "folder" ? this.romHints(path.join(this.library.gamesDir, game.source), game.sizeBytes) : undefined;
    const sources = this.ordered(emulated);
    for (const [i, p] of sources.entries()) {
      const result = await this.bestMatch(p, clean, system, rom);
      if (result) {
        this.log.info({ gameId, provider: p.name, name: result.name }, "Metadata matched");
        return this.store(gameId, await this.enrich(await this.fillGaps(result, clean, system, sources.slice(i + 1))), false);
      }
    }
    this.recordAttempt(gameId, `No confident match for "${clean.query}"`);
    return null;
  }

  /** The provider's confident match for a title (or the ROM's checksum), fetched in full. */
  private async bestMatch(p: MetadataProvider, clean: CleanTitle, system: Platform | undefined, rom?: RomHints): Promise<ProviderResult | null> {
    const candidates = (await p.search(clean.query, system, rom)).map((c) => ({ ...c, score: c.exact ? 1 : matchScore(clean, c) }));
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    return best && best.score >= AUTO_MATCH_THRESHOLD ? p.fetch(best.providerId) : null;
  }

  /** File name, size and a lazily worked-out MD5 for sources that match ROMs by checksum. */
  private romHints(file: string, size: number): RomHints {
    let md5: Promise<string | null> | null = null;
    return {
      fileName: path.basename(file),
      size,
      md5: () =>
        (md5 ??=
          size > MAX_HASH_BYTES
            ? Promise.resolve(null)
            : new Promise((resolve) => {
                const h = createHash("md5");
                createReadStream(file)
                  .on("data", (d) => h.update(d))
                  .on("end", () => resolve(h.digest("hex")))
                  .on("error", () => resolve(null));
              })),
    };
  }

  /**
   * When the first source to match lacks a cover, description or screenshots, the next
   * sources in the admin's order fill the gaps (the matched source's own values win).
   */
  private async fillGaps(r: ProviderResult, clean: CleanTitle, system: Platform | undefined, rest: MetadataProvider[]): Promise<ProviderResult> {
    const missing = () => !r.coverUrl || !r.summary || r.screenshots.length === 0 || r.genres.length === 0;
    for (const p of rest) {
      if (!missing()) break;
      if (p.name === "steam" && r.steamAppId) continue; // enrich() already uses the Steam app
      try {
        const extra = await this.bestMatch(p, { query: r.name, year: clean.year ?? (r.releaseDate ? Number(r.releaseDate.slice(0, 4)) : null) }, system);
        if (!extra) continue;
        r.coverUrl ??= extra.coverUrl;
        r.summary ??= extra.summary;
        if (!r.screenshots.length) r.screenshots = extra.screenshots;
        if (!r.genres.length) r.genres = extra.genres;
        r.releaseDate ??= extra.releaseDate;
        r.rating ??= extra.rating;
        if (!r.ageRatings.length) r.ageRatings = extra.ageRatings;
        r.steamAppId ??= extra.steamAppId;
      } catch (err) {
        this.log.warn({ provider: p.name, err: (err as Error).message }, "Metadata gap fill failed");
      }
    }
    return r;
  }

  /**
   * Looks one game up again now. A hand-picked match is fetched again from its source; any
   * other game is matched afresh with the current sources, keeping what it had if nothing
   * matches this time.
   */
  async refresh(gameId: string): Promise<GameMetadata | null> {
    const row = this.db.prepare("SELECT provider, provider_id, locked FROM metadata WHERE game_id = ?").get(gameId) as { provider: string; provider_id: string; locked: number } | undefined;
    if (row?.locked) return this.apply(gameId, row.provider, row.provider_id);
    this.db.prepare("DELETE FROM metadata_attempts WHERE game_id = ?").run(gameId);
    return this.autoMatch(gameId);
  }

  /** Manual match by an admin; locks the result so automatic refreshes keep it. */
  async apply(gameId: string, providerName: string, providerId: string): Promise<GameMetadata> {
    const p = this.provider(providerName);
    if (!p) throw new Error(`Metadata provider "${providerName}" is not enabled`);
    const result = await p.fetch(providerId);
    if (!result) throw new Error(`${providerName} has no game ${providerId}`);
    return this.store(gameId, await this.enrich(result), true);
  }

  clear(gameId: string): void {
    this.db.prepare("DELETE FROM metadata WHERE game_id = ?").run(gameId);
    this.db.prepare("DELETE FROM metadata_attempts WHERE game_id = ?").run(gameId);
  }

  /** Fills controller support (Steam tags, then PCGamingWiki) and Steam age data the main provider lacked. */
  private async enrich(r: ProviderResult): Promise<ProviderResult> {
    r = await this.enrichDetails(r);
    // RAWG and Steam only have wide images; SteamGridDB has proper portrait covers.
    if (this.steamgriddb.enabled && (!r.coverUrl || WIDE_COVERS.has(r.provider))) {
      try {
        const id = await this.steamgriddb.gameId(r.name, r.steamAppId);
        const best = id ? (await this.steamgriddb.covers(id))[0] : undefined;
        if (best) r.coverUrl = best.url;
      } catch (err) {
        this.log.warn({ err: (err as Error).message }, "SteamGridDB cover lookup failed");
      }
    }
    return r;
  }

  private async enrichDetails(r: ProviderResult): Promise<ProviderResult> {
    if (!r.steamAppId || r.provider === "steam") {
      if (r.controllerSupport === null && r.steamAppId) r.controllerSupport = await this.pcgw.controllerSupport(r.steamAppId).catch(() => null);
      return r;
    }
    try {
      const steam = await this.steam.fetch(r.steamAppId);
      if (steam) {
        r.controllerSupport ??= steam.controllerSupport;
        if (r.ageRatings.length === 0) r.ageRatings = steam.ageRatings;
        if (r.genres.length === 0) r.genres = steam.genres;
      }
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, "Steam enrichment failed");
    }
    if (r.controllerSupport === null) r.controllerSupport = await this.pcgw.controllerSupport(r.steamAppId).catch(() => null);
    return r;
  }

  private store(gameId: string, r: ProviderResult, locked: boolean): GameMetadata {
    const fetchedAt = now();
    this.db
      .prepare(
        `INSERT INTO metadata (game_id, provider, provider_id, name, summary, cover_url, screenshots, genres, themes, game_modes,
           release_date, rating, age_ratings, controller_support, steam_app_id, locked, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(game_id) DO UPDATE SET provider = excluded.provider, provider_id = excluded.provider_id, name = excluded.name,
           summary = excluded.summary, cover_url = excluded.cover_url, screenshots = excluded.screenshots, genres = excluded.genres,
           themes = excluded.themes, game_modes = excluded.game_modes, release_date = excluded.release_date, rating = excluded.rating,
           age_ratings = excluded.age_ratings, controller_support = excluded.controller_support, steam_app_id = excluded.steam_app_id,
           locked = excluded.locked, fetched_at = excluded.fetched_at`,
      )
      .run(
        gameId,
        r.provider,
        r.providerId,
        r.name,
        r.summary,
        r.coverUrl,
        JSON.stringify(r.screenshots),
        JSON.stringify(r.genres),
        JSON.stringify(r.themes),
        JSON.stringify(r.gameModes),
        r.releaseDate,
        r.rating,
        JSON.stringify(r.ageRatings),
        r.controllerSupport,
        r.steamAppId,
        locked ? 1 : 0,
        fetchedAt,
      );
    this.db.prepare("DELETE FROM metadata_attempts WHERE game_id = ?").run(gameId);
    return { ...r, locked, fetchedAt };
  }

  /** Where an uploaded image for a game is kept. */
  uploadPath(gameId: string, kind: ArtworkKind): string {
    return path.join(this.dataDir, "artwork", `${gameId}-${kind}.img`);
  }

  /** Saves an uploaded image (admin) and points the game's override at it. */
  async saveUpload(gameId: string, kind: ArtworkKind, data: Buffer, contentType: string): Promise<void> {
    if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(contentType)) throw new Error("Upload a PNG, JPEG, WebP, GIF or AVIF image");
    if (data.length > 15 * 1024 * 1024) throw new Error("Images can be at most 15 MB");
    const file = this.uploadPath(gameId, kind);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, data);
    await rename(`${file}.tmp`, file);
    await writeFile(`${file}.type`, contentType);
    this.setOverride(gameId, kind, `upload:${Date.now()}`);
  }

  /** Sets (URL or upload marker) or clears (null) a game's cover/background override. */
  setOverride(gameId: string, kind: ArtworkKind, value: string | null): void {
    if (value && !value.startsWith("upload:") && !/^https?:\/\//.test(value)) throw new Error("Use an http(s) image URL");
    const col = kind === "cover" ? "cover_override" : "background_override";
    this.db.prepare(`UPDATE games SET ${col} = ? WHERE id = ?`).run(value, gameId);
  }

  /** Replacement artwork to pick from: SteamGridDB when a key is set, plus what the metadata already has. */
  async artworkOptions(gameId: string, kind: ArtworkKind, query?: string): Promise<ArtworkOption[]> {
    const game = this.library.get(gameId);
    if (!game) return [];
    const out: ArtworkOption[] = [];
    if (this.steamgriddb.enabled) {
      const id = query
        ? ((await this.steamgriddb.search(query))[0]?.id ?? null)
        : await this.steamgriddb.gameId(game.title, game.metadata?.steamAppId ?? null);
      if (id) out.push(...(kind === "cover" ? await this.steamgriddb.covers(id) : await this.steamgriddb.backgrounds(id)));
    }
    const m = game.metadata;
    if (m) {
      const own = kind === "cover" ? [m.coverUrl, m.steamAppId ? steamCover(m.steamAppId) : null] : [...m.screenshots, m.steamAppId ? steamHeader(m.steamAppId) : null];
      for (const url of own) if (url && /^https?:/.test(url) && !out.some((o) => o.url === url)) out.push({ url, thumb: url, width: 0, height: 0, source: m.provider });
    }
    return out.slice(0, 60);
  }

  /**
   * Local copy of a game's cover or background, downloaded on first request so the UI
   * keeps working if the image host is slow or gone. An admin override (upload or URL)
   * wins over metadata. Returns null when there is no image.
   */
  async imageFile(gameId: string, kind: ArtworkKind): Promise<{ file: string; contentType: string } | null> {
    const g = this.db.prepare("SELECT cover_override, background_override FROM games WHERE id = ?").get(gameId) as
      | { cover_override: string | null; background_override: string | null }
      | undefined;
    const override = kind === "cover" ? g?.cover_override : g?.background_override;
    if (override?.startsWith("upload:")) {
      const file = this.uploadPath(gameId, kind);
      const contentType = (await readFile(`${file}.type`, "utf8").catch(() => "image/jpeg")).trim();
      return (await stat(file).catch(() => null)) ? { file, contentType } : null;
    }
    const row = this.db.prepare("SELECT cover_url, screenshots, steam_app_id FROM metadata WHERE game_id = ?").get(gameId) as
      | { cover_url: string | null; screenshots: string; steam_app_id: string | null }
      | undefined;
    const urls: string[] = [];
    if (override) urls.push(override);
    else {
      const shots = JSON.parse(row?.screenshots ?? "[]") as string[];
      if (kind === "cover") {
        // The matched cover, then Steam's portrait and header art, then a screenshot.
        if (row?.cover_url) urls.push(row.cover_url);
        if (row?.steam_app_id) urls.push(steamCover(row.steam_app_id), steamHeader(row.steam_app_id));
        if (shots[0]) urls.push(shots[0]);
      } else {
        if (shots[0]) urls.push(shots[0]);
        if (row?.steam_app_id) urls.push(steamHeader(row.steam_app_id));
      }
    }
    if (!urls.length) return null;
    const dir = path.join(this.dataDir, kind === "cover" ? "covers" : "backgrounds");
    const file = path.join(dir, `${gameId}-${Buffer.from(urls[0]!).toString("base64url").slice(-16)}.img`);
    try {
      await stat(file);
      return { file, contentType: (await readFile(`${file}.type`, "utf8").catch(() => "image/jpeg")).trim() };
    } catch {
      // not cached yet
    }
    let pending = this.downloads.get(file);
    if (!pending) {
      pending = this.download(urls, dir, file).finally(() => this.downloads.delete(file));
      this.downloads.set(file, pending);
    }
    const image = await pending;
    const key = `${gameId}:${kind}`;
    if (image) this.reportedMissing.delete(key);
    else if (!this.reportedMissing.has(key)) {
      this.reportedMissing.add(key);
      this.log.warn({ gameId, kind, tried: urls }, "No artwork could be downloaded for this game; it shows a placeholder until Find metadata picks new art");
    }
    return image;
  }

  /** Local copy of one of a game's metadata screenshots, for sources whose links need the server's credentials. */
  async screenshotFile(gameId: string, index: number): Promise<{ file: string; contentType: string } | null> {
    const row = this.db.prepare("SELECT screenshots FROM metadata WHERE game_id = ?").get(gameId) as { screenshots: string } | undefined;
    const url = (JSON.parse(row?.screenshots ?? "[]") as string[])[index];
    if (!url) return null;
    const dir = path.join(this.dataDir, "screenshots");
    const file = path.join(dir, `${gameId}-${index}-${Buffer.from(url).toString("base64url").slice(-16)}.img`);
    if (await stat(file).catch(() => null)) return { file, contentType: (await readFile(`${file}.type`, "utf8").catch(() => "image/jpeg")).trim() };
    let pending = this.downloads.get(file);
    if (!pending) {
      pending = this.download([url], dir, file).finally(() => this.downloads.delete(file));
      this.downloads.set(file, pending);
    }
    return pending;
  }

  /** Downloads the first address that returns an image into `file`. */
  private async download(urls: string[], dir: string, file: string): Promise<{ file: string; contentType: string } | null> {
    for (const url of urls) {
      const res = await this.fetchImpl(this.screenscraper.authorize(url), { signal: AbortSignal.timeout(20_000) }).catch(() => null);
      if (!res?.ok) continue;
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      if (!contentType.startsWith("image/")) continue;
      const body = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
      if (!body.length) continue;
      await mkdir(dir, { recursive: true });
      await writeFile(`${file}.tmp`, body);
      await rename(`${file}.tmp`, file);
      await writeFile(`${file}.type`, contentType);
      return { file, contentType };
    }
    return null;
  }
}
