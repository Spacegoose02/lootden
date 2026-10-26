import type { AgeRating, Platform } from "@lootden/shared";
import { limitedJson, RateLimiter, type FetchLike } from "./http.js";
import type { Candidate, MetadataProvider, ProviderResult } from "./types.js";

// Keys come with a monthly allowance; matching uses two or three requests per game.
const limiter = new RateLimiter(500);
const API = "https://api.thegamesdb.net/v1";

/** TheGamesDB platform ids for LootDen's platforms. */
const PLATFORMS: Record<string, number> = {
  pc: 1, nes: 7, snes: 6, n64: 3, gb: 4, gbc: 41, gba: 5, nds: 8, gamecube: 2, wii: 9,
  genesis: 18, saturn: 17, dreamcast: 16, ps1: 10, ps2: 11, ps3: 12, psp: 13, xbox: 14,
};

interface TgdbGame {
  id: number;
  game_title: string;
  release_date?: string | null;
  overview?: string | null;
  rating?: string | null;
  players?: number | null;
  coop?: string | null;
  genres?: number[] | null;
}

interface TgdbImage {
  type: string;
  side?: string | null;
  filename: string;
}

interface BaseUrl {
  original: string;
  large?: string;
  medium?: string;
  thumb?: string;
}

interface GamesResponse {
  data?: { games?: TgdbGame[] };
  include?: { boxart?: { base_url: BaseUrl; data: Record<string, TgdbImage[]> } };
}

const year = (d?: string | null) => (d ? Number(d.slice(0, 4)) || null : null);

/** TheGamesDB.net: community box art and descriptions, strong on consoles. */
export class TheGamesDbProvider implements MetadataProvider {
  readonly name = "thegamesdb";
  private genres: Map<number, string> | null = null;

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get enabled(): boolean {
    return !!this.apiKey;
  }

  private get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams({ apikey: this.apiKey, ...params });
    return limitedJson<T>(limiter, this.fetchImpl, `${API}${path}?${qs}`);
  }

  private front(r: GamesResponse, id: number, size: keyof BaseUrl = "original"): string | null {
    const box = r.include?.boxart;
    const img = box?.data?.[String(id)]?.find((i) => i.type === "boxart" && i.side === "front");
    return box && img ? `${box.base_url[size] ?? box.base_url.original}${img.filename}` : null;
  }

  async search(query: string, platform?: Platform): Promise<Candidate[]> {
    const params: Record<string, string> = { name: query, include: "boxart" };
    const id = PLATFORMS[platform?.id ?? "pc"];
    if (id) params["filter[platform]"] = String(id);
    const r = await this.get<GamesResponse>("/Games/ByGameName", params);
    return (r.data?.games ?? []).slice(0, 15).map((g) => ({
      provider: this.name,
      providerId: String(g.id),
      name: g.game_title,
      year: year(g.release_date),
      coverUrl: this.front(r, g.id, "medium"),
    }));
  }

  private async genreNames(): Promise<Map<number, string>> {
    if (!this.genres) {
      const r = await this.get<{ data?: { genres?: Record<string, { id: number; name: string }> } }>("/Genres");
      this.genres = new Map(Object.values(r.data?.genres ?? {}).map((g) => [g.id, g.name]));
    }
    return this.genres;
  }

  async fetch(id: string): Promise<ProviderResult | null> {
    if (!/^\d+$/.test(id)) return null;
    const r = await this.get<GamesResponse>("/Games/ByGameID", { id, fields: "players,genres,overview,rating,coop", include: "boxart" });
    const g = r.data?.games?.[0];
    if (!g) return null;
    const names = await this.genreNames().catch(() => new Map<number, string>());
    const shots = await this.get<{ data?: { base_url?: BaseUrl; images?: Record<string, TgdbImage[]> } }>("/Games/Images", {
      games_id: id,
      "filter[type]": "screenshot,fanart",
    }).catch(() => null);
    const base = shots?.data?.base_url?.original ?? "";
    const images = shots?.data?.images?.[id] ?? [];
    // "E - Everyone" -> E
    const esrb = g.rating?.split(" - ")[0]?.trim();
    const ageRatings: AgeRating[] = esrb && esrb !== "Not Rated" ? [{ organization: "ESRB", rating: esrb }] : [];
    const modes = [g.players && g.players > 1 ? "Multiplayer" : g.players === 1 ? "Single player" : null, g.coop === "Yes" ? "Co-op" : null];
    return {
      provider: this.name,
      providerId: String(g.id),
      name: g.game_title,
      summary: g.overview?.trim() || null,
      coverUrl: this.front(r, g.id),
      screenshots: [...images.filter((i) => i.type === "screenshot"), ...images.filter((i) => i.type === "fanart")].slice(0, 8).map((i) => `${base}${i.filename}`),
      genres: (g.genres ?? []).map((x) => names.get(x)).filter((x): x is string => !!x),
      themes: [],
      gameModes: modes.filter((x): x is string => !!x),
      releaseDate: g.release_date && /^\d{4}-\d{2}-\d{2}$/.test(g.release_date) ? g.release_date : null,
      rating: null,
      ageRatings,
      controllerSupport: null,
      steamAppId: null,
    };
  }
}
