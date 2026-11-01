import { ROBLOX_ADDON, parseRobloxPlace, robloxLaunchUrl, robloxPageUrl, type GameInfo, type RobloxGame, type StoreGame, type StoreGameDetail } from "@lootden/shared";
import { now, type Db } from "../db/database.js";
import type { FetchLike } from "../metadata/http.js";
import { RobloxPosters } from "./poster.js";

interface Row {
  universe_id: string;
  place_id: string;
  name: string;
  description: string | null;
  creator: string | null;
  icon_url: string | null;
  thumbnail_url: string | null;
  age_rating: string | null;
  genre: string | null;
  max_players: number | null;
  everyone: number;
  added_at: string;
  refreshed_at: string;
}

/** What Roblox's public APIs say about one experience. */
export interface RobloxDetails {
  universeId: string;
  placeId: string;
  name: string;
  description: string | null;
  creator: string | null;
  iconUrl: string | null;
  thumbnailUrl: string | null;
  ageRating: string | null;
  genre: string | null;
  maxPlayers: number | null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Roblox experiences an admin picks for the library. Details come from Roblox's public web APIs
 * (no account or key): the place's universe, then its name, description, creator, icon, a
 * screenshot and Roblox's age recommendation. Each experience is shown to everyone or only to
 * the profiles the admin ticked, as a store game under "Roblox" whose Play opens the Roblox app.
 */
export class RobloxCatalog {
  readonly posters: RobloxPosters;

  constructor(
    private readonly db: Db,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.posters = new RobloxPosters(fetchImpl);
  }

  /** A game's poster, for someone it's shown to. Null otherwise. */
  async poster(userId: number, universeId: string): Promise<string | null> {
    const g = this.forUser(userId).find((x) => x.universeId === universeId);
    return g ? this.posters.poster(g) : null;
  }

  /** A game's screenshot, for someone it's shown to. */
  screenshot(userId: number, universeId: string): string | null {
    return this.forUser(userId).find((x) => x.universeId === universeId)?.thumbnailUrl ?? null;
  }

  private async get<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(url, { ...init, headers: { accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Roblox answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** Looks a place up on Roblox. Throws a message an admin can act on. */
  async lookup(input: string): Promise<RobloxDetails> {
    const placeId = parseRobloxPlace(input);
    if (!placeId) throw new Error("Paste a Roblox game link (roblox.com/games/…) or its place ID");
    let universeId: string | null;
    try {
      const u = await this.get<{ universeId?: number | string | null }>(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
      universeId = u.universeId == null ? null : String(u.universeId);
    } catch (err) {
      throw new Error(/ 404$/.test((err as Error).message) ? "Roblox has no game with that place ID" : `Couldn't reach Roblox: ${(err as Error).message}`);
    }
    if (!universeId || !/^\d+$/.test(universeId)) throw new Error("Roblox has no game with that place ID");

    const games = await this.get<{ data?: Array<Record<string, unknown>> }>(`https://games.roblox.com/v1/games?universeIds=${universeId}`);
    const g = games.data?.[0];
    if (!g || !str(g.name)) throw new Error("Roblox didn't return that game's details (it may be private)");
    const creator = (g.creator ?? {}) as { name?: unknown };

    // Pictures and the age recommendation are extras: the game still gets added without them.
    const [iconUrl, thumbnailUrl, ageRating] = await Promise.all([
      this.get<{ data?: Array<{ imageUrl?: unknown; state?: unknown }> }>(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&returnPolicy=PlaceHolder&size=512x512&format=Png&isCircular=false`)
        .then((r) => str(r.data?.[0]?.imageUrl))
        .catch(() => null),
      this.get<{ data?: Array<{ thumbnails?: Array<{ imageUrl?: unknown }> }> }>(
        `https://thumbnails.roblox.com/v1/games/multiget/thumbnails?universeIds=${universeId}&countPerUniverse=1&defaults=true&size=768x432&format=Png&isCircular=false`,
      )
        .then((r) => str(r.data?.[0]?.thumbnails?.[0]?.imageUrl))
        .catch(() => null),
      this.get<unknown>("https://apis.roblox.com/experience-guidelines-api/experience-guidelines/get-age-recommendation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ universeId }),
      })
        .then(ageRatingOf)
        .catch(() => null),
    ]);

    return {
      universeId,
      // Play starts in the experience's start place, even when the link was to another of its places.
      placeId: g.rootPlaceId != null && /^\d+$/.test(String(g.rootPlaceId)) ? String(g.rootPlaceId) : placeId,
      name: str(g.name)!,
      description: str(g.description),
      creator: str(creator.name),
      iconUrl,
      thumbnailUrl,
      ageRating,
      genre: str(g.genre) === "All" ? null : str(g.genre),
      maxPlayers: typeof g.maxPlayers === "number" ? g.maxPlayers : null,
    };
  }

  private save(d: RobloxDetails): void {
    const at = now();
    this.db
      .prepare(
        `INSERT INTO roblox_games (universe_id, place_id, name, description, creator, icon_url, thumbnail_url, age_rating, genre, max_players, added_at, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(universe_id) DO UPDATE SET place_id = excluded.place_id, name = excluded.name, description = excluded.description, creator = excluded.creator,
           icon_url = excluded.icon_url, thumbnail_url = excluded.thumbnail_url, age_rating = excluded.age_rating, genre = excluded.genre,
           max_players = excluded.max_players, refreshed_at = excluded.refreshed_at`,
      )
      .run(d.universeId, d.placeId, d.name, d.description, d.creator, d.iconUrl, d.thumbnailUrl, d.ageRating, d.genre, d.maxPlayers, at, at);
  }

  /** Admins: adds a game (or refreshes one already added) and sets who sees it. */
  async add(input: string, access?: { everyone?: unknown; userIds?: unknown }): Promise<RobloxGame> {
    const d = await this.lookup(input);
    this.save(d);
    if (access) this.setAccess(d.universeId, access);
    return this.get1(d.universeId)!;
  }

  /** Admins: fetches a game's details from Roblox again. */
  async refresh(universeId: string): Promise<RobloxGame> {
    const cur = this.get1(universeId);
    if (!cur) throw new Error("No such Roblox game");
    const d = await this.lookup(cur.placeId);
    if (d.universeId !== universeId) throw new Error("That place belongs to a different game on Roblox now");
    this.save(d);
    return this.get1(universeId)!;
  }

  /** Admins: who sees a game. Ids that aren't profiles are dropped. */
  setAccess(universeId: string, access: { everyone?: unknown; userIds?: unknown }): RobloxGame {
    if (!this.get1(universeId)) throw new Error("No such Roblox game");
    const ids = Array.isArray(access.userIds) ? [...new Set(access.userIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : null;
    this.db.exec("BEGIN");
    try {
      if (access.everyone !== undefined) this.db.prepare("UPDATE roblox_games SET everyone = ? WHERE universe_id = ?").run(access.everyone ? 1 : 0, universeId);
      if (ids) {
        this.db.prepare("DELETE FROM roblox_access WHERE universe_id = ?").run(universeId);
        const add = this.db.prepare("INSERT OR IGNORE INTO roblox_access (universe_id, user_id) SELECT ?, id FROM users WHERE id = ?");
        for (const id of ids) add.run(universeId, id);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return this.get1(universeId)!;
  }

  remove(universeId: string): void {
    this.db.prepare("DELETE FROM roblox_games WHERE universe_id = ?").run(universeId);
  }

  private view(r: Row, access: Map<string, number[]>): RobloxGame {
    return {
      universeId: r.universe_id,
      placeId: r.place_id,
      name: r.name,
      description: r.description,
      creator: r.creator,
      iconUrl: r.icon_url,
      thumbnailUrl: r.thumbnail_url,
      ageRating: r.age_rating,
      genre: r.genre,
      maxPlayers: r.max_players,
      everyone: r.everyone === 1,
      userIds: access.get(r.universe_id) ?? [],
      addedAt: r.added_at,
      refreshedAt: r.refreshed_at,
    };
  }

  private accessMap(): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const a of this.db.prepare("SELECT universe_id, user_id FROM roblox_access ORDER BY user_id").all() as Array<{ universe_id: string; user_id: number }>) {
      out.set(a.universe_id, [...(out.get(a.universe_id) ?? []), a.user_id]);
    }
    return out;
  }

  /** Admins: every game, with who sees it. */
  list(): RobloxGame[] {
    const access = this.accessMap();
    return (this.db.prepare("SELECT * FROM roblox_games ORDER BY name COLLATE NOCASE").all() as unknown as Row[]).map((r) => this.view(r, access));
  }

  private get1(universeId: string): RobloxGame | null {
    const r = this.db.prepare("SELECT * FROM roblox_games WHERE universe_id = ?").get(universeId) as Row | undefined;
    return r ? this.view(r, this.accessMap()) : null;
  }

  /** The games this person was given. */
  forUser(userId: number): RobloxGame[] {
    return this.list().filter((g) => g.everyone || g.userIds.includes(userId));
  }

  /** This person's games as store games, so they sit with the other stores (filter, cards, Home, controller mode). */
  storeGames(userId: number): StoreGame[] {
    return this.forUser(userId).map(toStoreGame);
  }

  /** A game's page, for someone it's shown to. Null otherwise. */
  detail(userId: number, universeId: string): StoreGameDetail | null {
    const g = this.forUser(userId).find((x) => x.universeId === universeId);
    if (!g) return null;
    const page = robloxPageUrl(g.placeId);
    const info: GameInfo = {
      provider: ROBLOX_ADDON,
      providerId: g.universeId,
      name: g.name,
      releaseDate: null,
      dateText: null,
      coverUrl: g.iconUrl,
      imageUrl: g.thumbnailUrl,
      platforms: [],
      genres: g.genre ? [g.genre] : [],
      url: page,
      libraryId: null,
      summary: g.description,
      screenshots: g.thumbnailUrl ? [g.thumbnailUrl] : [],
      trailer: null,
      rating: null,
      developers: g.creator ? [g.creator] : [],
      ageRatings: g.ageRating ? [{ organization: "Roblox", rating: g.ageRating }] : [],
    };
    return { game: toStoreGame(g), info, coverUrl: robloxPosterPath(g), backgroundUrl: g.thumbnailUrl, custom: { title: null, cover: null, background: null, match: null } };
  }
}

/** Where the server serves a Roblox game's portrait poster (see poster.ts). */
export const robloxPosterPath = (g: RobloxGame) => `/api/store-games/${ROBLOX_ADDON}/${encodeURIComponent(g.universeId)}/cover?v=${RobloxPosters.version(g)}`;

export function toStoreGame(g: RobloxGame): StoreGame {
  return {
    addon: ROBLOX_ADDON,
    store: "Roblox",
    externalId: g.universeId,
    title: g.name,
    coverUrl: robloxPosterPath(g),
    storeUrl: robloxPageUrl(g.placeId),
    launchUrl: robloxLaunchUrl(g.placeId),
    playtimeSeconds: null,
    lastPlayedAt: null,
    libraryGameId: null,
    artUrl: null,
  };
}

/** Roblox's age recommendation ("Ages 9+") from its experience guidelines answer, wherever it sits. */
export function ageRatingOf(body: unknown): string | null {
  const details = (body as { ageRecommendationDetails?: Record<string, unknown> } | null)?.ageRecommendationDetails;
  if (!details) return null;
  const summary = (details.ageRecommendationSummary ?? details.summary) as { ageRecommendation?: { displayName?: unknown } } | undefined;
  return str(summary?.ageRecommendation?.displayName);
}
