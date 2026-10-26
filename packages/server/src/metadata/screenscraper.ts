import type { AgeRating, Platform } from "@lootden/shared";
import { HttpError, limitedJson, RateLimiter, type FetchLike } from "./http.js";
import type { Candidate, MetadataProvider, ProviderResult, RomHints } from "./types.js";

// Free accounts get one thread and a few requests a second; stay well under it.
const limiter = new RateLimiter(1200);
const API = "https://api.screenscraper.fr/api2";
const SOFTNAME = "LootDen";
/** Query parameters that carry credentials; kept out of stored URLs so they never reach a browser. */
const AUTH_PARAMS = ["devid", "devpassword", "softname", "ssid", "sspassword"];

/** ScreenScraper system ids for LootDen's platforms. */
const SYSTEMS: Record<string, number> = {
  pc: 138, nes: 3, snes: 4, n64: 14, gb: 9, gbc: 10, gba: 12, nds: 15, gamecube: 13, wii: 16,
  genesis: 1, saturn: 22, dreamcast: 23, ps1: 57, ps2: 58, ps3: 59, psp: 61, xbox: 32,
};
const REGIONS = ["us", "wor", "eu", "ss", "uk", "jp"];
const COVER_TYPES = ["box-2D", "box-2D-front"];
const SHOT_TYPES = ["ss", "sstitle", "fanart"];
/** Discs are too big to hash on every lookup; cartridge ROMs are small. */
export const MAX_HASH_BYTES = 128 * 1024 * 1024;

interface Text {
  text: string;
  region?: string;
  langue?: string;
}

interface SsMedia {
  type: string;
  url: string;
  region?: string;
  parent?: string;
}

export interface SsGame {
  id?: string;
  noms?: Text[];
  synopsis?: Text[];
  dates?: Text[];
  genres?: Array<{ noms?: Text[] }>;
  modes?: Array<{ noms?: Text[] }>;
  note?: { text?: string };
  classifications?: Array<{ type: string; text: string }>;
  medias?: SsMedia[];
}

const byRegion = <T extends { region?: string }>(items: T[]): T | undefined =>
  [...items].sort((a, b) => rank(a.region) - rank(b.region))[0];
const rank = (r?: string) => {
  const i = REGIONS.indexOf(r ?? "");
  return i < 0 ? REGIONS.length : i;
};
const english = (items?: Text[]): string | null => (items?.find((t) => t.langue === "en") ?? items?.[0])?.text?.trim() || null;

/** ScreenScraper.fr: retro box art, screenshots and descriptions, matched by ROM checksum or by name. */
export class ScreenScraperProvider implements MetadataProvider {
  readonly name = "screenscraper";
  /** Games already downloaded during this run, so a search then fetch costs one request of the daily quota. */
  private readonly seen = new Map<string, SsGame>();

  constructor(
    private readonly creds: { devId: string; devPassword: string; username: string; password: string },
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get enabled(): boolean {
    return !!(this.creds.devId && this.creds.devPassword);
  }

  private auth(): Record<string, string> {
    const a: Record<string, string> = { devid: this.creds.devId, devpassword: this.creds.devPassword, softname: SOFTNAME, output: "json" };
    if (this.creds.username) Object.assign(a, { ssid: this.creds.username, sspassword: this.creds.password });
    return a;
  }

  private async get<T>(endpoint: string, params: Record<string, string>): Promise<T | null> {
    const qs = new URLSearchParams({ ...this.auth(), ...params });
    try {
      return await limitedJson<T>(limiter, this.fetchImpl, `${API}/${endpoint}?${qs}`);
    } catch (err) {
      // Not found is a 404 with a French sentence; anything else means a real problem.
      if (err instanceof HttpError && err.status === 404) return null;
      if (err instanceof HttpError) throw new Error(this.explain(err.status), { cause: err });
      throw err;
    }
  }

  private explain(status: number): string {
    if (status === 401 || status === 403) return "ScreenScraper refused the login: check the developer ID, developer password and account";
    if (status === 423) return "ScreenScraper is offline at the moment";
    if (status === 426) return "ScreenScraper has blocked this app version";
    if (status === 429 || status === 430) return "ScreenScraper's quota is used up for today; it resets at midnight (France)";
    return `ScreenScraper answered ${status}`;
  }

  /** Adds the credentials back to a ScreenScraper image address, for the server's own download. */
  authorize(url: string): string {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return url;
    }
    if (!isScreenScraperUrl(u)) return url;
    // Appended as text so the rest of the address stays exactly as ScreenScraper wrote it.
    const extra = new URLSearchParams(Object.entries(this.auth()).filter(([k]) => k !== "output")).toString();
    const clean = stripAuth(url);
    return `${clean}${clean.includes("?") ? "&" : "?"}${extra}`;
  }

  async search(query: string, platform?: Platform, rom?: RomHints): Promise<Candidate[]> {
    const systemeid = String(SYSTEMS[platform?.id ?? "pc"] ?? "");
    if (rom) {
      const md5 = await rom.md5().catch(() => null);
      const params: Record<string, string> = { romtype: "rom", romnom: rom.fileName, romtaille: String(rom.size) };
      if (systemeid) params.systemeid = systemeid;
      if (md5) params.md5 = md5;
      const r = await this.get<{ response?: { jeu?: SsGame } }>("jeuInfos.php", params);
      const jeu = r?.response?.jeu;
      if (jeu?.id) return [{ ...this.candidate(this.remember(jeu)), exact: !!md5 }];
    }
    const params: Record<string, string> = { recherche: query };
    if (systemeid) params.systemeid = systemeid;
    const r = await this.get<{ response?: { jeux?: SsGame[] } }>("jeuRecherche.php", params);
    return (r?.response?.jeux ?? []).filter((g) => g.id).slice(0, 15).map((g) => this.candidate(this.remember(g)));
  }

  async fetch(id: string): Promise<ProviderResult | null> {
    if (!/^\d+$/.test(id)) return null;
    let jeu = this.seen.get(id);
    if (!jeu) {
      const r = await this.get<{ response?: { jeu?: SsGame } }>("jeuInfos.php", { gameid: id });
      jeu = r?.response?.jeu;
    }
    return jeu?.id ? this.toResult(jeu) : null;
  }

  private remember(g: SsGame): SsGame {
    if (this.seen.size > 500) this.seen.clear();
    this.seen.set(g.id!, g);
    return g;
  }

  private media(g: SsGame, types: string[]): string[] {
    const out: string[] = [];
    for (const type of types) {
      const best = byRegion((g.medias ?? []).filter((m) => m.type === type && m.url));
      if (best) out.push(stripAuth(best.url));
    }
    return out;
  }

  private candidate(g: SsGame): Candidate {
    const date = byRegion(g.dates ?? [])?.text;
    return {
      provider: this.name,
      providerId: g.id!,
      name: byRegion(g.noms ?? [])?.text ?? "Unknown",
      year: date ? Number(date.slice(0, 4)) || null : null,
      coverUrl: this.media(g, COVER_TYPES)[0] ?? null,
    };
  }

  private toResult(g: SsGame): ProviderResult {
    const c = this.candidate(g);
    const date = byRegion(g.dates ?? [])?.text ?? null;
    const note = Number(g.note?.text);
    const ageRatings: AgeRating[] = (g.classifications ?? [])
      .filter((x) => /^(ESRB|PEGI|CERO|USK|ACB)$/i.test(x.type) && x.text)
      .map((x) => ({ organization: x.type.toUpperCase(), rating: x.text }));
    return {
      provider: this.name,
      providerId: c.providerId,
      name: c.name,
      summary: english(g.synopsis),
      coverUrl: c.coverUrl,
      screenshots: this.media(g, SHOT_TYPES),
      genres: (g.genres ?? []).map((x) => english(x.noms)).filter((x): x is string => !!x),
      themes: [],
      gameModes: (g.modes ?? []).map((x) => english(x.noms)).filter((x): x is string => !!x),
      releaseDate: date && /^\d{4}(-\d{2}-\d{2})?$/.test(date) ? date : null,
      // Notes are out of 20.
      rating: Number.isFinite(note) && note > 0 ? note * 5 : null,
      ageRatings,
      controllerSupport: null,
      steamAppId: null,
    };
  }
}

export function isScreenScraperUrl(u: URL): boolean {
  return u.hostname === "screenscraper.fr" || u.hostname.endsWith(".screenscraper.fr");
}

/** Removes the developer and account passwords ScreenScraper puts in its image links. */
export function stripAuth(url: string): string {
  const [base, query] = url.split(/\?(.*)/s, 2) as [string, string | undefined];
  if (query === undefined) return url;
  const kept = query.split("&").filter((part) => part && !AUTH_PARAMS.includes(part.split("=")[0]!.toLowerCase()));
  return kept.length ? `${base}?${kept.join("&")}` : base;
}
