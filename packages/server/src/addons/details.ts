import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GameInfo, StoreGame, StoreGameCustom, StoreGameDetail } from "@lootden/shared";
import { json, now, type Db } from "../db/database.js";
import { gameInfo } from "../metadata/details.js";
import { AUTO_MATCH_THRESHOLD, type ArtworkKind, type MetadataService } from "../metadata/service.js";
import type { ArtworkOption } from "../metadata/steamgriddb.js";
import { steamHeader } from "../metadata/steam.js";
import { matchScore } from "../metadata/titles.js";

const RETRY_UNMATCHED_MS = 7 * 86400_000;
const REFRESH_INFO_MS = 30 * 86400_000;
const PROVIDERS = ["igdb", "rawg", "steam"];

/** Where the server serves a store game's cover (and background), for <img> tags. */
export const storeArtPath = (addon: string, externalId: string, kind: ArtworkKind = "cover") =>
  `/api/store-games/${encodeURIComponent(addon)}/${encodeURIComponent(externalId)}/${kind}`;

/** The cover address with the custom value in it, so a browser drops its cached copy when it changes. */
export const customArtUrl = (addon: string, externalId: string, value: string, kind: ArtworkKind = "cover") =>
  `${storeArtPath(addon, externalId, kind)}?v=${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;

/**
 * A store's title as a search: trademark signs dropped, and folder-style names split up
 * ("FarCry6" -> "Far Cry 6", "RidersRepublic" -> "Riders Republic"), as Ubisoft Connect's
 * install folders are all the PC knows some games by.
 */
export function storeQuery(title: string): string {
  let s = title.replace(/[™®©]/g, " ").replace(/[_]+/g, " ");
  if (!/\s/.test(s.trim())) s = s.replace(/([a-z])([A-Z0-9])/g, "$1 $2").replace(/([0-9])([A-Za-z])/g, "$1 $2");
  return s.replace(/\s+/g, " ").trim() || title;
}

interface MatchRow {
  provider: string | null;
  provider_id: string | null;
  cover_url: string | null;
  matched_at: string;
}

interface CustomRow {
  title: string | null;
  cover: string | null;
  background: string | null;
  provider: string | null;
  provider_id: string | null;
}

type Image = { file: string; contentType: string } | { url: string };

/**
 * Covers and details for games from other stores. Each game is matched once by title (a Steam
 * game straight by its app id) against IGDB, RAWG or the Steam store, and the match is shared
 * by everyone who owns it. Each person can rename a game, pick another match, or set their own
 * cover and background; those changes are theirs alone.
 */
export class StoreGameDetails {
  /** Matches run one at a time, so a page of covers doesn't fire hundreds of searches at once. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<string, Promise<MatchRow>>();

  constructor(
    private readonly db: Db,
    private readonly metadata: MetadataService,
    private readonly dataDir: string,
    private readonly log: { warn: (o: object, m: string) => void },
  ) {}

  // ---- Matching -------------------------------------------------------------------------

  private matchRow(addon: string, externalId: string): MatchRow | undefined {
    return this.db.prepare("SELECT provider, provider_id, cover_url, matched_at FROM store_game_match WHERE addon = ? AND external_id = ?").get(addon, externalId) as MatchRow | undefined;
  }

  /** The metadata entry for a store game, looked up the first time it's asked for. Null when nothing matched. */
  async match(addon: string, externalId: string, title: string): Promise<{ provider: string; providerId: string; coverUrl: string | null } | null> {
    let row = this.matchRow(addon, externalId);
    const stale = row && !row.provider && Date.now() - Date.parse(row.matched_at) > RETRY_UNMATCHED_MS;
    if ((!row || stale) && title) {
      const key = `${addon}:${externalId}`;
      let job = this.pending.get(key);
      if (!job) {
        job = this.enqueue(() => this.lookup(addon, externalId, title)).finally(() => this.pending.delete(key));
        this.pending.set(key, job);
      }
      row = await job;
    }
    return row?.provider && row.provider_id ? { provider: row.provider, providerId: row.provider_id, coverUrl: row.cover_url } : null;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async lookup(addon: string, externalId: string, title: string): Promise<MatchRow> {
    let found: { provider: string; providerId: string; name: string; steamAppId: string | null; coverUrl: string | null } | null = null;
    if (addon === "steam" && /^\d+$/.test(externalId)) found = { provider: "steam", providerId: externalId, name: title, steamAppId: externalId, coverUrl: null };
    else {
      const query = { query: storeQuery(title), year: null };
      for (const p of this.metadata.ordered(false)) {
        try {
          const best = (await p.search(query.query))
            .map((c) => ({ ...c, score: matchScore(query, c) }))
            .sort((a, b) => b.score - a.score)[0];
          if (best && best.score >= AUTO_MATCH_THRESHOLD) {
            found = { provider: p.name, providerId: best.providerId, name: best.name, steamAppId: p.name === "steam" ? best.providerId : null, coverUrl: best.coverUrl };
            break;
          }
        } catch (err) {
          this.log.warn({ provider: p.name, title, err: (err as Error).message }, "Store game lookup failed");
        }
      }
    }
    let cover = found?.provider === "igdb" ? found.coverUrl : null;
    // SteamGridDB has proper portrait covers where RAWG and Steam only have wide images.
    if (found && !cover && this.metadata.steamgriddb.enabled) {
      try {
        const id = await this.metadata.steamgriddb.gameId(found.name, found.steamAppId);
        cover = (id && (await this.metadata.steamgriddb.covers(id))[0]?.url) || null;
      } catch (err) {
        this.log.warn({ title, err: (err as Error).message }, "SteamGridDB cover lookup failed");
      }
    }
    cover ??= found?.coverUrl ?? null;
    const row: MatchRow = { provider: found?.provider ?? null, provider_id: found?.providerId ?? null, cover_url: cover, matched_at: now() };
    this.db
      .prepare(
        `INSERT INTO store_game_match (addon, external_id, provider, provider_id, cover_url, matched_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(addon, external_id) DO UPDATE SET provider = excluded.provider, provider_id = excluded.provider_id, cover_url = excluded.cover_url, matched_at = excluded.matched_at`,
      )
      .run(addon, externalId, row.provider, row.provider_id, row.cover_url, row.matched_at);
    return row;
  }

  /**
   * Looks a store game up again now: its match by title (skipped for a Steam game, which is
   * matched by its app id) and the details of whichever match this person sees.
   */
  async refresh(userId: number, addon: string, externalId: string, title: string): Promise<void> {
    const old = this.matchRow(addon, externalId);
    if (title) {
      const found = await this.enqueue(() => this.lookup(addon, externalId, title));
      // Nothing found this time (or the services are down): keep the match it had.
      if (!found.provider && old?.provider) {
        this.db
          .prepare("UPDATE store_game_match SET provider = ?, provider_id = ?, cover_url = ?, matched_at = ? WHERE addon = ? AND external_id = ?")
          .run(old.provider, old.provider_id, old.cover_url, old.matched_at, addon, externalId);
      }
    }
    const m = await this.effectiveMatch(userId, addon, externalId, title);
    if (m) await this.info(m.provider, m.providerId, true);
  }

  /** Full details for a metadata entry, kept for a month (fresh fetches it now). An old copy is used if the service is down. */
  async info(provider: string, providerId: string, fresh = false): Promise<GameInfo | null> {
    if (!PROVIDERS.includes(provider)) return null;
    const row = this.db.prepare("SELECT info, fetched_at FROM store_game_info WHERE provider = ? AND provider_id = ?").get(provider, providerId) as { info: string; fetched_at: string } | undefined;
    if (row && !fresh && Date.now() - Date.parse(row.fetched_at) < REFRESH_INFO_MS) return json<GameInfo | null>(row.info, null);
    try {
      const info = await gameInfo(this.metadata, provider, providerId);
      if (info) {
        this.db
          .prepare("INSERT INTO store_game_info (provider, provider_id, info, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(provider, provider_id) DO UPDATE SET info = excluded.info, fetched_at = excluded.fetched_at")
          .run(provider, providerId, JSON.stringify(info), now());
      }
      return info;
    } catch (err) {
      this.log.warn({ provider, providerId, err: (err as Error).message }, "Store game details failed");
      return row ? json<GameInfo | null>(row.info, null) : null;
    }
  }

  // ---- A person's changes ------------------------------------------------------------------

  private customRow(userId: number, addon: string, externalId: string): CustomRow | undefined {
    return this.db.prepare("SELECT title, cover, background, provider, provider_id FROM store_game_custom WHERE user_id = ? AND addon = ? AND external_id = ?").get(userId, addon, externalId) as CustomRow | undefined;
  }

  custom(userId: number, addon: string, externalId: string): StoreGameCustom {
    const c = this.customRow(userId, addon, externalId);
    return {
      title: c?.title ?? null,
      cover: c?.cover ?? null,
      background: c?.background ?? null,
      match: c?.provider && c.provider_id ? { provider: c.provider, providerId: c.provider_id } : null,
    };
  }

  /** Every game this person renamed or gave a cover, for the lists. */
  allCustom(userId: number): Array<{ addon: string; externalId: string; title: string | null; coverUrl: string | null }> {
    const rows = this.db.prepare("SELECT addon, external_id, title, cover FROM store_game_custom WHERE user_id = ?").all(userId) as Array<{ addon: string; external_id: string; title: string | null; cover: string | null }>;
    return rows.map((r) => ({ addon: r.addon, externalId: r.external_id, title: r.title, coverUrl: r.cover ? customArtUrl(r.addon, r.external_id, r.cover) : null }));
  }

  /** Changes a title or match; null puts back what the store and the title search give. */
  update(userId: number, addon: string, externalId: string, patch: { title?: string | null; match?: { provider: string; providerId: string } | null }): void {
    const cur = this.custom(userId, addon, externalId);
    const title = patch.title === undefined ? cur.title : patch.title?.trim().slice(0, 200) || null;
    let match = patch.match === undefined ? cur.match : patch.match;
    if (match && (!PROVIDERS.includes(match.provider) || !/^\d+$/.test(match.providerId))) throw new Error("Pick a game from the search results");
    match = match ? { provider: match.provider, providerId: match.providerId } : null;
    this.write(userId, addon, externalId, { ...cur, title, match });
  }

  setArtwork(userId: number, addon: string, externalId: string, kind: ArtworkKind, value: string | null): void {
    if (value && !value.startsWith("upload:") && !/^https?:\/\/[^\s]+$/.test(value)) throw new Error("Use an http(s) image URL");
    const cur = this.custom(userId, addon, externalId);
    if (!value && cur[kind]?.startsWith("upload:")) void rm(this.uploadPath(userId, addon, externalId, kind), { force: true }).catch(() => {});
    this.write(userId, addon, externalId, { ...cur, [kind]: value });
  }

  private write(userId: number, addon: string, externalId: string, c: StoreGameCustom): void {
    if (!c.title && !c.cover && !c.background && !c.match) {
      this.db.prepare("DELETE FROM store_game_custom WHERE user_id = ? AND addon = ? AND external_id = ?").run(userId, addon, externalId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO store_game_custom (user_id, addon, external_id, title, cover, background, provider, provider_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, addon, external_id) DO UPDATE SET title = excluded.title, cover = excluded.cover, background = excluded.background,
           provider = excluded.provider, provider_id = excluded.provider_id`,
      )
      .run(userId, addon, externalId, c.title, c.cover, c.background, c.match?.provider ?? null, c.match?.providerId ?? null);
  }

  /** Uploaded images are named by a hash, so store ids never become paths. */
  private uploadPath(userId: number, addon: string, externalId: string, kind: ArtworkKind): string {
    const name = createHash("sha256").update(`${userId}\0${addon}\0${externalId}`).digest("hex").slice(0, 32);
    return path.join(this.dataDir, "artwork", "store", `${name}-${kind}.img`);
  }

  async saveUpload(userId: number, addon: string, externalId: string, kind: ArtworkKind, data: Buffer, contentType: string): Promise<void> {
    if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(contentType)) throw new Error("Upload a PNG, JPEG, WebP, GIF or AVIF image");
    if (data.length > 15 * 1024 * 1024) throw new Error("Images can be at most 15 MB");
    const file = this.uploadPath(userId, addon, externalId, kind);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, data);
    await rename(`${file}.tmp`, file);
    await writeFile(`${file}.type`, contentType);
    this.setArtwork(userId, addon, externalId, kind, `upload:${Date.now()}`);
  }

  // ---- What the pages show -------------------------------------------------------------------

  /** The match this person sees: their own pick, else the one found by title. */
  private async effectiveMatch(userId: number, addon: string, externalId: string, title: string) {
    const own = this.custom(userId, addon, externalId).match;
    return own ? { ...own, coverUrl: null } : this.match(addon, externalId, title);
  }

  /** A cover or background to show: an uploaded file, or an address for the browser to load. */
  async image(userId: number, addon: string, externalId: string, title: string, kind: ArtworkKind): Promise<Image | null> {
    const own = this.custom(userId, addon, externalId)[kind];
    if (own?.startsWith("upload:")) {
      const file = this.uploadPath(userId, addon, externalId, kind);
      const contentType = (await readFile(`${file}.type`, "utf8").catch(() => "image/jpeg")).trim();
      return (await stat(file).catch(() => null)) ? { file, contentType } : null;
    }
    if (own) return { url: own };
    const m = await this.effectiveMatch(userId, addon, externalId, title);
    const info = m ? await this.info(m.provider, m.providerId) : null;
    const url =
      kind === "cover"
        ? (m?.coverUrl ?? info?.coverUrl ?? info?.imageUrl ?? (addon === "steam" && /^\d+$/.test(externalId) ? steamHeader(externalId) : null))
        : (info?.imageUrl ?? info?.screenshots[0] ?? (addon === "steam" && /^\d+$/.test(externalId) ? steamHeader(externalId) : null));
    return url ? { url } : null;
  }

  async detail(userId: number, addon: string, externalId: string, game: StoreGame | null, title: string): Promise<StoreGameDetail> {
    const custom = this.custom(userId, addon, externalId);
    const name = game?.title ?? title;
    const m = await this.effectiveMatch(userId, addon, externalId, name);
    const info = m ? await this.info(m.provider, m.providerId) : null;
    const cover = await this.image(userId, addon, externalId, name, "cover");
    const background = await this.image(userId, addon, externalId, name, "background");
    // Uploaded images are served by the server; addresses are loaded by the browser directly.
    const shown = (img: Image | null, kind: ArtworkKind) => (!img ? null : "url" in img ? img.url : customArtUrl(addon, externalId, custom[kind] ?? "", kind));
    return {
      game: game && custom.title ? { ...game, title: custom.title } : game,
      info,
      // The person's own cover, then the store's, then the matched one.
      coverUrl: custom.cover ? shown(cover, "cover") : (game?.coverUrl ?? shown(cover, "cover")),
      backgroundUrl: shown(background, "background"),
      custom,
    };
  }

  /** Images to pick from for a cover or background: SteamGridDB when it has a key, plus the matched entry's own. */
  async artworkOptions(userId: number, addon: string, externalId: string, title: string, kind: ArtworkKind, query?: string): Promise<ArtworkOption[]> {
    const out: ArtworkOption[] = [];
    const m = await this.effectiveMatch(userId, addon, externalId, title);
    const info = m ? await this.info(m.provider, m.providerId) : null;
    if (this.metadata.steamgriddb.enabled) {
      const steamAppId = m?.provider === "steam" ? m.providerId : addon === "steam" && /^\d+$/.test(externalId) ? externalId : null;
      const id = query ? ((await this.metadata.steamgriddb.search(query))[0]?.id ?? null) : await this.metadata.steamgriddb.gameId(storeQuery(title), steamAppId);
      if (id) out.push(...(kind === "cover" ? await this.metadata.steamgriddb.covers(id) : await this.metadata.steamgriddb.backgrounds(id)));
    }
    const own = kind === "cover" ? [m?.coverUrl, info?.coverUrl] : [info?.imageUrl, ...(info?.screenshots ?? [])];
    for (const url of own) if (url && !out.some((o) => o.url === url)) out.push({ url, thumb: url, width: 0, height: 0, source: m?.provider ?? "metadata" });
    return out.slice(0, 60);
  }
}
