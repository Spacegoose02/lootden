import type { AgeRating, Platform } from "@lootden/shared";
import { limitedJson, RateLimiter, type FetchLike } from "./http.js";
import type { Candidate, MetadataProvider, ProviderResult } from "./types.js";

// RAWG's free key allows 20,000 requests a month; matching uses two per game.
const limiter = new RateLimiter(250);
const API = "https://api.rawg.io/api";

const ESRB: Record<string, string> = {
  everyone: "E",
  "everyone-10-plus": "E10+",
  teen: "T",
  mature: "M",
  "adults-only": "AO",
  "rating-pending": "RP",
};

interface RawgGame {
  id: number;
  name: string;
  released?: string | null;
  background_image?: string | null;
  background_image_additional?: string | null;
  description_raw?: string;
  rating?: number;
  metacritic?: number | null;
  genres?: Array<{ name: string }>;
  tags?: Array<{ name: string; language?: string }>;
  esrb_rating?: { slug?: string } | null;
}

/** RAWG.io: free API key, broad catalogue. Used after IGDB, before the Steam store. */
export class RawgProvider implements MetadataProvider {
  readonly name = "rawg";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get enabled(): boolean {
    return !!this.apiKey;
  }

  private get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams({ key: this.apiKey, ...params });
    return limitedJson<T>(limiter, this.fetchImpl, `${API}${path}?${qs}`);
  }

  /** Any RAWG endpoint, for the Discover game page. */
  raw<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    return this.get<T>(path, params);
  }

  /** Games list with RAWG filters (dates, ordering, platforms...), for the calendar and Discover. */
  list(params: Record<string, string>): Promise<{ results: Array<RawgGame & { slug?: string; platforms?: Array<{ platform: { name: string } }> }> }> {
    return this.get("/games", params);
  }

  async search(query: string, platform?: Platform): Promise<Candidate[]> {
    // A console RAWG has no id for yet (Switch 2) searches every platform rather than PC's.
    const rawgPlatform = platform?.rawg ?? (platform && platform.id !== "pc" ? null : 4);
    const r = await this.get<{ results: RawgGame[] }>("/games", { search: query, page_size: "10", ...(rawgPlatform ? { platforms: String(rawgPlatform) } : {}) });
    return r.results.map((g) => ({
      provider: this.name,
      providerId: String(g.id),
      name: g.name,
      year: g.released ? Number(g.released.slice(0, 4)) : null,
      coverUrl: g.background_image ?? null,
    }));
  }

  async fetch(id: string): Promise<ProviderResult | null> {
    if (!/^\d+$/.test(id)) return null;
    const g = await this.get<RawgGame>(`/games/${id}`);
    const ageRatings: AgeRating[] = [];
    const esrb = g.esrb_rating?.slug ? ESRB[g.esrb_rating.slug] : undefined;
    if (esrb) ageRatings.push({ organization: "ESRB", rating: esrb });
    return {
      provider: this.name,
      providerId: String(g.id),
      name: g.name,
      summary: g.description_raw?.trim() || null,
      coverUrl: g.background_image ?? null,
      screenshots: [g.background_image, g.background_image_additional].filter((x): x is string => !!x),
      genres: (g.genres ?? []).map((x) => x.name),
      themes: [],
      gameModes: (g.tags ?? []).filter((t) => t.language !== "rus" && /player|co-op|multiplayer/i.test(t.name)).map((t) => t.name).slice(0, 4),
      releaseDate: g.released ?? null,
      rating: g.metacritic ?? (g.rating ? Math.round(g.rating * 20) : null),
      ageRatings,
      controllerSupport: null,
      steamAppId: null,
    };
  }
}
